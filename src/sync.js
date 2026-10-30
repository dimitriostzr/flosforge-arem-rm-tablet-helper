'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const { sanitizeFileName } = require('./sanitize');
const {
  SyncCancelledError,
  isCancelled,
  isNetworkError,
  isFatalDiskError,
  describeError,
} = require('./errors');

// Lives in the destination folder so the sync state moves with the PDFs.
const MANIFEST_NAME = '.remarkable-sync.json';
const TEMP_SUFFIX = '.rmsync.part';
// Copies that a newer version replaced (with "Keep older versions" on), in the same folders.
const VERSIONS_DIR = '_versions';

// What each kind of download is checked against: its first bytes.
const FORMATS = {
  pdf: { open: (client, id, signal) => client.openDownload(id, signal), magic: '%PDF-', wrong: 'The tablet did not return a PDF' },
  rmdoc: { open: (client, id, signal) => client.openRmdoc(id, signal), magic: 'PK\x03\x04', wrong: 'The tablet did not return a .rmdoc' },
};

async function loadManifest(destDir) {
  try {
    const data = JSON.parse(await fsp.readFile(path.join(destDir, MANIFEST_NAME), 'utf8'));
    if (data?.version === 2 && typeof data.docs === 'object' && data.docs !== null) return data;
  } catch {
    // Missing or corrupt: start fresh. Worst case is re-downloading everything once.
  }
  return { version: 2, docs: {} };
}

async function saveManifest(destDir, manifest) {
  const file = path.join(destDir, MANIFEST_NAME);
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(manifest, null, 2));
  await fsp.rename(tmp, file);
}

async function removeQuietly(file) {
  await fsp.rm(file, { force: true }).catch(() => {});
}

/** Removes temp files left behind by a crash or a force-quit mid-download. */
async function removeStaleTempFiles(destDir) {
  const entries = await fsp.readdir(destDir, { recursive: true }).catch(() => []);
  await Promise.all(
    entries.filter((e) => e.endsWith(TEMP_SUFFIX)).map((e) => removeQuietly(path.join(destDir, e)))
  );
}

async function fileSize(file) {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return -1;
  }
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

const LOCKED_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Renames tmp over file (an atomic overwrite). On Windows that fails while another app has the
 * file open, or Google Drive is uploading it: retry briefly, then fail just this notebook (an
 * error without a code, so the run goes on) instead of stopping the whole download.
 */
async function replaceFile(tmp, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fsp.rename(tmp, file);
    } catch (err) {
      if (!LOCKED_CODES.has(err.code) || !(await fileSize(file) >= 0)) throw err;
      if (attempt === 4) throw new Error(`${path.basename(file)} is open in another app, or locked; close it and download again`);
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
}

async function startsWith(file, magic) {
  const handle = await fsp.open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(magic.length), 0, magic.length, 0);
    return bytesRead === magic.length && buffer.toString('latin1') === magic;
  } finally {
    await handle.close();
  }
}

const shortId = (id) => id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'doc';
const key = (relPath) => relPath.toLowerCase(); // APFS is case-insensitive by default
/** The absolute path of relPath under destDir; throws if it would end up outside destDir. */
function absolute(destDir, relPath) {
  const root = path.resolve(destDir);
  const file = path.resolve(root, ...String(relPath).split('/'));
  if (file === root || !file.startsWith(root + path.sep)) throw new Error(`Not a path inside the save-to folder: ${relPath}`);
  return file;
}
const rmdocPath = (pdfPath) => pdfPath.replace(/\.pdf$/i, '.rmdoc');
const pdfPathOf = (relPath) => relPath.replace(/\.rmdoc$/i, '.pdf');

