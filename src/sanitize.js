'use strict';

const MAX_NAME_BYTES = 200; // leaves room for " (abcd1234).pdf" under the 255-byte APFS limit
// Names Windows reserves for devices, with or without an extension ("CON", "nul.pdf", "COM1").
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/** Turns a notebook name into a safe base file name (without extension). */
function sanitizeFileName(name) {
  let out = String(name ?? '')
    .normalize('NFC')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/[\u0000-\u001f\u007f]/g, '-') // control characters
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '') // no hidden files
    .replace(/[. ]+$/, ''); // trailing dots/spaces upset Finder and Drive

  const chars = Array.from(out); // code points, so emoji aren't cut in half
  while (Buffer.byteLength(chars.join(''), 'utf8') > MAX_NAME_BYTES) chars.pop();
  out = chars.join('').trim();
  if (WINDOWS_RESERVED.test(out)) out = `${out}-`;
  return out || 'Untitled';
}

module.exports = { sanitizeFileName };
