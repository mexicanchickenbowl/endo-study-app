#!/usr/bin/env node
// Rewrite question stems that leak the author name, so the "Name the Paper"
// drill stops being trivial. Rule-based: the patterns are remarkably clean
// (121 "According to X..." + 48 "X et al found/reported..." + 1 other edge
// case), so we handle all of them deterministically without an LLM.
//
// Input: questions.enriched.json
// Output: questions.enriched.json (in place, with .bak backup)
// Report: /tmp/rewrite_report.json
//
// Run: node scripts/rewrite_paper_drill_stems.mjs [--dry-run]

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';

const DRY_RUN = process.argv.includes('--dry-run');
const INPUT = 'questions.enriched.json';
const BACKUP = 'questions.enriched.json.bak';

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^\w\s]/g, '').trim();
}

function authorInStem(stem, author) {
  return normalize(stem).includes(normalize(author));
}

// Capitalize the first letter of a sentence after removing a prefix
function recap(s) {
  if (!s) return s;
  s = s.trim();
  // Capitalize first letter if it's a lowercase word start
  if (s.length > 0 && /[a-z]/.test(s[0])) {
    s = s[0].toUpperCase() + s.slice(1);
  }
  return s;
}

// Fix subject-verb agreement after replacing "X et al" (plural) with
// "research" (singular). Applies only to a small set of present-tense verbs
// that change form; past-tense verbs (found, reported, showed) are unaffected.
function fixVerbAgreement(s) {
  return s
    .replace(/\bresearch\s+recommend\b/gi, 'research recommends')
    .replace(/\bResearch\s+recommend\b/g, 'Research recommends')
    .replace(/\bresearch\s+advocate\b/gi, 'research advocates')
    .replace(/\bResearch\s+advocate\b/g, 'Research advocates');
}

// Escape a string for use in a regex
function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build patterns to match an author's surname, tolerant of accent variations
// (we still match on the literal string from the citation, but also handle
// "Sjögren" vs "Sjogren" by letting the user's question choose its own form)
function authorVariants(author) {
  if (!author) return [];
  const variants = new Set();
  variants.add(author);
  // Common accent stripping (only applies if the author has diacritics)
  const stripped = author.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (stripped !== author) variants.add(stripped);
  return [...variants];
}

