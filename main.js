'use strict';

if (typeof require('electron') === 'string') {
  // Electron is running as plain Node (some IDE terminals export ELECTRON_RUN_AS_NODE=1).
  console.error('Electron APIs unavailable: unset ELECTRON_RUN_AS_NODE and run `npm start` again.');
  process.exit(1);
}

const crypto = require('node:crypto');
const { createWriteStream } = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } = require('electron');

const { RemarkableClient, DEFAULT_BASE_URL, UPLOAD_TYPES, normalizeAddress } = require('./src/remarkable');
const { exportDocuments, fetchPdf, savedCopy, savedCopies } = require('./src/sync');
const { sanitizeFileName } = require('./src/sanitize');
const { Config, FLAGS } = require('./src/config');
const { TextIndex } = require('./src/textindex');
const { combinePdfs } = require('./src/combine');
const { THEMES, themeById } = require('./src/themes');
const { SyncCancelledError, isCancelled, isNetworkError, describeError } = require('./src/errors');

// Only while the window is open, and paused during downloads. Nothing is downloaded unless the
// user clicks Download, or turned on "Download everything when the tablet connects".
const STATUS_INTERVAL_MS = 3000;
const { version: APP_VERSION } = require('./package.json');

// What the About page, the welcome dialog and the macOS About panel say.
const ABOUT = {
  tagline: 'Free and open source (MIT). Developed by Dimitrios T. (FlosForge.eu).',
  trademark:
    'reMarkable is a trademark of reMarkable AS. FlosForge ArEm Buddy is an independent project and is not affiliated with, endorsed by or sponsored by reMarkable AS.',
};
// The only pages the app opens in the browser.
const LINKS = {
  flosforge: 'https://flosforge.eu',
  source: 'https://github.com/dimitriostzr/flosforge-arem-rm-tablet-helper',
};

const RENDERER_DIR = path.join(__dirname, 'renderer');
const RENDERER_URL = pathToFileURL(RENDERER_DIR + path.sep).href;
const PRELOAD = path.join(RENDERER_DIR, 'preload.js');
// See scripts/make-icons.mjs: edge to edge for Linux/Windows; on Apple's grid for the Dock.
const APP_ICON = path.join(__dirname, 'resources', 'icon.png');
const DOCK_ICON = path.join(__dirname, 'resources', 'icon-macos.png');

const client = new RemarkableClient();
let tabletAddress = DEFAULT_BASE_URL; // effective address; set from config at startup
let config;
let textIndex; // text inside notes with a PDF here, for search (userData/text)
// "Download everything when the tablet connects": armed until it has run for this connection.
let autoDownloadArmed = true;
// Thumbnails from the tablet (GET /thumbnail/{ID}): null until one answers, false if the
// firmware has none. Reset when the address changes.
let tabletThumbs = { supported: null, misses: 0 };

const state = {
  status: 'checking', // 'checking' | 'ok' | 'busy' | 'offline' (see RemarkableClient.probe)
  job: null, // { kind: 'download' | 'thumbnails' | 'upload', phase: 'listing' | 'downloading', current, total, name, stopping }
  reading: null, // { id, name, startedAt } while a note is exported for the reader
  lastResult: null, // { ok, summary?, error?, destination, at }
};

let mainWindow = null;
let statusTimer = null;
let jobAbort = null;
let readAbort = null;
const readablePaths = new Set(); // PDFs handed to the reader (the only ones it may open externally)
let stopRequested = false;
let quitConfirmed = false;

// Last line of defence: log instead of letting Electron show a crash dialog.
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

// ---------------------------------------------------------------------------
// State shared with the pages

function snapshot() {
  return {
    status: state.status,
    job: state.job,
    lastResult: state.lastResult,
    tabletAddress,
    defaultAddress: DEFAULT_BASE_URL,
    isDefaultAddress: tabletAddress === DEFAULT_BASE_URL,
    destination: config?.destination ?? '',
    destinationDisplay: displayPath(config?.destination ?? ''),
    appearance: config?.appearance ?? { mode: 'system', theme: 'ink' },
    version: APP_VERSION,
    problem: state.status === 'ok' ? null : client.lastProblem ?? null, // why the last check failed
    showWelcome: config ? !config.data.welcomed : false,
    skipUnchanged: config?.skipUnchanged ?? true,
    rmdocBackups: config?.rmdocBackups ?? false,
    keepVersions: config?.keepVersions ?? false,
    autoDownload: config?.autoDownload ?? false,
    tablets: config?.tablets ?? [],
    tabletName: config?.tablets.find((t) => t.address === tabletAddress)?.name ?? null,
    reading: state.reading,
  };
}

