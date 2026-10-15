'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareMacApp, makeUuidUnique, addInfo } = require('../scripts/mac-bundle.cjs');

const ELECTRON_UUID = Buffer.from('4c4c44f155553144a1f0f2b1ad5e7a11', 'hex');
const ARM64 = 0x0100000c;
const X64 = 0x01000007;

/** A minimal 64-bit Mach-O: header, a segment-sized filler command, then LC_UUID. */
function machO(cpu) {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(cpu, 4);
  header.writeUInt32LE(2, 12); // MH_EXECUTE
  header.writeUInt32LE(2, 16); // two commands
  header.writeUInt32LE(24 + 24, 20);
  const filler = Buffer.alloc(24);
  filler.writeUInt32LE(0x2, 0); // LC_SYMTAB
  filler.writeUInt32LE(24, 4);
  const uuid = Buffer.alloc(24);
  uuid.writeUInt32LE(0x1b, 0);
  uuid.writeUInt32LE(24, 4);
  ELECTRON_UUID.copy(uuid, 8);
  return Buffer.concat([header, filler, uuid, Buffer.alloc(64)]);
}

/** A universal binary of `thin` slices, each aligned to 4 KiB. */
function fat(thin) {
  const head = Buffer.alloc(8 + thin.length * 20);
  head.writeUInt32BE(0xcafebabe, 0);
  head.writeUInt32BE(thin.length, 4);
  const parts = [];
  let offset = 4096;
  thin.forEach((slice, i) => {
    const entry = 8 + i * 20;
    head.writeUInt32BE(slice.readUInt32LE(4), entry);
    head.writeUInt32BE(offset, entry + 8);
    head.writeUInt32BE(slice.length, entry + 12);
    head.writeUInt32BE(12, entry + 16);
    parts.push({ offset, slice });
    offset += 4096;
  });
  const out = Buffer.alloc(offset);
  head.copy(out, 0);
  for (const part of parts) part.slice.copy(out, part.offset);
  return out;
}

const uuidAt = (data, slice = 0) => data.subarray(slice + 32 + 24 + 8, slice + 32 + 24 + 24);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mac-bundle-'));

describe('mac bundle', () => {
  test('gives an executable a stable UUID of its own', () => {
    const dir = tmp();
    const file = path.join(dir, 'App');
    fs.writeFileSync(file, machO(ARM64));
    const first = makeUuidUnique(file, 'com.example.app');
    assert.equal(first.length, 1);
    const data = fs.readFileSync(file);
    assert.notDeepEqual(uuidAt(data), ELECTRON_UUID);
    assert.equal(uuidAt(data)[6] >> 4, 5, 'a version 5 UUID');
    assert.equal(data.length, machO(ARM64).length, 'nothing else changes');
    assert.equal(makeUuidUnique(file, 'com.example.app'), null, 'already done: no change');

    fs.writeFileSync(file, machO(ARM64));
    makeUuidUnique(file, 'com.example.other');
    assert.notDeepEqual(uuidAt(fs.readFileSync(file)), uuidAt(data), 'another app, another UUID');
  });

  test('gives each architecture of a universal binary its own UUID', () => {
    const dir = tmp();
    const file = path.join(dir, 'App');
    fs.writeFileSync(file, fat([machO(ARM64), machO(X64)]));
    assert.equal(makeUuidUnique(file, 'com.example.app').length, 2);
    const data = fs.readFileSync(file);
    const [a, b] = [uuidAt(data, 4096), uuidAt(data, 8192)];
    assert.notDeepEqual(a, ELECTRON_UUID);
    assert.notDeepEqual(b, ELECTRON_UUID);
    assert.notDeepEqual(a, b);
  });

  test('leaves other files alone', () => {
    const dir = tmp();
    const file = path.join(dir, 'script.sh');
    fs.writeFileSync(file, '#!/bin/sh\necho hi\n');
    assert.equal(makeUuidUnique(file, 'com.example.app'), null);
    assert.equal(fs.readFileSync(file, 'utf8'), '#!/bin/sh\necho hi\n');
  });

  test('prepares the app and its helpers', () => {
    const app = path.join(tmp(), 'Example.app');
    const helper = path.join(app, 'Contents', 'Frameworks', 'Example Helper.app');
    const plist = '<?xml version="1.0"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleName</key>\n\t<string>X</string>\n</dict>\n</plist>\n';
    for (const [bundle, name] of [[app, 'Example'], [helper, 'Example Helper']]) {
      fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
      fs.writeFileSync(path.join(bundle, 'Contents', 'MacOS', name), machO(ARM64));
      fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), plist);
    }
    const info = { NSLocalNetworkUsageDescription: 'Talks to <the> tablet & nothing else' };
    assert.equal(prepareMacApp(app, { seed: 'com.example.app', info }), true);
    const main = uuidAt(fs.readFileSync(path.join(app, 'Contents', 'MacOS', 'Example')));
    const help = uuidAt(fs.readFileSync(path.join(helper, 'Contents', 'MacOS', 'Example Helper')));
    assert.notDeepEqual(main, ELECTRON_UUID);
    assert.notDeepEqual(help, ELECTRON_UUID);
    assert.notDeepEqual(main, help);
    const helperPlist = fs.readFileSync(path.join(helper, 'Contents', 'Info.plist'), 'utf8');
    assert.match(helperPlist, /<key>NSLocalNetworkUsageDescription<\/key>\n\t<string>Talks to &lt;the&gt; tablet &amp; nothing else<\/string>\n<\/dict>\n<\/plist>\n$/);
    assert.equal(prepareMacApp(app, { seed: 'com.example.app', info }), false, 'second run: nothing to do');
    assert.equal(addInfo(path.join(helper, 'Contents', 'Info.plist'), info), false);
  });
});
