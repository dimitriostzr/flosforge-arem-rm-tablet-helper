// The in-app PDF viewer, drawn with pdf.js so it follows the app's theme (Chromium's built-in
// viewer can't be styled). Pages render as they scroll into view and are released again when
// far away, so long notebooks stay light.

import * as pdfjs from '../node_modules/pdfjs-dist/build/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;

const GAP = 16; // px between pages; matches .pdf-page margin in app.css
const PAD = 28; // horizontal padding inside the scroller
const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const KEEP_RENDERED = 2; // viewport-heights above/below that stay rendered
const RAIL_WIDTH = 108; // px: thumbnail width in the page strip (matches .rail-thumb in app.css)

class PdfView {
  /** `rail`, if given, gets a strip of page thumbnails for navigating. */
  constructor(scroller, { onChange = () => {}, rail = null } = {}) {
    this.scroller = scroller;
    this.rail = rail;
    this.railItems = [];
    this.railQueue = [];
    this.onChange = onChange;
    this.doc = null;
    this.pages = []; // { page, base: {width, height}, el, canvas, task, scale }
    this.zoom = 'fit'; // 'fit' (fit width) or a number
    this.current = 1;
    this.generation = 0;
    this.onScroll = () => this.#schedule();
    // Fit-width pages re-fit when the view's width changes (window resize, page strip shown or
    // hidden), keeping the same spot in view.
    this.resizeObserver = new ResizeObserver(() => this.zoom === 'fit' && this.pages.length && this.#layout(this.#anchor()));
  }

  /** Opens a PDF from its bytes. Resolves with the page count. */
  async open(bytes) {
    this.close();
    const generation = ++this.generation;
    const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false });
    this.loadingTask = task;
    const doc = await task.promise;
    if (generation !== this.generation) {
      task.destroy(); // pdf.js 6: documents are released through their loading task
      return 0;
    }
    this.doc = doc;
    this.pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      if (generation !== this.generation) return 0;
      const { width, height } = page.getViewport({ scale: 1 });
      const el = document.createElement('div');
      el.className = 'pdf-page';
      el.dataset.page = String(n);
      el.setAttribute('aria-label', `Page ${n}`);
      this.pages.push({ page, base: { width, height }, el, canvas: null, task: null, scale: 0 });
    }
    this.scroller.replaceChildren(...this.pages.map((p) => p.el));
    this.#buildRail();
    this.scroller.scrollTop = 0;
    this.scroller.addEventListener('scroll', this.onScroll, { passive: true });
    this.resizeObserver.observe(this.scroller);
    this.#layout();
    return doc.numPages;
  }

  close() {
    this.generation++;
    this.railObserver?.disconnect();
    this.railObserver = null;
    this.railQueue = [];
    for (const item of this.railItems) item.task?.cancel();
    this.railItems = [];
    this.rail?.replaceChildren();
    this.scroller.removeEventListener('scroll', this.onScroll);
    this.resizeObserver.disconnect();
    for (const p of this.pages) p.task?.cancel();
    this.pages = [];
    this.scroller.replaceChildren();
    this.loadingTask?.destroy();
    this.loadingTask = null;
    this.doc = null;
    this.current = 1;
  }

  get pageCount() {
    return this.pages.length;
  }

  /** The scale actually in use (fit width resolves to a number). */
  get scale() {
    return this.zoom === 'fit' ? this.#fitScale() : this.zoom;
  }

  setZoom(zoom) {
    const anchor = this.#anchor();
    this.zoom = zoom;
    this.#layout(anchor);
  }

  zoomIn() {
    const s = this.scale;
    this.setZoom(ZOOM_STEPS.find((z) => z > s + 0.01) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]);
  }

  zoomOut() {
    const s = this.scale;
    this.setZoom([...ZOOM_STEPS].reverse().find((z) => z < s - 0.01) ?? ZOOM_STEPS[0]);
  }

  next() {
    this.goTo(this.current + 1);
  }

  /** Call after showing the page strip: highlights and scrolls to the current page. */
  revealCurrent() {
    this.#markRail();
  }

  previous() {
    this.goTo(this.current - 1);
  }

  goTo(n) {
    const p = this.pages[Math.min(Math.max(n, 1), this.pages.length) - 1];
    if (p) this.scroller.scrollTop = p.el.offsetTop - GAP;
  }

  #fitScale() {
    const widest = Math.max(1, ...this.pages.map((p) => p.base.width));
    const available = this.scroller.clientWidth - PAD * 2;
    return Math.min(3, Math.max(0.25, available / widest));
  }

  /** Where we are, as page + fraction, so zooming keeps the same spot in view. */
  #anchor() {
    const p = this.pages[this.current - 1];
    if (!p) return null;
    return { n: this.current, fraction: (this.scroller.scrollTop - p.el.offsetTop) / Math.max(1, p.el.offsetHeight) };
  }

  #layout(anchor = null) {
    const scale = this.scale;
    for (const p of this.pages) {
      p.el.style.width = `${Math.floor(p.base.width * scale)}px`;
      p.el.style.height = `${Math.floor(p.base.height * scale)}px`;
    }
    if (anchor) {
      const p = this.pages[anchor.n - 1];
      if (p) this.scroller.scrollTop = p.el.offsetTop + anchor.fraction * p.el.offsetHeight;
    }
    this.#schedule(true);
  }

  #schedule(force = false) {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.#update(force);
    });
  }

  #update(force) {
    const top = this.scroller.scrollTop;
    const height = this.scroller.clientHeight;
    const scale = this.scale;

    // Current page: the one crossing the upper third of the view.
    const probe = top + height / 3;
    let current = 1;
    for (const p of this.pages) {
      if (p.el.offsetTop <= probe) current = Number(p.el.dataset.page);
      else break;
    }
    const changed = current !== this.current;
    this.current = current;
    if (changed || force) this.#markRail();

    for (const p of this.pages) {
      const start = p.el.offsetTop;
      const end = start + p.el.offsetHeight;
      const near = end > top - height * KEEP_RENDERED && start < top + height * (KEEP_RENDERED + 1);
      if (near && ((!p.canvas && !p.task) || p.scale !== scale)) this.#render(p, scale);
      else if (!near && p.canvas) this.#release(p);
    }
    if (changed || force) this.onChange({ page: this.current, pages: this.pages.length, scale, zoom: this.zoom });
  }

  async #render(p, scale) {
    if (p.task && p.scale === scale) return; // already rendering at this size
    p.task?.cancel();
    p.scale = scale;
    const ratio = window.devicePixelRatio || 1;
    const viewport = p.page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    const task = p.page.render({
      canvas,
      canvasContext: canvas.getContext('2d'),
      viewport,
      transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
    });
    p.task = task;
    try {
      await task.promise;
    } catch {
      return; // cancelled (zoomed, scrolled away or closed)
    } finally {
      if (p.task === task) p.task = null;
    }
    if (p.scale !== scale) return;
    p.canvas?.remove();
    p.canvas = canvas;
    p.el.append(canvas); // swap only when done: no flash of an empty page
  }

  // ------------------------------------------------------------ page strip

  #buildRail() {
    if (!this.rail) return;
    const generation = this.generation;
    this.railItems = this.pages.map((p, i) => {
      const n = i + 1;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'rail-page';
      button.dataset.page = String(n);
      button.setAttribute('aria-label', `Page ${n}`);
      const thumb = document.createElement('span');
      thumb.className = 'rail-thumb';
      thumb.style.aspectRatio = `${p.base.width} / ${p.base.height}`;
      const label = document.createElement('span');
      label.className = 'rail-num';
      label.textContent = String(n);
      button.append(thumb, label);
      button.addEventListener('click', () => this.goTo(n));
      return { n, page: p.page, button, thumb, canvas: null, task: null, wanted: false };
    });
    this.rail.replaceChildren(...this.railItems.map((item) => item.button));
    this.rail.scrollTop = 0;

    // Draw thumbnails as they come into view (a little ahead), drop them when far away.
    this.railObserver = new IntersectionObserver(
      (entries) => {
        if (generation !== this.generation) return;
        for (const entry of entries) {
          const item = this.railItems[Number(entry.target.dataset.page) - 1];
          if (!item) continue;
          item.wanted = entry.isIntersecting;
          if (item.wanted && !item.canvas && !this.railQueue.includes(item)) this.railQueue.push(item);
          if (!item.wanted && item.canvas) {
            item.canvas.remove();
            item.canvas = null;
          }
        }
        this.#drainRail(generation);
      },
      { root: this.rail, rootMargin: '400px 0px' }
    );
    for (const item of this.railItems) this.railObserver.observe(item.button);
    this.#markRail();
  }

  /** Thumbnails render one at a time, after whatever the main view is drawing. */
  async #drainRail(generation) {
    if (this.railBusy) return;
    this.railBusy = true;
    try {
      while (this.railQueue.length && generation === this.generation) {
        const item = this.railQueue.shift();
        if (!item.wanted || item.canvas) continue;
        const ratio = window.devicePixelRatio || 1;
        const base = item.page.getViewport({ scale: 1 });
        const viewport = item.page.getViewport({ scale: (RAIL_WIDTH * ratio) / base.width });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const context = canvas.getContext('2d');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        item.task = item.page.render({ canvas, canvasContext: context, viewport });
        try {
          await item.task.promise;
        } catch {
          continue; // cancelled
        } finally {
          item.task = null;
        }
        if (generation !== this.generation || !item.wanted) continue;
        item.canvas = canvas;
        item.thumb.append(canvas);
      }
    } finally {
      this.railBusy = false;
    }
  }

  /** Highlights the current page in the strip and keeps it in view. */
  #markRail() {
    if (!this.railItems.length) return;
    for (const item of this.railItems) {
      const on = item.n === this.current;
      item.button.classList.toggle('current', on);
      if (on) item.button.setAttribute('aria-current', 'page');
      else item.button.removeAttribute('aria-current');
    }
    const button = this.railItems[this.current - 1]?.button;
    if (!button || this.rail.hidden) return;
    const top = button.offsetTop; // the strip is the offset parent (position: relative)
    const bottom = top + button.offsetHeight;
    if (top < this.rail.scrollTop + 8) this.rail.scrollTop = top - 8;
    else if (bottom > this.rail.scrollTop + this.rail.clientHeight - 8) this.rail.scrollTop = bottom - this.rail.clientHeight + 8;
  }

  /**
   * Every page as an image for printing (`dpi` sharp, on white), in order. Resolves to
   * [{ url, width, height }] with blob: URLs (revoke them when done) and sizes in points; rejects
   * if the document is closed meanwhile.
   */
  async printImages({ dpi = 200, onProgress = () => {} } = {}) {
    const images = [];
    try {
      await this.pngPages({
        dpi,
        onPage: (n, total, blob) => {
          const { base } = this.pages[n - 1];
          images.push({ url: URL.createObjectURL(blob), width: base.width, height: base.height });
          onProgress(n, total);
        },
      });
    } catch (err) {
      for (const image of images) URL.revokeObjectURL(image.url);
      throw err;
    }
    return images;
  }

  /**
   * Draws every page as a PNG (`dpi` sharp, on white), in order, calling
   * `await onPage(n, total, blob)` for each. Rejects if the document is closed meanwhile.
   */
  async pngPages({ dpi = 200, onPage }) {
    const generation = this.generation;
    const pages = [...this.pages];
    for (const [i, p] of pages.entries()) {
      const viewport = p.page.getViewport({ scale: dpi / 72 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await p.page.render({ canvas, canvasContext: context, viewport }).promise;
      if (generation !== this.generation) throw new Error('closed');
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      canvas.width = canvas.height = 0; // free the pixels now, not at garbage collection
      await onPage(i + 1, pages.length, blob);
      if (generation !== this.generation) throw new Error('closed');
    }
  }

  #release(p) {
    p.task?.cancel();
    p.task = null;
    p.canvas?.remove();
    p.canvas = null;
    p.scale = 0;
  }
}

/**
 * Page 1 of a PDF as a small image for the library's cards, and the page count.
 * Resolves to { image: Uint8Array (WebP), pages }.
 */
async function renderThumbnail(bytes, width = 480) {
  const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const scale = width / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; // transparent PDFs would otherwise show the card behind
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.86));
    return { image: new Uint8Array(await blob.arrayBuffer()), pages: doc.numPages };
  } finally {
    task.destroy();
  }
}

const MAX_TEXT = 1_000_000; // characters per note, as src/textindex.js keeps

/** The text in a PDF (typed text, imported documents, converted handwriting), for search. */
async function extractText(bytes) {
  const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false });
  const doc = await task.promise;
  try {
    let text = '';
    for (let n = 1; n <= doc.numPages && text.length < MAX_TEXT; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      for (const item of content.items) text += (item.str ?? '') + (item.hasEOL ? '\n' : ' ');
      text += '\n';
      page.cleanup();
    }
    return text.slice(0, MAX_TEXT);
  } finally {
    task.destroy();
  }
}

window.PdfView = PdfView;
window.renderPdfThumbnail = renderThumbnail;
window.extractPdfText = extractText;
window.dispatchEvent(new Event('pdfview-ready'));
