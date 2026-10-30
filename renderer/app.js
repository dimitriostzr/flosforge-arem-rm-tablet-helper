'use strict';

const api = window.companion;
const $ = (id) => document.getElementById(id);

// Per-window conveniences (layout, sort, open folders). Never required for correctness.
const prefs = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage unavailable: fine
    }
  },
};

// ---------------------------------------------------------------------------
// Themes (src/themes.json, shared with FlosForge Radar). Main sets nativeTheme.themeSource
// from the System / Light / Dark setting, so prefers-color-scheme already follows it here.

let themes = null; // [{ id, name, description, monospace, light, dark }]
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const THEME_VARS = {
  '--background': 'background',
  '--surface': 'surface',
  '--surface-alt': 'surfaceAlt',
  '--hover': 'accent',
  '--text': 'foreground',
  '--muted': 'muted',
  '--border': 'border',
  '--input': 'border',
  '--primary': 'primary',
  '--on-primary': 'onPrimary',
  '--sidebar': 'sidebar',
  '--ring': 'primary',
};

const themeFor = (id) => themes?.find((t) => t.id === id) ?? themes?.[0];

function applyTheme() {
  const theme = current && themeFor(current.appearance.theme);
  if (!theme) return;
  const palette = darkQuery.matches ? theme.dark : theme.light;
  const root = document.documentElement;
  for (const [cssVar, key] of Object.entries(THEME_VARS)) root.style.setProperty(cssVar, palette[key]);
  // Notebooks (most of what's shown) take the theme's accent; PDFs and EPUBs keep their colours.
  root.style.setProperty('--type-notebook', palette.primary);
  if (theme.monospace) root.style.setProperty('--font', 'var(--mono)');
  else root.style.removeProperty('--font');
  root.dataset.theme = theme.id;
}

darkQuery.addEventListener('change', () => {
  applyTheme();
  if (ui.page === 'settings') renderAppearance();
});

let current = null; // latest state from main
let library = null; // { folders, docs } from the tablet, or from the save-to folder
let librarySource = null; // 'tablet' | 'local' (the notes saved in the save-to folder, offline)
let index = null; // lookups derived from library
let libraryError = null;
let libraryLoading = false;
let libraryAddress = null; // address the library was loaded from (null: from the folder)
let localLoadedFor = null; // save-to folder the offline library was last read from
// id -> what this computer has for the note's current version (see localNotes in main.js):
// { thumb?, pages?, tablet?, pdf?, indexed? }
let local = {};

const RECENT_DAYS = 30;
const ui = {
  page: 'library', // library | settings | about
  view: { kind: 'all' }, // all | favorites | recent | folder (+id)
  search: '',
  searchInView: false, // false: search everything; true: only the current view
  type: 'any',
  modified: 'any',
  favoritesOnly: false,
  includeSubfolders: true,
  sort: prefs.get('sort', 'modified-desc'),
  layout: prefs.get('layout', 'grid'),
  expanded: new Set(prefs.get('expanded', [])),
  railOpen: prefs.get('readerRail', true), // the reader's page strip
  selectMode: prefs.get('selectMode', 'one'), // one: click selects one note (⌘/Ctrl adds); many: clicks add
};
const selected = new Set(); // doc ids, kept across views
let shown = []; // docs currently rendered, in order
let lastClicked = null; // for shift-click ranges

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fold = (text) =>
  String(text ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
const TYPE_LABEL = { notebook: 'Notebook', pdf: 'PDF', epub: 'EPUB' };
const typeLabel = (type) => TYPE_LABEL[type] ?? type.toUpperCase();
const KNOWN_TYPES = ['notebook', 'pdf', 'epub'];
const typeClass = (type) => (KNOWN_TYPES.includes(type) ? type : 'notebook');

function timeOf(doc) {
  const t = doc.modified ? Date.parse(doc.modified) : NaN;
  return Number.isNaN(t) ? null : t;
}
function daysAgo(doc) {
  const t = timeOf(doc);
  return t === null ? null : (Date.now() - t) / 86400000;
}
function relativeDate(doc) {
  const t = timeOf(doc);
  if (t === null) return '';
  const days = (t - Date.now()) / 86400000;
  if (Math.abs(days) < 1) {
    const hours = Math.round(days * 24);
    return hours === 0 ? 'just now' : relative.format(hours, 'hour');
  }
  if (Math.abs(days) < 30) return relative.format(Math.round(days), 'day');
  if (Math.abs(days) < 365) return relative.format(Math.round(days / 30), 'month');
  return relative.format(Math.round(days / 365), 'year');
}
const fullDate = (doc) => (timeOf(doc) === null ? '' : dateFormat.format(timeOf(doc)));
const folderLabel = (doc) => (doc.folders.length ? doc.folders.join(' / ') : 'My files');
const hostOf = (address) => address.replace(/^https?:\/\//, '');

const ICONS = {
  folder:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>',
  notebook:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5.5" y="3" width="13" height="18" rx="1.5"/><path d="M8.5 8h7M8.5 11.5h7M8.5 15h4"/></svg>',
  pdf: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4.5 4.5V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4.5h4.5"/></svg>',
  epub: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5C6.5 4 9.5 4 12 5.5v14c-2.5-1.5-5.5-1.5-8 0zM20 5.5C17.5 4 14.5 4 12 5.5v14c2.5-1.5 5.5-1.5 8 0z"/></svg>',
  all: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>',
  favorites:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.4 7.2 18.9l.9-5.4-3.9-3.8 5.4-.8z"/></svg>',
  recent: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
};
const iconFor = (type) => ICONS[type] ?? ICONS.notebook;

/** Builds an element; `html` is only ever one of the static ICONS above. */
function el(tag, { className, text, html, attrs } = {}, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html) node.innerHTML = html;
  if (text !== undefined) node.append(document.createTextNode(text));
  for (const [key, value] of Object.entries(attrs ?? {})) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

const tile = (type) => el('span', { className: `tile tile-${type === 'folder' ? 'folder' : typeClass(type)}`, html: iconFor(type) });

// ---------------------------------------------------------------------------
// Library

function buildIndex({ folders, docs }) {
  const folderById = new Map(folders.map((f) => [f.id, f]));
  const childFolders = new Map();
  const docsIn = new Map();
  const push = (map, key, value) => (map.get(key) ?? map.set(key, []).get(key)).push(value);
  folders.forEach((f) => push(childFolders, f.parentId, f));
  docs.forEach((d) => push(docsIn, d.parentId, d));
  for (const list of childFolders.values()) list.sort((a, b) => collator.compare(a.name, b.name));

  const descendants = (id) => {
    const ids = new Set([id]);
    const stack = [id];
    while (stack.length) {
      for (const child of childFolders.get(stack.pop()) ?? []) {
        ids.add(child.id);
        stack.push(child.id);
      }
    }
    return ids;
  };
  const totals = new Map();
  const total = (id) => {
    if (!totals.has(id)) {
      let n = docsIn.get(id)?.length ?? 0;
      for (const child of childFolders.get(id) ?? []) n += total(child.id);
      totals.set(id, n);
    }
    return totals.get(id);
  };
  folders.forEach((f) => total(f.id));
  const haystack = new Map(docs.map((d) => [d.id, fold(`${d.name} ${d.folders.join(' ')}`)]));
  return { folderById, childFolders, docsIn, descendants, totals, haystack, docById: new Map(docs.map((d) => [d.id, d])) };
}

async function loadLibrary() {
  if (libraryLoading) return;
  libraryLoading = true;
  libraryError = null;
  render();
  const address = current?.tabletAddress;
  const result = await api.library();
  libraryLoading = false;
  if (result.error) libraryError = result.error;
  else setLibrary(result.library, 'tablet', address);
  render();
  refreshLocal();
}

/**
 * No tablet: shows the notes saved in the save-to folder, if there are any (else the connect
 * page stays). Read once per folder; the tablet's library replaces it when it connects.
 */
async function loadLocalLibrary() {
  const destination = current?.destination;
  localLoadedFor = destination;
  const result = await api.localLibrary();
  // The tablet connected, or the folder changed, meanwhile.
  if (result.error || current?.destination !== destination) return;
  if (library && librarySource !== 'local') return;
  if (result.library.docs.length) {
    setLibrary(result.library, 'local', null);
  } else if (library) {
    // Another folder, with nothing saved in it yet.
    [library, librarySource, index, local] = [null, null, null, {}];
  }
  render();
  refreshLocal();
}

function setLibrary(lib, source, address) {
  library = lib;
  librarySource = source;
  libraryAddress = address;
  index = buildIndex(library);
  // Drop selections and a folder view that no longer exist.
  for (const id of selected) if (!index.docById.has(id)) selected.delete(id);
  if (ui.view.kind === 'folder' && !index.folderById.has(ui.view.id)) ui.view = { kind: 'all' };
}

// ---------------------------------------------------------------------------
// Thumbnails and search text. Notes downloaded (or opened) on this computer get page 1 drawn
// with pdf.js, and their text indexed for search, in the background, one at a time; the main
// process keeps both per note version. Other notes show the tablet's own thumbnail, where the
// firmware has one.

let thumbsRunning = false;
let renderQueued = false;

function renderSoon() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (ui.page === 'library' && library) renderLibrary();
    if (current) renderDownloads(); // "Get n Thumbnails" counts follow too
  });
}

async function refreshLocal() {
  if (!library) return;
  const docs = library.docs.filter((d) => d.modified).map(({ id, name, modified }) => ({ id, name, modified }));
  const result = await api.localNotes(docs);
  if (result.error || !library) return;
  local = result.notes;
  renderSoon();
  drawThumbnails();
  fetchTabletThumbnails();
}

