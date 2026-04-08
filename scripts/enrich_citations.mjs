#!/usr/bin/env node
// Citation enrichment pipeline.
//
// For every question in the merged master, ask Claude (claude-opus-4-6) to
// identify the single most relevant primary-literature citation, classify it
// as "classic" or "historic", and return a structured JSON object matching
// the schema below. Results are written incrementally so the pipeline is
// resumable.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-... node scripts/enrich_citations.mjs
//   ANTHROPIC_API_KEY=sk-... node scripts/enrich_citations.mjs --limit 10    # dry run
//   ANTHROPIC_API_KEY=sk-... node scripts/enrich_citations.mjs --priority    # do the ~290 that already name an author first
//
// Requires: npm i @anthropic-ai/sdk
//
// Schema written back onto each question:
//   citation: {
//     author, coauthors, year, title, journal, volume, pages,
//     pmid (nullable), classification: "classic"|"historic",
//     relevance, verified: false
//   }
//
// IMPORTANT: `verified` starts as false. A human must review via
// scripts/curate_cli.mjs before citations render in the app.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const INPUT  = 'questions.merged.json';
const OUTPUT = 'questions.enriched.json';
// Sonnet 4.6 is the right tool for this task: structured citation lookup
// with explanations that already name the author ~20% of the time. Opus
// would be ~5x more expensive with no meaningful quality gain here.
// Override via MODEL env var if you want: `MODEL=claude-opus-4-6 ...`
const MODEL  = process.env.MODEL || 'claude-sonnet-4-6';
const BATCH  = 10;

const args = process.argv.slice(2);
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg >= 0 ? parseInt(args[limitArg + 1], 10) : Infinity;
const PRIORITY_ONLY = args.includes('--priority');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not set');
  process.exit(1);
}

// Thin HTTP client around `curl` — bypasses Node's undici which hangs on
// HTTP/2 against api.anthropic.com in the sandbox we develop in. curl runs
// everywhere and respects http_proxy/https_proxy if set. If you want to
// use the official SDK instead, just replace `callAnthropic` below.
function callAnthropic({ model, system, messages, max_tokens, temperature }) {
  const payload = JSON.stringify({ model, max_tokens, temperature, system, messages });
  return new Promise((resolve, reject) => {
    const proc = spawn('curl', [
      '-s', '--fail-with-body', '--max-time', '120',
      'https://api.anthropic.com/v1/messages',
      '-H', 'x-api-key: ' + process.env.ANTHROPIC_API_KEY,
      '-H', 'anthropic-version: 2023-06-01',
      '-H', 'content-type: application/json',
      '--data-binary', '@-',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error('curl exit ' + code + ': ' + (err || out).slice(0, 500)));
      try {
        const j = JSON.parse(out);
        if (j.type === 'error') return reject(new Error('anthropic: ' + JSON.stringify(j.error)));
        resolve(j);
      } catch (e) { reject(new Error('parse: ' + e.message + ' / ' + out.slice(0, 200))); }
    });
    proc.stdin.write(payload);
    proc.stdin.end();
  });
}

const SYSTEM = `You are an endodontics literature expert helping a dental resident prepare cite-the-study cards for ABE board prep. Accuracy matters far more than completeness — a wrong citation is worse than no citation, because the candidate may recite it on an oral exam.

STRICT RULES — read carefully:

1. ANCHOR to the author in the explanation. If the explanation says "Sjögren et al", your author field MUST be "Sjögren". If the explanation names no author, only cite if you are virtually certain which study the question is testing.

2. NEVER FABRICATE. If you are not confident in a field, leave it empty or null:
   - Don't guess coauthors. If you are unsure of the second/third authors, leave coauthors as an empty string "".
   - Don't guess years. If unsure, set year to null.
   - Don't guess volume, pages, or PMIDs — these are the most frequently wrong. Leave as "" or null when uncertain.
   - It is far better to return {"author":"Delivanis","coauthors":"","year":null,"title":"","journal":"J Endod","volume":"","pages":"","pmid":null,"classification":"historic","relevance":"..."} than to invent details.

3. CONFIDENCE FIELD. Add a "confidence" field to each citation: one of "high" (you are virtually certain author + title + approximate year are correct), "medium" (author matches but other fields are your best guess), "low" (you are guessing even the author — rare; should correspond mostly to your best judgment about the topic area).

4. CLASSIFICATION:
   - "classic": seminal, widely-cited, still practice-defining (e.g. Sjögren 1990, Torabinejad on MTA, Ørstavik on healing, Siqueira on microbiology).
   - "historic": >30 years old, often superseded but still on board reading lists (Kakehashi 1965, Möller 1981, Delivanis et al on bacteremia).

5. OUTPUT. Return ONLY strict JSON matching the schema described by the user. No prose. No markdown fences.

6. RELEVANCE. One sentence explaining how this study's finding supports the answer. Written so a resident could verbalize it on the oral boards.`;

