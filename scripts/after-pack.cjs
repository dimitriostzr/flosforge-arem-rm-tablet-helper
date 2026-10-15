'use strict';

// electron-builder afterPack hook: runs after the app is assembled and before it is signed.
// On macOS, gives the executables their own UUIDs so Local Network privacy can tell this app from
// other Electron apps (see scripts/mac-bundle.cjs), and copies in Electron's license and Chromium's
// third-party licenses, which the Windows and Linux builds already carry next to the app.

const fs = require('node:fs');
const path = require('node:path');
const { prepareMacApp } = require('./mac-bundle.cjs');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const { appInfo, config } = context.packager;
  const app = path.join(context.appOutDir, `${appInfo.productFilename}.app`);
  prepareMacApp(app, { seed: appInfo.id, info: config.mac?.extendInfo });
  console.log(`  • gave the executables of ${path.basename(app)} their own UUIDs (Local Network access)`);

  const dist = path.join(path.dirname(require.resolve('electron/package.json')), 'dist');
  const resources = path.join(app, 'Contents', 'Resources');
  fs.copyFileSync(path.join(dist, 'LICENSE'), path.join(resources, 'LICENSE.electron.txt'));
  fs.copyFileSync(path.join(dist, 'LICENSES.chromium.html'), path.join(resources, 'LICENSES.chromium.html'));
  console.log('  • added LICENSE.electron.txt and LICENSES.chromium.html');
};