// A PDF here still to draw a thumbnail from (with its page count), or to index.
const needsWork = (note) => note?.pdf && !note.failed && (!note.pages || !note.indexed);

async function drawThumbnails() {
  if (thumbsRunning) return;
  thumbsRunning = true;
  try {
    await pdfViewReady();
    for (;;) {
      const id = Object.keys(local).find((key) => needsWork(local[key]));
      const doc = id && index?.docById.get(id);
      if (!doc) break;
      const note = local[id];
      try {
        const file = await api.readNote(note.pdf);
        if (file.error) throw new Error(file.error);
        if (!note.pages) {
          // pdf.js takes over the bytes it's given: hand it a copy, the text needs them too.
          const { image, pages } = await window.renderPdfThumbnail(file.bytes.slice());
          const saved = await api.saveThumbnail({ id, name: doc.name, modified: doc.modified }, image, pages);
          if (saved.error) throw new Error(saved.error);
          Object.assign(note, saved, { tablet: false });
        }
        if (!note.indexed) {
          const text = await window.extractPdfText(file.bytes);
          const saved = await api.saveText({ id, modified: doc.modified }, text);
          if (saved.error) throw new Error(saved.error);
          note.indexed = true;
          if (searching()) searchText(); // it may match now
        }
      } catch (err) {
        console.warn('Thumbnail or text failed for', doc.name, err);
        note.failed = true; // don't retry until the next refresh
      }
      renderSoon();
    }
  } finally {
    thumbsRunning = false;
  }
}

let tabletThumbsRunning = false;
let tabletThumbsUnsupported = false; // this tablet's firmware has no /thumbnail
const tabletThumbMisses = new Set(); // "id@modified" the tablet had no thumbnail for

