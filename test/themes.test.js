'use strict';

// Same checks as FlosForge Radar's themes test: WCAG AA, with body text held to AAA.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { THEMES, DEFAULT_THEME_ID, themeById, contrast } = require('../src/themes');

const KEYS = ['accent', 'background', 'border', 'foreground', 'muted', 'onPrimary', 'primary', 'sidebar', 'surface', 'surfaceAlt'];

describe('themes', () => {
  test('have unique ids, names and descriptions, and include the default', () => {
    const ids = THEMES.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.includes(DEFAULT_THEME_ID));
    for (const t of THEMES) assert.ok(t.name && t.description, t.id);
  });

  test('fall back to the default for unknown ids', () => {
    assert.equal(themeById('no-such-theme').id, DEFAULT_THEME_ID);
  });

  for (const theme of THEMES) {
    for (const mode of ['light', 'dark']) {
      const p = theme[mode];
      test(`${theme.id} ${mode}: complete, valid colours`, () => {
        assert.deepEqual(Object.keys(p).sort(), KEYS);
        for (const v of Object.values(p)) assert.match(v, /^#[0-9A-F]{6}(?:[0-9A-F]{2})?$/i);
      });
      test(`${theme.id} ${mode}: readable`, () => {
        const at = (a, b, min, what) => assert.ok(contrast(p[a], p[b]) >= min, `${what}: ${contrast(p[a], p[b]).toFixed(2)} < ${min}`);
        at('foreground', 'background', 7, 'body text on the page');
        at('foreground', 'surfaceAlt', 7, 'body text on panels');
        at('muted', 'background', 4.5, 'secondary text on the page');
        at('muted', 'surface', 4.5, 'secondary text on cards');
        at('onPrimary', 'primary', 4.5, 'button labels');
        at('primary', 'background', 3, 'accent against the page');
      });
    }
  }
});
