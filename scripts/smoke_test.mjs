#!/usr/bin/env node
// Integration smoke test: extract the inline <script> from index.html,
// stub a minimal DOM + localStorage, inject 2 fake questions with past-due
// history, run startQuiz('reviewDue') → selectAnswer → finishQuiz, and
// verify the SM-2 scheduler + Review Due mode actually plumb together.
//
// Run: node scripts/smoke_test.mjs

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync('index.html', 'utf8');
const m = html.match(/<script>\s*([\s\S]*?)<\/script>/);
if (!m) { console.error('no inline script'); process.exit(1); }
const js = m[1];

// Minimal fake DOM sufficient for the render() paths we'll hit.
// escHtml() in index.html sets textContent then reads innerHTML — we need
// that mirror so citation rendering produces real output in the test.
function makeEl() {
  const el = {
    _text: '', innerHTML: '', className: '', style: {},
    children: [], dataset: {},
    get textContent() { return this._text; },
    set textContent(v) {
      this._text = String(v);
      this.innerHTML = String(v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {} },
    getBoundingClientRect() { return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }; },
    focus() {},
  };
  return el;
}
const docStub = {
  getElementById: () => makeEl(),
  querySelector: () => makeEl(),
  querySelectorAll: () => [],
  createElement: () => makeEl(),
  body: makeEl(),
  head: makeEl(),
  addEventListener() {}, removeEventListener() {},
};

const storageStub = {
  _d: new Map(),
  getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
  setItem(k, v) { this._d.set(k, String(v)); },
  removeItem(k) { this._d.delete(k); },
};

// Seed 2 fake questions (before loading the script we assign window.QUESTIONS)
const fakeQuestions = [
  { id: 'q_a', chapter: 1, chapterTitle: 'T', number: 1,
    question: 'Fake Q A', options: [{letter:'A',text:'aa'},{letter:'B',text:'bb'},{letter:'C',text:'cc'},{letter:'D',text:'dd'}],
    correctAnswer: 'A', answer: 'A', explanation: 'because aa.' },
  { id: 'q_b', chapter: 1, chapterTitle: 'T', number: 2,
    question: 'Fake Q B', options: [{letter:'A',text:'aa'},{letter:'B',text:'bb'},{letter:'C',text:'cc'},{letter:'D',text:'dd'}],
    correctAnswer: 'B', answer: 'B', explanation: 'because bb.' },
];

// Pre-seed progress in localStorage so load picks up past-due cards.
const now = Date.now();
const seeded = {
  schemaVersion: 2,
  xp: 0, streak: 0, lastStudyDate: null,
  questionHistory: {
    'q_a': { attempts: 3, correct: 2, lastSeen: now - 86400000 * 5,
             ease: 2.5, interval: 3, repetitions: 1, dueDate: now - 3600000, lastGrade: 4 },
    'q_b': { attempts: 2, correct: 1, lastSeen: now - 86400000 * 2,
             ease: 2.3, interval: 1, repetitions: 1, dueDate: now - 60000, lastGrade: 4 },
  },
  sessionHistory: [], flashcardHistory: {}, flagged: {},
  totalQuestions: 5, totalCorrect: 3,
};
storageStub.setItem('endoboard_progress', JSON.stringify(seeded));

const ctx = {
  window: {},
  document: docStub,
  localStorage: storageStub,
  navigator: { userAgent: '' },
  location: { href: '' },
  setInterval: () => 0, clearInterval: () => {},
  setTimeout: (fn) => { try { fn(); } catch(e) {} return 0; },
  clearTimeout: () => {},
  console,
  alert: () => {},
  confirm: () => true,
  requestAnimationFrame: (fn) => { fn(0); return 0; },
  URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
  Blob: class { constructor() {} },
  FileReader: class {},
  Capacitor: undefined,
};
ctx.window.QUESTIONS = fakeQuestions;
ctx.window.scrollTo = () => {};
ctx.globalThis = ctx;
vm.createContext(ctx);

// Execute the inline script in the fake context.
try {
  vm.runInContext(js, ctx, { filename: 'index.html/<inline>' });
} catch (e) {
  console.error('SCRIPT THREW:', e.message);
  console.error(e.stack);
  process.exit(1);
}

// let/const bindings at script scope aren't exposed on the context global,
// so pull references back out by evaluating an expression.
const api = vm.runInContext(
  '({ state, progress, getDueQuestions, startQuiz, selectAnswer, nextQuestion, loadProgress, renderCitation })',
  ctx
);