function displayPath(p) {
  const home = app.getPath('home');
  return p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

function broadcast() {
  const snap = snapshot();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('state', snap);
}

function setStatus(status) {
  if (status === state.status) return;
  state.status = status;
  const why = status === 'ok' ? '' : ` (${client.lastProblem ?? 'no detail'})`;
  console.log(`${new Date().toISOString()} Tablet ${status} at ${tabletAddress}${why}`);
  if (status === 'offline') autoDownloadArmed = true; // unplugged: the next connect counts again
  broadcast();
  if (status === 'ok') maybeAutoDownload();
}

/** Downloads everything once per connection, if that's turned on in Settings. */
function maybeAutoDownload() {
  if (!autoDownloadArmed || !config?.autoDownload || state.job || state.reading) return;
  autoDownloadArmed = false;
  console.log('Tablet connected: downloading everything (Download everything when the tablet connects)');
  runDownload({ all: true, skipUnchanged: config.skipUnchanged, auto: true });
}

// ---------------------------------------------------------------------------
// Connection status

/** Probes the tablet now. Resolves to the status; never rejects. */
async function checkStatus() {
  // During a download the tablet is busy exporting; probing would only slow it down.
  if (state.job || state.reading) return state.status;
  const probedAddress = tabletAddress;
  let status = await client.probe();
  // One slow answer right after a good one is usually the tablet's wake quirk (see Waker):
  // confirm before telling the user it isn't responding.
  if (status === 'busy' && state.status === 'ok') status = await client.probe();
  // Ignore a result that raced with an address change.
  if (probedAddress === tabletAddress) setStatus(status);
  return state.status;
}

function startStatusChecks() {
  clearTimeout(statusTimer);
  let checks = 0;
  const tick = async () => {
    const started = Date.now();
    try {
      await checkStatus();
      // The first few checks are logged in full, to diagnose connection problems from a log.
      if (++checks <= 5) console.log(`${new Date().toISOString()} check ${checks}: ${state.status} in ${Date.now() - started} ms${client.lastProblem ? ` (${client.lastProblem})` : ''}`);
    } catch (err) {
      console.error('Connection check failed', err); // must not stop the checks
    }
    if (mainWindow) statusTimer = setTimeout(tick, Math.max(0, STATUS_INTERVAL_MS - (Date.now() - started)));
  };
  tick();
}

// ---------------------------------------------------------------------------
// Downloads

function setJob(job) {
  state.job = job;
  broadcast();
}

/**
 * request: { all: true } for the whole tablet, or { targets: [{ type, id, name, folders,
 * modified }] } where a folder target means everything inside it.
 */
async function runDownload({ all, targets, skipUnchanged, auto = false }) {
  const destDir = config.destination;
  // The default (Google Drive or Documents) is fixed by the first download, so it can't move
  // later, e.g. on a day Google Drive isn't running, and split the downloads in two.
  if (!config.data.destination) await config.setDestination(destDir).catch(() => {});
  stopRequested = false;
  jobAbort = new AbortController();
  const signal = jobAbort.signal;
  setJob({ kind: 'download', phase: 'listing', current: 0, total: 0, name: null, stopping: false });

  try {
    const docs = [];
    if (all) {
      docs.push(...(await client.listDocuments(signal)));
    } else {
      for (const target of targets) {
        if (stopRequested) break;
        if (target.type === 'folder') {
          const folders = [...target.folders, target.name];
          docs.push(...(await client.listDocuments(signal, { folderId: target.id, folders })));
        } else {
          docs.push({ id: target.id, name: target.name, folders: target.folders, modified: target.modified });
        }
      }
    }

    const summary = await exportDocuments({
      client,
      destDir,
      docs,
      signal,
      skipUnchanged,
      keepVersions: config.keepVersions,
      rmdoc: config.rmdocBackups,
      shouldStop: () => stopRequested,
      onProgress: (progress) => setJob({ ...state.job, phase: 'downloading', ...progress }),
    });
    console.log('Download finished', { ...summary, destination: destDir });
    state.lastResult = { kind: 'download', ok: true, summary, destination: destDir, auto, at: Date.now() };
  } catch (err) {
    if (!isCancelled(err)) {
      console.error('Download failed', err);
      state.lastResult = { kind: 'download', ok: false, error: describeError(err), summary: err.summary, destination: destDir, auto, at: Date.now() };
    }
  } finally {
    jobAbort = null;
    setJob(null);
    checkStatus();
  }
}

/**
 * Exports the PDFs of these notes ({ id, name, modified }) into the reader's preview cache, so
 * the window can draw their thumbnails. Not a download: nothing goes to the save-to folder.
 * Notes that already have a current PDF here (downloaded or cached) are skipped.
 */
async function runThumbnailJob(docs) {
  stopRequested = false;
  jobAbort = new AbortController();
  const signal = jobAbort.signal;
  const summary = { total: docs.length, downloaded: 0, unchanged: 0, failed: [], stopped: false };
  setJob({ kind: 'thumbnails', phase: 'downloading', current: 0, total: docs.length, name: null, stopping: false });
  try {
    const saved = await savedCopies(config.destination, docs).catch(() => new Map());
    for (const [index, doc] of docs.entries()) {
      if (stopRequested) {
        summary.stopped = true;
        break;
      }
      setJob({ ...state.job, current: index + 1, name: doc.name });
      if (saved.has(doc.id) || (await cachedPreview(doc))) {
        summary.unchanged += 1;
        continue;
      }
      try {
        const { pdf, meta } = previewPaths(doc);
        await fetchPdf({ client, id: doc.id, filePath: pdf, signal });
        await fsp.writeFile(meta, JSON.stringify({ modified: doc.modified, name: doc.name }));
        summary.downloaded += 1;
      } catch (err) {
        if (isCancelled(err)) throw err;
        if (isNetworkError(err) && !(await client.isReachable())) throw err; // the tablet went away
        summary.failed.push({ id: doc.id, name: doc.name, error: describeError(err) });
      }
    }
    console.log('Thumbnails fetched', summary);
    state.lastResult = { kind: 'thumbnails', ok: true, summary, at: Date.now() };
  } catch (err) {
    if (!isCancelled(err)) {
      console.error('Fetching thumbnails failed', err);
      state.lastResult = { kind: 'thumbnails', ok: false, error: describeError(err), summary, at: Date.now() };
    }
  } finally {
    jobAbort = null;
    setJob(null);
    checkStatus();
  }
}

/** Uploads files (absolute paths, already checked) into a folder ({ id, name }; id null = top level). */
async function runUploadJob(files, folder) {
  stopRequested = false;
  jobAbort = new AbortController();
  const signal = jobAbort.signal;
  const summary = { total: files.length, downloaded: 0, unchanged: 0, failed: [], stopped: false };
  setJob({ kind: 'upload', phase: 'downloading', current: 0, total: files.length, name: null, stopping: false });
  try {
    for (const [index, file] of files.entries()) {
      if (stopRequested) {
        summary.stopped = true;
        break;
      }
      const name = path.basename(file);
      setJob({ ...state.job, current: index + 1, name });
      try {
        await client.upload(file, folder.id, signal);
        summary.downloaded += 1; // "done" count, shared with the other jobs' summaries
      } catch (err) {
        if (isCancelled(err)) throw err;
        if (isNetworkError(err) && !(await client.isReachable())) throw err;
        summary.failed.push({ id: name, name, error: describeError(err) });
      }
    }
    console.log('Upload finished', { ...summary, folder: folder.name });
    state.lastResult = { kind: 'upload', ok: true, summary, folder: folder.name, at: Date.now() };
  } catch (err) {
    if (!isCancelled(err)) {
      console.error('Upload failed', err);
      state.lastResult = { kind: 'upload', ok: false, error: describeError(err), summary, folder: folder.name, at: Date.now() };
    }
  } finally {
    jobAbort = null;
    setJob(null);
    checkStatus();
  }
}

/**
 * A current PDF of each note ({ id, name, modified }): an earlier download, the reader's cache,
 * or a fresh export into that cache. Calls onNote(index, doc) before each.
 * Resolves to [{ doc, file }] and fills `failed`; rejects if the tablet goes away.
 */
async function pdfsFor(docs, { signal, failed, onNote = () => {} }) {
  const saved = await savedCopies(config.destination, docs).catch(() => new Map());
  const found = [];
  for (const [index, doc] of docs.entries()) {
    if (stopRequested) break;
    onNote(index, doc);
    const existing = saved.get(doc.id) ?? (await cachedPreview(doc));
    if (existing) {
      found.push({ doc, file: existing });
      continue;
    }
    try {
      const { pdf, meta } = previewPaths(doc);
      await fetchPdf({ client, id: doc.id, filePath: pdf, signal });
      await fsp.writeFile(meta, JSON.stringify({ modified: doc.modified, name: doc.name }));
      found.push({ doc, file: pdf });
    } catch (err) {
      if (isCancelled(err)) throw err;
      if (isNetworkError(err) && !(await client.isReachable())) throw err;
      failed.push({ id: doc.id, name: doc.name, error: describeError(err) });
    }
  }
  return found;
}

/** Joins the PDFs of these notes, in this order, into one PDF at outPath. */
async function runCombineJob(docs, outPath) {
  stopRequested = false;
  jobAbort = new AbortController();
  const signal = jobAbort.signal;
  const summary = { total: docs.length, downloaded: 0, unchanged: 0, failed: [], stopped: false };
  const result = { kind: 'combine', file: outPath, fileDisplay: displayPath(outPath) };
  setJob({ kind: 'combine', phase: 'downloading', current: 0, total: docs.length, name: null, stopping: false });
  try {
    const parts = await pdfsFor(docs, {
      signal,
      failed: summary.failed,
      onNote: (index, doc) => setJob({ ...state.job, current: index + 1, name: doc.name }),
    });
    if (stopRequested) {
      // Stopped while getting the PDFs: nothing is written.
      state.lastResult = { ...result, ok: true, summary: { ...summary, stopped: true }, pages: 0, at: Date.now() };
      return;
    }
    setJob({ ...state.job, phase: 'combining', name: path.basename(outPath) });
    const { pages, failed } = await combinePdfs(
      parts.map(({ doc, file }) => ({ file, name: doc.name })),
      outPath,
      { title: path.basename(outPath, '.pdf') }
    );
    summary.failed.push(...failed);
    summary.downloaded = parts.length - failed.length;
    console.log('Combined', { ...summary, pages, file: outPath });
    state.lastResult = { ...result, ok: true, summary, pages, at: Date.now() };
  } catch (err) {
    if (!isCancelled(err)) {
      console.error('Combining failed', err);
      state.lastResult = { ...result, ok: false, error: describeError(err), summary, at: Date.now() };
    }
  } finally {
    jobAbort = null;
    setJob(null);
    checkStatus();
  }
}

/** Saves the tablet's own log (GET /log.txt) where the user picks, with a short header. */
async function saveTabletLog(parentWindow) {
  const blocked = uploadBlocked();
  if (blocked) return { error: blocked };
  const today = new Date().toISOString().slice(0, 10);
  const { canceled, filePath } = await dialog.showSaveDialog(parentWindow, {
    title: 'Save the tablet log',
    defaultPath: path.join(app.getPath('downloads'), `reMarkable log ${today}.txt`),
    filters: [{ name: 'Text', extensions: ['txt'] }],
  });
  if (canceled || !filePath) return {};
  const header = [
    `FlosForge ArEm Buddy ${APP_VERSION} on ${process.platform} ${process.getSystemVersion?.() ?? ''}`,
    `Tablet address: ${tabletAddress}`,
    `Saved: ${new Date().toISOString()}`,
    '',
    '',
  ].join('\n');
  const tmp = `${filePath}.part`;
  const log = await client.openLog();
  try {
    await fsp.writeFile(tmp, header);
    await pipeline(log.stream, new Transform({ transform: (chunk, _enc, done) => (log.onChunk(), done(null, chunk)) }), createWriteStream(tmp, { flags: 'a' }));
    await fsp.rename(tmp, filePath);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  } finally {
    log.done();
  }
  shell.showItemInFolder(filePath);
  return { saved: displayPath(filePath) };
}

// PNG export from the reader: the window draws each page and sends it; it's written into the
// folder picked in the dialog (and nowhere else).
let pngExport = null; // { token, dir, base }

async function choosePngFolder(parentWindow, name) {
  const { canceled, filePaths } = await dialog.showOpenDialog(parentWindow, {
    title: 'Choose a folder for the PNGs',
    buttonLabel: 'Export Here',
    defaultPath: app.getPath('downloads'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths[0]) return {};
  const base = sanitizeFileName(String(name).replace(/\.pdf$/i, ''));
  pngExport = { token: crypto.randomUUID(), dir: filePaths[0], base, first: null };
  return { token: pngExport.token, dir: displayPath(filePaths[0]) };
}

async function writePngPage(token, page, total, bytes) {
  if (!pngExport || token !== pngExport.token) throw new Error('Choose a folder first');
  const pad = String(total).length;
  const file = path.join(pngExport.dir, `${pngExport.base} - page ${String(page).padStart(pad, '0')}.png`);
  await fsp.writeFile(file, bytes);
  pngExport.first ??= file;
  return {};
}

/** Keeps only regular files of a type the tablet accepts. */
async function uploadable(paths) {
  const files = [];
  const rejected = [];
  for (const file of Array.isArray(paths) ? paths.slice(0, 500) : []) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) continue;
    const ext = path.extname(file).slice(1).toLowerCase();
    const stat = await fsp.stat(file).catch(() => null);
    if (stat?.isFile() && UPLOAD_TYPES[ext]) files.push(file);
    else rejected.push(path.basename(file));
  }
  return { files, rejected };
}

function parseFolder(folder) {
  const id = folder?.id === null || isNoteId(folder?.id) ? folder.id : undefined;
  if (id === undefined) throw new Error('Bad folder');
  return { id, name: typeof folder.name === 'string' && folder.name.length < 1000 ? folder.name : 'My files' };
}

function uploadBlocked() {
  if (state.job) return 'Wait for the current job to finish.';
  if (state.reading) return 'Wait for the note you opened to finish exporting.';
  if (state.status !== 'ok') return 'The tablet is not connected.';
  return null;
}

/** Validates what the page sent; returns a clean request or throws. */
function parseDownloadRequest(request) {
  const skipUnchanged = request?.skipUnchanged !== false;
  if (request?.all === true) return { all: true, skipUnchanged };
  const isString = (v) => typeof v === 'string' && v.length > 0 && v.length < 1000;
  const targets = Array.isArray(request?.targets) ? request.targets : [];
  const clean = targets
    .filter((t) => (t?.type === 'folder' || t?.type === 'notebook') && isString(t.id) && isString(t.name))
    .map((t) => ({
      type: t.type,
      id: t.id,
      name: t.name,
      folders: Array.isArray(t.folders) ? t.folders.filter(isString) : [],
      modified: isString(t.modified) ? t.modified : null,
    }));
  if (!clean.length) throw new Error('Nothing selected');
  return { targets: clean, skipUnchanged };
}

// ---------------------------------------------------------------------------
// Reading a note in the app

/**
 * Finds or makes a PDF of one notebook for the in-app reader: the copy from an earlier
 * download if it's current, else a cached export, else a fresh export from the tablet.
 */
/** The reader's export cache: previews/<id>/<note name>.pdf (the file name shows in "Open in PDF app"). */
function previewPaths(doc) {
  const dir = path.join(app.getPath('userData'), 'previews', doc.id);
  return {
    pdf: path.join(dir, `${sanitizeFileName(String(doc.name).replace(/\.pdf$/i, ''))}.pdf`),
    meta: path.join(dir, 'note.json'),
  };
}

/** The cached export of this version of the note, if there is one. */
async function cachedPreview(doc) {
  const { pdf, meta } = previewPaths(doc);
  const cached = await fsp
    .readFile(meta, 'utf8')
    .then(JSON.parse)
    .catch(() => null);
  const current = cached && doc.modified && cached.modified === doc.modified && cached.name === doc.name;
  return current && (await fsp.stat(pdf).catch(() => null)) ? pdf : null;
}

async function openNote(doc) {
  const { pdf, meta } = previewPaths(doc);
  const ready = (file, source) => {
    readablePaths.add(file);
    return { url: pathToFileURL(file).href, path: file, source };
  };

  const saved = await savedCopy(config.destination, doc).catch(() => null);
  if (saved) return ready(saved, 'saved');
  const cached = await cachedPreview(doc);
  if (cached) return ready(cached, 'cache');

  readAbort?.abort(new SyncCancelledError()); // only one note at a time
  const controller = new AbortController();
  readAbort = controller;
  state.reading = { id: doc.id, name: doc.name, startedAt: Date.now() };
  broadcast();
  try {
    await fetchPdf({ client, id: doc.id, filePath: pdf, signal: controller.signal });
    await fsp.writeFile(meta, JSON.stringify({ modified: doc.modified, name: doc.name }));
    return ready(pdf, 'tablet');
  } catch (err) {
    if (isCancelled(err)) return { cancelled: true };
    console.error('Opening note failed', err);
    return { error: describeError(err) };
  } finally {
    if (readAbort === controller) {
      readAbort = null;
      state.reading = null;
      broadcast();
      checkStatus();
    }
  }
}

// ---------------------------------------------------------------------------
// Thumbnails: page 1 of notes that have a current PDF on this computer. The window draws
// them with pdf.js; they're stored per note version (id + modified), with the page count.

const isNoteId = (id) => typeof id === 'string' && /^[\w-]{1,100}$/.test(id);
const thumbDir = () => path.join(app.getPath('userData'), 'thumbnails');
const thumbBase = (doc) =>
  path.join(thumbDir(), `${doc.id}-${crypto.createHash('sha1').update(String(doc.modified)).digest('hex').slice(0, 12)}`);

const TABLET_THUMB_TYPES = ['png', 'jpeg', 'webp'];

/** The thumbnail the tablet gave for this version of the note, if there is one. */
async function tabletThumbFile(doc) {
  for (const type of TABLET_THUMB_TYPES) {
    const file = `${thumbBase(doc)}-tablet.${type}`;
    if (await fsp.stat(file).catch(() => null)) return file;
  }
  return null;
}

/**
 * For each note ({ id, name, modified }), what this computer has for this version:
 *   thumb, pages   a thumbnail drawn from its PDF (pages: the page count)
 *   thumb, tablet  else, the tablet's own thumbnail
 *   pdf            a current PDF, when there's still a thumbnail to draw or text to index
 *   indexed        its text is in the search index
 * Notes with none of these are left out.
 */
async function localNotes(docs) {
  const saved = await savedCopies(config.destination, docs).catch(() => new Map());
  const notes = {};
  await Promise.all(
    docs.map(async (doc) => {
      if (!doc.modified) return; // no way to tell versions apart
      const base = thumbBase(doc);
      const note = {};
      const meta = await fsp
        .readFile(`${base}.json`, 'utf8')
        .then(JSON.parse)
        .catch(() => null);
      if (meta && (await fsp.stat(`${base}.webp`).catch(() => null))) {
        Object.assign(note, { thumb: pathToFileURL(`${base}.webp`).href, pages: meta.pages ?? null });
      } else {
        const fromTablet = await tabletThumbFile(doc);
        if (fromTablet) Object.assign(note, { thumb: pathToFileURL(fromTablet).href, tablet: true });
      }
      note.indexed = await textIndex.has(doc);
      if (!note.pages || !note.indexed) {
        const pdf = saved.get(doc.id) ?? (await cachedPreview(doc));
        if (pdf) {
          readablePaths.add(pdf);
          note.pdf = pdf;
        }
      }
      if (note.thumb || note.pdf || note.indexed) notes[doc.id] = note;
    })
  );
  return notes;
}

/** Removes thumbnails of other versions of this note. */
async function dropStaleThumbnails(doc) {
  const keep = path.basename(thumbBase(doc));
  const stale = (await fsp.readdir(thumbDir()).catch(() => [])).filter((f) => f.startsWith(`${doc.id}-`) && !f.startsWith(keep));
  await Promise.all(stale.map((f) => fsp.rm(path.join(thumbDir(), f), { force: true })));
}

/**
 * Fetches the tablet's thumbnails of these notes, one at a time, stopping early if a job
 * starts or a note is opened. Resolves to { thumbs: { id: url }, failed: [id], unsupported?, paused? }.
 */
async function fetchTabletThumbnails(docs) {
  const thumbs = {};
  const failed = [];
  if (tabletThumbs.supported === false) return { thumbs, failed, unsupported: true };
  await fsp.mkdir(thumbDir(), { recursive: true });
  const address = tabletAddress;
  for (const doc of docs) {
    if (state.job || state.reading || state.status !== 'ok' || address !== tabletAddress) return { thumbs, failed, paused: true };
    try {
      const { bytes, type } = await client.fetchThumbnail(doc.id);
      if (address !== tabletAddress) return { thumbs, failed, paused: true };
      tabletThumbs.supported = true;
      await dropStaleThumbnails(doc);
      const file = `${thumbBase(doc)}-tablet.${type}`;
      await fsp.writeFile(file, bytes);
      thumbs[doc.id] = pathToFileURL(file).href;
    } catch (err) {
      // A hiccup (timeout, 408, dropped connection) isn't a missing thumbnail: try again later.
      if (isNetworkError(err)) return { thumbs, failed, paused: true };
      failed.push(doc.id);
      // No answer that's an image for the first few notes: this firmware has none.
      const missing = (err.name === 'HttpError' && (err.status === 400 || err.status === 404)) || /not return an image/.test(err.message);
      if (missing && tabletThumbs.supported === null && ++tabletThumbs.misses >= 3) {
        tabletThumbs.supported = false;
        console.log('The tablet has no thumbnails (GET /thumbnail/{ID}); using PDFs only');
        return { thumbs, failed, unsupported: true };
      }
    }
  }
  return { thumbs, failed };
}

async function saveThumbnail(doc, image, pages) {
  const base = thumbBase(doc);
  await fsp.mkdir(thumbDir(), { recursive: true });
  await dropStaleThumbnails(doc);
  await fsp.writeFile(`${base}.webp`, image);
  await fsp.writeFile(`${base}.json`, JSON.stringify({ pages, name: doc.name }));
  return { thumb: pathToFileURL(`${base}.webp`).href, pages };
}

// ---------------------------------------------------------------------------
// Windows

// The system title bar is hidden. On macOS the traffic lights sit over the top of the sidebar
// (app.css keeps that strip clear); elsewhere the window buttons are drawn over the top-right
// corner of the page, in the page's own colours (app.css pads the page headers for them).
const IS_MAC = process.platform === 'darwin';
const OVERLAY_HEIGHT = 44; // = --overlay-height in app.css

// The palette in use: the chosen theme, in light or dark (nativeTheme follows the System /
// Light / Dark setting through themeSource).
function palette() {
  const theme = themeById(config?.appearance.theme);
  return nativeTheme.shouldUseDarkColors ? theme.dark : theme.light;
}
const pageBackground = () => palette().background;

function overlayColors() {
  const p = palette();
  return { color: p.background, symbolColor: p.foreground, height: OVERLAY_HEIGHT };
}

/** Repaints what the main process draws (window background, window buttons) in the theme. */
function applyWindowTheme() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setBackgroundColor(pageBackground());
  if (!IS_MAC) mainWindow.setTitleBarOverlay(overlayColors());
}

