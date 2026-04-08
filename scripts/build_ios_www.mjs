#!/usr/bin/env node
// Copy the canonical web assets into www/ so Capacitor can bundle them.
// Run: npm run build:ios
//
// We keep index.html + questions.js at the repo root so the existing
// `python3 -m http.server` dev workflow still works. This script is the
// single source of truth for what ships inside the iOS bundle.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const FILES = [
  'index.html',
  'questions.js',
];

mkdirSync('www', { recursive: true });

for (const f of FILES) {
  if (!existsSync(f)) {
    console.error('missing: ' + f);
    process.exit(1);
  }
  const body = readFileSync(f);
  const dest = 'www/' + f;
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, body);
  console.log('copied ' + f + ' -> ' + dest + ' (' + body.length + ' bytes)');
}

// Prefer the enriched question bank if it exists (has citations), otherwise
// use the merged master. Ship a fresh questions.js rebuilt from whatever is
// newest so iOS gets the freshest content.
if (existsSync('questions.enriched.json')) {
  const data = JSON.parse(readFileSync('questions.enriched.json', 'utf8'));
  const body = 'window.QUESTIONS = ' + JSON.stringify(data) + ';\n';
  writeFileSync('www/questions.js', body);
  console.log('overrode www/questions.js with enriched set (' + data.length + ' questions)');
}

console.log('\nwww/ is ready for `npx cap sync ios`.');