let failed = 0;
function assert(name, cond, detail) {
  if (cond) console.log('  PASS ' + name);
  else { failed++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

console.log('\nIntegration smoke test\n');

// After load, getDueQuestions should return both seeded cards.
const due = api.getDueQuestions();
assert('getDueQuestions returns both seeded cards', due.length === 2, 'got ' + due.length);

// Starting a reviewDue quiz should put both in state.quizQuestions.
api.startQuiz('reviewDue', []);
assert('reviewDue quiz has both cards', api.state.quizQuestions.length === 2);
assert('state.screen is quiz', api.state.screen === 'quiz');

// Answer the first question correctly and verify SM-2 updates.
const firstQ = api.state.quizQuestions[0];
const beforeDue = api.progress.questionHistory[firstQ.id].dueDate;
const beforeReps = api.progress.questionHistory[firstQ.id].repetitions;
api.selectAnswer(firstQ.correctAnswer);
const afterH = api.progress.questionHistory[firstQ.id];
assert('correct answer increments repetitions', afterH.repetitions === beforeReps + 1);
assert('dueDate advances into the future', afterH.dueDate > now + 86400000 - 1000, 'got ' + afterH.dueDate);
assert('lastGrade recorded', afterH.lastGrade === 4);

// Advance to next q, answer wrong, check reset.
api.nextQuestion();
const secondQ = api.state.quizQuestions[api.state.currentIndex];
api.selectAnswer('D'); // wrong answer (correct is B)
const after2 = api.progress.questionHistory[secondQ.id];
assert('wrong answer resets repetitions', after2.repetitions === 0);
assert('wrong answer sets interval to 1', after2.interval === 1);
assert('wrong answer lowers ease', after2.ease < 2.3);

// Migration test: clear schemaVersion and re-seed legacy entry.
const legacy = {
  xp: 0, streak: 0, lastStudyDate: null,
  questionHistory: {
    'q_legacy': { attempts: 2, correct: 2, lastSeen: now - 86400000 },
  },
  sessionHistory: [], flashcardHistory: {}, flagged: {},
  totalQuestions: 2, totalCorrect: 2,
};
storageStub.setItem('endoboard_progress', JSON.stringify(legacy));
api.loadProgress();
// loadProgress reassigns the script-scope `progress` variable, so re-fetch.
const progressNow = vm.runInContext('progress', ctx);
const lg = progressNow.questionHistory['q_legacy'];
assert('legacy entry got ease default', lg && lg.ease === 2.5, 'got ' + JSON.stringify(lg));
assert('legacy entry got dueDate set', lg && lg.dueDate > 0);
assert('schemaVersion bumped to 2', progressNow.schemaVersion === 2);
assert('backup key written', !!storageStub.getItem('endoboard_progress_backup_v1'));

// Citation render is gated on verified.
const cited = { citation: { author: 'Test', year: 2020, title: 't', journal: 'J', classification: 'classic', verified: true } };
const html2 = api.renderCitation(cited);
if (!html2.includes('Test') || !html2.includes('classic')) {
  console.log('  renderCitation output was:', JSON.stringify(html2));
}
assert('verified citation renders', html2.includes('Test') && html2.includes('classic'));
const uncited = { citation: { author: 'Test', verified: false } };
assert('unverified citation hidden', api.renderCitation(uncited) === '');
assert('no citation field hidden', api.renderCitation({}) === '');

// --- Blueprint sampling integration -------------------------------------
// Swap in a fresh balanced pool so the sampler has real chapter data.
const bpPool = [];
for (let ch = 1; ch <= 13; ch++) {
  for (let i = 0; i < 50; i++) {
    bpPool.push({
      id: 'bp_ch' + ch + '_' + i, chapter: ch, chapterTitle: 'ch' + ch, number: i,
      question: 'q', options: [{letter:'A',text:'a'},{letter:'B',text:'b'},{letter:'C',text:'c'},{letter:'D',text:'d'}],
      correctAnswer: 'A', answer: 'A', explanation: '',
    });
  }
}
vm.runInContext('QUESTIONS.length = 0; QUESTIONS.push(...' + JSON.stringify(bpPool) + ')', ctx);

const blueprintSample = vm.runInContext('blueprintSample', ctx);
const BLUEPRINT = vm.runInContext('BLUEPRINT', ctx);

// Blueprint exposure
assert('BLUEPRINT is exposed in script', typeof BLUEPRINT === 'object' && BLUEPRINT[8] === 0.18);
assert('blueprintSample is callable', typeof blueprintSample === 'function');

// Exam Sim via startQuiz('exam', []) should blueprint-sample 50 questions.
api.startQuiz('exam', []);
const examState = vm.runInContext('state', ctx);
assert('Exam Sim gets 50 questions', examState.quizQuestions.length === 50);
{
  const counts = {};
  examState.quizQuestions.forEach(q => counts[q.chapter] = (counts[q.chapter] || 0) + 1);
  // Treatment (0.18) should yield ~9 cards, Complications (0.02) ~1.
  assert('Exam Sim Tx ~= 9', counts[8] >= 7 && counts[8] <= 11, 'got ' + counts[8]);
  assert('Exam Sim Complications ~= 1', (counts[13] || 0) >= 0 && (counts[13] || 0) <= 2, 'got ' + counts[13]);
}

// User-picked chapters must bypass blueprint weighting (user intent wins).
api.startQuiz('exam', [8]);  // only Treatment
const txState = vm.runInContext('state', ctx);
assert('User-picked exam respects filter', txState.quizQuestions.every(q => q.chapter === 8));

// Quick 10 should also blueprint-sample when no chapters picked.
api.startQuiz('quick10', []);
const q10State = vm.runInContext('state', ctx);
assert('Quick 10 gets 10 questions', q10State.quizQuestions.length === 10);

console.log('');
if (failed === 0) { console.log('All smoke tests passed.'); process.exit(0); }
else { console.log(failed + ' smoke test(s) FAILED.'); process.exit(1); }