function windowChrome() {
  const backgroundColor = pageBackground(); // no flash of another colour while loading
  if (IS_MAC) return { backgroundColor, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } };
  return { backgroundColor, titleBarStyle: 'hidden', titleBarOverlay: overlayColors() };
}

// Keep the window in step with light/dark mode (the system's, or the setting's).
nativeTheme.on('updated', applyWindowTheme);

const securePreferences = () => ({
  preload: PRELOAD,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
});

function lockDown(win) {
  // Local pages only: no navigation, no popups.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 860,
    minHeight: 560,
    title: 'FlosForge ArEm Buddy',
    icon: APP_ICON, // Linux/Windows window icon (macOS uses the bundle's .icns)
    show: false,
    ...windowChrome(),
    webPreferences: securePreferences(),
  });
  lockDown(mainWindow);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', confirmCloseDuringDownload);
  mainWindow.on('closed', () => {
    mainWindow = null;
    clearTimeout(statusTimer);
  });
  mainWindow.loadFile(path.join(RENDERER_DIR, 'app.html')).catch(() => {});
  startStatusChecks();
}

/** Closing mid-download interrupts the tablet's export, which can leave it busy for minutes. */
function confirmCloseDuringDownload(event) {
  if (!state.job || quitConfirmed) return;
  event.preventDefault();
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'warning',
    buttons: ['Keep Downloading', 'Quit Anyway'],
    defaultId: 0,
    cancelId: 0,
    message: 'A download is in progress.',
    detail:
      'Quitting now interrupts the tablet while it exports a PDF; it may stay unresponsive for a few minutes. ' +
      'To stop cleanly, click Stop and wait for the current notebook to finish.',
  });
  if (choice === 1) {
    quitConfirmed = true;
    jobAbort?.abort(new SyncCancelledError());
    readAbort?.abort(new SyncCancelledError());
    app.quit();
  }
}

