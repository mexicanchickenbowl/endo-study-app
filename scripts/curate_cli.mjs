#!/usr/bin/env node
// Interactive citation review.
//
// Walks every unverified citation in questions.enriched.json. For each:
//   y — mark verified (renders in app)
//   n — delete citation
//   e — open current JSON in $EDITOR for manual editing
//   s — skip for now
//   q — quit and save progress
//
// Run: node scripts/curate_cli.mjs
//      node scripts/curate_cli.mjs --file questions.enriched.json
//      node scripts/curate_cli.mjs --priority    # only questions that name an author
//
// NOTE: never flips verified=true programmatically. Humans only.

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
const fileArg = args.indexOf('--file');
const FILE = fileArg >= 0 ? args[fileArg + 1] : 'questions.enriched.json';
const PRIORITY_ONLY = args.includes('--priority');

const data = JSON.parse(readFileSync(FILE, 'utf8'));
console.log('Loaded ' + data.length + ' questions from ' + FILE);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(res => rl.question(q, res));

function priority(q) {
  return /[A-Z][a-zéöø]+\s+et\s+al/i.test(q.explanation || '');
}

let queue = data
  .map((q, i) => ({q, i}))
  .filter(({q}) => q.citation && !q.citation.verified);
if (PRIORITY_ONLY) queue = queue.filter(({q}) => priority(q));

console.log('Review queue: ' + queue.length + ' unverified citation(s)\n');

let verified = 0, deleted = 0, skipped = 0, edited = 0;

function bold(s)  { return '\x1b[1m' + s + '\x1b[0m'; }
function dim(s)   { return '\x1b[2m' + s + '\x1b[0m'; }
function green(s) { return '\x1b[32m' + s + '\x1b[0m'; }
function red(s)   { return '\x1b[31m' + s + '\x1b[0m'; }
function cyan(s)  { return '\x1b[36m' + s + '\x1b[0m'; }

function printEntry({q}, pos, total) {
  const c = q.citation;
  console.log('\n' + dim('─'.repeat(72)));
  console.log(cyan('[' + pos + '/' + total + '] ' + q.id + '  ch' + q.chapter + ' — ' + q.chapterTitle));
  console.log('');
  console.log(bold('Q: ') + q.question);
  console.log(dim('Answer ') + (q.answer || q.correctAnswer) + ': ' + (q.options?.find(o => o.letter === (q.answer || q.correctAnswer))?.text || ''));
  console.log(dim('Explanation: ') + (q.explanation || '').slice(0, 300));
  console.log('');
  console.log(bold('Proposed citation:'));
  console.log('  ' + (c.author || '?') + (c.coauthors ? ', ' + c.coauthors : '') + (c.year ? ' (' + c.year + ')' : ''));
  console.log('  ' + (c.title || '?'));
  console.log('  ' + (c.journal || '?') + (c.volume ? ' ' + c.volume : '') + (c.pages ? ':' + c.pages : ''));
  console.log('  PMID: ' + (c.pmid || dim('none')));
  console.log('  Class: ' + (c.classification === 'historic' ? red(c.classification) : green(c.classification)));
  console.log('  Relevance: ' + (c.relevance || dim('—')));
}

function save() {
  writeFileSync(FILE, JSON.stringify(data, null, 2));
}

async function editJson(entry) {
  const editor = process.env.EDITOR || 'vi';
  const tmp = join(tmpdir(), 'endo_citation_' + entry.q.id + '.json');
  writeFileSync(tmp, JSON.stringify(entry.q.citation, null, 2));
  const r = spawnSync(editor, [tmp], { stdio: 'inherit' });
  if (r.status !== 0) { console.log(red('editor exited non-zero — ignoring edit')); return; }
  try {
    entry.q.citation = JSON.parse(readFileSync(tmp, 'utf8'));
    console.log(green('edited OK'));
  } catch (e) {
    console.log(red('invalid JSON, edit discarded: ' + e.message));
  }
}

(async () => {
  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i];
    printEntry(entry, i + 1, queue.length);
    const ans = (await ask('\n[y]es / [n]o / [e]dit / [s]kip / [q]uit > ')).trim().toLowerCase();
    if (ans === 'y') {
      entry.q.citation.verified = true;
      verified++;
      save();
    } else if (ans === 'n') {
      delete entry.q.citation;
      deleted++;
      save();
    } else if (ans === 'e') {
      await editJson(entry);
      edited++;
      // After edit, re-prompt for verify on the same card.
      i--;
    } else if (ans === 'q') {
      break;
    } else {
      skipped++;
    }
  }

  save();
  rl.close();
  console.log('\n' + bold('Session summary'));
  console.log('  verified: ' + verified);
  console.log('  deleted:  ' + deleted);
  console.log('  edited:   ' + edited);
  console.log('  skipped:  ' + skipped);
  console.log('  saved to: ' + FILE);
})();
