'use strict';

// Joins several PDFs into one, in order, with pdf-lib.

const fsp = require('node:fs/promises');
const path = require('node:path');

/**
 * parts: [{ file, name }]. Writes the combined PDF to outPath (atomically, via a temp file next
 * to it). Resolves to { pages, failed: [{ name, error }] }; rejects if no part could be read.
 */
async function combinePdfs(parts, outPath, { title } = {}) {
  let PDFDocument;
  try {
    ({ PDFDocument } = require('pdf-lib'));
  } catch {
    throw new Error('Combining PDFs needs pdf-lib: run npm install');
  }
  const out = await PDFDocument.create();
  const failed = [];
  for (const part of parts) {
    try {
      const source = await PDFDocument.load(await fsp.readFile(part.file));
      const pages = await out.copyPages(source, source.getPageIndices());
      for (const page of pages) out.addPage(page);
    } catch (err) {
      const encrypted = err?.constructor?.name === 'EncryptedPDFError';
      failed.push({ name: part.name, error: encrypted ? 'The PDF is encrypted' : err.message || String(err) });
    }
  }
  if (out.getPageCount() === 0) throw new Error(failed[0]?.error ?? 'Nothing to combine');

  if (title) out.setTitle(title);
  out.setProducer('FlosForge ArEm Buddy');
  out.setCreator('FlosForge ArEm Buddy');
  const tmp = path.join(path.dirname(outPath), `.${path.basename(outPath)}.part`);
  try {
    await fsp.writeFile(tmp, await out.save());
    await fsp.rename(tmp, outPath);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return { pages: out.getPageCount(), failed };
}

module.exports = { combinePdfs };
