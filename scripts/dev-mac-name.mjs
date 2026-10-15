// `npm start` on macOS runs inside node_modules/electron's Electron.app. This prepares that
// development copy like a release build:
//   - names it after the product (otherwise the menu bar and the Dock say "Electron");
//   - adds NSLocalNetworkUsageDescription, and gives its executables their own UUIDs (see
//     scripts/mac-bundle.cjs): without both, macOS Local Network privacy silently blocks the app
//     from the tablet's USB network and never lists it to allow;
// then re-signs it ad hoc (editing Info.plist breaks its signature, and Apple silicon won't
// launch a broken one). Release builds get the same from electron-builder (package.json).
// Does nothing on other systems, or when everything is already in place.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

if (process.platform !== 'darwin') process.exit(0);

const require = createRequire(import.meta.url);
const { productName, build } = require('../package.json');
const { addInfo, prepareMacApp } = require('./mac-bundle.cjs');
const extraInfo = build?.mac?.extendInfo ?? {};

let bundle;
try {
  // In plain Node, require('electron') is the path to .../Electron.app/Contents/MacOS/Electron.
  bundle = path.resolve(require('electron'), '../../..');
} catch {
  process.exit(0); // Electron isn't downloaded yet: it will be on first launch, and named next time.
}
const plist = path.join(bundle, 'Contents', 'Info.plist');
if (!existsSync(plist)) process.exit(0);

let text = readFileSync(plist, 'utf8');
let changed = false;
for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
  const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`);
  const match = text.match(pattern);
  if (match && match[2] !== productName) {
    text = text.replace(pattern, `$1${productName}$3`);
    changed = true;
  }
}
if (changed) writeFileSync(plist, text);
if (addInfo(plist, extraInfo)) changed = true;
// A seed of its own, so the development copy and the installed app don't share Local Network access.
if (prepareMacApp(bundle, { seed: `${build.appId}.dev`, info: extraInfo })) changed = true;
if (!changed) process.exit(0);

try {
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'ignore' });
} catch (err) {
  console.warn(`Couldn't re-sign the development Electron.app (${err.message}). If it won't start, run: npm install`);
}
// Tell Finder and the Dock about the new name.
const lsregister =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
try {
  execFileSync(lsregister, ['-f', bundle], { stdio: 'ignore' });
} catch {
  // Cosmetic only.
}
console.log(`Prepared the development Electron.app: named "${productName}", local network access declared, own executable UUIDs.`);
