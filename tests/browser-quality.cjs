// Run against the local Vite server. MAJLIS_PLAYWRIGHT may point to an existing
// Playwright installation; this check never connects to production services.
const { chromium } = require(process.env.MAJLIS_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.MAJLIS_CHROME ? { executablePath: process.env.MAJLIS_CHROME } : {}) });
  const context = await browser.newContext({ viewport: { width: 1365, height: 950 } });
  const origin = process.env.MAJLIS_LOCAL_URL || 'http://127.0.0.1:5177';
  const errors = [];
  const out = process.env.MAJLIS_QA_OUTPUT || path.join(require('node:os').tmpdir(), 'majlis-quality-qa');
  fs.mkdirSync(out, { recursive: true });
  try {
    await context.route('**/*', (route) => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    await context.addInitScript(() => {
      localStorage.setItem('majlis.prefs.v1', JSON.stringify({ username: 'اختبار محلي', sfx: false, eco: true }));
      window.__qaPeers = [];
      window.__qaTracks = [];
      const OriginalPeer = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends OriginalPeer {
        constructor(...args) { super(...args); window.__qaPeers.push(this); }
        addTransceiver(track, opts) {
          if (track instanceof MediaStreamTrack) window.__qaTracks.push(track);
          return super.addTransceiver(track, opts);
        }
      };
    });
    const page = await context.newPage();
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(`${origin}/?server=http://127.0.0.1:9&rt=ws://127.0.0.1:9`);
    await page.getByRole('button', { name: 'ابدأ البث', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    assert.equal(await dialog.locator('.preset[aria-pressed="true"] strong').innerText(), '2K');
    assert.match(await dialog.locator('[aria-label="معدل الإطارات"] [aria-pressed="true"]').innerText(), /60/);
    const check = dialog.getByRole('button', { name: 'اختبار 2K / 60 على هذا الجهاز', exact: true });
    await check.waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('اختبار 2K / 60') && !b.disabled));
    await page.screenshot({ path: path.join(out, 'studio-desktop.png'), fullPage: true });

    // Real browser encoder and receiver, no network server. Never assert a
    // particular FPS: headless performance is not the user's target laptop.
    await check.click();
    await dialog.getByRole('button', { name: 'إلغاء الفحص', exact: true }).waitFor();
    await dialog.locator('[role="status"]').waitFor({ timeout: 35000 });
    const result = await dialog.locator('[role="status"]').innerText();
    assert.match(result, /الفحص المحلي/);
    assert.match(result, /2560×1440/);
    const cleanup = await page.evaluate(() => ({
      peers: window.__qaPeers.map((p) => p.connectionState),
      tracks: window.__qaTracks.map((t) => t.readyState),
      diagnosticVideos: document.querySelectorAll('video[aria-hidden="true"]').length,
    }));
    assert(cleanup.tracks.every((s) => s === 'ended'));
    assert.equal(cleanup.diagnosticVideos, 0);
    assert(cleanup.peers.filter((s) => s === 'closed').length >= 2);

    // Explicit cancellation and closing the dialog both release local media.
    await check.click();
    await page.waitForFunction(() => window.__qaTracks.some((t) => t.readyState === 'live'));
    await dialog.getByRole('button', { name: 'إلغاء الفحص', exact: true }).click();
    await page.waitForFunction(() => window.__qaTracks.every((t) => t.readyState === 'ended'));
    await page.waitForFunction(() => !document.querySelector('video[aria-hidden="true"]'));
    await check.click();
    await page.waitForFunction(() => window.__qaTracks.some((t) => t.readyState === 'live'));
    await dialog.getByRole('button', { name: 'إغلاق', exact: true }).click();
    await page.waitForFunction(() => window.__qaTracks.every((t) => t.readyState === 'ended'));

    // A changed target triggers a new capability probe and invalidates results.
    await page.getByRole('button', { name: 'ابدأ البث', exact: true }).first().click();
    await dialog.locator('.preset').filter({ hasText: '720p' }).click();
    await dialog.getByRole('button', { name: '30 إطار', exact: true }).click();
    await dialog.getByRole('button', { name: 'اختبار 720p / 30 على هذا الجهاز', exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.getByRole('button', { name: 'اختبار 720p / 30 على هذا الجهاز', exact: true }).scrollIntoViewIfNeeded();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false);
    await page.screenshot({ path: path.join(out, 'studio-mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result, cleanup, errors, screenshots: out }, null, 2));
  } finally {
    await context.close();
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