/** Asks the tablet for the thumbnails of notes that have none here, the ones shown first. */
async function fetchTabletThumbnails() {
  if (tabletThumbsRunning || tabletThumbsUnsupported || !library) return;
  tabletThumbsRunning = true;
  const lib = library;
  try {
    while (library === lib && canDownload()) {
      const batch = [];
      const seen = new Set();
      for (const d of [...shown, ...lib.docs]) {
        if (batch.length >= 12) break;
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        // A note with a PDF here gets its thumbnail drawn from that instead.
        if (d.modified && !local[d.id]?.thumb && !local[d.id]?.pdf && !tabletThumbMisses.has(`${d.id}@${d.modified}`)) batch.push(d);
      }
      if (!batch.length) break;
      const result = await api.tabletThumbnails(batch.map(({ id, modified }) => ({ id, modified })));
      if (result.error || library !== lib) break;
      for (const [id, thumb] of Object.entries(result.thumbs)) local[id] = { ...local[id], thumb, tablet: true };
      for (const id of result.failed) {
        const doc = index.docById.get(id);
        if (doc) tabletThumbMisses.add(`${id}@${doc.modified}`);
      }
      renderSoon();
      if (result.unsupported) tabletThumbsUnsupported = true;
      if (result.unsupported || result.paused || !(Object.keys(result.thumbs).length + result.failed.length)) break;
    }
  } finally {
    tabletThumbsRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Searching the text inside notes (the main process searches its index)

let textHits = { query: '', hits: new Map() }; // id -> snippet, for the current versions
let textSearchTimer = null;

function searchText() {
  clearTimeout(textSearchTimer);
  const query = ui.search.trim();
  if (!query) {
    textHits = { query: '', hits: new Map() };
    return;
  }
  textSearchTimer = setTimeout(async () => {
    const result = await api.searchText(query);
    if (result.error || ui.search.trim() !== query || !index) return;
    const hits = new Map();
    for (const [id, hit] of Object.entries(result.hits)) {
      if (index.docById.get(id)?.modified === hit.modified) hits.set(id, hit.snippet);
    }
    textHits = { query, hits };
    render();
  }, 200);
}

/** The matching text, if this note was found by its text rather than its name. */
function textMatch(doc) {
  if (!searching() || textHits.query !== ui.search.trim() || !textHits.hits.has(doc.id)) return null;
  const words = terms();
  return words.every((w) => index.haystack.get(doc.id).includes(w)) ? null : textHits.hits.get(doc.id);
}

// ---------------------------------------------------------------------------
// Filtering

function inView(docs, view) {
  switch (view.kind) {
    case 'favorites':
      return docs.filter((d) => d.favorite);
    case 'recent':
      return docs.filter((d) => (daysAgo(d) ?? Infinity) <= RECENT_DAYS);
    case 'folder': {
      const ids = ui.includeSubfolders ? index.descendants(view.id) : new Set([view.id]);
      return docs.filter((d) => ids.has(d.parentId));
    }
    default:
      return docs;
  }
}

const searching = () => ui.search.trim() !== '';
const globalSearch = () => searching() && !ui.searchInView;
const terms = () => fold(ui.search).split(/\s+/).filter(Boolean);
const filtersActive = () => ui.type !== 'any' || ui.modified !== 'any' || ui.favoritesOnly;

/** Every filter except type (the type chips show counts for this set). */
function scopedDocs() {
  let docs = library.docs;
  if (!globalSearch()) docs = inView(docs, ui.view);
  if (ui.favoritesOnly) docs = docs.filter((d) => d.favorite);
  if (ui.modified !== 'any') {
    docs = docs.filter((d) => {
      const days = daysAgo(d);
      if (days === null) return false;
      return ui.modified === 'older365' ? days > 365 : days <= Number(ui.modified);
    });
  }
  if (searching()) {
    const words = terms();
    const byText = textHits.query === ui.search.trim() ? textHits.hits : new Map();
    docs = docs.filter((d) => byText.has(d.id) || words.every((w) => index.haystack.get(d.id).includes(w)));
  }
  return docs;
}

function sortDocs(docs) {
  const byName = (a, b) => collator.compare(a.name, b.name);
  const byTime = (a, b) => (timeOf(a) ?? 0) - (timeOf(b) ?? 0);
  const compare = {
    'modified-desc': (a, b) => byTime(b, a) || byName(a, b),
    'modified-asc': (a, b) => byTime(a, b) || byName(a, b),
    'name-asc': byName,
    'name-desc': (a, b) => byName(b, a),
    'folder-asc': (a, b) => collator.compare(folderLabel(a), folderLabel(b)) || byName(a, b),
  }[ui.sort];
  return [...docs].sort(compare ?? byName);
}

function clearFilters() {
  ui.type = 'any';
  ui.modified = 'any';
  ui.favoritesOnly = false;
  clearSearch();
  render();
}

function clearSearch() {
  ui.search = '';
  $('search').value = '';
  searchText();
}

function setView(view) {
  closeReader();
  ui.page = 'library';
  ui.view = view;
  if (view.kind === 'folder') {
    // Reveal it in the tree.
    for (let f = index.folderById.get(view.id); f?.parentId; f = index.folderById.get(f.parentId)) ui.expanded.add(f.parentId);
    prefs.set('expanded', [...ui.expanded]);
  }
  lastClicked = null;
  $('results').scrollTop = 0;
  render();
}

// ---------------------------------------------------------------------------
// Rendering: sidebar

/** Marks an element as a place to drop files for uploading into `folder` ({ id, name }; id null = top level). */
function dropFolder(node, folder) {
  node.dataset.dropFolder = folder.id ?? '';
  node.dataset.dropName = folder.name;
  return node;
}

function navItem({ icon, label, count, active, onClick, onDoubleClick, depth = 0, twisty, drop }) {
  const button = el('button', { className: `nav-item${active ? ' active' : ''}`, attrs: { type: 'button' } });
  if (drop) dropFolder(button, drop);
  button.style.setProperty('--depth', depth);
  if (twisty) button.append(twisty);
  button.append(el('span', { className: 'nav-icon', html: ICONS[icon] ?? iconFor(icon) }), el('span', { className: 'nav-label', text: label }));
  if (count !== undefined) button.append(el('span', { className: 'count', text: String(count) }));
  if (active) button.setAttribute('aria-current', 'page');
  button.addEventListener('click', onClick);
  if (onDoubleClick) button.addEventListener('dblclick', onDoubleClick);
  return el('li', {}, [button]);
}

const JOB_STATUS = { thumbnails: 'Getting thumbnails', upload: 'Uploading', combine: 'Combining' };

const STATUS = {
  checking: { label: 'Checking…', dot: '' },
  ok: { label: 'Connected', dot: 'ok' },
  busy: { label: 'Not responding', dot: 'warn' },
  offline: { label: 'Not connected', dot: '' },
};

function renderSidebar() {
  const { status, tabletAddress, job } = current;
  const info = STATUS[status] ?? STATUS.checking;
  $('status-dot').className = `status-dot ${job ? 'ok' : info.dot}`;
  $('status-label').textContent = job ? (JOB_STATUS[job.kind] ?? 'Downloading') : info.label;
  $('status-detail').textContent = job
    ? job.phase === 'listing'
      ? 'Finding notebooks…'
      : `${job.current} of ${job.total}`
    : [
        current.tabletName ?? hostOf(tabletAddress),
        library && status === 'ok' ? plural(library.docs.length, 'note') : '',
        library && librarySource === 'local' && status !== 'ok' ? `${plural(library.docs.length, 'note')} saved here` : '',
      ]
        .filter(Boolean)
        .join(' · ');
  $('refresh').disabled = status !== 'ok' || Boolean(job) || libraryLoading;
  $('refresh').title = 'Reload the notes from the tablet';
  $('open-folder').title = `Open ${current.destinationDisplay}, where downloads are saved`;
  $('nav-settings').classList.toggle('active', ui.page === 'settings');
  $('nav-about').classList.toggle('active', ui.page === 'about');

  const lib = ui.page === 'library';
  const items = [
    { icon: 'all', label: 'All notes', view: { kind: 'all' }, drop: { id: null, name: 'My files' } },
    { icon: 'favorites', label: 'Favorites', view: { kind: 'favorites' } },
    { icon: 'recent', label: 'Recently modified', view: { kind: 'recent' } },
  ];
  $('nav-library').replaceChildren(
    ...items.map((item) =>
      navItem({
        ...item,
        count: library ? inView(library.docs, item.view).length : undefined,
        active: lib && !globalSearch() && ui.view.kind === item.view.kind,
        onClick: () => {
          clearSearch();
          setView(item.view);
        },
      })
    )
  );

  const tree = $('nav-folders');
  tree.replaceChildren();
  $('folders-title').hidden = !library;
  if (!library) return;
  const addFolders = (parentId, depth, parentList) => {
    for (const folder of index.childFolders.get(parentId) ?? []) {
      const hasChildren = (index.childFolders.get(folder.id) ?? []).length > 0;
      const open = ui.expanded.has(folder.id);
      const twisty = el('span', {
        className: `twisty${hasChildren ? '' : ' none'}${open ? ' open' : ''}`,
        html: hasChildren ? ICONS.chevron : '',
        attrs: hasChildren ? { role: 'button', 'aria-label': open ? 'Collapse' : 'Expand' } : {},
      });
      twisty.addEventListener('click', (event) => {
        if (!hasChildren) return;
        event.stopPropagation();
        open ? ui.expanded.delete(folder.id) : ui.expanded.add(folder.id);
        prefs.set('expanded', [...ui.expanded]);
        renderSidebar();
      });
      const li = navItem({
        icon: 'folder',
        label: folder.name,
        count: index.totals.get(folder.id),
        active: lib && !globalSearch() && ui.view.kind === 'folder' && ui.view.id === folder.id,
        depth,
        twisty,
        drop: folder,
        onClick: () => {
          clearSearch();
          setView({ kind: 'folder', id: folder.id });
        },
        // Double-click opens (or closes) its subfolders in the tree.
        onDoubleClick: hasChildren
          ? () => {
              ui.expanded.has(folder.id) ? ui.expanded.delete(folder.id) : ui.expanded.add(folder.id);
              prefs.set('expanded', [...ui.expanded]);
              renderSidebar();
            }
          : undefined,
      });
      li.setAttribute('role', 'treeitem');
      if (hasChildren) li.setAttribute('aria-expanded', String(open));
      parentList.append(li);
      if (hasChildren && open) {
        const group = el('ul', { attrs: { role: 'group' } });
        li.append(group);
        addFolders(folder.id, depth + 1, group);
      }
    }
  };
  addFolders(null, 0, tree);
  if (!library.folders.length) tree.append(el('li', { className: 'muted nav-empty', text: 'No folders' }));
}

// ---------------------------------------------------------------------------
// Rendering: page head and toolbar

function viewTitle() {
  if (ui.view.kind === 'folder') return index.folderById.get(ui.view.id)?.name ?? 'Folder';
  return { all: 'All notes', favorites: 'Favorites', recent: 'Recently modified' }[ui.view.kind];
}

function renderHead(scoped) {
  const crumbs = $('page-crumbs');
  crumbs.replaceChildren();
  crumbs.hidden = true;
  const count = shown.length;
  const of = (total) => (count !== total ? `${count} of ${total} notes` : plural(count, 'note'));
  let title = viewTitle();
  let subtitle;

  if (globalSearch()) {
    title = 'Search';
    const byText = shown.filter((d) => textMatch(d) !== null).length;
    subtitle = `${plural(count, 'result')} for “${ui.search.trim()}”${byText ? `, ${byText} by text inside` : ''}`;
  } else if (ui.view.kind === 'folder') {
    const chain = [];
    for (let f = index.folderById.get(ui.view.id); f; f = index.folderById.get(f.parentId)) chain.unshift(f);
    const crumb = (label, onClick) => {
      const node = el('button', { className: 'crumb', text: label, attrs: { type: 'button' } });
      node.addEventListener('click', onClick);
      return node;
    };
    crumbs.append(crumb('My files', () => setView({ kind: 'all' })));
    for (const f of chain.slice(0, -1)) {
      crumbs.append(el('span', { className: 'crumb-sep', text: '/' }), crumb(f.name, () => setView({ kind: 'folder', id: f.id })));
    }
    crumbs.hidden = false;
    const hasSubfolders = (index.childFolders.get(ui.view.id) ?? []).length > 0;
    subtitle = `${of(inView(library.docs, ui.view).length)}${!hasSubfolders ? '' : ui.includeSubfolders ? ', including subfolders' : ' directly in this folder'}`;
  } else if (ui.view.kind === 'favorites') {
    subtitle = `${of(inView(library.docs, ui.view).length)} you starred on the tablet`;
  } else if (ui.view.kind === 'recent') {
    subtitle = `${of(inView(library.docs, ui.view).length)} edited in the past ${RECENT_DAYS} days`;
  } else {
    subtitle =
      librarySource === 'local'
        ? `${of(library.docs.length)} saved on this computer · Tablet not connected`
        : `${of(library.docs.length)} on your tablet`;
  }
  if (searching() && !globalSearch()) subtitle += ` · matching “${ui.search.trim()}”`;
  $('page-title').textContent = title;
  $('page-subtitle').textContent = subtitle;
  document.title = `${title} – FlosForge ArEm Buddy`;

  // Type chips, counted over everything but the type filter.
  const types = KNOWN_TYPES.filter((t) => library.docs.some((d) => d.fileType === t));
  const chips = [{ type: 'any', label: 'All', n: scoped.length }].concat(
    types.length > 1 ? types.map((t) => ({ type: t, label: `${typeLabel(t)}s`, n: scoped.filter((d) => d.fileType === t).length })) : []
  );
  $('type-chips').replaceChildren(
    ...chips.map(({ type, label, n }) => {
      const chip = el('button', { className: 'chip', attrs: { type: 'button', 'aria-pressed': String(ui.type === type) } });
      if (type !== 'any') {
        const dot = el('span', { className: 'dot', attrs: { 'aria-hidden': 'true' } });
        dot.style.background = `var(--type-${type})`;
        chip.append(dot);
      }
      chip.append(document.createTextNode(label), el('span', { className: 'count', text: String(n) }));
      chip.addEventListener('click', () => {
        ui.type = type;
        render();
      });
      return chip;
    })
  );

  const inFolder = ui.view.kind === 'folder';
  $('favorites-count').textContent = String(scoped.filter((d) => d.favorite).length);
  $('filter-favorites').setAttribute('aria-pressed', String(ui.favoritesOnly));
  $('filter-favorites').hidden = ui.view.kind === 'favorites' && !globalSearch();
  const subfolderToggle = inFolder && !globalSearch() && (index.childFolders.get(ui.view.id) ?? []).length > 0;
  $('filter-subfolders').hidden = !subfolderToggle;
  $('filter-subfolders').textContent = ui.includeSubfolders ? 'Only this folder' : 'Include subfolders';
  $('filter-scope').hidden = !searching() || ui.view.kind === 'all';
  $('filter-scope').textContent = `Only in “${viewTitle()}”`;
  $('filter-scope').setAttribute('aria-pressed', String(ui.searchInView));
  $('filter-modified').value = ui.modified;
  $('filter-clear').hidden = !filtersActive() && !searching();
  $('sort').value = ui.sort;
  $('layout-grid').setAttribute('aria-pressed', String(ui.layout === 'grid'));
  $('layout-list').setAttribute('aria-pressed', String(ui.layout === 'list'));
}

// ---------------------------------------------------------------------------
// Rendering: results

/** Subfolders of the open folder (top-level folders in All notes), or folders matching the search. */
function renderFolderStrip() {
  let folders = [];
  let label = 'Folders';
  if (searching()) {
    const words = terms();
    folders = library.folders.filter((f) => words.every((w) => fold(f.path.join(' ')).includes(w)));
    label = 'Matching folders';
  } else if (!filtersActive() && ui.view.kind === 'folder') {
    folders = index.childFolders.get(ui.view.id) ?? [];
  } else if (!filtersActive() && ui.view.kind === 'all') {
    folders = index.childFolders.get(null) ?? [];
  }
  const strip = $('subfolders');
  strip.hidden = folders.length === 0;
  strip.replaceChildren(
    el('div', { className: 'subfolders-label', text: label }),
    ...folders.slice(0, 60).map((folder) => {
      const count = index.totals.get(folder.id);
      const subfolders = (index.childFolders.get(folder.id) ?? []).length;
      const meta = [plural(count, 'note'), subfolders ? plural(subfolders, 'folder') : ''].filter(Boolean).join(' · ');
      const button = el('button', { className: 'folder-tile', attrs: { type: 'button', title: folder.path.join(' / ') } }, [
        tile('folder'),
        el('span', { className: 'folder-tile-text' }, [el('strong', { text: folder.name }), el('span', { text: meta })]),
      ]);
      dropFolder(button, folder);
      button.addEventListener('click', () => {
        if (globalSearch()) clearSearch();
        setView({ kind: 'folder', id: folder.id });
      });
      return button;
    })
  );
}

function toggleSelection(doc, event) {
  const position = shown.indexOf(doc);
  // Checkboxes, ⌘/Ctrl-click and "Many" mode add to the selection; otherwise a click picks one.
  const additive =
    ui.selectMode === 'many' || event?.metaKey || event?.ctrlKey || event?.target?.matches?.('input[type="checkbox"]');
  if (event?.shiftKey && lastClicked !== null && shown[lastClicked]) {
    const [from, to] = [Math.min(lastClicked, position), Math.max(lastClicked, position)];
    const select = !selected.has(doc.id);
    if (!additive) selected.clear();
    for (const d of shown.slice(from, to + 1)) select || !additive ? selected.add(d.id) : selected.delete(d.id);
  } else if (additive) {
    selected.has(doc.id) ? selected.delete(doc.id) : selected.add(doc.id);
  } else {
    const onlyThis = selected.size === 1 && selected.has(doc.id);
    selected.clear();
    if (!onlyThis) selected.add(doc.id);
  }
  lastClicked = position;
  renderResults();
  renderDownloads();
}

function folderButton(doc) {
  const button = el('button', { className: 'folder-link', text: folderLabel(doc), attrs: { type: 'button', title: 'Show folder' } });
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    clearSearch();
    setView(doc.parentId ? { kind: 'folder', id: doc.parentId } : { kind: 'all' });
  });
  return button;
}

