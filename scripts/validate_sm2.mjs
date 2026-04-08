#!/usr/bin/env node
// Unit tests for the SM-2 scheduler used in index.html.
// Keep this file in sync with the `applySM2` function in index.html.
// Run: node scripts/validate_sm2.mjs

const SM2_DEFAULTS = {ease: 2.5, interval: 0, repetitions: 0, dueDate: 0, lastGrade: null};

function applySM2(h, grade) {
  if (h.ease === undefined) Object.assign(h, SM2_DEFAULTS);
  if (grade < 3) {
    h.repetitions = 0;
    h.interval = 1;
  } else {
    h.repetitions = (h.repetitions || 0) + 1;
    if (h.repetitions === 1)      h.interval = 1;
    else if (h.repetitions === 2) h.interval = 6;
    else                          h.interval = Math.round(h.interval * h.ease);
  }
  h.ease = Math.max(1.3, h.ease + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02)));
  h.dueDate = Date.now() + h.interval * 86400000;
  h.lastGrade = grade;
  return h;
}

let failed = 0;
function assert(name, cond, detail) {
  if (cond) {
    console.log('  PASS ' + name);
  } else {
    failed++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}

console.log('\nSM-2 scheduler tests\n');

// Test 1: a fresh card graded [5,5,5] goes 1 -> 6 -> ~15 days
{
  const h = {attempts: 0, correct: 0, lastSeen: 0, ...SM2_DEFAULTS};
  applySM2(h, 5);
  assert('fresh+5 gives interval 1', h.interval === 1, 'got ' + h.interval);
  applySM2(h, 5);
  assert('second +5 gives interval 6', h.interval === 6, 'got ' + h.interval);
  applySM2(h, 5);
  // ease grows to 2.6 on grade-5, so interval = round(6 * 2.6) = 16
  assert('third +5 gives interval ~15-16', h.interval >= 14 && h.interval <= 17, 'got ' + h.interval);
  assert('ease stays >= 1.3', h.ease >= 1.3, 'got ' + h.ease);
}

// Test 2: failing a card (grade 2) resets reps and sets interval 1
{
  const h = {attempts: 5, correct: 5, lastSeen: 0, ease: 2.8, interval: 20, repetitions: 4, dueDate: 0, lastGrade: 5};
  applySM2(h, 2);
  assert('failed card resets reps', h.repetitions === 0);
  assert('failed card resets interval to 1', h.interval === 1);
  assert('failed card reduces ease', h.ease < 2.8);
}

// Test 3: the plan's canonical grade sequence [5,5,5,2,4,4]
{
  const h = {attempts: 0, correct: 0, lastSeen: 0, ...SM2_DEFAULTS};
  const intervals = [];
  [5, 5, 5, 2, 4, 4].forEach(g => { applySM2(h, g); intervals.push(h.interval); });
  console.log('  intervals after [5,5,5,2,4,4] =', intervals);
  // Expected shape: [1, 6, ~16, 1, 1, 6]
  // (after fail at step 4 reps=0 interval=1; step 5 grade 4 reps=1 interval=1; step 6 grade 4 reps=2 interval=6)
  assert('step 1 interval = 1', intervals[0] === 1);
  assert('step 2 interval = 6', intervals[1] === 6);
  assert('step 3 interval ~= 15-17', intervals[2] >= 14 && intervals[2] <= 17);
  assert('step 4 fail reset = 1', intervals[3] === 1);
  assert('step 5 pass reps=1 -> 1', intervals[4] === 1);
  assert('step 6 pass reps=2 -> 6', intervals[5] === 6);
  assert('ease floor 1.3 respected', h.ease >= 1.3);
}

// Test 4: ease never falls below 1.3 under repeated grade-2 failures
{
  const h = {attempts: 0, correct: 0, lastSeen: 0, ...SM2_DEFAULTS};
  for (let i = 0; i < 50; i++) applySM2(h, 2);
  assert('ease clamped at 1.3 after 50 failures', h.ease === 1.3, 'got ' + h.ease);
}

// Test 5: getDueQuestions boundary — a card due 1ms ago must be due
{
  const now = Date.now();
  const progress = { questionHistory: {
    'a': {ease:2.5,interval:1,repetitions:1,dueDate: now - 1, attempts:1, correct:1, lastSeen:now-86400000},
    'b': {ease:2.5,interval:5,repetitions:2,dueDate: now + 86400000, attempts:2, correct:2, lastSeen:now},
  }};
  const QUESTIONS = [{id:'a'},{id:'b'}];
  const due = QUESTIONS.filter(q => {
    const h = progress.questionHistory[q.id];
    return h && h.dueDate && h.dueDate <= Date.now();
  });
  assert('card due 1ms ago is in due set', due.length === 1 && due[0].id === 'a');
}

console.log('');
if (failed === 0) {
  console.log('All tests passed.');
  process.exit(0);
} else {
  console.log(failed + ' test(s) FAILED.');
  process.exit(1);
}