const USER_TEMPLATE = (items) => `Here are ${items.length} endo board questions. For EACH, return a JSON object with this exact shape:

{
  "id": "<echo the question id>",
  "citation": {
    "author": "<first author surname — MATCH the explanation exactly if it names one>",
    "coauthors": "<comma-separated other authors — empty string if unsure>",
    "year": <integer or null — null if unsure>,
    "title": "<full paper title — empty string if unsure>",
    "journal": "<journal abbreviation, e.g. J Endod — empty string if unsure>",
    "volume": "<string or empty>",
    "pages": "<start-end or empty>",
    "pmid": "<numeric string or null — ONLY if you are highly confident>",
    "classification": "classic" | "historic",
    "confidence": "high" | "medium" | "low",
    "relevance": "<one sentence explaining how this study's finding supports the answer>"
  }
}

Remember: a WRONG detail is worse than a MISSING detail. Leave fields empty/null when unsure. Return ALL ${items.length} objects as a single JSON array, no prose, no markdown fences.

QUESTIONS:
${items.map(q => JSON.stringify({
  id: q.id,
  chapter: q.chapterTitle,
  question: q.question,
  correctAnswer: q.options?.find(o => o.letter === (q.answer || q.correctAnswer))?.text,
  explanation: q.explanation,
})).join('\n---\n')}`;

function isPriority(q) {
  return /[A-Z][a-zéöø]+\s+et\s+al/i.test(q.explanation || '');
}

async function enrichBatch(batch) {
  console.log('    calling ' + MODEL + ' with ' + batch.length + ' q\'s...');
  const t0 = Date.now();
  const resp = await callAnthropic({
    model: MODEL,
    max_tokens: 4096,
    temperature: 0.2,
    system: SYSTEM,
    messages: [{ role: 'user', content: USER_TEMPLATE(batch) }],
  });
  console.log('    api ok in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  const text = (resp.content || []).map(c => c.type === 'text' ? c.text : '').join('');
  // Strip any accidental code-fence
  const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error('  JSON parse failed for batch; raw output:', text.slice(0, 400));
    return [];
  }
  return Array.isArray(parsed) ? parsed : [parsed];
}

// Validate PMIDs via PubMed HEAD request with a hard timeout so a slow or
// unreachable endpoint can't hang the whole pipeline. Off by default —
// enable with `VALIDATE_PMID=1 node ...`. When disabled, returned PMIDs
// are passed through unvalidated (still gated on `verified:false` until a
// human reviews).
const VALIDATE_PMID = process.env.VALIDATE_PMID === '1';
async function validatePmid(pmid) {
  if (!pmid) return false;
  if (!VALIDATE_PMID) return true; // trust; human review gate still applies
  try {
    const r = await fetch('https://pubmed.ncbi.nlm.nih.gov/' + encodeURIComponent(pmid) + '/', {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(5000),
    });
    return r.ok;
  } catch (e) {
    return false;
  }
}

async function main() {
  const questions = JSON.parse(readFileSync(INPUT, 'utf8'));
  let existing = [];
  if (existsSync(OUTPUT)) {
    existing = JSON.parse(readFileSync(OUTPUT, 'utf8'));
    console.log('Resuming — ' + existing.length + ' already enriched.');
  }
  const existingById = new Map(existing.map(q => [q.id, q]));

  let pool = questions.filter(q => !existingById.get(q.id)?.citation);
  if (PRIORITY_ONLY) pool = pool.filter(isPriority);
  pool = pool.slice(0, LIMIT);
  console.log('Enriching ' + pool.length + ' question(s) in batches of ' + BATCH);

  const result = existing.slice();
  const resultById = new Map(result.map(q => [q.id, q]));

  for (let i = 0; i < pool.length; i += BATCH) {
    const batch = pool.slice(i, i + BATCH);
    console.log('  batch ' + (i / BATCH + 1) + '/' + Math.ceil(pool.length / BATCH));
    const enriched = await enrichBatch(batch);
    const enrichedById = new Map(enriched.map(e => [e.id, e.citation]));

    for (const q of batch) {
      const citation = enrichedById.get(q.id);
      const out = { ...q };
      if (citation) {
        // Validate PMID before saving
        const pmidOk = await validatePmid(citation.pmid);
        if (!pmidOk) citation.pmid = null;
        citation.verified = false; // human must review
        out.citation = citation;
      }
      if (resultById.has(q.id)) {
        const idx = result.findIndex(r => r.id === q.id);
        result[idx] = out;
      } else {
        result.push(out);
        resultById.set(q.id, out);
      }
    }

    // Persist after every batch so we're always resumable.
    writeFileSync(OUTPUT, JSON.stringify(result, null, 2));
  }

  // Ensure every question (even unenriched) is present in the output so it's a
  // drop-in replacement for questions.merged.json.
  for (const q of questions) {
    if (!resultById.has(q.id)) result.push(q);
  }
  writeFileSync(OUTPUT, JSON.stringify(result, null, 2));

  const verified = result.filter(q => q.citation?.verified).length;
  const withCitation = result.filter(q => q.citation).length;
  console.log('\nDone.');
  console.log('  with citation: ' + withCitation + '/' + result.length);
  console.log('  human-verified: ' + verified);
  console.log('\nNext: run scripts/curate_cli.mjs to verify citations.');
}

main().catch(e => { console.error(e); process.exit(1); });