const lastPageText = (doc) => (doc.lastPage ? `Last open on page ${doc.lastPage}` : '');

function card(doc) {
  const isSelected = selected.has(doc.id);
  const box = el('input', { className: 'note-check', attrs: { type: 'checkbox', 'aria-label': `Select ${doc.name}` } });
  box.checked = isSelected;
  box.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleSelection(doc, event);
  });

  const type = typeClass(doc.fileType);
  const info = local[doc.id];
  const picture = info?.thumb
    ? el('img', { className: 'note-image', attrs: { src: info.thumb, alt: '', decoding: 'async', draggable: 'false' } })
    : tile(doc.fileType);
  const thumb = el('div', { className: `note-thumb${info?.thumb ? ' has-image' : ''}` }, [
    picture,
    el('span', { className: `note-type tile-${type}`, text: typeLabel(doc.fileType) }),
    box,
  ]);
  if (doc.favorite) thumb.append(el('span', { className: 'note-fav', text: '★', attrs: { title: 'Favorite', 'aria-label': 'Favorite' } }));

  const pagesText = info?.pages ? plural(info.pages, 'page') : doc.lastPage ? `open at p. ${doc.lastPage}` : '';
  const meta = [relativeDate(doc), pagesText].filter(Boolean).join(' · ');
  const node = el(
    'article',
    { className: `note${isSelected ? ' selected' : ''}`, attrs: { tabindex: '0', 'aria-selected': String(isSelected), title: 'Double-click to open' } },
    [
      thumb,
      el('div', { className: 'note-body' }, [
        el('div', { className: 'note-title', text: doc.name, attrs: { title: doc.name } }),
        folderButton(doc),
        el('div', { className: 'note-meta', text: meta, attrs: { title: [fullDate(doc), lastPageText(doc)].filter(Boolean).join('\n') } }),
      ]),
    ]
  );
  const snippet = textMatch(doc);
  if (snippet) node.querySelector('.note-body').append(el('div', { className: 'note-snippet', text: snippet, attrs: { title: 'Found in the text of this note' } }));
  node.addEventListener('click', (event) => toggleSelection(doc, event));
  node.addEventListener('dblclick', () => openReader(doc)); // the two clicks' toggles cancel out
  node.addEventListener('keydown', (event) => {
    if (event.target !== node) return;
    if (event.key === ' ') {
      event.preventDefault();
      toggleSelection(doc, event);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      openReader(doc);
    }
  });
  return node;
}

function row(doc) {
  const isSelected = selected.has(doc.id);
  const box = el('input', { attrs: { type: 'checkbox', 'aria-label': `Select ${doc.name}` } });
  box.checked = isSelected;
  box.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleSelection(doc, event);
  });
  const thumbUrl = local[doc.id]?.thumb;
  const picture = thumbUrl ? el('img', { className: 'row-thumb', attrs: { src: thumbUrl, alt: '', decoding: 'async', draggable: 'false' } }) : tile(doc.fileType);
  const name = el('span', { className: 'row-name' }, [picture, el('strong', { text: doc.name })]);
  if (doc.favorite) name.append(el('span', { className: 'star', text: '★', attrs: { title: 'Favorite' } }));
  const snippet = textMatch(doc);
  const nameCell = snippet ? [name, el('div', { className: 'row-snippet', text: snippet, attrs: { title: 'Found in the text of this note' } })] : [name];
  const dot = el('span', { className: 'dot' });
  dot.style.background = `var(--type-${typeClass(doc.fileType)})`;
  const tr = el('tr', { className: isSelected ? 'selected' : '', attrs: { title: 'Double-click to open' } }, [
    el('td', { className: 'col-check' }, [box]),
    el('td', {}, nameCell),
    el('td', {}, [folderButton(doc)]),
    el('td', { className: 'col-type' }, [el('span', { className: 'type-label' }, [dot, document.createTextNode(typeLabel(doc.fileType))])]),
    el('td', { className: 'col-date muted', text: fullDate(doc), attrs: { title: lastPageText(doc) } }),
  ]);
  tr.addEventListener('click', (event) => toggleSelection(doc, event));
  tr.addEventListener('dblclick', () => openReader(doc));
  return tr;
}

function renderSelectMode() {
  for (const button of $('select-mode').querySelectorAll('button')) {
    const on = button.dataset.mode === ui.selectMode;
    button.setAttribute('aria-pressed', String(on));
    button.setAttribute('aria-checked', String(on));
  }
}

function renderSelectToggle() {
  const picked = shown.filter((d) => selected.has(d.id)).length;
  const all = shown.length > 0 && picked === shown.length;
  $('select-toggle-label').textContent = all ? 'Deselect all' : 'Select all';
  $('select-toggle-box').className = `check-box${all ? ' checked' : picked ? ' mixed' : ''}`;
  $('select-toggle').disabled = shown.length === 0;
  $('select-toggle').title = all ? `Deselect the ${plural(shown.length, 'note')} shown` : `Select the ${plural(shown.length, 'note')} shown (\u2318A)`;
}

function renderResults() {
  renderSelectToggle();
  renderSelectMode();
  const grid = ui.layout === 'grid';
  $('grid').hidden = !grid || shown.length === 0;
  $('table-wrap').hidden = grid || shown.length === 0;
  if (grid) $('grid').replaceChildren(...shown.map(card));
  else $('rows').replaceChildren(...shown.map(row));
  const all = shown.length > 0 && shown.every((d) => selected.has(d.id));
  $('select-all').checked = all;
  $('select-all').indeterminate = !all && shown.some((d) => selected.has(d.id));

  $('empty').hidden = shown.length > 0;
  if (shown.length === 0) {
    const narrowed = filtersActive() || searching();
    $('empty-text').textContent = narrowed
      ? 'No notes match your search and filters.'
      : ui.view.kind === 'favorites'
        ? 'No favorites yet. Star notes on your tablet and they’ll show up here.'
        : ui.view.kind === 'folder' && !$('subfolders').hidden
          ? 'No notes directly in this folder.'
          : 'No notes here.';
    $('empty-action').hidden = !narrowed;
    $('empty-action').textContent = 'Clear search and filters';
    $('empty-action').onclick = clearFilters;
  }
}

function renderLibrary() {
  if (!library) {
    $('page-crumbs').hidden = true;
    $('page-title').textContent = 'Library';
    $('page-subtitle').textContent = libraryLoading ? 'Reading your notes from the tablet…' : '';
    $('type-chips').replaceChildren();
    $('subfolders').hidden = true;
    $('grid').hidden = true;
    $('table-wrap').hidden = true;
    $('empty').hidden = false;
    $('empty-text').textContent = libraryError ? `Couldn’t load your notes: ${libraryError}.` : 'Loading your notes…';
    $('empty-action').hidden = !libraryError;
    $('empty-action').textContent = 'Try again';
    $('empty-action').onclick = loadLibrary;
    return;
  }
  const scoped = scopedDocs();
  shown = sortDocs(ui.type === 'any' ? scoped : scoped.filter((d) => d.fileType === ui.type));
  renderHead(scoped);
  renderFolderStrip();
  renderResults();
}

// ---------------------------------------------------------------------------
// Rendering: connect page

const IS_MAC = navigator.userAgent.includes('Mac');

/** Turns a connection error code into a sentence, with the likely fix. */
function describeProblem(code) {
  const map = {
    EHOSTUNREACH: IS_MAC
      ? 'no route to the tablet (EHOSTUNREACH). If a browser on this Mac can open the address, macOS is blocking this app: allow it in System Settings → Privacy & Security → Local Network.'
      : 'no route to the tablet (EHOSTUNREACH). Check the cable.',
    ENETUNREACH: 'no network route to the tablet (ENETUNREACH). Check the cable.',
    ECONNREFUSED: 'the tablet refused the connection (ECONNREFUSED). Is the USB web interface on?',
    ETIMEDOUT: 'no answer within 2 seconds (ETIMEDOUT).',
    EPERM: IS_MAC
      ? 'the system refused the connection (EPERM). Allow this app in System Settings → Privacy & Security → Local Network.'
      : 'the system refused the connection (EPERM).',
    EACCES: 'the system refused the connection (EACCES).',
  };
  return map[code] ?? code;
}

function renderConnect() {
  const { status, tabletAddress } = current;
  const busy = status === 'busy';
  $('connect-title').textContent = busy ? 'Your tablet isn’t responding' : 'Connect your tablet';
  $('connect-reason').textContent = busy
    ? 'It’s connected, but its web interface doesn’t answer. It may be asleep, or still exporting a PDF from an interrupted download. Wake it up and wait a moment. If it stays like this, turn Settings → Storage → USB web interface off and on again, or replug the cable.'
    : status === 'checking'
      ? 'Looking for your tablet…'
      : 'ArEm reads your notes through the tablet’s USB web interface.';
  $('connect-steps').hidden = busy;
  $('connect-searching').textContent = `Checking ${hostOf(tabletAddress)} every few seconds`;
  $('connect-problem').hidden = !current.problem;
  $('connect-problem').textContent = current.problem ? `Last check: ${describeProblem(current.problem)}` : '';
}

