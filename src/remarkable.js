'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { TimeoutError, HttpError } = require('./errors');

const DEFAULT_BASE_URL = 'http://10.11.99.1';
const MAX_FOLDER_DEPTH = 32; // guards against a malformed (cyclic) tree

/**
 * An AbortController tied to an optional parent signal, with a re-armable timeout.
 * `arm(ms)` restarts the countdown, which makes it usable both as a "wait for headers"
 * timeout and as an idle/stall timeout while a body is streaming.
 */
function linkedAbort(parentSignal) {
  const controller = new AbortController();
  let timer = null;
  const onParentAbort = () => controller.abort(parentSignal.reason);

  if (parentSignal) {
    if (parentSignal.aborted) controller.abort(parentSignal.reason);
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }

  return {
    signal: controller.signal,
    arm(ms, message) {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new TimeoutError(message)), ms);
    },
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
  };
}

/**
 * "10.11.99.1" or "http://10.11.99.1/" -> "http://10.11.99.1".
 * Throws a user-readable Error for anything that isn't a plain http(s) address.
 */
function normalizeAddress(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error(`Enter the tablet address, e.g. ${DEFAULT_BASE_URL}`);
  const text = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`"${raw}" is not a valid address`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The address must start with http:// or https://');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The address should be just the host, e.g. http://10.11.99.1');
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

/** Resolves true if a TCP connection to url's host:port opens within timeoutMs. */
/** Opens and closes a TCP connection to url's host:port. Resolves to null, or why it failed. */
function canConnect(url, timeoutMs) {
  const { hostname, port, protocol } = new URL(url);
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname.replace(/^\[|\]$/g, ''), port: Number(port) || (protocol === 'https:' ? 443 : 80) });
    const finish = (problem) => {
      socket.destroy();
      resolve(problem);
    };
    socket.setTimeout(timeoutMs, () => finish('ETIMEDOUT'));
    socket.once('connect', () => finish(null));
    socket.once('error', (err) => finish(err.code || err.message));
  });
}

/**
 * Works around a quirk of the tablet's web server (seen on a Paper Pro): a request on its own
 * sits until a ~10 s timeout and gets "408 request timeout", but while another connection
 * to the tablet is open, requests are answered in milliseconds. So while any request is in
 * flight we hold one idle connection open, and reopen it whenever the tablet closes it.
 */
class Waker {
  constructor() {
    this.users = 0;
    this.socket = null;
    this.target = null;
  }

  /** Resolves once the wake connection is up (or after a short wait); call the result to release. */
  async acquire(baseUrl) {
    const { hostname, port, protocol } = new URL(baseUrl);
    const target = { host: hostname.replace(/^\[|\]$/g, ''), port: Number(port) || (protocol === 'https:' ? 443 : 80) };
    if (this.target && (this.target.host !== target.host || this.target.port !== target.port)) this.#close();
    this.target = target;
    this.users += 1;
    if (!this.socket) await this.#open();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.users -= 1;
      if (this.users === 0) this.#close();
    };
  }

  #open() {
    return new Promise((resolve) => {
      const socket = net.connect(this.target);
      this.socket = socket;
      socket.unref(); // never keeps the process alive
      socket.setNoDelay(true);
      const ready = setTimeout(resolve, 300); // don't hold the request up for long
      socket.once('connect', () => {
        clearTimeout(ready);
        resolve();
      });
      socket.on('error', () => {});
      socket.once('close', () => {
        clearTimeout(ready);
        resolve();
        if (this.socket !== socket) return;
        this.socket = null;
        // The tablet closes it after ~10 s (with a 408); keep one open while needed.
        if (this.users > 0) setTimeout(() => this.users > 0 && !this.socket && this.#open(), 20).unref();
      });
    });
  }

  #close() {
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
  }
}

// What the tablet's USB web interface accepts for upload (its own web UI allows these).
const UPLOAD_TYPES = { pdf: 'application/pdf', epub: 'application/epub+zip', rmdoc: 'application/octet-stream' };

// The tablet's own web UI reads every notebook from /download/{ID}/pdf; /placeholder is the
// older path. The first one that works is remembered.
const DOWNLOAD_FORMATS = ['pdf', 'placeholder'];

const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024;

/** 'png' | 'jpeg' | 'webp' from an image's first bytes, or null if it isn't one of those. */
function imageType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/**
 * GET for PDF downloads. The tablet's web server (seen on a Paper Pro) sends downloads with
 * both "Content-Length" and "Transfer-Encoding: chunked". That's invalid HTTP, and fetch()
 * rejects it ("Response body length does not match content-length header"). Node's lenient
 * parser accepts it and follows the chunked framing, as browsers and curl do. Aborting
 * `signal` destroys the request or response with `signal.reason`.
 */