/** "2026-10-01 09.30" (local time), for names in _versions. */
function stamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}`;
}

/**
 * Puts the file at relPath into _versions/<same folders>/<name> (<date>).<ext>, dated by the
 * tablet's modified time of that version (else the file's own). `move`: rename instead of copy.
 * Returns the new relative path, or null if there was no file.
 */
async function keepOldVersion(destDir, relPath, modified, { move = false } = {}) {
  const from = absolute(destDir, relPath);
  const stat = await fsp.stat(from).catch(() => null);
  if (!stat?.isFile()) return null;
  const parsed = modified ? new Date(modified) : null;
  const when = stamp(parsed && !Number.isNaN(parsed.getTime()) ? parsed : stat.mtime);
  const ext = path.posix.extname(relPath);
  const base = relPath.slice(0, relPath.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const target = `${VERSIONS_DIR}/${base} (${when}${n > 1 ? ` ${n}` : ''})${ext}`;
    const to = absolute(destDir, target);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    if (await fsp.stat(to).catch(() => null)) continue;
    if (move) await fsp.rename(from, to);
    else await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    return target;
  }
  throw new Error(`Too many older versions of ${relPath}`);
}

/** Removes (or, with keep, moves to _versions) an old copy, then its folder if that left it empty. */
async function retire(destDir, relPath, { keep = false, modified = null } = {}) {
  const file = absolute(destDir, relPath);
  // If it can't be moved into _versions, it stays where it is rather than being lost.
  if (keep) await keepOldVersion(destDir, relPath, modified, { move: true }).catch(() => {});
  else await removeQuietly(file);
  if (path.dirname(file) !== destDir) await fsp.rmdir(path.dirname(file)).catch(() => {});
}

/** Possible relative paths ("Folder/Sub/Name.pdf") for a notebook, best first. */
function candidatePaths(doc) {
  const folders = (doc.folders ?? []).map(sanitizeFileName);
  // A tablet folder called "_versions" at the top level would mix with the older versions.
  if (folders[0]?.toLowerCase() === VERSIONS_DIR) folders[0] += ' (tablet)';
  const prefix = folders.length ? `${folders.join('/')}/` : '';
  // Imported PDFs are often named "Something.pdf" on the tablet: don't save "Something.pdf.pdf".
  const base = sanitizeFileName(String(doc.name ?? '').replace(/\.pdf$/i, ''));
  const fullId = String(doc.id).replace(/[^\w-]/g, '') || 'doc';
  return [`${prefix}${base}.pdf`, `${prefix}${base} (${shortId(doc.id)}).pdf`, `${prefix}${base} (${fullId}).pdf`];
}

/**
 * Maps doc ID -> unique relative path mirroring the tablet's folders. Duplicate names in a
 * folder get " (<short id>)". Paths assigned on a previous run are kept when still valid,
 * so suffixes don't hop between notebooks.
 */
function assignFileNames(docs, manifest, taken = new Set()) {
  const names = new Map();
  const used = new Set([...reservedPaths(docs, manifest), ...taken]);
  const claim = (id, relPath) => {
    names.set(id, relPath);
    used.add(key(relPath));
  };

  for (const doc of docs) {
    const prev = manifest.docs[doc.id]?.file;
    if (candidatePaths(doc).slice(0, 2).includes(prev) && !used.has(key(prev))) claim(doc.id, prev);
  }

  for (const doc of docs) {
    if (names.has(doc.id)) continue;
    const candidates = candidatePaths(doc);
    claim(doc.id, candidates.find((c) => !used.has(key(c))) ?? candidates[2]);
  }
  return names;
}

/**
 * Paths a notebook could take (its PDF, or the .rmdoc next to it) where a file already exists
 * that no download made: the user's own files. They're never overwritten; the notebook gets
 * another name instead.
 */
async function foreignFiles(destDir, docs, manifest) {
  const ours = new Set(
    Object.values(manifest.docs)
      .flatMap((entry) => [entry?.file, entry?.rmdoc?.file])
      .filter((file) => typeof file === 'string')
      .map(key)
  );
  const taken = new Set();
  for (const doc of docs) {
    for (const candidate of candidatePaths(doc).slice(0, 2)) {
      for (const file of [candidate, rmdocPath(candidate)]) {
        if (!ours.has(key(file)) && (await fileSize(absolute(destDir, file))) >= 0) taken.add(key(candidate));
      }
    }
  }
  return taken;
}

/** Files that belong to notebooks outside this batch (from earlier downloads): never reuse them. */
function reservedPaths(docs, manifest) {
  const batch = new Set(docs.map((doc) => doc.id));
  return new Set(
    Object.entries(manifest.docs)
      .filter(([id, entry]) => !batch.has(id) && typeof entry?.file === 'string')
      .map(([, entry]) => key(entry.file))
  );
}

/** Streams one PDF (or .rmdoc) into a temp file next to finalPath, hashing it on the way. */
async function downloadToTemp(client, doc, finalPath, signal, format = 'pdf') {
  const tmpPath = path.join(path.dirname(finalPath), `.${path.basename(finalPath)}${TEMP_SUFFIX}`);
  const hash = crypto.createHash('sha256');
  let size = 0;

  const download = await FORMATS[format].open(client, doc.id, signal);
  try {
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        download.onChunk(); // resets the stall timer
        hash.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      },
    });
    await pipeline(download.stream, meter, fs.createWriteStream(tmpPath));
  } catch (err) {
    await removeQuietly(tmpPath);
    throw err;
  } finally {
    download.done();
  }

  if (!(await startsWith(tmpPath, FORMATS[format].magic))) {
    await removeQuietly(tmpPath);
    throw new Error(FORMATS[format].wrong);
  }
  return { tmpPath, size, sha256: hash.digest('hex') };
}

/**
 * Brings one file of a notebook (its PDF or its .rmdoc) up to date at relPath. `prev` is what the
 * manifest recorded for it ({ file, modified, size, sha256 }). Resolves to
 * { outcome: 'downloaded' | 'unchanged', record } with the record to store.
 */
async function syncFile({ client, doc, destDir, relPath, prev, isClaimed, signal, skipUnchanged, keepVersions, format }) {
  const finalPath = absolute(destDir, relPath);

  // Fast path: the tablet says it hasn't changed and our copy is intact. No download at all.
  if (
    skipUnchanged &&
    doc.modified &&
    prev?.modified === doc.modified &&
    prev.file === relPath &&
    (await fileSize(finalPath)) === prev.size
  ) {
    return { outcome: 'unchanged', record: prev };
  }

  await fsp.mkdir(path.dirname(finalPath), { recursive: true });
  const { tmpPath, size, sha256 } = await downloadToTemp(client, doc, finalPath, signal, format);

  let outcome = 'downloaded';
  try {
    const existing = await fileSize(finalPath);
    const identical = existing === size && (await hashFile(finalPath)) === sha256;
    if (identical) {
      // Leave the existing file untouched so Drive doesn't re-upload it.
      outcome = 'unchanged';
      await removeQuietly(tmpPath);
    } else {
      if (keepVersions && existing >= 0) await keepOldVersion(destDir, relPath, prev?.file === relPath ? prev.modified : null);
      await replaceFile(tmpPath, finalPath);
    }
  } catch (err) {
    await removeQuietly(tmpPath);
    throw err;
  }

  // Notebook renamed or moved on the tablet: drop the old copy (only files we created), and
  // its folder if that left it empty. With versions kept, a copy with other content is kept.
  if (prev?.file && prev.file !== relPath && !isClaimed(prev.file)) {
    await retire(destDir, prev.file, { keep: keepVersions && prev.sha256 !== sha256, modified: prev.modified });
  }
  return { outcome, record: { file: relPath, modified: doc.modified, size, sha256 } };
}

/**
 * Returns 'downloaded' or 'unchanged'. With `rmdoc`, the notebook's .rmdoc is saved next to its
 * PDF too; `backups` ({ count, unavailable }) tallies those across the run.
 */
async function syncDocument({ client, doc, destDir, relPath, manifest, claimed, signal, skipUnchanged, keepVersions, rmdoc, backups }) {
  const entry = manifest.docs[doc.id];
  const common = { client, doc, destDir, signal, skipUnchanged, keepVersions };
  const pdf = await syncFile({
    ...common,
    format: 'pdf',
    relPath,
    prev: entry?.file ? { file: entry.file, modified: entry.modified, size: entry.size, sha256: entry.sha256 } : null,
    isClaimed: (p) => claimed.has(key(p)),
  });
  let backup = entry?.rmdoc ?? null;
  // Folders, type and star as the tablet had them, so the library can be shown without it.
  const about = {
    name: doc.name,
    folders: doc.folders ?? [],
    fileType: doc.fileType ?? entry?.fileType,
    favorite: doc.favorite ?? entry?.favorite,
  };
  const record = () => ({ ...about, ...pdf.record, ...(backup ? { rmdoc: backup } : {}), syncedAt: new Date().toISOString() });
  manifest.docs[doc.id] = record();
  await saveManifest(destDir, manifest);

  let outcome = pdf.outcome;
  const backupPath = rmdocPath(relPath);
  const backupClaimed = (p) => claimed.has(key(pdfPathOf(p)));
  if (rmdoc && !backups.unavailable) {
    try {
      const result = await syncFile({ ...common, format: 'rmdoc', relPath: backupPath, prev: backup, isClaimed: backupClaimed });
      backup = result.record;
      if (result.outcome === 'downloaded') {
        backups.count += 1;
        outcome = 'downloaded';
      }
    } catch (err) {
      // Firmware without /rmdoc: say so once, and keep saving the PDFs.
      if (err.name !== 'HttpError' || (err.status !== 400 && err.status !== 404)) throw err;
      backups.unavailable = true;
    }
  } else if (backup?.file && backup.file !== backupPath && !backupClaimed(backup.file)) {
    // Backups are off but the notebook moved: take its earlier backup along.
    const target = absolute(destDir, backupPath);
    if (!(await fsp.stat(target).catch(() => null))) {
      const moved = await fsp.rename(absolute(destDir, backup.file), target).then(() => true, () => false);
      if (moved) backup = { ...backup, file: backupPath };
    }
  }
  manifest.docs[doc.id] = record();
  await saveManifest(destDir, manifest);
  return outcome;
}

/**
 * Saves the given notebooks ({ id, name, folders, modified }) as PDFs under destDir,
 * mirroring the tablet's folders, one at a time.
 *
 * Resolves with { total, downloaded, unchanged, failed: [{ id, name, error }], stopped } when
 * the run finishes, even if individual notebooks failed. `shouldStop()` is checked between
 * notebooks; a notebook that is downloading is always finished (interrupting the tablet
 * mid-export can leave it unresponsive for minutes). Rejects (with `err.summary` attached)
 * when the run can't continue: tablet unreachable, destination unwritable, or `signal` aborted.
 */
async function exportDocuments({
  client,
  destDir,
  docs,
  signal,
  onProgress = () => {},
  skipUnchanged = true,
  keepVersions = false,
  rmdoc = false,
  shouldStop = () => false,
}) {
  const unique = [...new Map(docs.map((doc) => [doc.id, doc])).values()];
  const summary = { total: unique.length, downloaded: 0, unchanged: 0, failed: [], stopped: false };
  // .rmdoc backups saved this run, and whether the tablet has no /rmdoc (only when asked for).
  const backups = { count: 0, unavailable: false };
  if (rmdoc) Object.assign(summary, { backups: 0, backupsUnavailable: false });
  const abortRun = (err) => {
    err.summary = summary;
    return err;
  };
  const checkCancelled = () => {
    if (signal?.aborted) throw abortRun(isCancelled(signal.reason) ? signal.reason : new SyncCancelledError());
  };

  try {
    await fsp.mkdir(destDir, { recursive: true });
    await fsp.access(destDir, fs.constants.W_OK);
  } catch (err) {
    throw abortRun(err);
  }
  await removeStaleTempFiles(destDir);
  const manifest = await loadManifest(destDir);

  const names = assignFileNames(unique, manifest, await foreignFiles(destDir, unique, manifest));
  const claimed = new Set([...names.values()].map(key).concat([...reservedPaths(unique, manifest)]));

  for (const [index, doc] of unique.entries()) {
    checkCancelled();
    if (shouldStop()) {
      summary.stopped = true;
      break;
    }
    onProgress({ current: index + 1, total: unique.length, name: doc.name });
    try {
      const outcome = await syncDocument({
        client,
        doc,
        destDir,
        relPath: names.get(doc.id),
        manifest,
        claimed,
        signal,
        skipUnchanged,
        keepVersions,
        rmdoc,
        backups,
      });
      summary[outcome] += 1;
      if (rmdoc) Object.assign(summary, { backups: backups.count, backupsUnavailable: backups.unavailable });
    } catch (err) {
      if (isCancelled(err) || isFatalDiskError(err)) throw abortRun(err);
      // A network error on one notebook is only fatal if the tablet is actually gone;
      // a single huge notebook timing out shouldn't stop the rest.
      if (isNetworkError(err) && !(await client.isReachable())) throw abortRun(err);
      summary.failed.push({ id: doc.id, name: doc.name, error: describeError(err) });
    }
  }
  return summary;
}

/**
 * Downloads one notebook's PDF to filePath (atomically, via a temp file next to it), for the
 * in-app reader. Rejects like any download: HttpError, network/timeout errors, disk errors.
 */
async function fetchPdf({ client, id, filePath, signal }) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const { tmpPath } = await downloadToTemp(client, { id }, filePath, signal);
  try {
    await fsp.rename(tmpPath, filePath);
  } catch (err) {
    await removeQuietly(tmpPath);
    throw err;
  }
}

/**
 * Where earlier downloads saved these notebooks ({ id, modified }), for those whose copy is
 * still current: Map of id -> file. Reads the manifest once.
 */
async function savedCopies(destDir, docs) {
  const manifest = await loadManifest(destDir);
  const found = new Map();
  await Promise.all(
    docs.map(async (doc) => {
      const entry = manifest.docs[doc.id];
      if (!entry?.file || !doc.modified || entry.modified !== doc.modified) return;
      let file;
      try {
        file = absolute(destDir, entry.file);
      } catch {
        return; // a manifest entry pointing outside the folder: not ours to open
      }
      if ((await fileSize(file)) === entry.size) found.set(doc.id, file);
    })
  );
  return found;
}

/** Where an earlier download saved this notebook, if that copy is still current. */
async function savedCopy(destDir, doc) {
  return (await savedCopies(destDir, [doc])).get(doc.id) ?? null;
}

/** The manifest entry's file, if it is still in the folder: absolute path, else null. */
async function existingFile(destDir, entry) {
  if (typeof entry?.file !== 'string') return null;
  try {
    const file = absolute(destDir, entry.file);
    return (await fsp.stat(file)).isFile() ? file : null;
  } catch {
    return null; // gone, or pointing outside the folder
  }
}

/**
 * The copy an earlier download saved of this notebook, whatever version it is, for reading
 * without the tablet: { file, modified } or null.
 */
async function savedFile(destDir, id) {
  const entry = (await loadManifest(destDir)).docs[id];
  const file = await existingFile(destDir, entry);
  return file ? { file, modified: entry.modified ?? null } : null;
}

/**
 * The notebooks saved in destDir, from its manifest, shaped like RemarkableClient.library()
 * ({ folders, docs }) so the library can be browsed without the tablet. Folder IDs are made up
 * from their paths. Downloads made before the manifest kept folders take them from the file's
 * path (as saved: sanitized names).
 */
async function localLibrary(destDir) {
  const manifest = await loadManifest(destDir);
  const folders = new Map(); // path key -> folder
  const folderId = (names) => {
    if (!names.length) return null;
    const id = `local:${names.join('/')}`;
    if (!folders.has(id)) folders.set(id, { id, name: names.at(-1), parentId: folderId(names.slice(0, -1)), path: names });
    return id;
  };
  const docs = [];
  await Promise.all(
    Object.entries(manifest.docs).map(async ([id, entry]) => {
      if (!(await existingFile(destDir, entry))) return;
      const isNames = Array.isArray(entry.folders) && entry.folders.every((f) => typeof f === 'string');
      const names = isNames ? entry.folders : entry.file.split('/').slice(0, -1);
      docs.push({
        id,
        name: typeof entry.name === 'string' ? entry.name : path.posix.basename(entry.file, '.pdf'),
        folders: names,
        modified: typeof entry.modified === 'string' ? entry.modified : null,
        fileType: typeof entry.fileType === 'string' ? entry.fileType : 'notebook',
        favorite: entry.favorite === true,
        lastPage: null,
      });
    })
  );
  // Built after the stats, so the folder list doesn't depend on which finished first.
  docs.sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const doc of docs) doc.parentId = folderId(doc.folders);
  return { folders: [...folders.values()], docs };
}

/** Lists the whole tablet, then exportDocuments() everything. Same result/rejections. */
async function syncAll({ client, signal, ...options }) {
  if (signal?.aborted) throw Object.assign(new SyncCancelledError(), { summary: emptySummary() });
  let docs;
  try {
    docs = await client.listDocuments(signal);
  } catch (err) {
    err.summary = emptySummary();
    throw err;
  }
  return exportDocuments({ client, signal, docs, ...options });
}

const emptySummary = () => ({ total: 0, downloaded: 0, unchanged: 0, failed: [], stopped: false });

module.exports = {
  syncAll,
  exportDocuments,
  fetchPdf,
  savedCopy,
  savedCopies,
  savedFile,
  localLibrary,
  assignFileNames,
  MANIFEST_NAME,
  TEMP_SUFFIX,
  VERSIONS_DIR,
};
