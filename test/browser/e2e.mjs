/**
 * End-to-end browser test.
 *
 * Not part of `npm test`, because it needs a browser and a running server that
 * the unit suite deliberately does not require. To run it:
 *
 *   node test/browser/make-fixtures.mjs        # write reference WAVs to disk
 *   python3 -m http.server 8181 &              # serve the app
 *   npm install playwright-core                # once
 *   CHROME=/path/to/chrome node test/browser/e2e.mjs
 *
 * It drives the real UI: creates a library, a client and a project, checks
 * eight reference files into it, reads the log back, exercises the to-do list,
 * exports every format, then saves the library, reloads the page, reopens the
 * saved file and asserts the full history survived.
 *
 * It removes the File System Access API before the app loads, so the app takes
 * its Safari fallback path. That is the path Playwright can actually drive
 * (it cannot operate Chrome's native file dialog) and the more fragile of the
 * two, so it is the one worth exercising end to end.
 */
import { chromium } from 'playwright-core';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUDIO = join(HERE, 'audio');
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8181';
const CHROME = process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const files = readdirSync(AUDIO).filter(f => f.endsWith('.wav')).sort().map(f => `${AUDIO}/${f}`);

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox'],
});
const ctx = await browser.newContext({ viewport: { width: 1340, height: 950 }, acceptDownloads: true });
// Remove the File System Access API BEFORE any app script runs, so the app's
// capability detection sees a Safari-like browser and takes the fallback
// download/upload path. That path is the one Playwright can actually drive
// (it cannot interact with Chrome's native file-picker dialog), and it is the
// more fragile of the two, so it is the one worth exercising end to end.
await ctx.addInitScript(() => {
  delete window.showOpenFilePicker;
  delete window.showSaveFilePicker;
  delete window.showDirectoryPicker;
});
const page = await ctx.newPage();

const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('pageerror', e => errors.push(`pageerror: ${e.message}\n${e.stack}`));

const step = (s) => console.log(`\n=== ${s} ===`);

/** Answer the import destination window with "don't log — just show me". */
async function dontLog(p) {
  await p.waitForSelector('#dest-target');
  await p.selectOption('#dest-target', '__none__');
  await p.click('.modal button[type="submit"]');
}


await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });

// ---------------------------------------------------------------- 1. library
step('Create library + client + project');
await page.click('.tab[data-view="clients"]');
await page.click('button:has-text("Start a new library")');
await page.waitForTimeout(200);
console.log('library bar:', (await page.locator('#library-file').textContent()).trim());
console.log('unsaved badge visible:', await page.locator('#unsaved-badge').isVisible());

await page.click('button:has-text("Add your first client")');
await page.fill('#f-name', 'The Bandits');
await page.fill('#f-notes', 'Met at the Fringe, 2025');
await page.click('.modal button[type="submit"]');
await page.waitForTimeout(300);
console.log('after add client, heading:', (await page.locator('#view-clients h2').first().textContent()).trim());

await page.click('button:has-text("Add the first project")');
await page.fill('#f-name', 'Album — Blue Room');
await page.click('.modal button[type="submit"]');
await page.waitForTimeout(300);
console.log('project heading:', (await page.locator('#view-clients h2').first().textContent()).trim());

// ---------------------------------------------------------------- 2. inspect
step('Check files into the project');
await page.click('button:has-text("Check files into this project")');
await page.waitForTimeout(200);
console.log('remembered destination line:', (await page.locator('#pick-target').textContent()).trim());

const chooserPromise = page.waitForEvent('filechooser');
await page.click('#btn-pick-files');
const chooser = await chooserPromise;
await chooser.setFiles(files);
// The destination window opens before a byte is read. It should already have
// the project chosen by "Check files into this project" selected.
await page.waitForSelector('#dest-target');
console.log('destination preselected:', (await page.locator('#dest-target option:checked').textContent()).trim());
await page.click('.modal button[type="submit"]');
await page.waitForTimeout(2500);