// ---------------------------------------------------------------------------
// Settings page

let settingsAddressShown = null; // the saved address last put in the field

function setAddressStatus(text, kind = '') {
  $('address-status').className = `form-status ${kind}`;
  $('address-status').textContent = text;
}

function renderSettings() {
  const state = current;
  if (settingsAddressShown !== state.tabletAddress) {
    $('address').value = state.tabletAddress;
    settingsAddressShown = state.tabletAddress;
  }
  const info = STATUS[state.status] ?? STATUS.checking;
  $('settings-dot').className = `status-dot ${info.dot}`;
  $('settings-status-text').textContent = info.label;
  $('default-address').textContent = state.defaultAddress;
  $('destination').textContent = state.destinationDisplay;
  $('destination').title = state.destination;
  $('skip-unchanged').checked = state.skipUnchanged;
  $('rmdoc-backups').checked = state.rmdocBackups;
  $('keep-versions').checked = state.keepVersions;
  $('auto-download').checked = state.autoDownload;

  // Changing the address or folder mid-download would split one run across two targets.
  const busy = Boolean(state.job);
  const atDefault = state.isDefaultAddress && $('address').value.trim() === state.defaultAddress;
  $('save').disabled = busy;
  $('choose-destination').disabled = busy;
  for (const id of ['skip-unchanged', 'rmdoc-backups', 'keep-versions', 'auto-download']) $(id).disabled = busy;
  $('reset').disabled = busy || atDefault;
  $('save-log').disabled = !canDownload();
  $('save-log').title = canDownload() ? 'Save the tablet log to a file' : 'Needs the tablet connected, and no download running';
  renderTablets();
  $('busy-note').textContent = busy ? 'A download is running: changes are paused until it finishes.' : '';
  $('busy-note').hidden = !busy;
  renderAppearance();
}

/** Saved tablets: the one in use is marked; the others can be switched to. */
function renderTablets() {
  const { tablets, tabletAddress, job } = current;
  $('tablet-list').hidden = tablets.length === 0;
  $('tablet-list').replaceChildren(
    ...tablets.map((tablet) => {
      const inUse = tablet.address === tabletAddress;
      const use = el('button', { text: inUse ? 'In use' : 'Use', attrs: { type: 'button' } });
      use.disabled = inUse || Boolean(job);
      use.addEventListener('click', async () => {
        const result = await api.useTablet(tablet.address);
        if (result?.error) return setTabletStatus(result.error, 'error');
        settingsAddressShown = null;
        setTabletStatus(`Using ${tablet.name}.`, 'ok');
      });
      const remove = el('button', { className: 'link', text: 'Remove', attrs: { type: 'button' } });
      remove.addEventListener('click', () => api.removeTablet(tablet.address));
      return el('li', { className: inUse ? 'in-use' : '' }, [
        el('span', { className: 'tablet-text' }, [el('strong', { text: tablet.name }), el('code', { text: tablet.address })]),
        use,
        remove,
      ]);
    })
  );
  const saved = tablets.find((t) => t.address === tabletAddress);
  $('tablet-name').placeholder = saved ? `Rename “${saved.name}”` : 'Name for the address above, e.g. Paper Pro';
}

function setTabletStatus(text, kind = '') {
  $('tablet-status').className = `form-status ${kind}`;
  $('tablet-status').textContent = text;
}

function renderAppearance() {
  if (!themes) return;
  const { mode, theme: selectedId } = current.appearance;
  for (const button of $('mode-group').querySelectorAll('button')) {
    const on = button.dataset.mode === mode;
    button.setAttribute('aria-pressed', String(on));
    button.setAttribute('aria-checked', String(on));
  }
  const dark = darkQuery.matches;
  $('theme-grid').replaceChildren(
    ...themes.map((theme) => {
      const p = dark ? theme.dark : theme.light;
      const selected = theme.id === selectedId;
      const card = el('button', {
        className: `theme-card${selected ? ' selected' : ''}`,
        attrs: { type: 'button', role: 'radio', 'aria-checked': String(selected), title: theme.description },
      });
      // A miniature of the app in this theme: sidebar, a card, a highlighted dot.
      for (const [name, value] of Object.entries({
        '--t-bg': p.background,
        '--t-surface': p.surface,
        '--t-alt': p.surfaceAlt,
        '--t-fg': p.foreground,
        '--t-muted': p.muted,
        '--t-border': p.border,
        '--t-primary': p.primary,
        '--t-sidebar': p.sidebar,
      })) {
        card.style.setProperty(name, value);
      }
      const preview = el('span', { className: 'theme-preview', attrs: { 'aria-hidden': 'true' } }, [
        el('span', { className: 'tp-sidebar' }, [el('i', { className: 'tp-accent' }), el('i'), el('i')]),
        el('span', { className: 'tp-panel' }, [el('i', { className: 'tp-text' }), el('i')]),
        el('span', { className: 'tp-dot' }, [el('i')]),
      ]);
      const label = el('span', { className: 'theme-label' }, [
        el('strong', { text: theme.name }),
        el('span', { text: theme.description }),
      ]);
      if (theme.monospace) label.firstChild.classList.add('mono');
      card.append(preview, label);
      if (selected) card.append(el('span', { className: 'theme-check', text: '\u2713', attrs: { 'aria-hidden': 'true' } }));
      card.addEventListener('click', () => api.setAppearance({ theme: theme.id }));
      return card;
    })
  );
}

for (const button of $('mode-group').querySelectorAll('button')) {
  button.addEventListener('click', () => api.setAppearance({ mode: button.dataset.mode }));
}

$('address').addEventListener('input', () => {
  setAddressStatus('');
  renderSettings();
});
$('test').addEventListener('click', async () => {
  $('test').disabled = true;
  setAddressStatus('Testing…');
  try {
    const result = await api.testAddress($('address').value);
    if (result.error) setAddressStatus(result.error, 'error');
    else if (result.found) setAddressStatus(`Found a reMarkable at ${result.address}.`, 'ok');
    else if (result.status === 'ok') setAddressStatus(`${result.address} responds, but not like a reMarkable: ${result.detail}`, 'warn');
    else if (result.status === 'busy') setAddressStatus(`Something is at ${result.address} but not responding (a sleeping or busy tablet does this).`, 'warn');
    else setAddressStatus(`Nothing responded at ${result.address}: ${describeProblem(result.problem ?? 'no answer')}`, 'warn');
  } finally {
    $('test').disabled = false;
  }
});
$('address-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await api.saveAddress($('address').value);
  if (result.error) return setAddressStatus(result.error, 'error');
  settingsAddressShown = null; // show the normalised form
  setAddressStatus(`Saved. Using ${result.state.tabletAddress}.`, 'ok');
});
$('reset').addEventListener('click', async () => {
  const result = await api.resetAddress();
  if (result.error) return setAddressStatus(result.error, 'error');
  settingsAddressShown = null;
  setAddressStatus(`Reset to ${result.state.tabletAddress}.`, 'ok');
});
$('choose-destination').addEventListener('click', () => api.chooseDestination());
$('open-destination').addEventListener('click', () => api.openDestination());
$('skip-unchanged').addEventListener('change', () => api.setSkipUnchanged($('skip-unchanged').checked));
for (const [id, flag] of [
  ['rmdoc-backups', 'rmdocBackups'],
  ['keep-versions', 'keepVersions'],
  ['auto-download', 'autoDownload'],
]) {
  $(id).addEventListener('change', () => api.setFlag(flag, $(id).checked));
}
$('tablet-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('tablet-name').value.trim();
  const result = await api.saveTablet(name, $('address').value);
  if (result?.error) return setTabletStatus(result.error, 'error');
  $('tablet-name').value = '';
  setTabletStatus(`Saved “${name}”.`, 'ok');
});
$('save-log').addEventListener('click', async () => {
  $('save-log').disabled = true;
  setLogStatus('Getting the log from the tablet…');
  try {
    const result = await api.saveTabletLog();
    if (result?.error) setLogStatus(`Couldn’t save the log: ${result.error}`, 'error');
    else if (result?.saved) setLogStatus(`Saved the tablet log to ${result.saved}.`, 'ok');
    else setLogStatus('');
  } finally {
    renderSettings();
  }
});

function setLogStatus(text, kind = '') {
  $('log-status').className = `form-status ${kind}`;
  $('log-status').textContent = text;
}

// ---------------------------------------------------------------------------
// Downloads (header button, selection bar, activity strip)

const canDownload = () => current?.status === 'ok' && !current.job && !current.reading;
const noteTarget = (d) => ({ type: 'notebook', id: d.id, name: d.name, folders: d.folders, modified: d.modified, fileType: d.fileType, favorite: d.favorite });
const selectedNeedingThumbnails = () =>
  [...selected].map((id) => index?.docById.get(id)).filter((d) => d && d.modified && !local[d.id]?.thumb);
let dismissedResultAt = null;

/** Where Upload (and dropped files) go: the open folder, else the top level. */
function uploadTarget() {
  if (library && ui.view.kind === 'folder' && !globalSearch()) {
    const folder = index.folderById.get(ui.view.id);
    if (folder) return { id: folder.id, name: folder.name };
  }
  return { id: null, name: 'My files' };
}

function reportRejected(rejected) {
  if (rejected?.length) alert(`Only PDF, EPUB and .rmdoc files can go on the tablet. Skipped:\n${rejected.join('\n')}`);
}

