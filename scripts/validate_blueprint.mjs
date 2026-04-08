#!/usr/bin/env node
// Unit tests for blueprintSample() and the BLUEPRINT constant.
// Keep this file in sync with the implementation in index.html.
// Run: node scripts/validate_blueprint.mjs

// MUST stay in sync with BLUEPRINT in index.html
const BLUEPRINT = {
  1:  0.04, 2:  0.10, 3:  0.05, 4:  0.15, 5:  0.10,
  6:  0.15, 7:  0.03, 8:  0.18, 9:  0.08, 10: 0.04,
  11: 0.03, 12: 0.03, 13: 0.02,
};

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function blueprintSample(pool, count) {
  if (!pool.length || count <= 0) return [];
  if (pool.length <= count) { const c = pool.slice(); shuffleArray(c); return c; }

  const byChapter = {};
  pool.forEach(q => { (byChapter[q.chapter] = byChapter[q.chapter] || []).push(q); });

  const chapters = Object.keys(byChapter).map(Number);
  const weightSum = chapters.reduce((s, c) => s + (BLUEPRINT[c] || 0), 0) || 1;
  const targets = chapters.map(c => ({
    chapter: c,
    weight: (BLUEPRINT[c] || 0) / weightSum,
    available: byChapter[c].length,
  }));

  const raw = targets.map(t => {
    const want = t.weight * count;
    const cap  = Math.min(t.available, Math.ceil(want));
    return { ...t, want, floor: Math.min(t.available, Math.floor(want)), frac: want - Math.floor(want), cap };
  });
  let taken = raw.reduce((s, t) => s + t.floor, 0);
  raw.sort((a, b) => b.frac - a.frac);
  for (const t of raw) {
    if (taken >= count) break;
    if (t.floor < t.cap) { t.floor++; taken++; }
  }
  if (taken < count) {
    const overflow = raw.slice().sort((a, b) => (b.available - b.floor) - (a.available - a.floor));
    for (const t of overflow) {
      while (taken < count && t.floor < t.available) { t.floor++; taken++; }
    }
  }

  const out = [];
  raw.forEach(t => {
    const bucket = byChapter[t.chapter].slice();
    shuffleArray(bucket);
    out.push(...bucket.slice(0, t.floor));
  });
  shuffleArray(out);
  return out.slice(0, count);
}

let failed = 0;
function assert(name, cond, detail) {
  if (cond) console.log('  PASS ' + name);
  else { failed++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

console.log('\nBlueprint sampler tests\n');

// Test: BLUEPRINT sums to 1.0 within rounding
{
  const sum = Object.values(BLUEPRINT).reduce((s, v) => s + v, 0);
  assert('BLUEPRINT sums ~1.0', Math.abs(sum - 1.0) < 0.01, 'got ' + sum);
}

// Build a large balanced pool: 100 questions per chapter
function makePool(perCh) {
  const pool = [];
  for (let ch = 1; ch <= 13; ch++) {
    for (let i = 0; i < perCh; i++) {
      pool.push({ id: 'ch' + ch + '_q' + i, chapter: ch });
    }
  }
  return pool;
}

// Test: returns exactly `count` items
{
  const out = blueprintSample(makePool(100), 50);
  assert('sample size = 50', out.length === 50, 'got ' + out.length);
}
{
  const out = blueprintSample(makePool(100), 10);
  assert('sample size = 10', out.length === 10, 'got ' + out.length);
}

// Test: distribution roughly matches blueprint for a large sample
{
  const pool = makePool(200);
  const out = blueprintSample(pool, 100);
  const counts = {};
  out.forEach(q => counts[q.chapter] = (counts[q.chapter] || 0) + 1);
  let maxDev = 0;
  for (let ch = 1; ch <= 13; ch++) {
    const expected = Math.round(BLUEPRINT[ch] * 100);
    const got = counts[ch] || 0;
    maxDev = Math.max(maxDev, Math.abs(got - expected));
  }
  // Tolerance 2 because largest-remainder rounding may over/underfill by 1.
  assert('each chapter within ±2 of expected', maxDev <= 2, 'max deviation ' + maxDev);
}

// Test: matches blueprint exactly for a 100-question sample
{
  const pool = makePool(200);
  const out = blueprintSample(pool, 100);
  assert('Treatment (18%) has ~18', out.filter(q => q.chapter === 8).length >= 16 && out.filter(q => q.chapter === 8).length <= 20);
  assert('Pathology (15%) has ~15', out.filter(q => q.chapter === 4).length >= 13 && out.filter(q => q.chapter === 4).length <= 17);
  assert('Diagnosis (15%) has ~15', out.filter(q => q.chapter === 6).length >= 13 && out.filter(q => q.chapter === 6).length <= 17);
  assert('Microbiology (10%) has ~10', out.filter(q => q.chapter === 2).length >= 8 && out.filter(q => q.chapter === 2).length <= 12);
  assert('Complications (2%) has ~2', out.filter(q => q.chapter === 13).length >= 1 && out.filter(q => q.chapter === 13).length <= 3);
}

// Test: handles pool smaller than count
{
  const pool = makePool(1);  // only 13 questions total
  const out = blueprintSample(pool, 50);
  assert('returns all when pool < count', out.length === 13);
}

// Test: handles chapter with very few available questions
{
  // Only 1 question in Treatment, plenty elsewhere
  const pool = [
    { id: 'ch8_only', chapter: 8 },
    ...Array.from({length: 50}, (_, i) => ({ id: 'ch6_' + i, chapter: 6 })),
    ...Array.from({length: 50}, (_, i) => ({ id: 'ch4_' + i, chapter: 4 })),
  ];
  const out = blueprintSample(pool, 20);
  assert('respects low availability (Tx=1)', out.filter(q => q.chapter === 8).length === 1);
  assert('fills remainder from other chapters', out.length === 20);
}

// Test: empty pool → empty result
{
  assert('empty pool', blueprintSample([], 10).length === 0);
}

// Test: count=0 → empty result
{
  assert('count 0', blueprintSample(makePool(10), 0).length === 0);
}

// Test: no duplicate selections
{
  const out = blueprintSample(makePool(50), 50);
  const ids = new Set(out.map(q => q.id));
  assert('no duplicates', ids.size === out.length);
}

// Test: restricted pool (user picked only 2 chapters) renormalizes properly
// NOTE: in production we DON'T call blueprintSample when user picks chapters,
// but the helper should still behave sanely if called with a filtered pool.
{
  const pool = [
    ...Array.from({length: 50}, (_, i) => ({ id: 'ch8_' + i, chapter: 8 })),
    ...Array.from({length: 50}, (_, i) => ({ id: 'ch6_' + i, chapter: 6 })),
  ];
  const out = blueprintSample(pool, 20);
  // 8:0.20, 6:0.15  → renormalized 8=0.571, 6=0.428 → ~11.4 vs ~8.6
  const tx = out.filter(q => q.chapter === 8).length;
  const dx = out.filter(q => q.chapter === 6).length;
  assert('Tx gets more than Dx when renormalized (Tx>Dx)', tx > dx, 'tx=' + tx + ' dx=' + dx);
  assert('filtered sample totals to count', out.length === 20);
}

console.log('');
if (failed === 0) { console.log('All tests passed.'); process.exit(0); }
else { console.log(failed + ' test(s) FAILED.'); process.exit(1); }
