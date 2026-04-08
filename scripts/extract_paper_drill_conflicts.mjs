#!/usr/bin/env node
// Extract the full list of questions where the citation author appears in the
// question stem. Writes to /tmp/paper_drill_conflicts.json for the rewriter.

import { readFileSync, writeFileSync } from 'node:fs';

const questions = JSON.parse(readFileSync('questions.enriched.json', 'utf8'));

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .trim();
}

const conflicts = [];

for (const q of questions) {
  if (!q.citation || !q.citation.verified) continue;
  const author = (q.citation.author || '').trim();
  if (!author) continue;

  const stemNorm = normalize(q.question);
  const authorNorm = normalize(author);

  if (stemNorm.includes(authorNorm)) {
    conflicts.push({
      id: q.id,
      chapter: q.chapter,
      author: q.citation.author,
      coauthors: q.citation.coauthors || '',
      question: q.question,
      correctAnswer: q.correctAnswer,
      options: q.options,
      explanation: q.explanation || '',
    });
  }
}

writeFileSync('/tmp/paper_drill_conflicts.json', JSON.stringify(conflicts, null, 2));
console.log(`Wrote ${conflicts.length} conflicts to /tmp/paper_drill_conflicts.json`);

// Quick pattern analysis
const patterns = {
  'According to X': 0,
  'Per X': 0,
  'X reported/showed/found': 0,
  'X et al': 0,
  'other': 0,
};

for (const c of conflicts) {
  const q = c.question.toLowerCase();
  const a = c.author.toLowerCase();
  if (new RegExp(`according to ${a}`, 'i').test(c.question)) patterns['According to X']++;
  else if (new RegExp(`per ${a}`, 'i').test(c.question)) patterns['Per X']++;
  else if (new RegExp(`${a} (reported|showed|found|demonstrated|recommends?)`, 'i').test(c.question)) patterns['X reported/showed/found']++;
  else if (new RegExp(`${a} et al`, 'i').test(c.question)) patterns['X et al']++;
  else patterns['other']++;
}

console.log('\nPattern distribution:');
for (const [k, v] of Object.entries(patterns)) {
  console.log(`  ${k}: ${v}`);
}
