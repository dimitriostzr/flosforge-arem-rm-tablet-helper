// Builds installers for this OS into release/. Extra arguments go to electron-builder
// (e.g. `npm run dist -- --dir` for an unpacked app only). Same approach as FlosForge Radar.
//
// On macOS without a Developer ID certificate the app is signed ad hoc ("-"). Left unsigned, the
// app would carry Electron's original signature, which the build invalidates by renaming the
// binary and editing Info.plist, and Apple silicon Macs refuse to launch an app with a broken
// signature. With a certificate (CSC_LINK or CSC_NAME, or one in the keychain picked by
// CSC_IDENTITY_AUTO_DISCOVERY), electron-builder signs with it as usual.
//
// On macOS with Xcode 26 or later, the app gets the Icon Composer icon (resources/icon.icon), which
// macOS 26+ shows like its own apps' icons; without it, the classic .icns, which those versions
// shrink onto a grey tile.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Resolved directly, so this also works outside npm scripts, where node_modules/.bin isn't on PATH.
const cli = createRequire(import.meta.url).resolve('electron-builder/cli.js');

const args = ['--publish', 'never', ...process.argv.slice(2)];
const env = { ...process.env };
const hasCertificate = env.CSC_LINK || env.CSC_NAME || env.CSC_IDENTITY_AUTO_DISCOVERY === 'true';
if (process.platform === 'darwin' && !hasCertificate) {
  console.log('No Developer ID certificate configured: signing ad hoc, for this Mac.');
  args.push('-c.mac.identity=-');
}

/** Xcode 26+'s actool, if it's installed and compiles our icon; otherwise null (and why). */
function iconCompiler() {
  const found = spawnSync('xcrun', ['--find', 'actool'], { encoding: 'utf8' });
  if (found.status !== 0) return { why: 'Xcode is not installed' };
  const actool = found.stdout.trim();
  const version = spawnSync(actool, ['--version'], { encoding: 'utf8' }).stdout ?? '';
  const major = Number(/<key>short-bundle-version<\/key>\s*<string>(\d+)/.exec(version)?.[1] ?? 0);
  if (major < 26) return { why: `Xcode ${major || '(unknown version)'} is installed, 26 or later is needed` };
  // A trial run, so a problem with the icon falls back to the classic one instead of failing the build.
  const out = mkdtempSync(path.join(tmpdir(), 'arem-icon-'));
  try {
    const trial = spawnSync(
      actool,
      ['resources/icon.icon', '--compile', out, '--app-icon', 'icon', '--platform', 'macosx', '--target-device', 'mac',
        '--minimum-deployment-target', '26.0', '--output-partial-info-plist', path.join(out, 'info.plist')],
      { encoding: 'utf8' }
    );
    if (trial.status !== 0) return { why: `actool couldn't compile resources/icon.icon: ${(trial.stderr || trial.stdout).trim()}` };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  return { actool };
}

if (process.platform === 'darwin') {
  const { actool, why } = iconCompiler();
  if (actool) {
    console.log('Using the Icon Composer icon (macOS 26+).');
    args.push('-c.mac.icon=resources/icon.icon');
    // electron-builder runs plain `actool`, which is inside Xcode, not on PATH.
    env.PATH = `${path.dirname(actool)}${path.delimiter}${env.PATH}`;
  } else {
    console.log(`Using the classic icon (${why}). macOS 26 and later show it on a grey tile; install Xcode 26+ for the proper one.`);
  }
}

const result = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit', env });
process.exit(result.status ?? 1);
