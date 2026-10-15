'use strict';

const { test, describe, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { RemarkableClient, normalizeAddress, DEFAULT_BASE_URL } = require('../src/remarkable');
const { Config } = require('../src/config');
const { syncAll, exportDocuments, fetchPdf, savedCopy, savedCopies, MANIFEST_NAME, TEMP_SUFFIX, VERSIONS_DIR } = require('../src/sync');
const { TextIndex, foldText } = require('../src/textindex');
const { combinePdfs } = require('../src/combine');
const { sanitizeFileName } = require('../src/sanitize');
const { SyncCancelledError, isNetworkError, isCancelled, isFatalDiskError } = require('../src/errors');
const { createMockTablet, fakePdf, fakeRmdoc, TINY_PNG } = require('./mock-tablet');

// pdf-lib (for Combine) may be missing where node_modules was installed before it was added.
const pdfLib = (() => {
  try {
    return require('pdf-lib');
  } catch {
    return null;
  }
})();

// Any rejection nobody handled fails the run (on top of Node's default crash-on-unhandled).
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));
after(() => assert.deepEqual(unhandled, [], 'there were unhandled promise rejections'));

const FAST = { probeTimeoutMs: 300, listTimeoutMs: 1000, responseTimeoutMs: 1000, stallTimeoutMs: 300 };

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'rm-sync-test-'));
}

async function closedPortUrl() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