/** What the header's download button does in the current view. */
function viewDownload() {
  if (!library) return null;
  if (ui.view.kind === 'folder' && !searching() && !filtersActive()) {
    const folder = index.folderById.get(ui.view.id);
    const target = { type: 'folder', id: folder.id, name: folder.name, folders: folder.path.slice(0, -1) };
    return { label: 'Download Folder', request: { targets: [target] } };
  }
  if (ui.view.kind === 'all' && !searching() && !filtersActive()) return { label: 'Download All', request: { all: true } };
  return { label: `Download ${shown.length} Shown`, request: { targets: shown.map(noteTarget) }, empty: shown.length === 0 };
}

function renderDownloads() {
  const action = viewDownload();
  $('download-view-label').textContent = action?.label ?? 'Download All';
  $('upload').disabled = !canDownload() || !library;
  $('upload').title = `Upload PDFs, EPUBs or .rmdoc files to \u201c${uploadTarget().name}\u201d (or drop them on the window)`;
  $('download-view').disabled = !canDownload() || !action || Boolean(action.empty);

  const count = selected.size;
  const shownIds = new Set(shown.map((d) => d.id));
  const hiddenCount = [...selected].filter((id) => !shownIds.has(id)).length;
  $('selection-bar').hidden = count === 0;
  $('selection-count').textContent = `${count} selected${hiddenCount ? ` (${hiddenCount} not shown)` : ''}`;
  $('download-selected').textContent = `Download ${plural(count, 'Note')}`;
  $('download-selected').disabled = !canDownload() || count === 0;
  const needThumbs = selectedNeedingThumbnails();
  $('thumbs-selected-label').textContent = needThumbs.length ? `Get ${plural(needThumbs.length, 'Thumbnail')}` : 'Thumbnails ready';
  $('thumbs-selected').disabled = !canDownload() || needThumbs.length === 0;
  $('combine-selected').disabled = !canDownload() || count < 2;

  renderActivity();
  if (reading?.state === 'ready') renderReaderDownload();
}

function displayDestination(destination) {
  return destination === current.destination ? current.destinationDisplay : destination;
}

function renderActivity() {
  const job = current.job;
  const result = current.lastResult;
  const showResult = !job && Boolean(result) && result.at !== dismissedResultAt;
  $('activity').hidden = !job && !showResult;
  $('activity').classList.toggle('error', Boolean(showResult && (!result.ok || result.summary?.failed.length)));
  $('activity-spinner').hidden = !job;
  $('activity-icon').hidden = Boolean(job);
  $('stop').hidden = !job;
  $('activity-open').hidden = Boolean(job);
  $('activity-dismiss').hidden = Boolean(job);
  $('progress-bar').hidden = !job;
  $('result-failures').hidden = true;

  if (job) {
    const bar = $('progress-bar');
    let text;
    if (job.phase === 'listing') {
      text = 'Finding notebooks…';
      bar.removeAttribute('value'); // indeterminate
    } else if (job.phase === 'combining') {
      text = `Combining into ${job.name}\u2026`;
      bar.removeAttribute('value');
    } else {
      const verb = { thumbnails: 'Getting thumbnail', upload: 'Uploading', combine: 'Getting PDF' }[job.kind] ?? 'Downloading';
      text = job.name ? `${verb} ${job.current} of ${job.total}: ${job.name}` : `${verb}s\u2026`;
      bar.max = job.total || 1;
      bar.value = Math.max(0, job.current - 1);
    }
    $('activity-text').textContent = job.stopping ? `${text} (stopping after this one)` : text;
    $('stop').disabled = job.stopping;
    $('stop').hidden = job.phase === 'combining'; // one step, can't be interrupted
    return;
  }
  if (!showResult) return;

  const s = result.summary;
  const saved = s ? s.downloaded : 0;
  const where = displayDestination(result.destination);
  let text;
  $('activity-open').textContent = 'Open folder';
  if (result.kind === 'combine') {
    if (!result.ok) text = `Combining failed: ${result.error}.`;
    else if (s.stopped) text = 'Combining stopped. Nothing was saved.';
    else {
      text = `Combined ${plural(s.downloaded, 'note')} (${plural(result.pages, 'page')}) into ${result.fileDisplay}`;
      text += s.failed.length ? `; ${s.failed.length} left out.` : '.';
      $('activity-open').textContent = 'Show file';
    }
    $('activity-open').hidden = !result.ok || s.stopped;
  } else if (result.kind === 'upload') {
    const parts = [];
    if (!result.ok) parts.push(`Upload failed: ${result.error}`);
    if (saved) parts.push(`Uploaded ${plural(saved, 'file')} to \u201c${result.folder}\u201d`);
    if (s?.failed.length) parts.push(`${s.failed.length} failed`);
    text = (parts.join(', ') || 'Nothing uploaded') + (s?.stopped ? ' (stopped early).' : '.');
    $('activity-open').hidden = true;
  } else if (result.kind === 'thumbnails') {
    const parts = [];
    if (!result.ok) parts.push(`Getting thumbnails failed: ${result.error}`);
    if (saved) parts.push(`Got ${plural(saved, 'thumbnail')}`);
    if (s?.unchanged) parts.push(`${s.unchanged} already had one`);
    if (s?.failed.length) parts.push(`${s.failed.length} failed`);
    text = (parts.join(', ') || 'Nothing to do') + (s?.stopped ? ' (stopped early).' : '.');
    $('activity-open').hidden = true; // nothing went to the save-to folder
  } else if (!result.ok) {
    text = `Download failed: ${result.error}.${saved ? ` ${plural(saved, 'PDF')} saved to ${where} before that.` : ''}`;
  } else if (s.total === 0) {
    text = 'No notebooks found in the selection.';
  } else {
    const parts = [`Saved ${plural(saved, 'PDF')} to ${where}`];
    if (s.backups) parts.push(`${plural(s.backups, '.rmdoc backup')}`);
    if (s.unchanged) parts.push(`${s.unchanged} unchanged`);
    if (s.failed.length) parts.push(`${s.failed.length} failed`);
    text = parts.join(', ') + (s.stopped ? ' (stopped early).' : '.');
    if (s.backupsUnavailable) text += ' This tablet can’t export .rmdoc files, so no backups were saved.';
  }
  if (result.kind === 'download' && result.auto) text = `Tablet connected. ${text}`;
  $('activity-text').textContent = text;

  const failures = s?.failed ?? [];
  $('result-failures').hidden = failures.length === 0;
  $('result-failures-summary').textContent = `Show ${plural(failures.length, 'failed note')}`;
  $('result-failures-list').replaceChildren(...failures.map((f) => el('li', { text: `${f.name}: ${f.error}` })));
}

async function startDownload(request) {
  const result = await api.startDownload(request);
  if (result?.error) alert(result.error);
}

// ---------------------------------------------------------------------------
// Reader (pages are drawn by pdf-view.mjs with pdf.js)

let reading = null; // { doc, state: 'loading' | 'ready' | 'error', file?, error?, pages? }
let readerTimer = null;
let viewer = null;
let readerDownloadAt = null; // when the reader's Download button was used, to show its result

function pdfViewReady() {
  return window.PdfView ? Promise.resolve() : new Promise((resolve) => window.addEventListener('pdfview-ready', resolve, { once: true }));
}

function readerElapsed() {
  const started = current?.reading?.id === reading?.doc.id ? current.reading.startedAt : null;
  return started ? Math.round((Date.now() - started) / 1000) : 0;
}

function renderReaderTools() {
  if (!viewer || reading?.state !== 'ready') return;
  $('reader-page').textContent = `Page ${viewer.current} of ${viewer.pageCount}`;
  $('zoom-fit').textContent = `${Math.round(viewer.scale * 100)}%`;
  $('zoom-fit').setAttribute('aria-pressed', String(viewer.zoom === 'fit'));
  $('zoom-fit').title = viewer.zoom === 'fit' ? 'Fitting the width (⌘0)' : 'Fit width (⌘0)';
}

function renderReaderDownload() {
  const job = current.job;
  const mine = readerDownloadAt !== null;
  const result = current.lastResult;
  const done = mine && !job && result && result.kind === 'download' && result.at >= readerDownloadAt;
  $('reader-download-label').textContent = job && mine ? 'Downloading…' : 'Download';
  $('reader-download').disabled = !canDownload();
  $('reader-download').title = `Save to ${current.destinationDisplay}`;

  // Short, so the note's title keeps its room; the details are in the tooltip.
  let saved = '';
  let detail = '';
  let failed = false;
  if (done && (!result.ok || result.summary?.failed.length)) {
    [saved, detail, failed] = ['Download failed', result.error ?? result.summary.failed[0].error, true];
  } else if (done && result.summary?.downloaded) {
    [saved, detail] = ['Saved \u2713', `Saved to ${displayDestination(result.destination)}`];
  } else if (done && result.summary?.unchanged) {
    [saved, detail] = ['Already saved', `Unchanged since it was saved to ${displayDestination(result.destination)}`];
  }
  $('reader-saved').textContent = saved;
  $('reader-saved').title = detail;
  $('reader-saved').hidden = !saved;
  $('reader-saved').classList.toggle('error', failed);
  $('reader-saved-open').hidden = !saved || failed;
}

