#!/usr/bin/env node
// Rebuild questions.js from whichever question file is current.
// Preference order:  questions.enriched.json > questions.merged.json > endoboard_import_1300.json
//
// Run: npm run questions:rebuild

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CANDIDATES = [
  'questions.enriched.json',
  'questions.merged.json',
  'endoboard_import_1300.json',
];

const src = CANDIDATES.find(existsSync);
if (!src) { console.error('no question source file found'); process.exit(1); }

const data = JSON.parse(readFileSync(src, 'utf8'));
writeFileSync('questions.js', 'window.QUESTIONS = ' + JSON.stringify(data) + ';\n');
console.log('rebuilt questions.js from ' + src + ' (' + data.length + ' questions)');
