'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { DEFAULT_BASE_URL, normalizeAddress } = require('./remarkable');
const { DEFAULT_THEME_ID, MODES, themeById } = require('./themes');

const FOLDER_NAME = 'reMarkable_PDFs';
const FLAGS = ['rmdocBackups', 'keepVersions', 'autoDownload'];
const MAX_TABLETS = 20;
const MAX_TABLET_NAME = 60;

/**
 * reMarkable_PDFs inside Google Drive's My Drive when Google Drive for desktop is installed, so
 * the PDFs are backed up: ~/Google Drive/My Drive (older versions), the GoogleDrive-<account>
 * folder under ~/Library/CloudStorage (current macOS versions), ~/My Drive (Windows, mirroring)
 * or G:\My Drive (Windows, streaming). Otherwise ~/Documents/reMarkable_PDFs.
 */
function defaultDestination(home = os.homedir(), platform = process.platform) {
  const myDrives = [path.join(home, 'Google Drive', 'My Drive'), path.join(home, 'My Drive')];
  try {
    const cloudStorage = path.join(home, 'Library', 'CloudStorage');
    for (const entry of fs.readdirSync(cloudStorage)) {
      if (entry.startsWith('GoogleDrive-')) myDrives.push(path.join(cloudStorage, entry, 'My Drive'));
    }
  } catch {
    // No CloudStorage folder (not macOS, or no cloud drives).
  }
  if (platform === 'win32') myDrives.push('G:\\My Drive');
  const myDrive = myDrives.find((dir) => fs.existsSync(dir));
  return path.join(myDrive ?? path.join(home, 'Documents'), FOLDER_NAME);
}

class Config {
  constructor(dir) {
    this.file = path.join(dir, 'config.json');
    this.data = {};
  }

  async load() {
    try {
      this.data = JSON.parse(await fsp.readFile(this.file, 'utf8')) ?? {};
    } catch {
      this.data = {};
    }
    return this;
  }

  get destination() {
    return this.data.destination || defaultDestination();
  }

  get tabletAddress() {
    return this.data.tabletAddress || DEFAULT_BASE_URL;
  }

  get isDefaultTabletAddress() {
    return !this.data.tabletAddress;
  }

  /** Validates and stores the address; returns the normalised form. Throws on bad input. */
  async setTabletAddress(input) {
    const address = normalizeAddress(input);
    if (address === DEFAULT_BASE_URL) delete this.data.tabletAddress;
    else this.data.tabletAddress = address;
    await this.save();
    return address;
  }

  async resetTabletAddress() {
    delete this.data.tabletAddress;
    await this.save();
    return DEFAULT_BASE_URL;
  }

  /** { mode: 'system' | 'light' | 'dark', theme: theme id } */
  get appearance() {
    const mode = MODES.includes(this.data.appearance?.mode) ? this.data.appearance.mode : 'system';
    return { mode, theme: themeById(this.data.appearance?.theme ?? DEFAULT_THEME_ID).id };
  }

  async setAppearance({ mode, theme } = {}) {
    const next = { ...this.appearance };
    if (MODES.includes(mode)) next.mode = mode;
    if (typeof theme === 'string') next.theme = themeById(theme).id;
    this.data.appearance = next;
    await this.save();
    return next;
  }

  /** Skip notebooks whose modified date matches the last download (default on). */
  get skipUnchanged() {
    return this.data.skipUnchanged !== false;
  }

  async setSkipUnchanged(value) {
    this.data.skipUnchanged = Boolean(value);
    await this.save();
  }

  /** Also save each notebook as .rmdoc next to its PDF (default off). */
  get rmdocBackups() {
    return this.data.rmdocBackups === true;
  }

  /** Move a PDF (or .rmdoc) that a newer version replaces into _versions (default off). */
  get keepVersions() {
    return this.data.keepVersions === true;
  }

  /** Download everything when the tablet connects while the window is open (default off). */
  get autoDownload() {
    return this.data.autoDownload === true;
  }

  /** Sets one of the on/off settings above. */
  async setFlag(name, value) {
    if (!FLAGS.includes(name)) throw new Error(`Unknown setting ${name}`);
    this.data[name] = Boolean(value);
    await this.save();
  }

  /** Tablets saved under a name: [{ name, address }]. */
  get tablets() {
    return Array.isArray(this.data.tablets)
      ? this.data.tablets.filter((t) => typeof t?.name === 'string' && typeof t.address === 'string')
      : [];
  }

  /** Saves `address` under `name`, replacing an entry with the same address. Returns the list. */
  async saveTablet(name, input) {
    const label = String(name ?? '').trim().slice(0, MAX_TABLET_NAME);
    if (!label) throw new Error('Give the tablet a name');
    const address = normalizeAddress(input);
    const others = this.tablets.filter((t) => t.address !== address);
    if (others.length >= MAX_TABLETS) throw new Error(`Up to ${MAX_TABLETS} tablets can be saved`);
    this.data.tablets = [...others, { name: label, address }];
    await this.save();
    return this.tablets;
  }

  async removeTablet(address) {
    this.data.tablets = this.tablets.filter((t) => t.address !== address);
    await this.save();
    return this.tablets;
  }

  async setDestination(dir) {
    this.data.destination = dir;
    await this.save();
  }

  /** One save at a time: two at once would share the temp file and could leave it empty. */
  save() {
    const write = async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(this.data, null, 2));
      await fsp.rename(tmp, this.file);
    };
    this.saving = (this.saving ?? Promise.resolve()).then(write, write);
    return this.saving;
  }
}

module.exports = { Config, defaultDestination, FLAGS };