function renderReader() {
  const open = Boolean(reading);
  $('reader').hidden = !open;
  if (!open) return;
  const { doc, state } = reading;
  const ready = state === 'ready';
  $('reader-name').textContent = doc.name;
  $('reader-meta').textContent = [
    folderLabel(doc),
    reading.pages ? plural(reading.pages, 'page') : '',
    fullDate(doc),
    reading.outdated ? 'Older saved copy (tablet not connected)' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const multiPage = ready && (reading.pages ?? 0) > 1;
  $('reader-pages').hidden = !ready;
  $('reader-rail').hidden = !multiPage || !ui.railOpen;
  $('reader-rail-toggle').hidden = !multiPage;
  $('reader-rail-toggle').setAttribute('aria-pressed', String(ui.railOpen));
  $('reader-rail-toggle').title = ui.railOpen ? 'Hide pages' : 'Show pages';
  $('reader-rail-toggle').setAttribute('aria-label', $('reader-rail-toggle').title);
  $('reader-state').hidden = ready;
  $('reader-tools').hidden = !ready;
  $('reader-external').hidden = !ready;
  $('reader-print').hidden = !ready;
  $('reader-png').hidden = !ready;
  $('reader-download').hidden = !ready;
  $('reader-spinner').hidden = state !== 'loading';
  $('reader-action').hidden = ready;

  if (ready) {
    renderReaderTools();
    renderReaderDownload();
  } else {
    $('reader-saved').hidden = true;
    $('reader-saved-open').hidden = true;
  }
  if (state === 'loading') {
    const seconds = readerElapsed();
    $('reader-message').textContent = current?.status === 'ok' ? 'Exporting from your tablet…' : 'Opening the saved copy…';
    $('reader-hint').textContent =
      seconds >= 20
        ? `${seconds} s so far. Long notebooks take a while; if nothing happens, the tablet may not be exporting at all.`
        : 'The tablet renders the PDF first.';
    $('reader-action').textContent = 'Cancel';
  } else if (state === 'error') {
    $('reader-message').textContent = `Couldn’t open this note: ${reading.error}.`;
    $('reader-hint').textContent = '';
    $('reader-action').textContent = 'Try again';
  }
}

async function openReader(doc) {
  if (current?.job) return alert('Wait for the download to finish.');
  // Without the tablet, the main process opens the copy saved on this computer, if any.
  viewer?.close();
  const mine = { doc, state: 'loading' };
  reading = mine;
  readerDownloadAt = null;
  renderReader();
  clearInterval(readerTimer);
  readerTimer = setInterval(() => reading?.state === 'loading' && renderReader(), 1000);

  const fail = (error) => {
    Object.assign(mine, { state: 'error', error });
    renderReader();
  };
  const result = await api.openNote({ id: doc.id, name: doc.name, modified: doc.modified });
  if (reading !== mine) return; // closed or replaced meanwhile
  clearInterval(readerTimer);
  if (result.cancelled) return closeReader();
  if (result.error) return fail(result.error);

  const file = await api.readNote(result.path);
  if (reading !== mine) return;
  if (file.error) return fail(file.error);

  // Show the page area first, so the viewer can measure it for fit-to-width.
  Object.assign(mine, { state: 'ready', file: result.path, outdated: Boolean(result.outdated) });
  renderReader();
  await pdfViewReady();
  viewer ??= new window.PdfView($('reader-pages'), { onChange: renderReaderTools, rail: $('reader-rail') });
  try {
    mine.pages = await viewer.open(file.bytes);
  } catch (err) {
    if (reading === mine) fail(`the PDF couldn’t be displayed (${err.message})`);
    return;
  }
  if (reading !== mine) return;
  renderReader();
  viewer.revealCurrent();
  $('reader-pages').focus();
  if (!local[doc.id]?.thumb) refreshLocal(); // it now has a PDF here
}

function closeReader() {
  if (!reading) return;
  if (reading.state === 'loading') api.cancelOpenNote();
  reading = null;
  readerDownloadAt = null;
  clearInterval(readerTimer);
  viewer?.close();
  renderReader();
}

$('reader-back').addEventListener('click', closeReader);
$('reader-action').addEventListener('click', () => {
  if (!reading) return;
  if (reading.state === 'loading') closeReader();
  else openReader(reading.doc);
});
$('reader-external').addEventListener('click', () => reading?.file && api.openExternally(reading.file));

// Printing: the pages are drawn as images into #print-sheet, which is all that prints (app.css).
let printing = false;
const PRINT_TITLE = `Print (${navigator.userAgent.includes('Mac') ? '\u2318P' : 'Ctrl+P'})`;
$('reader-print').title = PRINT_TITLE;

function clearPrintSheet() {
  for (const img of $('print-sheet').querySelectorAll('img')) URL.revokeObjectURL(img.src);
  $('print-sheet').replaceChildren();
}
window.addEventListener('afterprint', clearPrintSheet);

async function printNote() {
  if (printing || !viewer || reading?.state !== 'ready' || !reading.pages) return;
  const mine = reading;
  const button = $('reader-print');
  printing = true;
  button.disabled = true;
  try {
    const images = await viewer.printImages({
      onProgress: (n, total) => (button.title = `Preparing page ${n} of ${total}\u2026`),
    });
    if (reading !== mine) return images.forEach((image) => URL.revokeObjectURL(image.url));
    clearPrintSheet();
    const pages = images.map(({ url }) => el('div', { className: 'print-page' }, [el('img', { attrs: { src: url, alt: '' } })]));
    $('print-sheet').replaceChildren(...pages);
    await Promise.all(pages.map((page) => page.firstChild.decode().catch(() => {})));
    // The print dialog and the job are named after the document.
    const title = document.title;
    document.title = mine.doc.name;
    try {
      window.print();
    } finally {
      document.title = title;
    }
  } catch (err) {
    if (reading === mine) alert(`Couldn\u2019t print this note: ${err.message}.`);
  } finally {
    printing = false;
    button.disabled = false;
    button.title = PRINT_TITLE;
  }
}
$('reader-print').addEventListener('click', printNote);

let exportingPng = false;
const PNG_TITLE = 'Export pages as PNG images';

async function exportPng() {
  if (exportingPng || !viewer || reading?.state !== 'ready' || !reading.pages) return;
  const mine = reading;
  const button = $('reader-png');
  const folder = await api.choosePngFolder(mine.doc.name);
  if (folder.error) return alert(folder.error);
  if (!folder.token || reading !== mine) return;
  exportingPng = true;
  button.disabled = true;
  try {
    await viewer.pngPages({
      dpi: 200,
      onPage: async (n, total, blob) => {
        button.title = `Exporting page ${n} of ${total}\u2026`;
        const written = await api.writePngPage(folder.token, n, total, new Uint8Array(await blob.arrayBuffer()));
        if (written?.error) throw new Error(written.error);
      },
    });
    api.showPngExport(folder.token);
  } catch (err) {
    if (reading === mine) alert(`Couldn\u2019t export the pages: ${err.message}.`);
  } finally {
    exportingPng = false;
    button.disabled = false;
    button.title = PNG_TITLE;
  }
}
$('reader-png').addEventListener('click', exportPng);
$('reader-rail-toggle').addEventListener('click', () => {
  ui.railOpen = !ui.railOpen;
  prefs.set('readerRail', ui.railOpen);
  renderReader();
  if (ui.railOpen) viewer?.revealCurrent();
});
$('zoom-in').addEventListener('click', () => viewer?.zoomIn());
$('zoom-out').addEventListener('click', () => viewer?.zoomOut());
$('zoom-fit').addEventListener('click', () => viewer?.setZoom('fit'));
$('reader-download').addEventListener('click', async () => {
  if (!reading) return;
  readerDownloadAt = Date.now();
  renderReaderDownload();
  const result = await api.startDownload({ targets: [noteTarget(reading.doc)] });
  if (result?.error) {
    readerDownloadAt = null;
    alert(result.error);
  }
});
$('reader-saved-open').addEventListener('click', () => api.openDestination());
$('open-folder').addEventListener('click', async () => {
  const result = await api.openDestination();
  if (result?.error) alert(result.error);
});

// ---------------------------------------------------------------------------

let welcomeClosed = false;

function renderWelcome() {
  $('welcome').hidden = !current.showWelcome || welcomeClosed;
  if (!$('welcome').hidden && !$('welcome').contains(document.activeElement)) $('welcome-ok').focus();
}

function render() {
  if (!current) return;
  const connected = current.status === 'ok' || Boolean(current.job) || Boolean(library);
  $('about-view').hidden = ui.page !== 'about';
  $('about-version').textContent = `Version ${current.version}`;
  $('settings-view').hidden = ui.page !== 'settings';
  $('library-view').hidden = ui.page !== 'library' || !connected;
  $('connect').hidden = ui.page !== 'library' || connected;
  renderSidebar();
  if (ui.page === 'settings') renderSettings();
  else if (connected) renderLibrary();
  else renderConnect();
  renderDownloads();
  renderReader();
  renderWelcome();
}

function onState(state) {
  const wasOk = current?.status === 'ok';
  const downloadEnded = Boolean(current?.job) && !state.job;
  const folderChanged = current && current.destination !== state.destination;
  if (current && current.tabletAddress !== state.tabletAddress) {
    // A different tablet: its notes and folder IDs mean nothing here.
    library = null;
    librarySource = null;
    localLoadedFor = null;
    index = null;
    local = {};
    selected.clear();
    ui.view = { kind: 'all' };
    tabletThumbsUnsupported = false;
    tabletThumbMisses.clear();
  }
  current = state;
  applyTheme();
  render();
  const needLibrary = !library || librarySource === 'local' || libraryAddress !== state.tabletAddress;
  const needLocal = (!library || (librarySource === 'local' && folderChanged)) && localLoadedFor !== state.destination;
  if (state.status === 'ok' && !state.job && (needLibrary || (!wasOk && libraryError))) loadLibrary();
  else if (state.status !== 'ok' && !state.job && needLocal) loadLocalLibrary();
  else if (downloadEnded && state.lastResult?.kind === 'upload' && state.lastResult.summary?.downloaded) loadLibrary();
  else if (downloadEnded || folderChanged) refreshLocal();
}

// ---------------------------------------------------------------------------
// Controls

$('search').addEventListener('input', () => {
  ui.search = $('search').value;
  lastClicked = null;
  searchText();
  render();
});
$('search').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    clearSearch();
    render();
  }
});
$('search').title = `Search note and folder names (${navigator.userAgent.includes('Mac') ? '\u2318F' : 'Ctrl+F'})`;