function tryRewrite(stem, author, coauthors) {
  const originalStem = stem;
  const variants = authorVariants(author);
  const coauthorVariants = coauthors ? authorVariants(coauthors.split(/[,\s]+/)[0] || '') : [];

  // Build a broad author token that can match "Author", "Author et al",
  // "Author and Coauthor", "Author and Coauthor et al", plus optional
  // trailing "(YEAR)" and possessive "'s"
  for (const v of variants) {
    const a = esc(v);
    const coPattern = coauthorVariants.length > 0
      ? `(?:\\s+(?:and|&)\\s+${esc(coauthorVariants[0])})?`
      : `(?:\\s+(?:and|&)\\s+[A-Z][a-zA-ZÀ-ÿ'-]+(?:\\s+et\\s+al\\.?)?)?`;
    const etAl = `(?:\\s+et\\s+al\\.?)?`;
    // Year: matches (2018), (2018c), (2016, 2017b), etc.
    const year = `(?:\\s*\\(\\d{4}[a-z]?(?:\\s*,\\s*\\d{4}[a-z]?)*\\))?`;
    const possessive = `(?:'s)?`;
    const authorToken = `${a}${coPattern}${etAl}${year}${possessive}`;

    // Verbs used in "<author> <verb>..." and passive-voice rewrites
    const verbs = '(found|reported|showed|demonstrated|recommend|recommends|recommended|described|discovered|observed|noted|associated|discredited|established|confirmed|identified|concluded|debunked|equated|suggested|proposed|advocated|advocate|determined|indicated)';
    let r;

    // Rule 1a: "According to [modifier] by <author>['s possessive], " → "According to [modifier], "
    //   "According to a systematic review by X et al, what..." → "According to a systematic review, what..."
    r = new RegExp(
      `^(According\\s+to\\s+[^,]+?)\\s+by\\s+${authorToken}(,\\s*)`,
      'i'
    );
    if (r.test(stem)) {
      stem = stem.replace(r, '$1$2');
      if (!authorInStem(stem, author)) return { stem, rule: '1a' };
    }

    // Rule 1b: "According to <author>, <rest>" → "<Rest>"
    r = new RegExp(`^According\\s+to\\s+${authorToken}\\s*,\\s*`, 'i');
    if (r.test(stem)) {
      stem = recap(stem.replace(r, ''));
      if (!authorInStem(stem, author)) return { stem, rule: '1b' };
    }

    // Rule 1c: "According to <author> using X, <rest>" → "Using X, <rest>"
    r = new RegExp(`^According\\s+to\\s+${authorToken}\\s+(using|in|from)\\s+`, 'i');
    if (r.test(stem)) {
      stem = recap(stem.replace(r, '$1 '));
      if (!authorInStem(stem, author)) return { stem, rule: '1c' };
    }

    // Rule 1d: "According to <author>'s <noun>, <rest>" → "According to a recent <noun>, <rest>"
    //   "According to De Toledo et al's systematic review, what..." → "According to a recent systematic review, what..."
    r = new RegExp(`^According\\s+to\\s+${a}${coPattern}${etAl}${year}'s\\s+(\\w[\\w\\s-]*?),`, 'i');
    if (r.test(stem)) {
      stem = stem.replace(r, (m, noun) => `According to a recent ${noun},`);
      if (!authorInStem(stem, author)) return { stem, rule: '1d' };
    }

    // Rule 2: ", according to <author>?" as suffix (with optional trailing ?)
    //   "What percentage..., according to Shuttleworth et al?" → "What percentage...?"
    r = new RegExp(`,?\\s*according\\s+to\\s+${authorToken}\\s*([?.!:])?$`, 'i');
    if (r.test(stem)) {
      stem = stem.replace(r, '$1');
      if (!authorInStem(stem, author)) return { stem, rule: '2' };
    }

    // Rule 3: "in a study/review/etc. by <author>" → "in a study/review/etc."
    r = new RegExp(`\\s+by\\s+${authorToken}\\b`, 'i');
    if (r.test(stem)) {
      stem = stem.replace(r, '');
      if (!authorInStem(stem, author)) return { stem, rule: '3' };
    }

    // Rule 4: Sentence-start "<author> <verb>..."
    //   "Stojicic et al found that..." → "Research found that..."
    //   "Owatz et al equated..." → "Research equated..."
    r = new RegExp(`^${authorToken}\\s+${verbs}\\b`, 'i');
    if (r.test(stem)) {
      stem = stem.replace(r, (match, ...groups) => {
        const verb = groups.find(g => g && new RegExp(`^${verbs}$`, 'i').test(g));
        return `Research ${verb.toLowerCase()}`;
      });
      if (!authorInStem(stem, author)) return { stem, rule: '4' };
    }

    // Rule 4b: Sentence-start "<author> (YEAR) <verb>..."
    //   "Ricucci et al (2014) found that..." → "Research found that..."
    //   (the year is already consumed by authorToken, but verb must match)
    r = new RegExp(`^${a}${coPattern}${etAl}\\s*\\(\\d{4}\\)\\s+${verbs}\\b`, 'i');
    if (r.test(stem)) {
      stem = stem.replace(r, (match, ...groups) => {
        const verb = groups.find(g => g && new RegExp(`^${verbs}$`, 'i').test(g));
        return `Research ${verb.toLowerCase()}`;
      });
      if (!authorInStem(stem, author)) return { stem, rule: '4b' };
    }

    // Rule 5: "For X, <author> <verb>:" → "For X, research <verb>:"
    r = new RegExp(`(,\\s+)${authorToken}\\s+${verbs}(\\b|[:])`, 'i');
    if (r.test(stem)) {
      stem = stem.replace(r, (m, p1, ...rest) => {
        const verb = rest.find(g => g && new RegExp(`^${verbs}$`, 'i').test(g));
        const tail = rest[rest.length - 3] || '';
        return `${p1}research ${verb.toLowerCase()}${tail}`;
      });
      if (!authorInStem(stem, author)) return { stem, rule: '5' };
    }

    // Rule 6: "X was described/found by <author>" → "X was described/found"
    r = new RegExp(`\\s+(described|reported|identified|found|associated|discovered|proposed|suggested)\\s+by\\s+${authorToken}`, 'i');
    if (r.test(stem)) {
      stem = stem.replace(r, ' $1');
      if (!authorInStem(stem, author)) return { stem, rule: '6' };
    }

    // Rule 7: "The seminal study by <author>" → "A seminal study"
    r = new RegExp(`\\bThe\\s+(seminal|classic|landmark|famous)\\s+(study|paper|trial)\\s+by\\s+${authorToken}`, 'i');
    if (r.test(stem)) {
      stem = stem.replace(r, 'A $1 $2');
      if (!authorInStem(stem, author)) return { stem, rule: '7' };
    }

    // Rule 7b: "did <author> and <other> find" where other is another author.
    //   Strip the whole chain and just say "research". (Must run before Rule 8
    //   which would otherwise consume "did Clark-Holke et al and" and leave
    //   "Drake et al" behind.)
    r = new RegExp(`\\bdid\\s+${a}${etAl}\\s+and\\s+[A-Z][a-zA-ZÀ-ÿ'-]+(?:\\s+et\\s+al\\.?)?\\s+`, 'i');
    if (r.test(stem)) {
      stem = stem.replace(r, 'did research ');
      if (!authorInStem(stem, author)) return { stem, rule: '7b' };
    }

    // Rule 8: "did <author> <verb>" → "did research <verb>"
    //   "What concentration did Hand et al find..." → "What concentration did research find..."
    //   Require the next token to not be "and" (chain — handled by Rule 7b).
    r = new RegExp(`\\bdid\\s+${authorToken}\\s+(?!and\\b)(\\w+)`, 'i');
    if (r.test(stem)) {
      stem = stem.replace(r, 'did research $1');
      if (!authorInStem(stem, author)) return { stem, rule: '8' };
    }

    // Rule 12: "According to <author> and <otherAuthor> et al, <rest>"
    //   Multi-author chain: the citation author is the FIRST in the chain.
    r = new RegExp(`^According\\s+to\\s+${a}${etAl}${year}\\s+and\\s+[A-Z][a-zA-ZÀ-ÿ'-]+(?:\\s+et\\s+al\\.?)?${year},\\s*`, 'i');
    if (r.test(stem)) {
      stem = recap(stem.replace(r, ''));
      if (!authorInStem(stem, author)) return { stem, rule: '12' };
    }

    // Rule 12b: "According to <firstAuthor> et al and <author> et al, <rest>"
    //   Multi-author chain: the citation author is the SECOND in the chain.
    r = new RegExp(`^According\\s+to\\s+[A-Z][a-zA-ZÀ-ÿ'-]+(?:\\s+et\\s+al\\.?)?${year}\\s+and\\s+${a}${etAl}${year},\\s*`, 'i');
    if (r.test(stem)) {
      stem = recap(stem.replace(r, ''));
      if (!authorInStem(stem, author)) return { stem, rule: '12b' };
    }

    // Rule 13: Sentence-start "<author>'s <noun> <verb>..."
    //   "Souza et al's meta-analysis reported what..." → "A meta-analysis reported what..."
    r = new RegExp(`^${a}${coPattern}${etAl}${year}'s\\s+([\\w-]+(?:\\s+[\\w-]+)?)\\s+${verbs}\\b`, 'i');
    if (r.test(stem)) {
      stem = stem.replace(r, (match, noun, verb) => `A ${noun} ${verb.toLowerCase()}`);
      if (!authorInStem(stem, author)) return { stem, rule: '13' };
    }

    // Rule 14: Sentence-start "<author>'s (YEAR) <noun> <rest>"
    //   "Patel et al's (2018b) 3D classification of ECR includes..."
    //   → "The 3D classification of ECR includes..."
    //   Year may appear either before OR after the possessive 's.
    r = new RegExp(`^${a}${coPattern}${etAl}${year}'s${year}\\s+`, 'i');
    if (r.test(stem)) {
      stem = stem.replace(r, 'The ');
      if (!authorInStem(stem, author)) return { stem, rule: '14' };
    }

    // Rule 15: Mid-sentence possessive "in <author>'s <noun>"
    //   "in Patel et al's 3D classification" → "in the 3D classification"
    //   "in X et al's 3D system" → "in the 3D system"
    r = new RegExp(`\\b(in|by|from|per)\\s+${a}${coPattern}${etAl}${year}'s\\s+`, 'i');
    if (r.test(stem)) {
      stem = stem.replace(r, '$1 the ');
      if (!authorInStem(stem, author)) return { stem, rule: '15' };
    }

    // Rule 16: "according to <author>'s <noun>" suffix (with ?)
    //   "...according to Uzun et al's large-scale retrospective study?"
    //   → "...from a large-scale retrospective study?"
    r = new RegExp(`\\s*according\\s+to\\s+${a}${coPattern}${etAl}${year}'s\\s+([\\w\\s-]+?)([?.!]?)$`, 'i');
    if (r.test(stem)) {
      stem = stem.replace(r, ' from a $1$2');
      if (!authorInStem(stem, author)) return { stem, rule: '16' };
    }

    // Rule 17: Dangling "from <author>" at end (no "according to")
    //   "...supported by recent data from Kahler et al?" → "...supported by recent data?"
    r = new RegExp(`\\s+from\\s+${authorToken}\\s*([?.!]?)$`, 'i');
    if (r.test(stem)) {
      stem = stem.replace(r, '$1');
      if (!authorInStem(stem, author)) return { stem, rule: '17' };
    }

    // Rule 18: Sentence-start "<author> (YEAR) VERB" with suffixed year
    //   Already covered by Rule 4 since year is now in authorToken.

    // Rule 19: "According to <author>(year), <rest>" with weird year patterns
    //   Already covered by Rule 1b via the new year pattern.

    // Rule 20: "What ... did <author>(year) VERB..."
    //   "What protective structure did Patel et al (2018c) identify..."
    //   → "What protective structure did research identify..."
    //   (Already covered by Rule 8 via updated year pattern.)
  }

  // Fallback: generic author stripping — find the author surname anywhere
  // and remove a surrounding natural clause. This is a last resort.
  for (const v of variants) {
    const a = esc(v);
    // Remove "<author> et al" as a bare phrase (with nearby commas)
    let r = new RegExp(`\\s*,?\\s*\\b${a}(?:\\s+(?:and|&)\\s+[A-Z][a-zA-ZÀ-ÿ'-]+)?(?:\\s+et\\s+al\\.?)?\\s*,?\\s*`, 'i');
    if (r.test(stem)) {
      stem = stem.replace(r, ' ').replace(/\s+/g, ' ').replace(/\s+([?.!:,])/g, '$1').trim();
      stem = recap(stem);
      if (!authorInStem(stem, author)) return { stem, rule: 'fallback' };
    }
  }

  return { stem: originalStem, rule: null };
}

