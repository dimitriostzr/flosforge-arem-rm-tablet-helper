'use strict';

// The text inside notes that have a PDF on this computer, for searching. The window extracts
// it with pdf.js; it's stored per note version (id + modified), like the thumbnails.
// Handwriting has no text unless it was converted on the tablet.

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MAX_CHARS = 1_000_000; // per note
const SNIPPET_RADIUS = 60; // characters around the first match

/**
 * Lowercase, without accents, one output code point per input code point, so positions in
 * the folded text are positions in the original (for snippets).
 */
function foldText(text) {
  let out = '';
  for (const ch of String(text ?? '')) {
    const plain = ch.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
    const lower = ch.toLowerCase();
    out += plain.length === ch.length ? plain : lower.length === ch.length ? lower : ch;
  }
  return out;
}

const terms = (query) => foldText(query).split(/\s+/).filter(Boolean);

function snippet(text, folded, at, length) {
  const from = Math.max(0, at - SNIPPET_RADIUS);
  const to = Math.min(text.length, at + length + SNIPPET_RADIUS);
  const body = text.slice(from, to).replace(/\s+/g, ' ').trim();
  return `${from > 0 ? '…' : ''}${body}${to < text.length ? '…' : ''}`;
}

class TextIndex {
  constructor(dir) {
    this.dir = dir;
    this.entries = null; // id -> { file, modified, text, folded }, loaded on first search
  }

  #base(doc) {
    const version = crypto.createHash('sha1').update(String(doc.modified)).digest('hex').slice(0, 12);
    return path.join(this.dir, `${doc.id}-${version}.json`);
  }

  /** True if this version of the note has been indexed (possibly with no text). */
  async has(doc) {
    return Boolean(await fsp.stat(this.#base(doc)).catch(() => null));
  }

  /** Stores the text of one note version ({ id, modified }), replacing older versions. */
  async save(doc, text) {
    const clean = String(text ?? '').normalize('NFC').slice(0, MAX_CHARS);
    const file = this.#base(doc);
    await fsp.mkdir(this.dir, { recursive: true });
    const stale = (await fsp.readdir(this.dir).catch(() => [])).filter(
      (f) => f.startsWith(`${doc.id}-`) && f.length === path.basename(file).length && f !== path.basename(file)
    );
    await Promise.all(stale.map((f) => fsp.rm(path.join(this.dir, f), { force: true })));
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ id: doc.id, modified: doc.modified, text: clean }));
    await fsp.rename(tmp, file);
    this.entries?.set(doc.id, { modified: doc.modified, text: clean, folded: foldText(clean) });
  }

  async #load() {
    if (this.entries) return this.entries;
    const entries = new Map();
    for (const name of await fsp.readdir(this.dir).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      const data = await fsp
        .readFile(path.join(this.dir, name), 'utf8')
        .then(JSON.parse)
        .catch(() => null);
      if (typeof data?.id !== 'string' || typeof data.text !== 'string') continue;
      entries.set(data.id, { modified: data.modified ?? null, text: data.text, folded: foldText(data.text) });
    }
    this.entries = entries;
    return entries;
  }

  /**
   * Notes whose text contains every word of `query`: { [id]: { modified, snippet } }. The caller
   * keeps only hits whose `modified` matches the note's current version.
   */
  async search(query) {
    const words = terms(query);
    const hits = {};
    if (!words.length) return hits;
    for (const [id, entry] of await this.#load()) {
      if (!entry.text || !words.every((w) => entry.folded.includes(w))) continue;
      const at = entry.folded.indexOf(words[0]);
      hits[id] = { modified: entry.modified, snippet: snippet(entry.text, entry.folded, at, words[0].length) };
    }
    return hits;
  }
}

module.exports = { TextIndex, foldText };
