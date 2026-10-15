'use strict';

// Makes a macOS .app built on Electron's prebuilt binaries recognisable to Local Network privacy.
//
// macOS 15+ tells apps apart for Local Network access by the Mach-O UUID (LC_UUID) of their
// executables, not by bundle id or signature. Electron ships one binary for everyone, so every app
// on the same Electron version has the same UUID: macOS mixes their permissions up, typically never
// asks, never lists the app under Privacy & Security > Local Network, and fails its connections
// at once with EHOSTUNREACH (Apple's TN3179 and developer forums: the UUID must be present and
// unique). Each executable here gets its own UUID, derived from the bundle id, so it
// stays the same from build to build (and across Electron upgrades, so access granted once sticks).
//
// Used by scripts/after-pack.cjs (release builds, before signing) and scripts/dev-mac-name.mjs
// (`npm start`). Both re-sign afterwards: the changes invalidate the code signature.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LC_UUID = 0x1b;
const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
// RFC 4122's URL namespace, for name-based (version 5) UUIDs.
const NAMESPACE = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');

/** A version 5 UUID for `name`, as 16 bytes. */
function uuidFor(name) {
  const bytes = crypto.createHash('sha1').update(NAMESPACE).update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes;
}

const formatUuid = (bytes) =>
  bytes.toString('hex').toUpperCase().replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

/** The architectures in a Mach-O file: [{ offset, cpu }] (one per slice of a universal binary). */
function slices(data) {
  if (data.length < 8) return [];
  const fat = data.readUInt32BE(0);
  if (fat === FAT_MAGIC || fat === FAT_MAGIC_64) {
    const wide = fat === FAT_MAGIC_64;
    const count = data.readUInt32BE(4);
    const found = [];
    for (let i = 0; i < count; i++) {
      const entry = 8 + i * (wide ? 32 : 20);
      const offset = wide ? Number(data.readBigUInt64BE(entry + 8)) : data.readUInt32BE(entry + 8);
      found.push({ offset, cpu: data.readUInt32BE(entry) });
    }
    return found;
  }
  const magic = data.readUInt32LE(0);
  return magic === MH_MAGIC || magic === MH_MAGIC_64 ? [{ offset: 0, cpu: data.readUInt32LE(4) }] : [];
}

/** Where a slice's 16 UUID bytes are, or -1 if it has none. */
function uuidOffset(data, slice) {
  const wide = data.readUInt32LE(slice) === MH_MAGIC_64;
  const commands = data.readUInt32LE(slice + 16);
  let at = slice + (wide ? 32 : 28);
  for (let i = 0; i < commands && at + 8 <= data.length; i++) {
    const command = data.readUInt32LE(at);
    const size = data.readUInt32LE(at + 4);
    if (command === LC_UUID) return at + 8;
    if (size < 8) break;
    at += size;
  }
  return -1;
}

/**
 * Gives a Mach-O executable a UUID of its own (one per architecture), derived from `seed` and its
 * file name. Returns the new UUIDs if it changed anything, else null.
 */
function makeUuidUnique(file, seed) {
  const data = fs.readFileSync(file);
  const changed = [];
  for (const { offset, cpu } of slices(data)) {
    const at = uuidOffset(data, offset);
    if (at < 0) continue;
    const wanted = uuidFor(`${seed}/${path.basename(file)}/${cpu}`);
    if (data.subarray(at, at + 16).equals(wanted)) continue;
    wanted.copy(data, at);
    changed.push(formatUuid(wanted));
  }
  if (!changed.length) return null;
  fs.writeFileSync(file, data);
  return changed;
}

/** Adds string entries to an Info.plist that doesn't have them yet. Returns whether it did. */
function addInfo(plist, entries) {
  let text = fs.readFileSync(plist, 'utf8');
  const xml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let changed = false;
  for (const [key, value] of Object.entries(entries ?? {})) {
    if (typeof value !== 'string' || text.includes(`<key>${key}</key>`)) continue;
    text = text.replace(/<\/dict>\s*<\/plist>\s*$/, `\t<key>${key}</key>\n\t<string>${xml(value)}</string>\n</dict>\n</plist>\n`);
    changed = true;
  }
  if (changed) fs.writeFileSync(plist, text);
  return changed;
}

/** The app itself and its helper apps (Contents/Frameworks/*.app). */
function bundles(app) {
  const frameworks = path.join(app, 'Contents', 'Frameworks');
  const helpers = fs.existsSync(frameworks)
    ? fs.readdirSync(frameworks).filter((name) => name.endsWith('.app')).map((name) => path.join(frameworks, name))
    : [];
  return [app, ...helpers];
}

/**
 * Gives every executable of `app` its own UUID, and adds `info` (Info.plist strings such as
 * NSLocalNetworkUsageDescription) to the helpers too. Returns whether anything changed.
 */
function prepareMacApp(app, { seed, info } = {}) {
  let changed = false;
  for (const bundle of bundles(app)) {
    const macos = path.join(bundle, 'Contents', 'MacOS');
    if (fs.existsSync(macos)) {
      for (const name of fs.readdirSync(macos)) {
        const file = path.join(macos, name);
        if (fs.statSync(file).isFile() && makeUuidUnique(file, seed)) changed = true;
      }
    }
    const plist = path.join(bundle, 'Contents', 'Info.plist');
    if (bundle !== app && info && fs.existsSync(plist) && addInfo(plist, info)) changed = true;
  }
  return changed;
}

module.exports = { prepareMacApp, makeUuidUnique, addInfo, uuidFor, formatUuid };
