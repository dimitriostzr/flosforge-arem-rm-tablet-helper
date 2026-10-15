'use strict';

// Takes the README screenshots: the real app, driven against the mock tablet with a made-up
// library (no real notes), into docs/screenshots/.
//
//   npm run screenshots
//
// The notebooks' PDFs are drawn here (vector "handwriting", sketches, titles), so thumbnails,
// page counts and the reader look real. Runs under Electron; main.js is loaded as usual.

const { app, BrowserWindow, nativeTheme } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockTablet } = require('../test/mock-tablet');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');

// ---------------------------------------------------------------------------
// Fake notebooks, as small hand-written PDFs

function rng(seed) {
  // mulberry32: deterministic, so the screenshots only change when the drawing does
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W = 702; // reMarkable's 3:4 page, in points
const H = 936;
const f = (n) => n.toFixed(1);
// Helvetica in a PDF without an embedded font only covers Latin-1: anything else becomes '-'.
const esc = (text) => text.replace(/[^\x20-\x7e]/g, '-').replace(/[\\()]/g, (c) => `\\${c}`);

/** A line of cursive-looking scribble from x0 to x1 on a baseline. */
function scribble(random, x0, x1, y, size = 15) {
  let ops = '';
  let x = x0;
  while (x < x1 - 30) {
    const word = 30 + random() * 70;
    let px = x;
    ops += `${f(px)} ${f(y)} m `;
    while (px < Math.min(x + word, x1)) {
      const step = 6 + random() * 7;
      const h = size * (0.35 + random() * 0.75) * (random() < 0.12 ? 1.7 : 1);
      ops += `${f(px + step * 0.3)} ${f(y + h)} ${f(px + step * 0.7)} ${f(y + h)} ${f(px + step)} ${f(y + (random() < 0.2 ? -size * 0.4 : 0))} c `;
      px += step;
    }
    ops += 'S\n';
    x = px + 10 + random() * 12;
  }
  return ops;
}

function page({ title, seed, kind = 'notes', number = 1 }) {
  const random = rng(seed);
  let s = '1 1 1 rg 0 0 W H re f\n'.replace('W', W).replace('H', H);
  // faint ruling
  s += '0.86 0.87 0.9 RG 0.6 w\n';
  for (let y = H - 150; y > 70; y -= 34) s += `56 ${y} m ${W - 56} ${y} l S\n`;
  // title (typed) and its teal underline
  s += `BT /F1 26 Tf 0.12 0.13 0.15 rg 56 ${H - 92} Td (${esc(number > 1 ? `${title} – ${number}` : title)}) Tj ET\n`;
  s += `0.17 0.7 0.78 RG 3 w 1 J 56 ${H - 108} m ${56 + Math.min(420, title.length * 13)} ${H - 108} l S\n`;
  s += '0.13 0.14 0.17 RG 1.7 w 1 J 1 j\n';
  if (kind === 'sketch') {
    // boxes, arrows and a few notes around them
    const boxes = [
      [80, 560, 200, 110],
      [400, 600, 220, 120],
      [240, 330, 230, 120],
    ];
    for (const [x, y, w, h] of boxes) {
      s += `${x} ${y} m ${x + w} ${y + 3} l ${x + w - 2} ${y + h} l ${x + 2} ${y + h - 2} l h S\n`;
      s += scribble(random, x + 16, x + w - 10, y + h / 2 - 6, 11);
    }
    s += '0.17 0.7 0.78 RG 2.2 w\n';
    s += '282 615 m 340 640 360 645 398 655 c S 388 666 m 398 655 l 384 646 l S\n';
    s += '180 556 m 210 500 240 470 280 452 c S 268 448 m 280 452 l 274 464 l S\n';
    s += '0.13 0.14 0.17 RG 1.7 w\n';
    for (let y = 250; y > 120; y -= 34) s += scribble(random, 70, W - 90 - random() * 180, y + 4);
  } else {
    let y = H - 150;
    const lines = 12 + Math.floor(random() * 8);
    for (let i = 0; i < lines && y > 90; i++, y -= 34) {
      if (random() < 0.12) continue; // a paragraph break
      const indent = random() < 0.2 ? 30 : 0;
      s += scribble(random, 66 + indent, W - 70 - random() * 160, y + 4);
      if (random() < 0.08) s += `0.17 0.7 0.78 RG 66 ${y - 2} m ${W - 260} ${y - 1} l S 0.13 0.14 0.17 RG\n`;
    }
  }
  return s;
}

/** A minimal PDF: one Helvetica font, one content stream per page. */
function pdf(contents) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (const content of contents) {
    const pageId = objects.length + 1;
    kids.push(`${pageId} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${contents.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const notebook = (title, seed, pages = 3, kind = 'notes') =>
  pdf(Array.from({ length: pages }, (_, i) => page({ title, seed: seed + i, kind: i === 1 && kind === 'mixed' ? 'sketch' : kind === 'mixed' ? 'notes' : kind, number: i + 1 })));

// ---------------------------------------------------------------------------
// The made-up library

const day = 86400000;
const now = Date.now();
const ago = (d) => new Date(now - d * day).toISOString();

const LIBRARY = [
  { ID: 'f-work', VissibleName: 'Work', Type: 'CollectionType' },
  { ID: 'f-meet', VissibleName: 'Meetings', Type: 'CollectionType', Parent: 'f-work' },
  { ID: 'f-proj', VissibleName: 'Projects', Type: 'CollectionType', Parent: 'f-work' },
  { ID: 'f-study', VissibleName: 'Studies', Type: 'CollectionType' },
  { ID: 'f-phys', VissibleName: 'Physics 201', Type: 'CollectionType', Parent: 'f-study' },
  { ID: 'f-personal', VissibleName: 'Personal', Type: 'CollectionType' },
  { ID: 'f-reading', VissibleName: 'Reading', Type: 'CollectionType' },

  { ID: 'n01', VissibleName: 'Weekly planner', ModifiedClient: ago(0.15), CurrentPage: 4, Bookmarked: true, pages: 6, kind: 'notes' },
  { ID: 'n02', VissibleName: 'Project kickoff', Parent: 'f-meet', ModifiedClient: ago(1.2), CurrentPage: 1, Bookmarked: true, pages: 3, kind: 'mixed' },
  { ID: 'n03', VissibleName: 'Team sync', Parent: 'f-meet', ModifiedClient: ago(3), CurrentPage: 0, pages: 2 },
  { ID: 'n04', VissibleName: 'Roadmap sketches', Parent: 'f-proj', ModifiedClient: ago(5), CurrentPage: 2, pages: 4, kind: 'sketch' },
  { ID: 'n05', VissibleName: 'Lecture 04 – Thermodynamics', Parent: 'f-phys', ModifiedClient: ago(2), CurrentPage: 7, Bookmarked: true, pages: 9, kind: 'mixed' },
  { ID: 'n06', VissibleName: 'Problem set 3', Parent: 'f-phys', ModifiedClient: ago(9), CurrentPage: 1, pages: 3 },
  { ID: 'n07', VissibleName: 'Course syllabus.pdf', Parent: 'f-study', ModifiedClient: ago(40), CurrentPage: 0, fileType: 'pdf', pages: 2 },
  { ID: 'n08', VissibleName: 'Travel journal', Parent: 'f-personal', ModifiedClient: ago(12), CurrentPage: 11, pages: 5 },
  { ID: 'n09', VissibleName: 'Garden layout', Parent: 'f-personal', ModifiedClient: ago(25), CurrentPage: 0, pages: 1, kind: 'sketch' },
  { ID: 'n10', VissibleName: 'Recipe ideas', Parent: 'f-personal', ModifiedClient: ago(70), CurrentPage: 2, pages: 3 },
  { ID: 'n11', VissibleName: 'Research paper draft.pdf', Parent: 'f-reading', ModifiedClient: ago(6), CurrentPage: 3, fileType: 'pdf', pages: 4 },
  { ID: 'n12', VissibleName: 'Short stories.epub', Parent: 'f-reading', ModifiedClient: ago(150), CurrentPage: 18, fileType: 'epub', pages: 2 },
  { ID: 'n13', VissibleName: 'Quick sheets', ModifiedClient: ago(0.6), CurrentPage: 0, pages: 2 },
  { ID: 'n14', VissibleName: 'Whiteboard ideas', ModifiedClient: ago(16), CurrentPage: 1, pages: 2, kind: 'sketch' },
].map((d, i) =>
  d.Type === 'CollectionType'
    ? d
    : { fileType: 'notebook', ...d, body: notebook(d.VissibleName.replace(/\.(pdf|epub)$/, ''), 1000 + i * 17, d.pages, d.kind) }
);

// ---------------------------------------------------------------------------
// Driving the app

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const win = () => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('app.html'));
const js = (code) => win().webContents.executeJavaScript(code);
async function until(code, ms = 20000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(150)) {
    if (win() && !win().webContents.isLoading() && (await js(code).catch(() => false))) return;
  }
  throw new Error(`timed out waiting for: ${code}`);
}
async function shot(name) {
  await wait(700);
  // Show what a real user sees instead of the mock's address and the temporary profile. The app
  // re-renders these labels, so they're rewritten whenever they change.
  await js(`(() => {
    if (window.__shotLabels) return;
    window.__shotLabels = true;
    const fix = () => {
      const detail = document.getElementById('status-detail');
      if (detail.textContent.includes('127.0.0.1:18190')) detail.textContent = detail.textContent.replace('127.0.0.1:18190', '10.11.99.1');
      const dest = document.getElementById('destination');
      if (dest.textContent !== '~/Google Drive/My Drive/reMarkable_PDFs') dest.textContent = '~/Google Drive/My Drive/reMarkable_PDFs';
    };
    for (const id of ['status-detail', 'destination']) new MutationObserver(fix).observe(document.getElementById(id), { childList: true, characterData: true, subtree: true });
    fix();
  })()`);
  await wait(100);
  const image = await win().webContents.capturePage();
  fs.writeFileSync(path.join(OUT, `${name}.png`), image.toPNG());
  console.log('saved', `docs/screenshots/${name}.png`);
}
const clickText = (selector, text) =>
  js(`[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.innerText.includes(${JSON.stringify(text)})).click()`);
const appearance = (mode, theme) => js(`window.companion.setAppearance(${JSON.stringify({ mode, theme })})`);
const open = (name) =>
  js(`[...document.querySelectorAll('#grid .note')].find((c) => c.innerText.includes(${JSON.stringify(name)})).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);

// Isolated profile, so your own settings and downloads are never touched.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'arem-shots-'));
app.setPath('userData', path.join(profile, 'data'));
fs.mkdirSync(path.join(profile, 'data'), { recursive: true });
fs.writeFileSync(path.join(profile, 'data', 'config.json'), JSON.stringify({ destination: path.join(profile, 'PDFs') }));
nativeTheme.themeSource = 'light';

// No tablet thumbnails: the mock's are 1x1 placeholders; the cards draw page 1 from the PDFs.
const tablet = createMockTablet({ docs: LIBRARY, port: 18190, thumbnails: false });
process.env.RM_HOST = 'http://127.0.0.1:18190';

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await tablet.start();
  try {
    await until(`document.querySelectorAll("#grid .note").length === ${LIBRARY.filter((d) => !d.Type).length}`);
    win().setContentSize(1360, 860); // wide enough for the toolbar on one line
    await shot('welcome');
    await js('document.getElementById("welcome-ok").click()');

    // Download everything once, so cards get thumbnails and page counts.
    await js('document.getElementById("download-view").click()');
    await until('!document.getElementById("activity").hidden && document.getElementById("stop").hidden', 60000);
    await until(`document.querySelectorAll("#grid .note img.note-image").length === ${LIBRARY.filter((d) => !d.Type).length}`, 60000);
    await js('document.getElementById("activity-dismiss").click()');
    await shot('library');

    await clickText('#nav-folders .nav-item', 'Studies');
    await js(`[...document.querySelectorAll('#nav-folders .nav-item')].find((b) => b.innerText.includes('Studies')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await until('document.querySelectorAll("#grid .note img.note-image").length >= 2', 20000);
    await js('document.getElementById("layout-list").click()');
    await until('document.querySelectorAll("#rows img.row-thumb").length >= 2');
    await js(`document.querySelectorAll('#rows tr')[0].click()`);
    await js(`document.querySelectorAll('#rows tr')[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))`);
    await shot('folder-list');
    await js('document.getElementById("select-none").click()');
    await js('document.getElementById("layout-grid").click()');

    await until('document.querySelectorAll("#grid .note").length >= 3');
    await open('Lecture 04');
    await until('document.querySelectorAll("#reader-rail canvas").length >= 4 && document.querySelectorAll("#reader-pages canvas").length >= 1', 30000);
    await js(`document.querySelector('.rail-page[data-page="2"]').click()`);
    await shot('reader');
    await js('document.getElementById("reader-back").click()');

    await clickText('#nav-library .nav-item', 'All notes');
    await js(`(() => { const s = document.getElementById('search'); s.value = 'ideas'; s.dispatchEvent(new Event('input')); })()`);
    await appearance('dark', 'sprawl');
    await until('document.querySelectorAll("#grid .note img.note-image").length === 2');
    await shot('search-dark');
    await js(`(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);

    await appearance('dark', 'phosphor');
    await clickText('#nav-library .nav-item', 'Favorites');
    await shot('favorites-phosphor');

    await appearance('dark', 'ink');
    await js('document.getElementById("nav-settings").click()');
    await js(`document.querySelector('#settings-view .settings-body').scrollTop = 99999`);
    await shot('settings-themes');

    await appearance('light', 'ink');
    await js('document.getElementById("nav-about").click()');
    await shot('about');
    console.log('done');
  } catch (err) {
    console.error('screenshots failed:', err.message);
    process.exitCode = 1;
  } finally {
    await tablet.stop();
    fs.rmSync(profile, { recursive: true, force: true });
    app.exit(process.exitCode ?? 0);
  }
});

require('../main.js');