document.addEventListener('keydown', (event) => {
  if (!$('welcome').hidden) {
    if (event.key === 'Escape') $('welcome-ok').click();
    return; // the dialog has the keyboard
  }
  const mod = event.metaKey || event.ctrlKey;
  if (reading) {
    const key = event.key.toLowerCase();
    if (event.key === 'Escape') return closeReader();
    if (mod && (key === '=' || key === '+')) {
      event.preventDefault();
      return viewer?.zoomIn();
    }
    if (mod && key === '-') {
      event.preventDefault();
      return viewer?.zoomOut();
    }
    if (mod && key === '0') {
      event.preventDefault();
      return viewer?.setZoom('fit');
    }
    if (mod && key === 'p') {
      event.preventDefault();
      return printNote();
    }
    if (!mod && (event.key === 'ArrowRight' || event.key === 'ArrowLeft') && reading.state === 'ready') {
      event.preventDefault();
      return event.key === 'ArrowRight' ? viewer?.next() : viewer?.previous();
    }
    if (!(mod && (key === 'f' || key === ','))) return; // the reader has the keyboard
    closeReader();
  }
  const active = document.activeElement;
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(active?.tagName ?? '') && active.type !== 'checkbox';
  if (mod && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    ui.page = 'library';
    render();
    $('search').focus();
    $('search').select();
  } else if (mod && event.key === ',') {
    event.preventDefault();
    ui.page = 'settings';
    render();
  } else if (ui.page === 'library' && mod && event.key.toLowerCase() === 'a' && !typing && library) {
    event.preventDefault();
    shown.forEach((d) => selected.add(d.id));
    render();
  } else if (event.key === 'Escape' && !typing && selected.size) {
    selected.clear();
    render();
  }
});

$('filter-modified').addEventListener('change', () => {
  ui.modified = $('filter-modified').value;
  render();
});
$('filter-favorites').addEventListener('click', () => {
  ui.favoritesOnly = !ui.favoritesOnly;
  render();
});
$('filter-subfolders').addEventListener('click', () => {
  ui.includeSubfolders = !ui.includeSubfolders;
  render();
});
$('filter-scope').addEventListener('click', () => {
  ui.searchInView = !ui.searchInView;
  render();
});
$('filter-clear').addEventListener('click', clearFilters);
$('sort').addEventListener('change', () => {
  ui.sort = $('sort').value;
  prefs.set('sort', ui.sort);
  render();
});
for (const layout of ['grid', 'list']) {
  $(`layout-${layout}`).addEventListener('click', () => {
    ui.layout = layout;
    prefs.set('layout', layout);
    render();
  });
}
$('select-all').addEventListener('change', () => {
  if ($('select-all').checked) shown.forEach((d) => selected.add(d.id));
  else shown.forEach((d) => selected.delete(d.id));
  render();
});
$('select-toggle').addEventListener('click', () => {
  const all = shown.length > 0 && shown.every((d) => selected.has(d.id));
  shown.forEach((d) => (all ? selected.delete(d.id) : selected.add(d.id)));
  render();
});
$('thumbs-selected').addEventListener('click', async () => {
  const docs = selectedNeedingThumbnails().map(({ id, name, modified }) => ({ id, name, modified }));
  if (!docs.length) return;
  const result = await api.fetchThumbnails(docs);
  if (result?.error) alert(result.error);
});
$('combine-selected').addEventListener('click', async () => {
  // In the order shown, then any selected notes that aren't shown.
  const ids = new Set([...shown.filter((d) => selected.has(d.id)).map((d) => d.id), ...selected]);
  const order = [...ids].map((id) => index?.docById.get(id)).filter(Boolean);
  const docs = order.filter((d) => d.modified).map((d) => ({ id: d.id, name: d.name, modified: d.modified }));
  if (docs.length < order.length) alert('Notes without a modified date can’t be combined; they’re left out.');
  const result = await api.combine(docs);
  if (result?.error) alert(result.error);
});
$('select-none').addEventListener('click', () => {
  selected.clear();
  render();
});

$('refresh').addEventListener('click', loadLibrary);
$('nav-settings').addEventListener('click', () => {
  closeReader();
  ui.page = 'settings';
  render();
});
$('nav-about').addEventListener('click', () => {
  closeReader();
  ui.page = 'about';
  render();
});
for (const link of document.querySelectorAll('[data-link]')) {
  link.addEventListener('click', () => api.openLink(link.dataset.link));
}
for (const id of ['about-licenses', 'about-licenses-all']) {
  $(id).addEventListener('click', async () => {
    const result = await api.openLicenses();
    if (result?.error) alert(result.error);
  });
}
$('about-chromium').addEventListener('click', async () => {
  const result = await api.openChromiumLicenses();
  if (result?.error) alert(result.error);
});
$('welcome-ok').addEventListener('click', () => {
  welcomeClosed = true;
  renderWelcome();
  api.welcomeDone();
});
$('check').addEventListener('click', async () => {
  $('check').disabled = true;
  try {
    await api.checkNow();
  } finally {
    $('check').disabled = false;
  }
});
$('change-address').addEventListener('click', () => {
  ui.page = 'settings';
  render();
  $('address').focus();
});

$('download-view').addEventListener('click', () => {
  const action = viewDownload();
  if (action && !action.empty) startDownload(action.request);
});
$('download-selected').addEventListener('click', () => {
  const targets = [...selected].map((id) => index?.docById.get(id)).filter(Boolean).map(noteTarget);
  startDownload({ targets });
});
$('stop').addEventListener('click', () => api.stopDownload());

for (const button of $('select-mode').querySelectorAll('button')) {
  button.addEventListener('click', () => {
    ui.selectMode = button.dataset.mode;
    prefs.set('selectMode', ui.selectMode);
    renderSelectMode();
  });
}

// "One" mode: a click on empty space clears the selection.
$('results').addEventListener('click', (event) => {
  if (ui.selectMode !== 'one' || !selected.size) return;
  if (event.target.closest('.note, tr, button, input, a, .folder-tile')) return;
  selected.clear();
  renderResults();
  renderDownloads();
});

$('upload').addEventListener('click', async () => {
  const result = await api.chooseUpload(uploadTarget());
  if (result?.error) alert(result.error);
  reportRejected(result?.rejected);
});

// Drag files onto the library to upload them: into the folder tile or sidebar folder they're
// dropped on, else into the folder that's open.
let dragDepth = 0;
let dropHighlight = null;
const draggingFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');

/** The folder under the pointer that takes dropped files ({ id, name, node }), if any. */
function dropFolderAt(target) {
  const node = target?.closest?.('[data-drop-folder]');
  return node ? { id: node.dataset.dropFolder || null, name: node.dataset.dropName, node } : null;
}

function highlightDrop(node) {
  if (dropHighlight === node) return;
  dropHighlight?.classList.remove('drop-here');
  dropHighlight = node;
  node?.classList.add('drop-here');
}

async function uploadDropped(event, folder) {
  const paths = [...event.dataTransfer.files].map((file) => api.pathForFile(file)).filter(Boolean);
  const result = await api.uploadFiles(paths, { id: folder.id, name: folder.name });
  if (result?.error) alert(result.error);
  reportRejected(result?.rejected);
}

$('library-view').addEventListener('dragenter', (event) => {
  if (!draggingFiles(event) || !canDownload()) return;
  event.preventDefault();
  dragDepth += 1;
  $('drop-overlay').hidden = false;
});
$('library-view').addEventListener('dragover', (event) => {
  if (!draggingFiles(event) || !canDownload()) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  const folder = dropFolderAt(event.target);
  highlightDrop(folder?.node ?? null);
  $('drop-overlay').classList.toggle('on-folder', Boolean(folder)); // let the folder's highlight show
  $('drop-title').textContent = `Drop to upload to \u201c${(folder ?? uploadTarget()).name}\u201d`;
});
$('library-view').addEventListener('dragleave', (event) => {
  if (!draggingFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    $('drop-overlay').hidden = true;
    highlightDrop(null);
  }
});
$('library-view').addEventListener('drop', async (event) => {
  if (!draggingFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  $('drop-overlay').hidden = true;
  highlightDrop(null);
  if (!canDownload()) return;
  uploadDropped(event, dropFolderAt(event.target) ?? uploadTarget());
});

// The sidebar: "All notes" (the top level) and every folder in the tree take drops too.
const sidebarNav = document.querySelector('.sidebar-nav');
sidebarNav.addEventListener('dragover', (event) => {
  if (!draggingFiles(event)) return;
  const folder = library && canDownload() ? dropFolderAt(event.target) : null;
  highlightDrop(folder?.node ?? null);
  event.preventDefault();
  event.dataTransfer.dropEffect = folder ? 'copy' : 'none';
});
sidebarNav.addEventListener('dragleave', (event) => {
  if (!sidebarNav.contains(event.relatedTarget)) highlightDrop(null);
});
sidebarNav.addEventListener('drop', (event) => {
  if (!draggingFiles(event)) return;
  event.preventDefault();
  highlightDrop(null);
  const folder = library && canDownload() ? dropFolderAt(event.target) : null;
  if (folder) uploadDropped(event, folder);
});
// Files dropped anywhere else must not navigate the window to them.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => {
  event.preventDefault();
  highlightDrop(null);
});
$('activity-open').addEventListener('click', () => api.showResult());
$('activity-dismiss').addEventListener('click', () => {
  dismissedResultAt = current.lastResult?.at ?? null;
  renderActivity();
});

api.themes().then((result) => {
  themes = result.themes ?? null;
  applyTheme();
  if (current && ui.page === 'settings') renderAppearance();
});
api.getState().then(onState);
api.onState(onState);
