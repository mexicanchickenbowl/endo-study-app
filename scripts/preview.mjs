#!/usr/bin/env node
// Render the EndoBoard app into a series of screenshots so the user can
// preview it without setting up iOS Simulator or Xcode.
//
// Launches a local HTTP server beforehand? No — caller does that. We just
// point Playwright at http://localhost:3000/index.html
//
// Produces:
//   /tmp/preview-01-dashboard-mobile.png
//   /tmp/preview-02-dashboard-desktop.png
//   /tmp/preview-03-quiz-unanswered.png
//   /tmp/preview-04-quiz-answered-with-citation.png
//   /tmp/preview-05-chapter-select.png
//
// Run: node scripts/preview.mjs

import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const URL = 'http://localhost:3000/index.html';

async function seedProgressAndCitation(page) {
  // Seed realistic progress state so the dashboard has something interesting
  // to show. We no longer inject fake citations — the real enriched set is
  // baked into questions.js.
  await page.evaluate(() => {
    if (!window.QUESTIONS || !window.QUESTIONS.length) return;
    // Seed realistic SM-2 history: 240 attempted, 12 due, 4-day streak.
    const now = Date.now();
    const progress = {
      schemaVersion: 2,
      xp: 2180,
      streak: 4,
      lastStudyDate: new Date().toDateString(),
      totalQuestions: 318,
      totalCorrect: 241,
      sessionHistory: [],
      flashcardHistory: {},
      flagged: {},
      questionHistory: {},
    };
    const flagIds = [];
    for (let i = 0; i < 240; i++) {
      const qi = window.QUESTIONS[i];
      if (!qi) break;
      const attempts = 1 + (i % 4);
      const correct = Math.max(1, attempts - (i % 3));
      // 12 past-due, rest future
      const past = i < 12;
      progress.questionHistory[qi.id] = {
        attempts, correct,
        lastSeen: now - 86400000 * (1 + (i % 5)),
        ease: 2.5 + ((i % 4) * 0.1 - 0.2),
        interval: past ? 1 : 3 + (i % 6),
        repetitions: correct,
        dueDate: past ? now - (i + 1) * 60000 : now + 86400000 * (1 + (i % 10)),
        lastGrade: 4,
      };
      if (i % 37 === 0) flagIds.push(qi.id);
    }
    for (const id of flagIds) progress.flagged[id] = true;
    localStorage.setItem('endoboard_progress', JSON.stringify(progress));
    // Suppress the XP popup animation so screenshots stay clean.
    const style = document.createElement('style');
    style.textContent = '.xp-popup{display:none !important}';
    document.head.appendChild(style);
  });
}

async function shoot(page, name) {
  const path = '/tmp/preview-' + name + '.png';
  await page.screenshot({ path, fullPage: true });
  console.log('wrote ' + path);
}

(async () => {
  const browser = await chromium.launch();

  // --- 1. Mobile dashboard (iPhone 15 Pro dimensions) ---
  {
    const ctx = await browser.newContext({
      viewport: { width: 393, height: 852 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    const page = await ctx.newPage();
    await page.goto(URL);
    await seedProgressAndCitation(page);
    // Re-render after seeding
    await page.evaluate(() => { if (typeof loadProgress === 'function') { loadProgress(); render(); } });
    await page.waitForTimeout(300);
    await shoot(page, '01-dashboard-mobile');

    // Quiz start
    await page.evaluate(() => { state.quizMode = 'study'; startQuiz('study', [1]); });
    await page.waitForTimeout(300);
    await shoot(page, '03-quiz-unanswered-mobile');

    // Answer (click first option, wrong or right)
    await page.evaluate(() => {
      const q = state.quizQuestions[state.currentIndex];
      selectAnswer(q.answer || q.correctAnswer);
    });
    await page.waitForTimeout(300);
    await shoot(page, '04-quiz-answered-with-citation-mobile');

    await ctx.close();
  }

  // --- 2. Desktop dashboard (with sidebar) ---
  {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    await page.goto(URL);
    await seedProgressAndCitation(page);
    await page.evaluate(() => { if (typeof loadProgress === 'function') { loadProgress(); render(); } });
    await page.waitForTimeout(300);
    await shoot(page, '02-dashboard-desktop');

    // Chapter select
    await page.evaluate(() => { state.quizMode = 'study'; state.screen = 'chapterSelect'; render(); });
    await page.waitForTimeout(200);
    await shoot(page, '05-chapter-select-desktop');

    // Stats page (shows the new Blueprint Coverage card)
    await page.evaluate(() => { state.screen = 'stats'; render(); });
    await page.waitForTimeout(200);
    await shoot(page, '06-stats-blueprint-desktop');

    // Name the Paper drill — question prompt (unrevealed)
    await page.evaluate(() => { startPaperDrill([]); });
    await page.waitForTimeout(200);
    // Read the correct author from the currently-loaded card and type it
    // so the revealed screenshot shows a successful match.
    const correctAuthor = await page.evaluate(() => {
      const q = state.paperDrillQueue[state.paperDrillIndex];
      return q && q.citation ? q.citation.author : '';
    });
    await page.fill('#paper-drill-input', correctAuthor || 'guess');
    await shoot(page, '08-name-the-paper-prompt-desktop');

    // Name the Paper drill — revealed with citation + correct match
    await page.evaluate(() => { submitPaperDrillAnswer(); });
    await page.waitForTimeout(200);
    await shoot(page, '09-name-the-paper-revealed-desktop');

    await ctx.close();
  }

  // Stats page on mobile so you can see how the blueprint table reflows
  {
    const ctx = await browser.newContext({
      viewport: { width: 393, height: 852 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    const page = await ctx.newPage();
    await page.goto(URL);
    await seedProgressAndCitation(page);
    await page.evaluate(() => {
      if (typeof loadProgress === 'function') { loadProgress(); }
      state.screen = 'stats'; render();
    });
    await page.waitForTimeout(200);
    await shoot(page, '07-stats-blueprint-mobile');
    await ctx.close();
  }

  await browser.close();
  console.log('\nDone.');
})().catch(e => { console.error(e); process.exit(1); });