async function openDestination() {
  const error = await shell.openPath(config.destination);
  return error ? { error } : {};
}

async function chooseDestination(parentWindow) {
  if (state.job) return { error: 'Wait for the download to finish.' };
  const { canceled, filePaths } = await dialog.showOpenDialog(parentWindow, {
    title: 'Choose where to save the PDFs',
    defaultPath: config.destination,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths[0]) return {};
  await config.setDestination(filePaths[0]);
  broadcast();
  return {};
}

/** Switches to a new tablet address and re-checks the connection there. */
function applyTabletAddress(address) {
  if (address === tabletAddress) return;
  tabletAddress = address;
  client.setBaseUrl(address);
  autoDownloadArmed = true;
  tabletThumbs = { supported: null, misses: 0 };
  console.log(`Tablet address set to ${address}`);
  state.status = 'checking';
  broadcast();
  checkStatus();
}

// ---------------------------------------------------------------------------
// IPC (from the app's own pages only)

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    const url = event.senderFrame?.url ?? '';
    if (!url.startsWith(RENDERER_URL)) throw new Error(`Blocked IPC "${channel}" from ${url || 'unknown sender'}`);
    try {
      return await fn(event, ...args);
    } catch (err) {
      return { error: describeError(err) };
    }
  });
}

function registerIpc() {
  handle('state:get', () => snapshot());
  handle('connection:check', async () => ({ status: await checkStatus() }));

  handle('tablet:library', async () => {
    try {
      return { library: await client.library() };
    } catch (err) {
      checkStatus();
      return { error: describeError(err) };
    }
  });

  handle('download:start', (_event, request) => {
    if (state.job) return { error: 'A download is already running.' };
    if (state.reading) return { error: 'Wait for the note you opened to finish exporting.' };
    if (state.status !== 'ok') return { error: 'The tablet is not connected.' };
    runDownload({ ...parseDownloadRequest(request), skipUnchanged: config.skipUnchanged }); // progress arrives via 'state'
    return { started: true };
  });

  handle('notes:local', async (_event, docs) => {
    if (!Array.isArray(docs) || docs.length > 20000) throw new Error('Bad notes');
    const clean = docs
      .filter((d) => isNoteId(d?.id) && typeof d.name === 'string' && typeof d.modified === 'string')
      .map((d) => ({ id: d.id, name: d.name, modified: d.modified }));
    return { notes: await localNotes(clean) };
  });

  handle('thumbs:save', async (_event, doc, image, pages) => {
    const valid = isNoteId(doc?.id) && typeof doc.modified === 'string' && typeof doc.name === 'string';
    if (!valid || !(image instanceof Uint8Array) || image.length > 5_000_000) throw new Error('Bad thumbnail');
    return saveThumbnail(doc, image, Number.isInteger(pages) && pages > 0 ? pages : null);
  });

  handle('note:open', async (_event, doc) => {
    const valid = isNoteId(doc?.id) && typeof doc.name === 'string' && doc.name.length < 1000;
    if (!valid) throw new Error('Bad note');
    if (state.job) return { error: 'Wait for the download to finish.' };
    if (state.status !== 'ok') return { error: 'The tablet is not connected.' };
    return openNote({ id: doc.id, name: doc.name, modified: typeof doc.modified === 'string' ? doc.modified : null });
  });

  handle('note:cancel', () => {
    readAbort?.abort(new SyncCancelledError());
    return {};
  });

  // The reader renders the PDF itself (pdf.js), so it needs the bytes.
  handle('note:read', async (_event, file) => {
    if (!readablePaths.has(file)) throw new Error('Unknown file');
    return { bytes: new Uint8Array(await fsp.readFile(file)) };
  });

  handle('note:external', async (_event, file) => {
    if (!readablePaths.has(file)) throw new Error('Unknown file');
    const error = await shell.openPath(file);
    return error ? { error } : {};
  });

  handle('themes:list', () => ({ themes: THEMES }));

  handle('welcome:done', async () => {
    config.data.welcomed = true;
    await config.save();
    broadcast();
    return {};
  });

  handle('open:link', (_event, name) => {
    if (!Object.hasOwn(LINKS, name)) throw new Error('Unknown link');
    shell.openExternal(LINKS[name]).catch(() => {});
    return {};
  });

  // LICENSE and THIRD_PARTY_NOTICES.md ship with the app: next to main.js (inside the archive),
  // or in the app's resources folder (electron-builder puts the notices there). They're copied
  // out to a temporary file the system viewer can open.
  handle('open:licenses', async () => {
    const out = path.join(app.getPath('temp'), 'FlosForge ArEm Buddy licenses.md');
    const read = async (name) => {
      for (const dir of [__dirname, process.resourcesPath]) {
        const text = await fsp.readFile(path.join(dir, name), 'utf8').catch(() => null);
        if (text !== null) return text;
      }
      throw new Error(`${name} is missing from this copy of the app`);
    };
    const [license, notices] = await Promise.all(['LICENSE', 'THIRD_PARTY_NOTICES.md'].map(read));
    await fsp.writeFile(out, `# FlosForge ArEm Buddy\n\n\`\`\`\n${license}\`\`\`\n\n${notices}`);
    const error = await shell.openPath(out);
    return error ? { error } : {};
  });

  // Chromium's (and Electron's other components') licenses: next to the app on Windows and
  // Linux, in Resources on macOS (scripts/after-pack.cjs), in node_modules when run from source.
  handle('open:chromium-licenses', async () => {
    const candidates = [
      path.join(process.resourcesPath, 'LICENSES.chromium.html'),
      path.join(path.dirname(process.execPath), 'LICENSES.chromium.html'),
      path.join(__dirname, 'node_modules', 'electron', 'dist', 'LICENSES.chromium.html'),
    ];
    for (const file of candidates) {
      if (await fsp.stat(file).catch(() => null)) {
        const error = await shell.openPath(file);
        return error ? { error } : {};
      }
    }
    return { error: 'The Chromium license file is missing from this copy of the app' };
  });

  handle('appearance:set', async (_event, change) => {
    const appearance = await config.setAppearance(change ?? {});
    nativeTheme.themeSource = appearance.mode; // the page's prefers-color-scheme follows
    applyWindowTheme();
    broadcast();
    return { appearance };
  });

  handle('settings:skip-unchanged', async (_event, value) => {
    await config.setSkipUnchanged(value === true);
    broadcast();
    return {};
  });

  handle('settings:flag', async (_event, name, value) => {
    if (!FLAGS.includes(name)) throw new Error('Unknown setting');
    await config.setFlag(name, value === true);
    broadcast();
    return {};
  });

  handle('tablets:save', async (_event, name, address) => {
    await config.saveTablet(name, address);
    broadcast();
    return {};
  });

  handle('tablets:remove', async (_event, address) => {
    await config.removeTablet(String(address));
    broadcast();
    return {};
  });

  handle('tablets:use', async (_event, address) => {
    if (state.job) return { error: 'Wait for the download to finish.' };
    if (!config.tablets.some((t) => t.address === address)) throw new Error('Unknown tablet');
    applyTabletAddress(await config.setTabletAddress(address));
    return {};
  });

  handle('tablet:log', (event) => saveTabletLog(BrowserWindow.fromWebContents(event.sender)));

  handle('thumbs:tablet', (_event, docs) => {
    if (state.status !== 'ok') return { thumbs: {}, failed: [], paused: true };
    const clean = (Array.isArray(docs) ? docs : [])
      .slice(0, 24)
      .filter((d) => isNoteId(d?.id) && typeof d.modified === 'string')
      .map((d) => ({ id: d.id, modified: d.modified }));
    return fetchTabletThumbnails(clean);
  });

  handle('text:save', async (_event, doc, text) => {
    if (!isNoteId(doc?.id) || typeof doc.modified !== 'string' || typeof text !== 'string') throw new Error('Bad text');
    await textIndex.save({ id: doc.id, modified: doc.modified }, text);
    return {};
  });

  handle('text:search', async (_event, query) => ({ hits: await textIndex.search(String(query ?? '').slice(0, 500)) }));

  handle('combine:start', async (event, docs) => {
    const blocked = uploadBlocked();
    if (blocked) return { error: blocked };
    const clean = (Array.isArray(docs) ? docs : [])
      .filter((d) => isNoteId(d?.id) && typeof d.name === 'string' && d.name.length < 1000 && typeof d.modified === 'string')
      .map((d) => ({ id: d.id, name: d.name, modified: d.modified }));
    if (clean.length < 2) return { error: 'Select at least two notes to combine.' };
    const today = new Date().toISOString().slice(0, 10);
    const folder = await fsp.stat(config.destination).then((s) => s.isDirectory(), () => false);
    const { canceled, filePath } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: `Combine ${clean.length} notes into one PDF`,
      buttonLabel: 'Combine',
      defaultPath: path.join(folder ? config.destination : app.getPath('downloads'), `Combined notes ${today}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return {};
    if (state.job) return { error: 'Wait for the current job to finish.' };
    runCombineJob(clean, filePath.toLowerCase().endsWith('.pdf') ? filePath : `${filePath}.pdf`); // progress arrives via 'state'
    return { started: true };
  });

  handle('export:png-folder', (event, name) => {
    if (typeof name !== 'string' || name.length > 1000) throw new Error('Bad name');
    return choosePngFolder(BrowserWindow.fromWebContents(event.sender), name);
  });

  handle('export:png-page', (_event, token, page, total, bytes) => {
    const valid = Number.isInteger(page) && Number.isInteger(total) && page >= 1 && page <= total && total <= 10000;
    if (!valid || !(bytes instanceof Uint8Array) || bytes.length > 100_000_000) throw new Error('Bad page');
    return writePngPage(token, page, total, bytes);
  });

  handle('export:png-show', (_event, token) => {
    if (pngExport?.token === token && pngExport.first) shell.showItemInFolder(pngExport.first);
    return {};
  });

  // "Open folder" / "Show file" on the result strip.
  handle('result:show', () => {
    const result = state.lastResult;
    if (result?.kind === 'combine' && result.ok) shell.showItemInFolder(result.file);
    else return openDestination();
    return {};
  });

  handle('thumbs:fetch', (_event, docs) => {
    if (state.job) return { error: 'Wait for the download to finish.' };
    if (state.reading) return { error: 'Wait for the note you opened to finish exporting.' };
    if (state.status !== 'ok') return { error: 'The tablet is not connected.' };
    const clean = (Array.isArray(docs) ? docs : [])
      .filter((d) => isNoteId(d?.id) && typeof d.name === 'string' && d.name.length < 1000 && typeof d.modified === 'string')
      .map((d) => ({ id: d.id, name: d.name, modified: d.modified }));
    if (!clean.length) return { error: 'Nothing selected' };
    runThumbnailJob(clean); // progress arrives via 'state'
    return { started: true };
  });

  // Pick files with the system dialog, then upload them into `folder`.
  handle('upload:choose', async (event, folderInput) => {
    const folder = parseFolder(folderInput);
    const blocked = uploadBlocked();
    if (blocked) return { error: blocked };
    const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: `Upload to ${folder.name}`,
      buttonLabel: 'Upload',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PDF, EPUB or reMarkable document', extensions: Object.keys(UPLOAD_TYPES) }],
    });
    if (canceled || !filePaths.length) return {};
    const blockedNow = uploadBlocked(); // something may have started while the picker was open
    if (blockedNow) return { error: blockedNow };
    const { files, rejected } = await uploadable(filePaths);
    if (files.length) runUploadJob(files, folder);
    return { started: files.length > 0, rejected };
  });

  // Files dropped on the window (their paths come from the preload's webUtils).
  handle('upload:files', async (_event, paths, folderInput) => {
    const folder = parseFolder(folderInput);
    const blocked = uploadBlocked();
    if (blocked) return { error: blocked };
    const { files, rejected } = await uploadable(paths);
    if (files.length) runUploadJob(files, folder);
    return { started: files.length > 0, rejected };
  });

  handle('download:stop', () => {
    if (!state.job) return {};
    stopRequested = true;
    setJob({ ...state.job, stopping: true });
    return {};
  });

  handle('address:test', async (_event, input) => {
    const address = normalizeAddress(input);
    const probe = new RemarkableClient({ baseUrl: address, probeTimeoutMs: 3000, listTimeoutMs: 8000 });
    const status = await probe.probe();
    if (status !== 'ok') return { address, status, problem: probe.lastProblem };
    try {
      await probe.listFolder(null);
      return { address, status, found: true };
    } catch (err) {
      return { address, status, found: false, detail: describeError(err) };
    }
  });

  handle('address:save', async (_event, input) => {
    if (state.job) return { error: 'Wait for the download to finish.' };
    applyTabletAddress(await config.setTabletAddress(input));
    return { state: snapshot() };
  });

  handle('address:reset', async () => {
    if (state.job) return { error: 'Wait for the download to finish.' };
    applyTabletAddress(await config.resetTabletAddress());
    return { state: snapshot() };
  });

  handle('destination:choose', (event) => chooseDestination(BrowserWindow.fromWebContents(event.sender)));
  handle('destination:open', () => openDestination());
}

// ---------------------------------------------------------------------------
// App lifecycle

if (!app.requestSingleInstanceLock()) {
  console.log('FlosForge ArEm Buddy is already running; switching to its window.');
  app.quit();
} else {
  app.whenReady().then(async () => {
    // A packaged app shows its .icns in the Dock; `npm start` would show Electron's.
    if (IS_MAC && !app.isPackaged) app.dock?.setIcon(DOCK_ICON);
    app.setAboutPanelOptions({
      applicationName: 'FlosForge ArEm Buddy',
      applicationVersion: APP_VERSION,
      copyright: 'Copyright © 2026 Dimitrios T. (FlosForge.eu)',
      credits: `${ABOUT.tagline}\n\n${ABOUT.trademark}`,
      iconPath: APP_ICON, // Linux/Windows; macOS uses the app icon
    });
    console.log(`FlosForge ArEm Buddy ${APP_VERSION} on ${process.platform} ${process.getSystemVersion?.() ?? ''}, Electron ${process.versions.electron}, tablet address ${process.env.RM_HOST || '(saved)'}`);
    config = await new Config(app.getPath('userData')).load();
    textIndex = new TextIndex(path.join(app.getPath('userData'), 'text'));
    nativeTheme.themeSource = config.appearance.mode;
    // RM_HOST (e.g. a mock tablet, see test/mock-tablet.js) overrides the saved address for
    // this session only; saving an address in Settings replaces it.
    tabletAddress = process.env.RM_HOST ? normalizeAddress(process.env.RM_HOST) : config.tabletAddress;
    client.setBaseUrl(tabletAddress);

    // No View > Zoom: ⌘+ / ⌘− / ⌘0 belong to the reader. macOS still needs Edit for copy/paste.
    Menu.setApplicationMenu(
      IS_MAC
        ? Menu.buildFromTemplate([
            { role: 'appMenu' },
            { role: 'editMenu' },
            { label: 'View', submenu: [{ role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }])] },
            { role: 'windowMenu' },
          ])
        : null
    );
    registerIpc();
    createMainWindow();
  });

  app.on('second-instance', () => {
    if (!mainWindow) return createMainWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  // macOS: clicking the Dock icon with no window open.
  app.on('activate', () => {
    if (!mainWindow && config) createMainWindow();
  });

  // Nothing runs without the window: closing it quits.
  app.on('window-all-closed', () => app.quit());
}
