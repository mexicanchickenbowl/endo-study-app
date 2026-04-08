#!/usr/bin/env node
// Auto-verify citations whose `author` field appears literally in the
// question's explanation text. This is a mechanical cross-check, not a
// guess: if the explanation says "Sjögren et al" and the citation author
// is "Sjögren", the binding is trustworthy — the rest of the citation
// (year, title, PMID) may be empty or low-confidence, but the author is
// correct and that's what the Name the Paper drill grades on.
//
// Any citation whose author is NOT present in the explanation stays
// `verified: false` and must be human-reviewed via curate_cli.mjs.
//
// Run: node scripts/auto_verify_citations.mjs
// Safe to re-run; idempotent.

import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'questions.enriched.json';

function normalize(s) {
  return (s || '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .toLowerCase();
}

const data = JSON.parse(readFileSync(FILE, 'utf8'));
let total = 0, verified = 0, skipped = 0, alreadyVerified = 0;

for (const q of data) {
  if (!q.citation) continue;
  total++;
  if (q.citation.verified) { alreadyVerified++; continue; }
  const author = normalize(q.citation.author || '').trim();
  const explanation = normalize(q.explanation || '');
  if (!author) { skipped++; continue; }
  // Require at least 4 chars so a short surname doesn't false-match.
  if (author.length < 4) { skipped++; continue; }
  if (explanation.includes(author)) {
    q.citation.verified = true;
    verified++;
  } else {
    skipped++;
  }
}

writeFileSync(FILE, JSON.stringify(data, null, 2));
console.log('citations total:        ' + total);
console.log('  already verified:     ' + alreadyVerified);
console.log('  auto-verified now:    ' + verified);
console.log('  left unverified:      ' + skipped);
console.log('wrote ' + FILE);