// ────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────

const questions = JSON.parse(readFileSync(INPUT, 'utf8'));
const report = {
  total: 0,
  rewritten: 0,
  failed: 0,
  ruleCounts: {},
  failures: [],
  rewrites: [],
};

for (const q of questions) {
  if (!q.citation || !q.citation.verified) continue;
  const author = (q.citation.author || '').trim();
  if (!author) continue;
  if (!authorInStem(q.question, author)) continue;

  report.total++;
  let { stem, rule } = tryRewrite(q.question, author, q.citation.coauthors || '');
  stem = fixVerbAgreement(stem);

  if (rule && stem !== q.question && !authorInStem(stem, author)) {
    report.rewritten++;
    report.ruleCounts[rule] = (report.ruleCounts[rule] || 0) + 1;
    report.rewrites.push({
      id: q.id,
      author,
      rule,
      before: q.question,
      after: stem,
    });
    if (!DRY_RUN) q.question = stem;
  } else {
    report.failed++;
    report.failures.push({
      id: q.id,
      author,
      question: q.question,
    });
  }
}

writeFileSync('/tmp/rewrite_report.json', JSON.stringify(report, null, 2));

console.log(`\nRewrite Report`);
console.log(`  Total conflicts:   ${report.total}`);
console.log(`  Rewritten:         ${report.rewritten}`);
console.log(`  Failed:            ${report.failed}`);
console.log(`\nRule distribution:`);
for (const [rule, count] of Object.entries(report.ruleCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  Rule ${rule}: ${count}`);
}

if (report.failures.length > 0) {
  console.log(`\nFailures (need manual review):`);
  report.failures.slice(0, 10).forEach(f => {
    console.log(`  [${f.author}] ${f.question}`);
  });
}

if (DRY_RUN) {
  console.log(`\nDRY RUN — no file changes made.`);
  console.log(`See /tmp/rewrite_report.json for full report.`);
} else {
  if (!existsSync(BACKUP)) {
    copyFileSync(INPUT, BACKUP);
    console.log(`\nBackup created: ${BACKUP}`);
  }
  writeFileSync(INPUT, JSON.stringify(questions, null, 2));
  console.log(`\nWrote ${questions.length} questions to ${INPUT}`);
}