function lenientGet(url, signal, accept = 'application/pdf') {
  return new Promise((resolve, reject) => {
    let response = null;
    const onAbort = () => (response ?? request).destroy(signal.reason);
    const lib = url.protocol === 'https:' ? https : http;
    const request = lib.get(url, { insecureHTTPParser: true, agent: false, headers: { Accept: accept } }, (res) => {
      response = res;
      res.once('close', () => signal.removeEventListener('abort', onAbort));
      resolve(res);
    });
    request.once('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Releases the socket of a response whose body we don't need. */
function discardBody(res) {
  res.body?.cancel().catch(() => {});
}

// reMarkable's API really does spell it "VissibleName".
const displayName = (item) => item.VissibleName ?? item.VisibleName ?? String(item.ID);

class RemarkableClient {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    probeTimeoutMs = 2000,
    listTimeoutMs = 20000,
    // The tablet renders the PDF before (or while) streaming it; large notebooks take a while.
    responseTimeoutMs = 180000,
    stallTimeoutMs = 60000,
    uploadTimeoutMs = 300000,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.probeTimeoutMs = probeTimeoutMs;
    this.listTimeoutMs = listTimeoutMs;
    this.responseTimeoutMs = responseTimeoutMs;
    this.stallTimeoutMs = stallTimeoutMs;
    this.uploadTimeoutMs = uploadTimeoutMs;
    this.format = null; // download format that worked on this tablet
    this.waker = new Waker();
  }

  /**
   * 'ok'      - the web interface answers
   * 'busy'    - something accepts connections at the address but the web interface doesn't
   *             answer in time, or answers 408/5xx (seen while the tablet exports a PDF or
   *             is asleep)
   * 'offline' - nothing there (unplugged, USB web interface off, wrong address)
   * Never throws.
   */
  async probe() {
    // Why the last check failed (an error code such as EHOSTUNREACH), for the connect screen.
    this.lastProblem = await canConnect(this.baseUrl, this.probeTimeoutMs);
    if (this.lastProblem) return 'offline';
    const abort = linkedAbort();
    abort.arm(this.probeTimeoutMs, 'Reachability probe timed out');
    const release = await this.waker.acquire(this.baseUrl);
    try {
      const res = await fetch(`${this.baseUrl}/`, { signal: abort.signal, cache: 'no-store' });
      discardBody(res);
      if (res.status === 408 || res.status >= 500) {
        this.lastProblem = `HTTP ${res.status}`;
        return 'busy';
      }
      return 'ok';
    } catch (err) {
      this.lastProblem = err?.name === 'TimeoutError' ? 'no answer' : err?.cause?.code || err?.message || 'error';
      return err?.name === 'TimeoutError' ? 'busy' : 'offline';
    } finally {
      release();
      abort.dispose();
    }
  }

  /** True if the web interface answers. Never throws. */
  async isReachable() {
    return (await this.probe()) === 'ok';
  }

  /** Points the client at a different tablet address (from Settings). */
  setBaseUrl(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.format = null;
  }

  /** GET /documents/ (root) or /documents/{folderId}: the raw items in one folder. */
  async listFolder(folderId, signal) {
    const url = folderId ? `${this.baseUrl}/documents/${encodeURIComponent(folderId)}` : `${this.baseUrl}/documents/`;
    const abort = linkedAbort(signal);
    abort.arm(this.listTimeoutMs, 'Timed out listing documents');
    const release = await this.waker.acquire(this.baseUrl);
    try {
      const res = await fetch(url, {
        signal: abort.signal,
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!res.ok) {
        discardBody(res);
        throw new HttpError(res.status, url);
      }
      const items = await res.json();
      if (!Array.isArray(items)) throw new Error(`Unexpected response from ${url} (expected a JSON array)`);
      return items.filter((item) => item && item.ID && item.Type);
    } finally {
      release();
      abort.dispose();
    }
  }

  /**
   * One folder's contents for browsing: [{ id, name, type: 'folder' | 'notebook', modified }],
   * folders first, then by name.
   */
  async browse(folderId, signal) {
    const items = (await this.listFolder(folderId, signal))
      .filter((item) => item.Type === 'CollectionType' || item.Type === 'DocumentType')
      .map((item) => ({
        id: String(item.ID),
        name: displayName(item),
        type: item.Type === 'CollectionType' ? 'folder' : 'notebook',
        modified: typeof item.ModifiedClient === 'string' ? item.ModifiedClient : null,
      }));
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return items.sort((a, b) => (a.type === b.type ? collator.compare(a.name, b.name) : a.type === 'folder' ? -1 : 1));
  }

  /**
   * The whole tablet in one walk, for the library view:
   *   folders: [{ id, name, parentId, path }]   path = folder names from the root, inclusive
   *   docs:    [{ id, name, parentId, folders, modified, fileType, favorite, lastPage }]
   * `lastPage` is the page last open on the tablet (1-based), not a page count: the USB web
   * interface doesn't report page counts, tags or thumbnails.
   */
  async library(signal) {
    const folders = [];
    const docs = [];
    const visited = new Set();
    const queue = [{ id: null, path: [] }];
    while (queue.length) {
      const folder = queue.shift();
      for (const item of await this.listFolder(folder.id, signal)) {
        const id = String(item.ID);
        const name = displayName(item);
        if (item.Type === 'CollectionType') {
          if (visited.has(id) || folder.path.length >= MAX_FOLDER_DEPTH) continue;
          visited.add(id);
          const path = [...folder.path, name];
          folders.push({ id, name, parentId: folder.id, path });
          queue.push({ id, path });
        } else if (item.Type === 'DocumentType') {
          docs.push({
            id,
            name,
            parentId: folder.id,
            folders: folder.path,
            modified: typeof item.ModifiedClient === 'string' ? item.ModifiedClient : null,
            fileType: typeof item.fileType === 'string' ? item.fileType : 'notebook',
            favorite: item.Bookmarked === true,
            lastPage: Number.isInteger(item.CurrentPage) ? item.CurrentPage + 1 : null,
          });
        }
      }
    }
    return { folders, docs };
  }

  /**
   * Every notebook under a folder (default: the whole tablet), normalised to
   * { id, name, folders, modified, fileType, favorite }.
   *
   * /documents/ only lists the top level, so folders (CollectionType) are walked with
   * /documents/{folderId}, which is what the tablet's own web UI does. `folders` is the
   * list of folder names from the root down (starting with `folders` passed in);
   * `modified` is ModifiedClient when present.
   */
  async listDocuments(signal, { folderId = null, folders = [] } = {}) {
    const docs = [];
    const visited = new Set();
    const queue = [{ id: folderId, folders }];

    while (queue.length) {
      const folder = queue.shift();
      for (const item of await this.listFolder(folder.id, signal)) {
        const name = displayName(item);
        if (item.Type === 'CollectionType') {
          if (!visited.has(item.ID) && folder.folders.length < MAX_FOLDER_DEPTH) {
            visited.add(item.ID);
            queue.push({ id: String(item.ID), folders: [...folder.folders, name] });
          }
        } else if (item.Type === 'DocumentType') {
          docs.push({
            id: String(item.ID),
            name,
            folders: folder.folders,
            modified: typeof item.ModifiedClient === 'string' ? item.ModifiedClient : null,
            fileType: typeof item.fileType === 'string' ? item.fileType : 'notebook',
            favorite: item.Bookmarked === true,
          });
        }
      }
    }
    return docs;
  }

  /**
   * Uploads a PDF, EPUB or .rmdoc into a folder (null: the top level). The tablet puts uploads
   * in the folder listed last, so it lists the target first, as the tablet's own web UI does;
   * then POST /upload with the file as multipart form field "file". Expects 201.
   */
  async upload(filePath, folderId = null, signal) {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    if (!UPLOAD_TYPES[ext]) throw new Error(`Can't upload .${ext || '?'} files (PDF, EPUB or .rmdoc only)`);
    const { size } = await fs.promises.stat(filePath);
    await this.listFolder(folderId, signal);

    const url = new URL(`${this.baseUrl}/upload`);
    const boundary = `----FlosForgeArEm${crypto.randomBytes(12).toString('hex')}`;
    // Quotes and line breaks in the name are percent-encoded, as browsers do.
    const filename = path.basename(filePath).replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${UPLOAD_TYPES[ext]}\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);

    const abort = linkedAbort(signal);
    abort.arm(this.uploadTimeoutMs, 'Timed out uploading to the tablet');
    const release = await this.waker.acquire(this.baseUrl);
    try {
      const status = await new Promise((resolve, reject) => {
        const lib = url.protocol === 'https:' ? https : http;
        const request = lib.request(
          url,
          {
            method: 'POST',
            insecureHTTPParser: true, // see lenientGet
            agent: false,
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': head.length + size + tail.length },
          },
          (res) => {
            res.resume(); // the body is just a message
            res.once('end', () => resolve(res.statusCode));
            res.once('error', reject);
          }
        );
        const onAbort = () => request.destroy(abort.signal.reason);
        abort.signal.addEventListener('abort', onAbort, { once: true });
        request.once('close', () => abort.signal.removeEventListener('abort', onAbort));
        request.once('error', reject);
        if (abort.signal.aborted) return onAbort();

        request.write(head);
        const file = fs.createReadStream(filePath);
        file.on('data', () => abort.arm(this.stallTimeoutMs, 'The upload stalled'));
        file.once('error', (err) => request.destroy(err));
        file.once('end', () => request.end(tail));
        file.pipe(request, { end: false });
      });
      if (status !== 201 && status !== 200) throw new HttpError(status, url.href);
    } finally {
      release();
      abort.dispose();
    }
  }

  /**
   * GET /download/{ID}/pdf (falling back to /placeholder): resolves once headers arrive,
   * with the body as a Node Readable `stream`. Call `done()` once it has been consumed (or
   * abandoned).
   */
  async openDownload(id, signal) {
    const formats = this.format ? [this.format] : DOWNLOAD_FORMATS;
    for (const [index, format] of formats.entries()) {
      try {
        const download = await this.#open(`/download/${encodeURIComponent(id)}/${format}`, signal, {
          accept: 'application/pdf',
          waiting: 'Timed out waiting for the tablet to render the PDF',
        });
        this.format = format;
        return download;
      } catch (err) {
        // 400/404 on the first format means "not supported here": try the next one.
        const unsupported = err.name === 'HttpError' && (err.status === 400 || err.status === 404);
        if (!unsupported || index === formats.length - 1) throw err;
      }
    }
    throw new Error('unreachable');
  }

  /**
   * GET /download/{ID}/rmdoc: the notebook in reMarkable's own format (a zip with the pen
   * strokes), which can be uploaded back. Same contract as openDownload().
   */
  openRmdoc(id, signal) {
    return this.#open(`/download/${encodeURIComponent(id)}/rmdoc`, signal, {
      accept: 'application/octet-stream',
      waiting: 'Timed out waiting for the tablet to package the notebook',
    });
  }

  /** GET /log.txt: the tablet's own log, for troubleshooting. Same contract as openDownload(). */
  openLog(signal) {
    return this.#open('/log.txt', signal, { accept: 'text/plain', waiting: 'Timed out waiting for the tablet log' });
  }

  /**
   * GET /thumbnail/{ID}: the picture the tablet shows for a note. Resolves to
   * { bytes: Buffer, type: 'png' | 'jpeg' | 'webp' }. Rejects with HttpError (404/400 where the
   * firmware has no thumbnails) or an Error if the answer isn't an image.
   */
  async fetchThumbnail(id, signal) {
    const download = await this.#open(`/thumbnail/${encodeURIComponent(id)}`, signal, {
      accept: 'image/*',
      waiting: 'Timed out waiting for a thumbnail',
      timeoutMs: this.listTimeoutMs,
    });
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of download.stream) {
        download.onChunk();
        size += chunk.length;
        if (size > MAX_THUMBNAIL_BYTES) throw new Error('The thumbnail is too large');
        chunks.push(chunk);
      }
    } finally {
      download.stream.destroy();
      download.done();
    }
    const bytes = Buffer.concat(chunks);
    const type = imageType(bytes);
    if (!type) throw new Error('The tablet did not return an image');
    return { bytes, type };
  }

  async #open(pathname, signal, { accept, waiting, timeoutMs = this.responseTimeoutMs }) {
    const url = new URL(`${this.baseUrl}${pathname}`);
    const abort = linkedAbort(signal);
    abort.arm(timeoutMs, waiting);
    const release = await this.waker.acquire(this.baseUrl);
    try {
      const res = await lenientGet(url, abort.signal, accept);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume(); // discard the body
        throw new HttpError(res.statusCode, url.href);
      }
      abort.arm(this.stallTimeoutMs, 'The transfer stalled');
      return {
        stream: res, // a Node Readable
        onChunk: () => abort.arm(this.stallTimeoutMs, 'The transfer stalled'),
        done: () => {
          release();
          abort.dispose();
        },
      };
    } catch (err) {
      release();
      abort.dispose();
      throw err;
    }
  }
}

module.exports = { RemarkableClient, DEFAULT_BASE_URL, UPLOAD_TYPES, normalizeAddress };
