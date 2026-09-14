// New lead: a real click on #btn-play-run left the sim STOPPED (running:false),
// while an earlier probe's programmatic .click() started it. startMusic() is
// called from startRun(), so a run that never starts is silent AND empty - which
// would explain both "music isn't playing" and "isn't showing anything".
// Find out which branch the click takes and what state the page is in.
//
// ONE browser, foreground. Usage: node tools/start-run-probe.js [--url URL]
const { chromium } = require('playwright');
const arg = process.argv.indexOf('--url');
const debugURL = require('./lib/debug-url');
const URL = debugURL(arg > 0 ? process.argv[arg + 1] : 'https://funkyburnquest.project-testing.xyz/');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message.slice(0, 180)));
  page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 180)); });
  await page.goto(URL, { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(3000);

  const pre = await page.evaluate(() => {
    const S = window.BurnQuestSim || window.Sim;
    const btn = document.getElementById('btn-play-run');
    const r = btn ? btn.getBoundingClientRect() : null;
    const dash = document.getElementById('dashboard');
    const game = document.getElementById('game-screen');
    return {
      hasSim: !!S,
      running: S && S.isRunning ? S.isRunning() : null,
      paused: S && S.isPaused ? S.isPaused() : null,
      hasRun: S && S.hasRun ? S.hasRun() : null,
      btn: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width),
                 h: Math.round(r.height), visible: r.width > 0 && r.height > 0 } : 'missing',
      dashboardHidden: dash ? dash.classList.contains('hidden') : 'n/a',
      gameHidden: game ? game.classList.contains('hidden') : 'n/a',
      campaignSelected: (() => { try { return !!(window.BurnQuestSim || window.Sim).getCurrentCampaign(); } catch (e) { return 'threw: ' + e.message.slice(0, 60); } })(),
    };
  });
  console.log('BEFORE CLICK:', JSON.stringify(pre));

  await page.click('#btn-play-run', { timeout: 5000 }).catch(e => console.log('click failed:', e.message.slice(0, 90)));
  await page.waitForTimeout(3000);

  const post = await page.evaluate(() => {
    const S = window.BurnQuestSim || window.Sim;
    const dash = document.getElementById('dashboard');
    const game = document.getElementById('game-screen');
    const fatal = document.getElementById('fatal') || document.querySelector('.fatal');
    return {
      running: S && S.isRunning ? S.isRunning() : null,
      paused: S && S.isPaused ? S.isPaused() : null,
      hasRun: S && S.hasRun ? S.hasRun() : null,
      frog: (() => { try { return S.getState().frog; } catch (e) { return 'no state'; } })(),
      dashboardHidden: dash ? dash.classList.contains('hidden') : 'n/a',
      gameHidden: game ? game.classList.contains('hidden') : 'n/a',
      fatalShown: fatal ? !fatal.classList.contains('hidden') : false,
      loadingShown: (() => { const l = document.getElementById('loading'); return l ? !l.classList.contains('hidden') : 'n/a'; })(),
    };
  });
  console.log('AFTER  CLICK:', JSON.stringify(post));
  console.log('errors:', errs.length ? errs.slice(0, 5) : 'none');
  await page.screenshot({ path: 'test-shots/live-after-click.png' }).catch(() => {});
  await browser.close();
})().catch(e => { console.error('PROBE FAILED', e.message); process.exit(1); });
