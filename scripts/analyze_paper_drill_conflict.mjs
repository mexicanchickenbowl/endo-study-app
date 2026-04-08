#!/usr/bin/env node
// Analyze how many questions in the paper drill pool have the author's name
// already visible in the question stem. This reveals how many "Name the Paper"
// questions are actually trivial (answer is already on screen).
//
// Run: node scripts/analyze_paper_drill_conflict.mjs

import { readFileSync } from 'node:fs';

const questions = JSON.parse(readFileSync('questions.enriched.json', 'utf8'));

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')  // strip punctuation
    .trim();
}

let total = 0, authorInStem = 0, noAuthor = 0, unverified = 0;
const conflicts = [];

for (const q of questions) {
  if (!q.citation || !q.citation.verified) {
    if (q.citation && !q.citation.verified) unverified++;
    continue;
  }

  total++;
  const author = (q.citation.author || '').trim();
  if (!author) {
    noAuthor++;
    continue;
  }

  const stemNorm = normalize(q.question);
  const authorNorm = normalize(author);

  // Check if author (or surname fragment) appears in question stem
  if (stemNorm.includes(authorNorm)) {
    authorInStem++;
    conflicts.push({
      id: q.id,
      author: q.citation.author,
      question: q.question.substring(0, 80),
    });
  }
}

console.log(`\nName the Paper Drill Analysis\n`);
console.log(`Total verified citations:              ${total}`);
console.log(`  Author appears in question stem:     ${authorInStem} (${(100*authorInStem/total).toFixed(1)}%)`);
console.log(`  Author NOT in stem (usable drills):  ${total - authorInStem - noAuthor} (${(100*(total - authorInStem - noAuthor)/total).toFixed(1)}%)`);
console.log(`  Missing author field:                ${noAuthor}`);
console.log(`Unverified citations (not in pool):    ${unverified}`);

if (conflicts.length > 0) {
  console.log(`\nFirst 20 conflicts (author already in question stem):\n`);
  conflicts.slice(0, 20).forEach((c, i) => {
    console.log(`${i+1}. ${c.author}`);
    console.log(`   ${c.question}...`);
  });
  if (conflicts.length > 20) {
    console.log(`\n... and ${conflicts.length - 20} more`);
  }
}
