#!/usr/bin/env node
// Set the unlock password for the EndoBoard password gate.
//
// Usage: node scripts/set_password.mjs <newpassword>
//
// This hashes the password with SHA-256 and writes it into index.html as the
// PW_HASH constant. Commit + push afterward to take effect on GitHub Pages.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const pw = process.argv[2];
if (!pw || pw.length < 1) {
  console.error('Usage: node scripts/set_password.mjs <newpassword>');
  process.exit(1);
}

const hash = createHash('sha256').update(pw).digest('hex');
const html = readFileSync('index.html', 'utf8');

const lineRe = /const PW_HASH = '[a-f0-9]{64}';/;
if (!lineRe.test(html)) {
  console.error('ERROR: Could not find PW_HASH line in index.html');
  process.exit(1);
}

const updated = html.replace(lineRe, `const PW_HASH = '${hash}';`);
writeFileSync('index.html', updated);

console.log(`Password updated.`);
console.log(`SHA-256: ${hash}`);
console.log(`\nNext steps:`);
console.log(`  1. Clear your unlock cookie so you can test:`);
console.log(`     localStorage.removeItem('endoboard_pwUnlocked_v1') in your browser console`);
console.log(`  2. git add index.html && git commit -m "Update password" && git push`);