const cards = await page.locator('.report').count();
console.log('report cards rendered:', cards, '(expected 8)');
console.log('batch summary:', (await page.locator('.panel h2').first().textContent()).trim());
console.log('badges:', await page.locator('.panel .badge').allTextContents());

// Verify specific findings surfaced in the UI.
//
// Only things visible in BATCH view are asserted here: with more than one file
// on screen the metadata sections render collapsed, so their text is correctly
// absent from innerText. The single-file checks below cover those.
const failures = [];
const bodyText = await page.locator('#results').innerText();
const expect = (label, re, text = bodyText) => {
  const ok = re.test(text);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`);
  if (!ok) failures.push(label);
};

expect('48 kHz on riverbed', /48 kHz/);
expect('24-bit', /24-bit/);
expect('clipping observed', /Flat-topped peaks/i);
expect('silence observed', /entirely silent/i);
expect('LFE silent', /1 of 6 channels is silent/i);
expect('pulldown explained', /pull-down/i);
expect('truncated data reported', /shorter than the header declares/i);
expect('unreadable file', /could not be read/i);
expect('RF64 container', /RF64/);
expect('no invented values for the unreadable file', /—/);

await page.screenshot({ path: join(HERE, 'shot-reports.png'), fullPage: false });

// ---------------------------------------------------------------- 3. the log
step('Project log');
await page.click('.tab[data-view="clients"]');
await page.waitForTimeout(300);
const logRows = await page.locator('.panel:has-text("File check log") table.data tbody tr').count();
console.log('log rows:', logRows, '(expected 8)');
const firstRow = await page.locator('.panel:has-text("File check log") table.data tbody tr').first().innerText();
console.log('newest row:', firstRow.replace(/\s+/g, ' ').slice(0, 110));

// Open a log entry
await page.locator('.panel:has-text("File check log") table.data tbody tr').first().click();
await page.waitForTimeout(400);
console.log('log entry modal open:', await page.locator('#modal .report').isVisible());
await page.click('#modal button:has-text("Close")');
await page.waitForTimeout(200);

// ---------------------------------------------------------------- 4. to-dos
step('To-do list');
await page.fill('.add-row input', 'Chase the missing take 4');
await page.click('.add-row button:has-text("Add")');
await page.waitForTimeout(300);
await page.fill('.add-row input', 'Send rough mixes Friday');
await page.press('.add-row input', 'Enter');
await page.waitForTimeout(300);
console.log('todos:', await page.locator('.todo').count());
await page.locator('.todo input[type="checkbox"]').first().check();
await page.waitForTimeout(300);
console.log('first todo done class:', await page.locator('.todo').first().getAttribute('class'));
console.log('todo counts:', (await page.locator('.panel:has-text("To-do list") .muted').first().textContent()).trim());

await page.screenshot({ path: join(HERE, 'shot-project.png'), fullPage: false });

// ------------------------------------------------------------- 5. exports
step('Exports');
await page.evaluate(() => { window.__downloads = []; });
for (const fmt of ['.txt', '.csv', '.pdf']) {
  await page.click('.tab[data-view="inspect"]');
  await page.waitForTimeout(200);
  const dl = page.waitForEvent('download', { timeout: 15000 });
  await page.locator('.panel button', { hasText: new RegExp(`^\\${fmt}$`) }).first().click();
  const d = await dl;
  const path = await d.path();
  const size = readFileSync(path).length;
  console.log(`  ${fmt} -> ${d.suggestedFilename()} (${size} bytes)`);
}

// Project history export
await page.click('.tab[data-view="clients"]');
await page.waitForTimeout(300);
await page.click('button:has-text("Export history")');
await page.waitForTimeout(300);
const dlPdf = page.waitForEvent('download', { timeout: 15000 });
await page.click('#modal button:has-text(".pdf")');
const pdf = await dlPdf;
console.log('  project history pdf ->', pdf.suggestedFilename(), readFileSync(await pdf.path()).length, 'bytes');

// ------------------------------------------------------- 6. save + reopen
step('Save library, reload, reopen');
const dlLib = page.waitForEvent('download', { timeout: 15000 });
await page.click('#btn-save-library');
const libDl = await dlLib;
const libPath = await libDl.path();
const libJson = readFileSync(libPath, 'utf8');
console.log('  saved:', libDl.suggestedFilename(), libJson.length, 'bytes');
const parsed = JSON.parse(libJson);
console.log('  kind:', parsed.kind, '| clients:', parsed.clients.length,
            '| projects:', parsed.clients[0].projects.length,
            '| log entries:', parsed.clients[0].projects[0].log.length,
            '| todos:', parsed.clients[0].projects[0].todos.length);
console.log('  unsaved badge after save:', await page.locator('#unsaved-badge').isVisible());

// Reload and re-open the downloaded library file
const savedCopy = join(HERE, 'library.kingfisher.json');
const { writeFileSync } = await import('node:fs');
writeFileSync(savedCopy, libJson);

await page.reload({ waitUntil: 'networkidle' });
const chooser2Promise = page.waitForEvent('filechooser');
await page.click('#btn-open-library');
const chooser2 = await chooser2Promise;
await chooser2.setFiles([savedCopy]);
await page.waitForTimeout(800);

console.log('  reopened library bar:', (await page.locator('#library-file').textContent()).trim());
await page.click('.tab[data-view="clients"]');
await page.waitForTimeout(300);
const rosterText = await page.locator('#view-clients').innerText();
console.log('  roster shows client:', /The Bandits/.test(rosterText));
console.log('  roster shows counts:', rosterText.replace(/\s+/g,' ').match(/\d+ project.*?checks?/)?.[0]);

await page.click('.card button:has-text("Open")');
await page.waitForTimeout(300);
await page.click('.card button:has-text("Open")');
await page.waitForTimeout(400);
const reopenedLog = await page.locator('.panel:has-text("File check log") table.data tbody tr').count();
const reopenedTodos = await page.locator('.todo').count();
console.log('  after reopen — log rows:', reopenedLog, '| todos:', reopenedTodos);

await page.screenshot({ path: join(HERE, 'shot-reopened.png'), fullPage: false });

// ------------------------------------------------------------ 7. rename/delete
step('Rename and delete');
await page.click('.crumbs button:has-text("All clients")');
await page.waitForTimeout(300);
await page.click('.card button:has-text("Rename")');
await page.fill('#f-name', 'The Bandits Ltd');
await page.click('.modal button[type="submit"]');
await page.waitForTimeout(300);
console.log('  renamed:', /The Bandits Ltd/.test(await page.locator('#view-clients').innerText()));

await page.click('.card button:has-text("Delete")');
await page.waitForTimeout(300);
console.log('  delete warning:', (await page.locator('#modal .warning').textContent()).trim().slice(0, 120));
await page.click('#modal button:has-text("Cancel")');
await page.waitForTimeout(200);
console.log('  cancelled, client still present:', /The Bandits Ltd/.test(await page.locator('#view-clients').innerText()));

// ------------------------------------------------- 8. single-file metadata
// Run last, so checking one more file cannot perturb the log counts asserted
// above. In batch view the metadata sections render collapsed by design, so
// this is where their content is verified.
step('Single-file view shows embedded metadata expanded');
await page.click('.tab[data-view="inspect"]');
{
  const c = page.waitForEvent('filechooser');
  await page.click('#btn-pick-files');
  (await c).setFiles([join(AUDIO, '01 riverbed.wav')]);
  await dontLog(page);
  await page.waitForTimeout(1200);
  const single = await page.locator('#results').innerText();
  expect('bext description', /SC 14 TK 3 — kitchen wide/, single);
  expect('bext originator', /Sound Devices 833/, single);
  expect('bext timecode', /10:00:00\.000/, single);
  expect('bext v2 loudness', /-23 LUFS/, single);
  expect('coding history', /A=PCM,F=48000/, single);
  expect('iXML project', /Blue Room Sessions/, single);
  expect('iXML track name', /Boom/, single);
  expect('INFO title', /Riverbed/, single);
  expect('chunk map', /Chunks found/i, single);
  await page.screenshot({ path: join(HERE, 'shot-single.png'), fullPage: false });
}

// ------------------------------------------------ 9. levels by decoding
// MP3 is an open codec, so every browser can decode it — unlike AAC, which
// Chrome and Safari ship but open-source Chromium builds omit.
step('Measure levels by decoding');
await page.click('.tab[data-view="inspect"]');
{
  const c = page.waitForEvent('filechooser');
  await page.click('#btn-pick-files');
  (await c).setFiles([join(AUDIO, '11 plain.mp3')]);
  await dontLog(page);
  await page.waitForTimeout(1500);

  const offer = page.locator('.measure-offer button');
  expect('an offer to measure levels is shown', /./, (await offer.count()) ? 'yes' : '');
  await offer.first().click();
  await page.waitForSelector('.detail-section:has-text("Levels")', { timeout: 60000 });

  // The Levels section renders already open for a single file, so clicking its
  // summary unconditionally would close it and read back nothing.
  const card = page.locator('.report').first();
  const levelsSection = card.locator('.detail-section:has-text("Levels")');
  if ((await levelsSection.getAttribute('open')) === null) {
    await levelsSection.locator('summary').click();
    await page.waitForTimeout(300);
  }
  const levels = await levelsSection.locator('.detail-body').innerText();
  // The fixture's frames are zero-filled, so it decodes to real silence and
  // correctly reads -∞ dBFS. Accept either form: what matters is that a peak
  // was reported at all.
  expect('a peak level is reported', /Peak\s+(-?[\d.]+|-∞)\s*dBFS/, levels);
  // Detecting the silence proves the samples were actually measured rather
  // than the section being filled in with placeholders.
  expect('the silent fixture measures as silent', /silent/i, levels);
  expect('every frame was measured', /460,800 of 460,800/, levels);
  expect('the source is named as decoded', /decoded audio/i, levels);
  expect('the decoder is named', /Chrome|Safari|Firefox|this browser/, levels);
  const obs = (await card.locator('.obs-title').allInnerTexts()).join(' | ');
  expect('the decoded-measurement note is raised', /decoding the audio/i, obs);
}

// ------------------------------------------------------- 10. provenance
step('Provenance: declared, possible, and nothing found');
{
  const c = page.waitForEvent('filechooser');
  await page.click('#btn-pick-files');
  (await c).setFiles([
    join(AUDIO, '09 declared-ai.m4a'),
    join(AUDIO, '10 tool-tagged.mp3'),
    join(AUDIO, '01 riverbed.wav'),
  ]);
  await dontLog(page);
  await page.waitForTimeout(3000);

  const declared = await page.locator('.report').nth(0).locator('.ai-flag').innerText();
  expect('a declaring manifest is reported as declared', /declares that it was AI-generated/i, declared);
  expect('its reasons are listed', /What raised this/i, declared);
  expect('the generative model assertion is named', /generative model/i, declared);
  expect('and it is not claimed as verified', /did not verify the signature/i, declared);

  const tagged = await page.locator('.report').nth(1).locator('.ai-flag').innerText();
  expect('a tool-tagged file reads as possible, not declared', /Possibly AI-generated/i, tagged);
  expect('the tool is named', /Suno/, tagged);
  expect('the phrase in the comment is a separate reason', /"AI-generated"/i, tagged);

  // The ordinary file must NOT be flagged, and must not read as a clean result.
  const plainCard = page.locator('.report').nth(2);
  expect('an ordinary file raises no flag badge', /^$/,
    (await plainCard.locator('.obs-title').allInnerTexts()).filter((t) => /AI-generated/i.test(t)).join(''));
  const plainProv = plainCard.locator('.detail-section:has-text("Origin and provenance")');
  if ((await plainProv.getAttribute('open')) === null) {
    await plainProv.locator('summary').click();
    await page.waitForTimeout(300);
  }
  const plain = await plainCard.locator('.ai-flag').innerText();
  expect('nothing found is stated plainly', /No signs of AI generation were found/i, plain);
  expect('and never as a clean bill of health', /not a clean bill of health/i, plain);
  expect('with the watermark limit stated', /watermark/i, plain);
}
await page.screenshot({ path: join(HERE, 'shot-provenance.png'), fullPage: false });

// ------------------------------- 11. filing an import into a new project
// The destination window is the only way to choose where checks are filed, so
// its create-as-you-go path is the one that has to work: a brand new client
// and a new project under it, named in the same window as the import.
step('Destination window creates a client and a project');
{
  await page.click('.tab[data-view="inspect"]');
  const c = page.waitForEvent('filechooser');
  await page.click('#btn-pick-files');
  (await c).setFiles([join(AUDIO, '01 riverbed.wav')]);
  await page.waitForSelector('#dest-target');

  // A project is never required. With none in hand the window leads with the
  // one-off and selects it, so checking a file someone sent over is a confirm.
  expect('the one-off is the first thing offered', /Just this once/,
    await page.locator('#dest-target option').first().textContent());
  expect('and it is what is selected by default', /Just this once/,
    await page.locator('#dest-target option:checked').textContent());
  expect('no project name is asked for until one is wanted', /false/,
    String(await page.locator('#dest-project-name').isVisible()));

  await page.selectOption('#dest-target', '__new__');
  await page.selectOption('#dest-client', '__new__');
  expect('naming a new client is asked for', /true/,
    String(await page.locator('#dest-client-name').isVisible()));
  await page.fill('#dest-client-name', 'Wren Recordings');
  await page.fill('#dest-project-name', 'Session tapes');
  await page.screenshot({ path: join(HERE, 'shot-destination.png'), fullPage: false });
  await page.click('.modal button[type="submit"]');
  await page.waitForTimeout(1500);

  expect('the new destination is shown under the Check buttons', /Wren Recordings › Session tapes/,
    await page.locator('#pick-target').textContent());

  await page.click('.tab[data-view="clients"]');
  await page.waitForTimeout(400);
  const roster = await page.locator('#view-clients').innerText();
  expect('the tab lists projects by client', /Projects by client/, roster);
  expect('the new client is in the roster', /Wren Recordings/, roster);
  expect('with the check already logged to it', /1 project/, roster);

  // And a second import into an existing client, choosing a new project only.
  await page.click('.tab[data-view="inspect"]');
  const c2 = page.waitForEvent('filechooser');
  await page.click('#btn-pick-files');
  (await c2).setFiles([join(AUDIO, '02 clipped.wav')]);
  await page.waitForSelector('#dest-target');
  expect('the last destination is remembered as the default', /Session tapes/,
    await page.locator('#dest-target option:checked').textContent());
  await page.selectOption('#dest-target', '__new__');
  await page.selectOption('#dest-client', await page.locator('#dest-client option', { hasText: 'Wren Recordings' }).getAttribute('value'));
  expect('an existing client needs no name', /false/,
    String(await page.locator('#dest-client-name').isVisible()));
  await page.fill('#dest-project-name', 'Mix revisions');
  await page.click('.modal button[type="submit"]');
  await page.waitForTimeout(1500);
  expect('the second project is filed under the same client', /Wren Recordings › Mix revisions/,
    await page.locator('#pick-target').textContent());
}

console.log('\n=== RESULT ===');
console.log('page errors:', errors.length ? errors.join('\n') : 'none');
console.log('failed assertions:', failures.length ? failures.join(', ') : 'none');

await browser.close();
process.exit(errors.length || failures.length ? 1 : 0);
