/**
 * Chrome File System Access path — save in place.
 *
 * Run:
 *   python3 -m http.server 8181 &
 *   node test/browser/fsa.mjs
 *
 * WHAT THIS COVERS. Everything the app does with a file handle: writing
 * through it, clearing the unsaved flag, saving a second time to the SAME
 * file rather than producing another one, and the contents being current.
 * That is the behaviour that distinguishes Chrome from the Safari fallback,
 * and it previously had no automated coverage at all.
 *
 * WHAT IT CANNOT COVER, and why. Two things need a real handle:
 *
 *   1. The native save dialog. No automation can click it; that is the point
 *      of it being native.
 *   2. Remembering the library across a restart. The handle is kept in
 *      IndexedDB, which stores values by structured clone — and a plain
 *      JavaScript object with methods is NOT structured-cloneable
 *      (DataCloneError). A real FileSystemFileHandle is a platform object
 *      with clone support built in; a stand-in cannot be. So the
 *      remember-and-reopen path genuinely needs a human with a real browser,
 *      and is listed in ROADMAP.md as such rather than pretended to here.
 *
 * The stand-in below therefore proves the write path and stops honestly at
 * the boundary rather than asserting something it has not established.
 */

import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8181';
const CHROME = process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1340, height: 900 } });

// Installed before any app code runs, so capability detection sees a browser
// that can save in place.
await ctx.addInitScript(() => {
  window.__disk = { name: 'studio-library.kingfisher.json', contents: null, writes: 0 };

  const handle = {
    kind: 'file',
    name: window.__disk.name,
    async getFile() {
      return new File([window.__disk.contents ?? ''], window.__disk.name, { type: 'application/json' });
    },
    async createWritable() {
      let buffer = '';
      return {
        async write(data) { buffer += data; },
        async close() { window.__disk.contents = buffer; window.__disk.writes++; },
      };
    },
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
  };

  window.showSaveFilePicker = async () => handle;
  window.showOpenFilePicker = async () => [handle];
  window.showDirectoryPicker = async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); };

  // Count downloads, so "saved in place" can be distinguished from "dropped a
  // copy in Downloads" — the exact difference between the two browser paths.
  window.__downloads = 0;
  const realCreate = document.createElement.bind(document);
  document.createElement = (tag, ...rest) => {
    const node = realCreate(tag, ...rest);
    if (String(tag).toLowerCase() === 'a') {
      const realClick = node.click.bind(node);
      node.click = () => { if (node.download) window.__downloads++; return realClick(); };
    }
    return node;
  };
});

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const failures = [];
const expect = (label, condition) => {
  console.log(`  ${condition ? 'OK  ' : 'FAIL'} ${label}`);
  if (!condition) failures.push(label);
};

await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });

console.log('=== capability detection ===');
expect('reports saving in place, not the Safari fallback',
  /saving writes straight back/i.test(await page.locator('#browser-note').innerText()));

console.log('\n=== create, populate, save ===');
await page.click('.tab[data-view="clients"]');
await page.click('button:has-text("Start a new library")');
await page.click('button:has-text("Add your first client")');
await page.fill('#f-name', 'The Bandits');
await page.click('.modal button[type="submit"]');
await page.waitForTimeout(300);
await page.click('button:has-text("Add the first project")');
await page.fill('#f-name', 'Album — Blue Room');
await page.click('.modal button[type="submit"]');
await page.waitForTimeout(300);
await page.fill('.add-row input', 'Chase the missing take 4');
await page.click('.add-row button:has-text("Add")');
await page.waitForTimeout(300);

expect('unsaved changes are flagged', await page.locator('#unsaved-badge').isVisible());

await page.click('#btn-save-library');
await page.waitForTimeout(800);

const afterSave = await page.evaluate(() => ({
  writes: window.__disk.writes,
  bytes: (window.__disk.contents || '').length,
  downloads: window.__downloads,
}));
expect('the library was written through the handle', afterSave.writes === 1 && afterSave.bytes > 0);
expect('NO download was produced — this is the in-place path', afterSave.downloads === 0);
expect('the unsaved badge cleared', !(await page.locator('#unsaved-badge').isVisible()));
expect('the toolbar names the file that was written',
  (await page.locator('#library-file').innerText()).includes('studio-library'));

console.log('\n=== saving again must update the same file ===');
await page.fill('.add-row input', 'Send rough mixes Friday');
await page.click('.add-row button:has-text("Add")');
await page.waitForTimeout(300);
await page.click('#btn-save-library');
await page.waitForTimeout(800);

const afterSecond = await page.evaluate(() => {
  const doc = JSON.parse(window.__disk.contents);
  return {
    writes: window.__disk.writes,
    downloads: window.__downloads,
    todos: doc.clients[0].projects[0].todos.length,
    client: doc.clients[0].name,
  };
});
expect('a second save wrote to the same file, not a new one', afterSecond.writes === 2);
expect('still no downloads', afterSecond.downloads === 0);
expect('the saved contents are current', afterSecond.todos === 2 && afterSecond.client === 'The Bandits');

console.log('\n=== reopening from the handle ===');
await page.click('#btn-open-library');
await page.waitForTimeout(800);
await page.click('.tab[data-view="clients"]');
await page.waitForTimeout(400);
expect('the library reopens from the handle with its contents',
  /The Bandits/.test(await page.locator('#view-clients').innerText()));

console.log('\n=== not covered here (needs a real browser and a human) ===');
console.log('  - the native save dialog itself');
console.log('  - remembering the library across a restart: the handle lives in');
console.log('    IndexedDB, which stores by structured clone, and a stand-in');
console.log('    object with methods cannot be cloned. See ROADMAP.md.');

console.log('\n=== RESULT ===');
console.log('page errors:', errors.length ? errors.join('\n') : 'none');
console.log('failed assertions:', failures.length ? failures.join(', ') : 'none');

await browser.close();
process.exit(errors.length || failures.length ? 1 : 0);
