'use strict';

// Error codes that mean "the tablet went away" (cable pulled, interface off, link stalled).
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'EADDRNOTAVAIL',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CLOSED',
]);

// The tablet's web server answers these while the tablet is asleep or busy (observed: 408
// after ~10s on every request). Treated like a dropped connection, not a bad notebook.
const UNAVAILABLE_STATUSES = new Set([408, 502, 503, 504]);

// Filesystem codes after which every further write would fail too, so the run should stop.
const FATAL_DISK_CODES = new Set(['ENOSPC', 'EDQUOT', 'EROFS', 'EACCES', 'EPERM', 'ENOTDIR', 'EIO']);

class SyncCancelledError extends Error {
  constructor() {
    super('Sync cancelled');
    this.name = 'SyncCancelledError';
  }
}

class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
    this.code = 'ETIMEDOUT';
  }
}

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} from ${url}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** Walks the `cause` chain (fetch wraps socket errors as TypeError('fetch failed', { cause })). */
function errorCode(err) {
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (typeof e.code === 'string') return e.code;
  }
  return undefined;
}

function isCancelled(err) {
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (e instanceof SyncCancelledError) return true;
  }
  return false;
}

function isNetworkError(err) {
  if (!err || isCancelled(err)) return false;
  if (err.name === 'TimeoutError') return true;
  if (err.name === 'HttpError' && UNAVAILABLE_STATUSES.has(err.status)) return true;
  const code = errorCode(err);
  if (code && NETWORK_CODES.has(code)) return true;
  // undici: TypeError('fetch failed') before headers, TypeError('terminated') mid-body.
  return err instanceof TypeError && /fetch failed|terminated|network/i.test(err.message);
}

function isFatalDiskError(err) {
  const code = errorCode(err);
  return Boolean(code && FATAL_DISK_CODES.has(code) && err.syscall !== 'connect');
}

function describeError(err) {
  if (!err) return 'Unknown error';
  if (isCancelled(err)) return 'Sync cancelled';
  if (err.name === 'HttpError' && UNAVAILABLE_STATUSES.has(err.status)) {
    return 'The tablet is not responding. Wake it up and try again';
  }
  const code = errorCode(err);
  if (err.name === 'TimeoutError' || code === 'ETIMEDOUT') return 'The tablet stopped responding (timed out)';
  if (isNetworkError(err)) return 'Lost connection to the tablet';
  switch (code) {
    case 'ENOSPC':
    case 'EDQUOT':
      return 'The destination disk is full';
    case 'EACCES':
    case 'EPERM':
      return 'No permission to write to the destination folder';
    case 'EROFS':
      return 'The destination folder is read-only';
    case 'ENOTDIR':
      return 'The destination path is not a folder';
    default:
      return err.message || String(err);
  }
}

module.exports = {
  SyncCancelledError,
  TimeoutError,
  HttpError,
  errorCode,
  isCancelled,
  isNetworkError,
  isFatalDiskError,
  describeError,
};
