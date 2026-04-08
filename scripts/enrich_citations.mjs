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
import Anthropic from '@anthropic-ai/sdk';

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
const client = new Anthropic();

const SYSTEM = `You are an endodontics literature expert. For each exam question, identify the single most relevant primary-literature citation (typically from Journal of Endodontics, International Endodontic Journal, Oral Surg Oral Med, Dental Traumatology, etc.).

Rules:
- If the explanation already names an author (e.g. "Sjögren et al"), anchor the citation to that author/study. Do NOT invent a different one.
- Classify "classic": seminal, widely-cited, still practice-defining (e.g. Sjögren 1990 on outcomes, Torabinejad on MTA, Ørstavik on healing).
- Classify "historic": older (>30 yrs), mostly superseded, but still appears in board reading lists (e.g. Kakehashi 1965, Möller 1981).
- Return strict JSON. Do NOT include prose outside the JSON.
- If you cannot identify a specific study with reasonable confidence, set pmid=null and leave fields you are unsure about as empty strings. NEVER fabricate a PMID. A human reviewer will verify every entry.
- Prefer the most cited / highest-impact study when multiple support the answer.
- "relevance" is one sentence explaining how this study supports the answer (the examiner wants to hear you cite this).`;

const USER_TEMPLATE = (items) => `Here are ${items.length} endo board questions. For EACH, return a JSON object with this exact shape:

{
  "id": "<echo the question id>",
  "citation": {
    "author": "<first author surname>",
    "coauthors": "<comma-separated other authors, or empty>",
    "year": <integer or null>,
    "title": "<full paper title>",
    "journal": "<journal abbreviation, e.g. J Endod>",
    "volume": "<string or empty>",
    "pages": "<start-end or empty>",
    "pmid": "<numeric string or null>",
    "classification": "classic" | "historic",
    "relevance": "<one sentence explaining why this study supports the answer>"
  }
}

Return ALL ${items.length} objects as a single JSON array, no prose, no markdown fences.

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
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    temperature: 0.2,
    system: SYSTEM,
    messages: [{ role: 'user', content: USER_TEMPLATE(batch) }],
  });
  const text = resp.content.map(c => c.type === 'text' ? c.text : '').join('');
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

// Validate PMIDs via PubMed HEAD request. Blanks any 404 and forces verified:false.
async function validatePmid(pmid) {
  if (!pmid) return false;
  try {
    const r = await fetch('https://pubmed.ncbi.nlm.nih.gov/' + encodeURIComponent(pmid) + '/', {
      method: 'HEAD',
      redirect: 'follow',
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