/** Accepts TCP connections and never answers: what a half-dead USB link looks like. */
async function blackHole() {
  const sockets = new Set();
  const server = net.createServer((s) => sockets.add(s));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      sockets.forEach((s) => s.destroy());
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/** All non-hidden files under dir, as sorted "a/b/c.pdf" paths. */
const visibleFiles = async (dir) =>
  (await fsp.readdir(dir, { recursive: true }))
    .map((f) => f.split(path.sep).join('/'))
    .filter((f) => !f.split('/').some((part) => part.startsWith('.')) && f.endsWith('.pdf'))
    .sort();
const tempFilesIn = async (dir) => (await fsp.readdir(dir, { recursive: true })).filter((f) => f.endsWith(TEMP_SUFFIX));

describe('sanitizeFileName', () => {
  test('replaces invalid path characters with -', () => {
    assert.equal(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
  });
  test('handles hidden-file dots, trailing dots, control chars, empty', () => {
    assert.equal(sanitizeFileName('..secret'), 'secret');
    assert.equal(sanitizeFileName('Notes...  '), 'Notes');
    assert.equal(sanitizeFileName('a\nb\tc'), 'a-b-c');
    assert.equal(sanitizeFileName('   '), 'Untitled');
    assert.equal(sanitizeFileName(undefined), 'Untitled');
  });
  test('Windows device names get a dash', () => {
    for (const name of ['CON', 'nul', 'Com1', 'LPT9']) assert.equal(sanitizeFileName(name), `${name}-`);
    assert.equal(sanitizeFileName('Console'), 'Console');
  });

  test('caps length without splitting multi-byte characters', () => {
    const out = sanitizeFileName('📓'.repeat(100));
    assert.ok(Buffer.byteLength(out) <= 200);
    assert.equal(out, '📓'.repeat(50));
  });
});

describe('normalizeAddress', () => {
  test('adds http:// and strips trailing slashes', () => {
    assert.equal(normalizeAddress('10.11.99.1'), 'http://10.11.99.1');
    assert.equal(normalizeAddress(' http://10.11.99.1/ '), 'http://10.11.99.1');
    assert.equal(normalizeAddress('https://tablet.local:8443/'), 'https://tablet.local:8443');
  });
  test('rejects empty, non-http and junk input', () => {
    assert.throws(() => normalizeAddress(''), /Enter the tablet address/);
    assert.throws(() => normalizeAddress('ftp://10.11.99.1'), /http/);
    assert.throws(() => normalizeAddress('http://10.11.99.1/?x=1'), /just the host/);
    assert.throws(() => normalizeAddress('http://exa mple'), /not a valid address/);
  });
});

describe('Config tablet address', () => {
  test('defaults to 10.11.99.1, persists changes, and resets', async () => {
    const dir = await tmpDir();
    const config = await new Config(dir).load();
    assert.equal(config.tabletAddress, DEFAULT_BASE_URL);
    assert.equal(config.isDefaultTabletAddress, true);

    assert.equal(await config.setTabletAddress('192.168.1.50/'), 'http://192.168.1.50');
    const reloaded = await new Config(dir).load();
    assert.equal(reloaded.tabletAddress, 'http://192.168.1.50');
    assert.equal(reloaded.isDefaultTabletAddress, false);

    await assert.rejects(reloaded.setTabletAddress('ftp://nope'));
    assert.equal(reloaded.tabletAddress, 'http://192.168.1.50', 'invalid input must not change the address');

    assert.equal(await reloaded.resetTabletAddress(), DEFAULT_BASE_URL);
    assert.equal((await new Config(dir).load()).tabletAddress, DEFAULT_BASE_URL);
  });
});

describe('defaultDestination', () => {
  const { defaultDestination } = require('../src/config');

  test('Google Drive for desktop when it is there, else Documents', async () => {
    const home = await tmpDir();
    assert.equal(defaultDestination(home, 'linux'), path.join(home, 'Documents', 'reMarkable_PDFs'));

    await fsp.mkdir(path.join(home, 'My Drive')); // Windows, mirroring
    assert.equal(defaultDestination(home, 'win32'), path.join(home, 'My Drive', 'reMarkable_PDFs'));

    const cloud = path.join(home, 'Library', 'CloudStorage', 'GoogleDrive-me@example.com', 'My Drive');
    await fsp.mkdir(cloud, { recursive: true });
    await fsp.rmdir(path.join(home, 'My Drive'));
    assert.equal(defaultDestination(home, 'darwin'), path.join(cloud, 'reMarkable_PDFs'));

    await fsp.mkdir(path.join(home, 'Google Drive', 'My Drive'), { recursive: true }); // older versions win
    assert.equal(defaultDestination(home, 'darwin'), path.join(home, 'Google Drive', 'My Drive', 'reMarkable_PDFs'));
  });
});

describe('Config appearance', () => {
  test('defaults to System + Ink, persists changes, ignores bad values', async () => {
    const dir = await tmpDir();
    const config = await new Config(dir).load();
    assert.deepEqual(config.appearance, { mode: 'system', theme: 'ink' });

    assert.deepEqual(await config.setAppearance({ mode: 'dark', theme: 'phosphor' }), { mode: 'dark', theme: 'phosphor' });
    assert.deepEqual((await new Config(dir).load()).appearance, { mode: 'dark', theme: 'phosphor' });

    await config.setAppearance({ mode: 'sepia' }); // not a mode: kept as is
    assert.equal(config.appearance.mode, 'dark');
    await config.setAppearance({ theme: 'no-such-theme' }); // unknown theme: the default
    assert.equal(config.appearance.theme, 'ink');
    await config.setAppearance({ mode: 'light' }); // one part at a time
    assert.deepEqual(config.appearance, { mode: 'light', theme: 'ink' });
  });
});

describe('Config switches and saved tablets', () => {
  test('backups, older versions and download-on-connect are off until turned on', async () => {
    const dir = await tmpDir();
    const config = await new Config(dir).load();
    assert.deepEqual([config.rmdocBackups, config.keepVersions, config.autoDownload], [false, false, false]);
    await config.setFlag('rmdocBackups', true);
    await config.setFlag('autoDownload', true);
    const reloaded = await new Config(dir).load();
    assert.deepEqual([reloaded.rmdocBackups, reloaded.keepVersions, reloaded.autoDownload], [true, false, true]);
    await assert.rejects(config.setFlag('welcomed', true), /Unknown setting/);
  });

  test('saves made at the same time all land, and the file stays valid', async () => {
    const dir = await tmpDir();
    const config = await new Config(dir).load();
    await Promise.all([config.setFlag('rmdocBackups', true), config.setFlag('keepVersions', true), config.setSkipUnchanged(false)]);
    const reloaded = await new Config(dir).load();
    assert.deepEqual([reloaded.rmdocBackups, reloaded.keepVersions, reloaded.skipUnchanged], [true, true, false]);
  });

  test('tablets are saved by name, one entry per address', async () => {
    const dir = await tmpDir();
    const config = await new Config(dir).load();
    assert.deepEqual(config.tablets, []);
    await config.saveTablet('Paper Pro', '10.11.99.1');
    await config.saveTablet('  Old rM2  ', 'http://192.168.1.20/');
    await config.saveTablet('Paper Pro (work)', 'http://10.11.99.1'); // same address: renamed
    assert.deepEqual((await new Config(dir).load()).tablets, [
      { name: 'Old rM2', address: 'http://192.168.1.20' },
      { name: 'Paper Pro (work)', address: 'http://10.11.99.1' },
    ]);
    await assert.rejects(config.saveTablet('', '10.0.0.1'), /name/);
    await assert.rejects(config.saveTablet('Bad', 'ftp://x'));
    assert.deepEqual(await config.removeTablet('http://192.168.1.20'), [{ name: 'Paper Pro (work)', address: 'http://10.11.99.1' }]);
  });
});

describe('TextIndex', () => {
  test('finds notes by every word, ignoring case and accents, with a snippet', async () => {
    const index = new TextIndex(path.join(await tmpDir(), 'text'));
    const a = { id: 'note-a', modified: '2026-01-01T00:00:00Z' };
    const b = { id: 'note-b', modified: '2026-01-02T00:00:00Z' };
    assert.equal(await index.has(a), false);
    await index.save(a, 'Notes from the Café meeting.\nBudget for Q4 approved.');
    await index.save(b, '');
    assert.equal(await index.has(a), true);
    assert.equal(await index.has(b), true, 'a note without text still counts as indexed');

    const hits = await new TextIndex(index.dir).search('cafe BUDGET');
    assert.deepEqual(Object.keys(hits), ['note-a']);
    assert.equal(hits['note-a'].modified, a.modified);
    assert.match(hits['note-a'].snippet, /Café meeting\. Budget/);
    assert.deepEqual(await index.search('café dinner'), {});
    assert.deepEqual(await index.search('   '), {});
  });

  test('a new version replaces the old one', async () => {
    const index = new TextIndex(path.join(await tmpDir(), 'text'));
    await index.save({ id: 'n', modified: 'v1' }, 'old words');
    await index.search('old'); // loads the index
    await index.save({ id: 'n', modified: 'v2' }, 'new words');
    assert.deepEqual(await index.search('old'), {});
    assert.equal((await index.search('new')).n.modified, 'v2');
    assert.equal((await fsp.readdir(index.dir)).length, 1);
    assert.equal(await index.has({ id: 'n', modified: 'v1' }), false);
  });

  test('foldText keeps one character per character', () => {
    for (const text of ['Ærøskøbing Straße', 'İstanbul', '한국어 노트', 'Crème brûlée']) {
      assert.equal(Array.from(foldText(text)).length, Array.from(text).length, text);
    }
    assert.equal(foldText('Crème BRÛLÉE'), 'creme brulee');
  });
});

describe('combinePdfs', { skip: pdfLib ? false : 'pdf-lib not installed (npm install)' }, () => {
  const makePdf = async (pages) => {
    const doc = await pdfLib.PDFDocument.create();
    for (let i = 0; i < pages; i++) doc.addPage([200, 300]);
    return doc.save();
  };

  test('joins PDFs in order and reports the ones it could not read', async () => {
    const dir = await tmpDir();
    await fsp.writeFile(path.join(dir, 'a.pdf'), await makePdf(2));
    await fsp.writeFile(path.join(dir, 'b.pdf'), await makePdf(3));
    await fsp.writeFile(path.join(dir, 'bad.pdf'), 'not a pdf');
    const out = path.join(dir, 'out.pdf');
    const result = await combinePdfs(
      [
        { file: path.join(dir, 'a.pdf'), name: 'A' },
        { file: path.join(dir, 'bad.pdf'), name: 'Bad' },
        { file: path.join(dir, 'b.pdf'), name: 'B' },
      ],
      out,
      { title: 'Both' }
    );
    assert.equal(result.pages, 5);
    assert.deepEqual(result.failed.map((f) => f.name), ['Bad']);
    const combined = await pdfLib.PDFDocument.load(await fsp.readFile(out));
    assert.equal(combined.getPageCount(), 5);
    assert.equal(combined.getTitle(), 'Both');
    assert.deepEqual((await fsp.readdir(dir)).filter((f) => f.endsWith('.part')), []);
  });

  test('rejects when nothing could be read, and writes nothing', async () => {
    const dir = await tmpDir();
    await fsp.writeFile(path.join(dir, 'bad.pdf'), 'nope');
    await assert.rejects(combinePdfs([{ file: path.join(dir, 'bad.pdf'), name: 'Bad' }], path.join(dir, 'out.pdf')));
    assert.deepEqual(await fsp.readdir(dir), ['bad.pdf']);
  });
});

describe('unreachable tablet', () => {
  test('ECONNREFUSED: isReachable() resolves false', async () => {
    const client = new RemarkableClient({ baseUrl: await closedPortUrl(), ...FAST });
    assert.equal(await client.isReachable(), false);
  });

  test('ETIMEDOUT (no response): isReachable() resolves false within the probe timeout', async () => {
    const hole = await blackHole();
    try {
      const client = new RemarkableClient({ baseUrl: hole.url, ...FAST });
      const started = Date.now();
      assert.equal(await client.isReachable(), false);
      assert.ok(Date.now() - started < 1500);
    } finally {
      await hole.close();
    }
  });

  test('ECONNREFUSED: syncAll rejects with a network error, writes nothing', async () => {
    const dest = await tmpDir();
    const client = new RemarkableClient({ baseUrl: await closedPortUrl(), ...FAST });
    const err = await syncAll({ client, destDir: dest }).catch((e) => e);
    assert.ok(isNetworkError(err), `expected network error, got ${err}`);
    assert.equal(err.summary.downloaded, 0);
    assert.deepEqual(await visibleFiles(dest), []);
  });

  test('ETIMEDOUT: syncAll rejects with a timeout when listing hangs', async () => {
    const hole = await blackHole();
    try {
      const client = new RemarkableClient({ baseUrl: hole.url, ...FAST });
      const err = await syncAll({ client, destDir: await tmpDir() }).catch((e) => e);
      assert.equal(err.name, 'TimeoutError');
      assert.ok(isNetworkError(err));
    } finally {
      await hole.close();
    }
  });
});

describe('sync against a mock tablet', () => {
  let tablet;
  let client;
  let dest;

  // Listing order (breadth-first): id-0001, id-0003 (top level), id-0002, then id-0004.
  const docs = () => [
    { ID: 'folder-1', VissibleName: 'Work / Projects', Type: 'CollectionType' },
    { ID: 'folder-2', VissibleName: '..', Type: 'CollectionType', Parent: 'folder-1' },
    { ID: 'id-0001', VissibleName: 'Meeting notes', ModifiedClient: '2026-01-01T00:00:00Z' },
    { ID: 'id-0002', VisibleName: 'Ideas: 2026/Q4?', ModifiedClient: '2026-01-02T00:00:00Z', Parent: 'folder-1' },
    { ID: 'id-0003', VissibleName: 'Meeting notes', ModifiedClient: '2026-01-03T00:00:00Z' },
    { ID: 'id-0004', VissibleName: 'No timestamp', Parent: 'folder-2' },
  ];
  const EXPECTED_FILES = [
    'Meeting notes (id0003).pdf',
    'Meeting notes.pdf',
    'Work - Projects/Ideas- 2026-Q4-.pdf',
    'Work - Projects/Untitled/No timestamp.pdf', // a folder named ".." can't escape
  ];
  const doc = (id) => tablet.docs.find((d) => d.ID === id);

  beforeEach(async () => {
    tablet = createMockTablet({ docs: docs(), busyDelayMs: 50 });
    client = new RemarkableClient({ baseUrl: await tablet.start(), ...FAST });
    dest = path.join(await tmpDir(), 'nested', 'reMarkable_PDFs'); // must be created
  });
  afterEach(async () => tablet?.server.listening && tablet.stop()); // also when a test fails

  const downloads = () => tablet.requests.filter((r) => r.startsWith('/download/'));

  test('walks folders, downloads documents only, mirrors folders with sanitized names', async () => {
    const progress = [];
    const summary = await syncAll({ client, destDir: dest, onProgress: (p) => progress.push(p) });

    assert.deepEqual(summary, { total: 4, downloaded: 4, unchanged: 0, failed: [], stopped: false });
    assert.deepEqual(await visibleFiles(dest), EXPECTED_FILES);
    assert.ok(tablet.requests.includes('/documents/folder-1'), 'folders are listed via /documents/{ID}');
    assert.ok(!downloads().some((r) => r.includes('folder-')), 'folders must not be downloaded');
    assert.deepEqual(progress.map((p) => `${p.current}/${p.total}`), ['1/4', '2/4', '3/4', '4/4']);
    assert.deepEqual(await fsp.readFile(path.join(dest, 'Meeting notes.pdf')), fakePdf('Meeting notes'));
    await tablet.stop();
  });

  test('second run skips unchanged notebooks; edited ones are re-downloaded', async () => {
    await syncAll({ client, destDir: dest });
    const before = await fsp.stat(path.join(dest, 'Meeting notes.pdf'));
    tablet.requests.length = 0;

    const second = await syncAll({ client, destDir: dest });
    assert.equal(second.unchanged, 4);
    assert.equal(second.downloaded, 0);
    // Only the doc without ModifiedClient had to be fetched (and then matched by checksum).
    assert.deepEqual(downloads(), ['/download/id-0004/pdf']);
    const afterStat = await fsp.stat(path.join(dest, 'Meeting notes.pdf'));
    assert.equal(afterStat.mtimeMs, before.mtimeMs, 'unchanged file must not be rewritten');

    doc('id-0001').ModifiedClient = '2026-02-01T00:00:00Z';
    doc('id-0001').body = fakePdf('Meeting notes', 2);
    const third = await syncAll({ client, destDir: dest });
    assert.equal(third.downloaded, 1);
    assert.deepEqual(await fsp.readFile(path.join(dest, 'Meeting notes.pdf')), fakePdf('Meeting notes', 2));
    await tablet.stop();
  });

  test('renamed notebook replaces its old file', async () => {
    await syncAll({ client, destDir: dest });
    doc('id-0004').VissibleName = 'Renamed';
    await syncAll({ client, destDir: dest });
    const files = await visibleFiles(dest);
    assert.ok(files.includes('Work - Projects/Untitled/Renamed.pdf'));
    assert.ok(!files.includes('Work - Projects/Untitled/No timestamp.pdf'));
    await tablet.stop();
  });

  test('notebook moved to another folder moves locally and the emptied folder is removed', async () => {
    await syncAll({ client, destDir: dest });
    doc('id-0004').Parent = '';
    await syncAll({ client, destDir: dest });
    assert.ok((await visibleFiles(dest)).includes('No timestamp.pdf'));
    await assert.rejects(fsp.stat(path.join(dest, 'Work - Projects', 'Untitled')), { code: 'ENOENT' });
    await tablet.stop();
  });

  test('per-notebook failures (HTTP 500, non-PDF, stall) are reported and the rest still sync', async () => {
    doc('id-0001').behavior = 'error500';
    doc('id-0002').behavior = 'html';
    doc('id-0003').behavior = 'stall';
    const summary = await syncAll({ client, destDir: dest });

    assert.equal(summary.downloaded, 1);
    const failed = Object.fromEntries(summary.failed.map((f) => [f.id, f.error]));
    assert.deepEqual(Object.keys(failed).sort(), ['id-0001', 'id-0002', 'id-0003']);
    assert.match(failed['id-0002'], /did not return a PDF/);
    assert.match(failed['id-0003'], /timed out/);
    assert.deepEqual(await visibleFiles(dest), ['Work - Projects/Untitled/No timestamp.pdf']);
    assert.deepEqual(await tempFilesIn(dest), [], 'temp files cleaned up');
    await tablet.stop();
  });

  test('tablet asleep (408 on every request) is not reachable, and sync fails as unavailable', async () => {
    tablet.busy = true;
    assert.equal(await client.isReachable(), false);
    const err = await syncAll({ client, destDir: dest }).catch((e) => e);
    assert.equal(err.status, 408);
    assert.ok(isNetworkError(err), 'treated like a lost connection, so the app re-syncs when it wakes');
    await tablet.stop();
  });

  test('tablet falls asleep mid-run: run aborts instead of failing every notebook', async () => {
    tablet.server.on('request', (req) => {
      if (req.url.startsWith('/download/')) tablet.busy = true;
    });
    const err = await syncAll({ client, destDir: dest }).catch((e) => e);
    assert.ok(isNetworkError(err), `expected unavailable error, got ${err}`);
    assert.deepEqual(err.summary.failed, []);
    await tablet.stop();
  });

  test('cable pulled mid-transfer: run aborts, partial file removed, existing copy intact', async () => {
    await syncAll({ client, destDir: dest });
    const original = await fsp.readFile(path.join(dest, 'Meeting notes.pdf'));

    doc('id-0001').ModifiedClient = '2026-03-01T00:00:00Z';
    doc('id-0001').behavior = 'drop';
    // When the socket drops, the whole tablet "goes away".
    tablet.server.on('request', (req) => {
      if (req.url.startsWith('/download/id-0001')) setTimeout(() => tablet.stop(), 5);
    });

    const err = await syncAll({ client, destDir: dest }).catch((e) => e);
    assert.ok(err instanceof Error, 'expected rejection');
    assert.ok(isNetworkError(err), `expected network error, got ${err.stack}`);
    assert.equal(err.summary.total, 4);
    assert.deepEqual(await fsp.readFile(path.join(dest, 'Meeting notes.pdf')), original);
    assert.deepEqual(await tempFilesIn(dest), []);
  });

  test('cancellation via AbortSignal stops the run cleanly', async () => {
    tablet.docs.forEach((d) => (d.chunkDelayMs = 50));
    const controller = new AbortController();
    const promise = syncAll({
      client,
      destDir: dest,
      signal: controller.signal,
      onProgress: (p) => p.current === 2 && setTimeout(() => controller.abort(new SyncCancelledError()), 20),
    });
    const err = await promise.catch((e) => e);
    assert.ok(isCancelled(err), `expected cancellation, got ${err}`);
    assert.equal(err.summary.downloaded, 1);
    assert.deepEqual(await tempFilesIn(dest), []);
    await tablet.stop();
  });

  test('disk errors: destination path under a file (ENOTDIR) rejects without crashing', async () => {
    const root = await tmpDir();
    const blocker = path.join(root, 'not-a-folder');
    await fsp.writeFile(blocker, 'x');
    const err = await syncAll({ client, destDir: path.join(blocker, 'PDFs') }).catch((e) => e);
    assert.ok(isFatalDiskError(err), `expected disk error, got ${err}`);
    await tablet.stop();
  });

  test('disk errors: read-only destination rejects without crashing', { skip: process.getuid?.() === 0 }, async () => {
    await fsp.mkdir(dest, { recursive: true });
    await fsp.chmod(dest, 0o555);
    try {
      const err = await syncAll({ client, destDir: dest }).catch((e) => e);
      assert.ok(isFatalDiskError(err), `expected disk error, got ${err}`);
    } finally {
      await fsp.chmod(dest, 0o755);
      await tablet.stop();
    }
  });

  test('probe() tells offline, busy and ok apart', async () => {
    assert.equal(await client.probe(), 'ok');
    tablet.busy = true;
    assert.equal(await client.probe(), 'busy', 'answers 408');
    const hole = await blackHole();
    try {
      const silent = new RemarkableClient({ baseUrl: hole.url, ...FAST });
      assert.equal(await silent.probe(), 'busy', 'accepts connections but never answers');
    } finally {
      await hole.close();
    }
    const nothing = new RemarkableClient({ baseUrl: await closedPortUrl(), ...FAST });
    assert.equal(await nothing.probe(), 'offline');
  });

  test('browse() returns one folder, folders first, sorted by name', async () => {
    tablet.docs.push({ ID: 'id-0005', VissibleName: 'apple', Parent: 'folder-1' });
    assert.deepEqual(
      (await client.browse(null)).map((i) => `${i.type}:${i.name}`),
      ['folder:Work / Projects', 'notebook:Meeting notes', 'notebook:Meeting notes']
    );
    assert.deepEqual(
      (await client.browse('folder-1')).map((i) => `${i.type}:${i.name}`),
      ['folder:..', 'notebook:apple', 'notebook:Ideas: 2026/Q4?']
    );
  });

  test('library() returns every folder and notebook with paths and metadata', async () => {
    doc('id-0001').Bookmarked = true;
    doc('id-0001').CurrentPage = 4;
    doc('id-0002').fileType = 'pdf';
    const { folders, docs: notebooks } = await client.library();
    assert.deepEqual(folders.map((f) => f.path.join('/')), ['Work / Projects', 'Work / Projects/..']);
    assert.deepEqual(folders.map((f) => f.parentId), [null, 'folder-1']);
    const byId = Object.fromEntries(notebooks.map((n) => [n.id, n]));
    assert.equal(notebooks.length, 4);
    assert.deepEqual(byId['id-0001'], {
      id: 'id-0001', name: 'Meeting notes', parentId: null, folders: [], modified: '2026-01-01T00:00:00Z',
      fileType: 'notebook', favorite: true, lastPage: 5,
    });
    assert.equal(byId['id-0002'].fileType, 'pdf');
    assert.deepEqual(byId['id-0004'].folders, ['Work / Projects', '..']);
  });

  test('downloading one folder lists only that folder (recursively) and keeps its path', async () => {
    const docs = await client.listDocuments(undefined, { folderId: 'folder-1', folders: ['Work / Projects'] });
    const summary = await exportDocuments({ client, destDir: dest, docs });
    assert.equal(summary.downloaded, 2);
    assert.deepEqual(await visibleFiles(dest), [
      'Work - Projects/Ideas- 2026-Q4-.pdf',
      'Work - Projects/Untitled/No timestamp.pdf',
    ]);
    assert.ok(!tablet.requests.includes('/documents/'), 'root not listed');
  });

  test('downloads survive the tablet sending both Content-Length and chunked encoding', async () => {
    const url = `${client.baseUrl}/download/id-0001/pdf`;
    // The mock reproduces the tablet's invalid headers: a strict client gives up on them...
    await assert.rejects(fetch(url).then((r) => r.arrayBuffer()), (err) => /content-length|fetch failed/i.test(`${err.message} ${err.cause?.message}`));
    // ...and the download path still gets the whole PDF.
    const file = path.join(dest, 'both-headers.pdf');
    await fetchPdf({ client, id: 'id-0001', filePath: file });
    assert.deepEqual(await fsp.readFile(file), fakePdf('Meeting notes'));
  });

  test('fetchPdf() saves one PDF for the reader, leaving no temp file on failure', async () => {
    const file = path.join(dest, 'previews', 'id-0001.pdf');
    await fetchPdf({ client, id: 'id-0001', filePath: file });
    assert.deepEqual(await fsp.readFile(file), fakePdf('Meeting notes'));

    doc('id-0002').behavior = 'html';
    const err = await fetchPdf({ client, id: 'id-0002', filePath: path.join(dest, 'previews', 'id-0002.pdf') }).catch((e) => e);
    assert.match(err.message, /did not return a PDF/);
    assert.deepEqual((await fsp.readdir(path.join(dest, 'previews'))).sort(), ['id-0001.pdf']);
  });

  test('savedCopy() returns an earlier download only while it is current', async () => {
    await syncAll({ client, destDir: dest });
    const meeting = { id: 'id-0001', modified: '2026-01-01T00:00:00Z' };
    assert.equal(await savedCopy(dest, meeting), path.join(dest, 'Meeting notes.pdf'));
    assert.equal(await savedCopy(dest, { ...meeting, modified: '2026-05-05T00:00:00Z' }), null, 'edited since');
    assert.equal(await savedCopy(dest, { id: 'id-0004', modified: null }), null, 'no timestamp to compare');
    await fsp.rm(path.join(dest, 'Meeting notes.pdf'));
    assert.equal(await savedCopy(dest, meeting), null, 'file gone');
  });

  test('savedCopies() checks many notes in one pass', async () => {
    await syncAll({ client, destDir: dest });
    const found = await savedCopies(dest, [
      { id: 'id-0001', modified: '2026-01-01T00:00:00Z' },
      { id: 'id-0002', modified: '2026-01-02T00:00:00Z' },
      { id: 'id-0003', modified: '1999-01-01T00:00:00Z' }, // edited since
      { id: 'nope', modified: '2026-01-01T00:00:00Z' },
    ]);
    assert.deepEqual([...found.keys()].sort(), ['id-0001', 'id-0002']);
    assert.equal(found.get('id-0002'), path.join(dest, 'Work - Projects', 'Ideas- 2026-Q4-.pdf'));
    assert.equal((await savedCopies(path.join(dest, 'missing'), [{ id: 'id-0001', modified: 'x' }])).size, 0);
  });

  test('a PDF named "x.pdf" on the tablet is saved as x.pdf, not x.pdf.pdf', async () => {
    await exportDocuments({ client, destDir: dest, docs: [{ id: 'id-0001', name: 'IAM cheatsheet.PDF', folders: [] }] });
    assert.deepEqual(await visibleFiles(dest), ['IAM cheatsheet.pdf']);
  });

  test('a later partial download never takes over another notebook\'s file', async () => {
    await exportDocuments({ client, destDir: dest, docs: [{ id: 'id-0003', name: 'Meeting notes', folders: [] }] });
    await exportDocuments({ client, destDir: dest, docs: [{ id: 'id-0001', name: 'Meeting notes', folders: [] }] });
    assert.deepEqual(await visibleFiles(dest), ['Meeting notes (id0001).pdf', 'Meeting notes.pdf']);
    assert.deepEqual(await fsp.readFile(path.join(dest, 'Meeting notes.pdf')), fakePdf('Meeting notes'));
  });

  test('stop request finishes the current notebook, then stops', async () => {
    let stop = false;
    const summary = await syncAll({
      client,
      destDir: dest,
      shouldStop: () => stop,
      onProgress: (p) => p.current === 2 && (stop = true),
    });
    assert.equal(summary.stopped, true);
    assert.equal(summary.downloaded, 2, 'notebook 2 was already downloading, so it completes');
    assert.deepEqual(await tempFilesIn(dest), []);
  });

  test('skipUnchanged: false re-checks every notebook', async () => {
    await syncAll({ client, destDir: dest });
    tablet.requests.length = 0;
    const summary = await syncAll({ client, destDir: dest, skipUnchanged: false });
    assert.equal(downloads().length, 4);
    assert.equal(summary.unchanged, 4, 'identical content is still left untouched');
  });

  test('falls back to /placeholder on firmware without /pdf', async () => {
    await tablet.stop();
    tablet = createMockTablet({ docs: docs(), formats: ['placeholder'] });
    client = new RemarkableClient({ baseUrl: await tablet.start(), ...FAST });
    const summary = await syncAll({ client, destDir: dest });
    assert.equal(summary.downloaded, 4);
    assert.equal(downloads().filter((r) => r.endsWith('/pdf')).length, 1, 'only the first notebook tries /pdf');
  });

  test('upload() sends the file into the chosen folder, as the tablet expects', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'Lecture "slides".pdf');
    await fsp.writeFile(file, fakePdf('Lecture'));
    await client.upload(file, 'folder-1');
    await client.upload(path.join(dir, 'Lecture "slides".pdf'), null); // top level
    assert.deepEqual(tablet.uploads.map((u) => [u.name, u.parent, u.size]), [
      ['Lecture %22slides%22.pdf', 'folder-1', fakePdf('Lecture').length],
      ['Lecture %22slides%22.pdf', '', fakePdf('Lecture').length],
    ]);
    assert.match(tablet.uploads[0].type, /^multipart\/form-data; boundary=/);
    const { docs: after } = await client.library();
    assert.equal(after.filter((d) => d.parentId === 'folder-1' && d.name.startsWith('Lecture')).length, 1);

    const txt = path.join(dir, 'notes.txt');
    await fsp.writeFile(txt, 'x');
    await assert.rejects(client.upload(txt, null), /PDF, EPUB or \.rmdoc only/);
  });

  test('upload() reports the tablet refusing a file', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'a.pdf');
    await fsp.writeFile(file, fakePdf('a'));
    tablet.server.prependListener('request', (req) => {
      if (req.url === '/upload') req.headers['content-type'] = 'text/plain'; // mock answers 400
    });
    await assert.rejects(client.upload(file, null), (err) => err.name === 'HttpError' && err.status === 400);
  });

  test('rmdoc: saves a .rmdoc next to each PDF, and only re-fetches it when the notebook changes', async () => {
    const first = await syncAll({ client, destDir: dest, rmdoc: true });
    assert.equal(first.backups, 4);
    assert.equal(first.backupsUnavailable, false);
    assert.deepEqual(await fsp.readFile(path.join(dest, 'Meeting notes.rmdoc')), fakeRmdoc('Meeting notes'));
    assert.ok(await fsp.stat(path.join(dest, 'Work - Projects', 'Ideas- 2026-Q4-.rmdoc')));
    const manifest = JSON.parse(await fsp.readFile(path.join(dest, MANIFEST_NAME), 'utf8'));
    assert.equal(manifest.docs['id-0001'].rmdoc.file, 'Meeting notes.rmdoc');

    tablet.requests.length = 0;
    const second = await syncAll({ client, destDir: dest, rmdoc: true });
    assert.equal(second.backups, 0);
    assert.deepEqual(downloads().sort(), ['/download/id-0004/pdf', '/download/id-0004/rmdoc'], 'only the note without a date');
    await tablet.stop();
  });

  test('rmdoc: turned on later, backups are added without re-downloading PDFs', async () => {
    await syncAll({ client, destDir: dest });
    tablet.requests.length = 0;
    const summary = await syncAll({ client, destDir: dest, rmdoc: true });
    assert.equal(summary.backups, 4);
    assert.equal(downloads().filter((r) => r.endsWith('/pdf') && !r.includes('id-0004')).length, 0);
    await tablet.stop();
  });

  test('rmdoc: firmware without /rmdoc still saves every PDF, and says so', async () => {
    await tablet.stop();
    tablet = createMockTablet({ docs: docs(), formats: ['pdf'] });
    client = new RemarkableClient({ baseUrl: await tablet.start(), ...FAST });
    const summary = await syncAll({ client, destDir: dest, rmdoc: true });
    assert.equal(summary.downloaded, 4);
    assert.deepEqual(summary.failed, []);
    assert.equal(summary.backupsUnavailable, true);
    assert.equal(downloads().filter((r) => r.endsWith('/rmdoc')).length, 1, 'asked once, then skipped');
    await tablet.stop();
  });

  test('rmdoc: with backups off, a moved notebook takes its earlier backup along', async () => {
    await syncAll({ client, destDir: dest, rmdoc: true });
    doc('id-0001').VissibleName = 'Renamed notes';
    doc('id-0001').ModifiedClient = '2026-03-01T00:00:00Z';
    await syncAll({ client, destDir: dest });
    assert.ok(await fsp.stat(path.join(dest, 'Renamed notes.rmdoc')));
    await assert.rejects(fsp.stat(path.join(dest, 'Meeting notes.rmdoc')), { code: 'ENOENT' });
    await tablet.stop();
  });

  test('keepVersions: a changed notebook moves its old PDF into _versions, dated', async () => {
    await syncAll({ client, destDir: dest, keepVersions: true, rmdoc: true });
    doc('id-0001').ModifiedClient = '2026-02-01T00:00:00Z';
    doc('id-0001').body = fakePdf('Meeting notes', 2);
    doc('id-0001').rmdoc = fakeRmdoc('Meeting notes', 2);
    await syncAll({ client, destDir: dest, keepVersions: true, rmdoc: true });

    assert.deepEqual(await fsp.readFile(path.join(dest, 'Meeting notes.pdf')), fakePdf('Meeting notes', 2));
    const kept = (await fsp.readdir(path.join(dest, VERSIONS_DIR))).sort();
    assert.equal(kept.length, 2);
    assert.match(kept[0], /^Meeting notes \(\d{4}-\d\d-\d\d \d\d\.\d\d\)\.pdf$/);
    assert.match(kept[1], /^Meeting notes \(.+\)\.rmdoc$/);
    assert.deepEqual(await fsp.readFile(path.join(dest, VERSIONS_DIR, kept[0])), fakePdf('Meeting notes'));

    // Unchanged content is never versioned.
    await syncAll({ client, destDir: dest, keepVersions: true, skipUnchanged: false });
    assert.equal((await fsp.readdir(path.join(dest, VERSIONS_DIR))).length, 2);
    await tablet.stop();
  });

  test('keepVersions: a renamed notebook with new content keeps the old file in _versions', async () => {
    await syncAll({ client, destDir: dest, keepVersions: true });
    doc('id-0004').VissibleName = 'Renamed';
    doc('id-0004').body = fakePdf('Renamed', 2);
    await syncAll({ client, destDir: dest, keepVersions: true });
    const files = await visibleFiles(dest);
    assert.ok(files.includes('Work - Projects/Untitled/Renamed.pdf'));
    assert.ok(files.some((f) => f.startsWith(`${VERSIONS_DIR}/Work - Projects/Untitled/No timestamp (`)));
    assert.ok(!files.includes('Work - Projects/Untitled/No timestamp.pdf'));
    await tablet.stop();
  });

  test('keepVersions off: nothing goes to _versions', async () => {
    await syncAll({ client, destDir: dest });
    doc('id-0001').ModifiedClient = '2026-02-01T00:00:00Z';
    doc('id-0001').body = fakePdf('Meeting notes', 2);
    await syncAll({ client, destDir: dest });
    await assert.rejects(fsp.stat(path.join(dest, VERSIONS_DIR)), { code: 'ENOENT' });
    await tablet.stop();
  });

  test('fetchThumbnail() returns the image and its type; 404 where there are none', async () => {
    const { bytes, type } = await client.fetchThumbnail('id-0001');
    assert.equal(type, 'png');
    assert.deepEqual(bytes, TINY_PNG);
    await assert.rejects(client.fetchThumbnail('folder-1'), (err) => err.name === 'HttpError' && err.status === 404);
    tablet.server.prependListener('request', (req) => {
      if (req.url.startsWith('/thumbnail/')) req.url = '/'; // answers HTML
    });
    await assert.rejects(client.fetchThumbnail('id-0001'), /did not return an image/);
    await tablet.stop();
  });

  test('openLog() streams the tablet log', async () => {
    const log = await client.openLog();
    let text = '';
    for await (const chunk of log.stream) text += chunk;
    log.done();
    assert.match(text, /xochitl started/);
    await tablet.stop();
  });

  test('a file of yours already at a notebook\'s path is never overwritten; the notebook gets another name', async () => {
    await fsp.mkdir(dest, { recursive: true });
    await fsp.writeFile(path.join(dest, 'Meeting notes.pdf'), 'my own file');
    await fsp.writeFile(path.join(dest, 'Meeting notes (id0003).rmdoc'), 'my own backup');
    await syncAll({ client, destDir: dest, rmdoc: true });
    assert.equal(await fsp.readFile(path.join(dest, 'Meeting notes.pdf'), 'utf8'), 'my own file');
    assert.equal(await fsp.readFile(path.join(dest, 'Meeting notes (id0003).rmdoc'), 'utf8'), 'my own backup');
    const files = await visibleFiles(dest);
    assert.ok(files.includes('Meeting notes (id0001).pdf'), files.join(', '));
    assert.ok(files.includes('Meeting notes (id-0003).pdf'), files.join(', '));
    await tablet.stop();
  });

  test('a file another app has open (Windows) fails only that notebook', async () => {
    await syncAll({ client, destDir: dest });
    doc('id-0001').ModifiedClient = '2026-02-01T00:00:00Z';
    doc('id-0001').body = fakePdf('Meeting notes', 2);
    const rename = fsp.rename;
    fsp.rename = async (from, to) => {
      if (to.endsWith('Meeting notes.pdf')) throw Object.assign(new Error('locked'), { code: 'EPERM' });
      return rename(from, to);
    };
    try {
      const summary = await syncAll({ client, destDir: dest, skipUnchanged: false });
      assert.equal(summary.failed.length, 1);
      assert.match(summary.failed[0].error, /open in another app/);
      assert.equal(summary.failed[0].id, 'id-0001');
      assert.equal(summary.downloaded + summary.unchanged, 3, 'the others still ran');
      assert.deepEqual(await tempFilesIn(dest), []);
    } finally {
      fsp.rename = rename;
    }
    await tablet.stop();
  });

  test('a tablet folder named _versions doesn\'t mix with older versions; Windows device names are avoided', async () => {
    tablet.docs.push(
      { ID: 'folder-v', VissibleName: '_versions', Type: 'CollectionType' },
      { ID: 'id-v1', VissibleName: 'Old', ModifiedClient: '2026-01-05T00:00:00Z', Parent: 'folder-v' },
      { ID: 'folder-con', VissibleName: 'CON', Type: 'CollectionType' },
      { ID: 'id-nul', VissibleName: 'nul', ModifiedClient: '2026-01-05T00:00:00Z', Parent: 'folder-con' }
    );
    await syncAll({ client, destDir: dest });
    const files = await visibleFiles(dest);
    assert.ok(files.includes('_versions (tablet)/Old.pdf'), files.join(', '));
    assert.ok(files.includes('CON-/nul-.pdf'), files.join(', '));
    await tablet.stop();
  });

  test('sync records pointing outside the save-to folder are never followed', async () => {
    const outside = path.join(path.dirname(dest), 'outside.pdf');
    await fsp.mkdir(dest, { recursive: true });
    await fsp.writeFile(outside, fakePdf('outside'));
    const manifest = { version: 2, docs: { 'id-0001': { name: 'Meeting notes', file: '../outside.pdf', modified: '2026-01-01T00:00:00Z', size: fakePdf('outside').length, sha256: 'x' } } };
    await fsp.writeFile(path.join(dest, MANIFEST_NAME), JSON.stringify(manifest));
    assert.equal(await savedCopy(dest, { id: 'id-0001', modified: '2026-01-01T00:00:00Z' }), null);
    await syncAll({ client, destDir: dest });
    assert.ok(await fsp.stat(outside), 'the file outside must not be removed');
    assert.ok((await visibleFiles(dest)).includes('Meeting notes.pdf'));
    await tablet.stop();
  });

  test('corrupt manifest is ignored', async () => {
    await fsp.mkdir(dest, { recursive: true });
    await fsp.writeFile(path.join(dest, MANIFEST_NAME), '{not json');
    const summary = await syncAll({ client, destDir: dest });
    assert.equal(summary.downloaded, 4);
    await tablet.stop();
  });
});
