#!/usr/bin/env node
// Dedupe + merge the cleaned 1,295-question set with the raw 1,860 superset.
// Output: questions.merged.json (master source) and a diff report.
//
// Dedupe key: normalized question text (lowercase, strip whitespace/punct,
// first 120 chars). On collision, prefer the cleaned entry.
//
// Run: node scripts/merge_questions.mjs

import { readFileSync, writeFileSync } from 'node:fs';

const CLEAN = 'endoboard_import_1300.json';
const SUPER = 'endoboard_all_questions.json';
const OUT   = 'questions.merged.json';

function norm(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 120);
}

function load(path) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(data)) throw new Error(path + ' is not an array');
  return data;
}

const clean = load(CLEAN);
const superset = load(SUPER);
console.log('loaded: clean=' + clean.length + '  super=' + superset.length);

const byKey = new Map();

// Seed with the clean set — these win on conflict.
for (const q of clean) {
  const k = norm(q.question);
  if (!k) continue;
  byKey.set(k, { source: 'clean', q });
}

let added = 0, collisions = 0;
for (const q of superset) {
  const k = norm(q.question);
  if (!k) continue;
  if (byKey.has(k)) {
    collisions++;
    continue;
  }
  byKey.set(k, { source: 'super', q });
  added++;
}

// Stable order: clean first (by original order), then newly added from super.
const merged = [];
for (const q of clean) {
  const k = norm(q.question);
  const entry = byKey.get(k);
  if (entry && entry.q === q) merged.push(q);
}
for (const q of superset) {
  const k = norm(q.question);
  const entry = byKey.get(k);
  if (entry && entry.source === 'super' && entry.q === q) merged.push(q);
}

writeFileSync(OUT, JSON.stringify(merged, null, 2));
console.log('');
console.log('merged:      ' + merged.length);
console.log('from clean:  ' + clean.length);
console.log('new from super: ' + added);
console.log('collisions (superset dupes dropped): ' + collisions);
console.log('wrote: ' + OUT);
