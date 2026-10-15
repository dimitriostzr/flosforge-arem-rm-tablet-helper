'use strict';

// Colour themes (themes.json, shared with FlosForge Radar). Each has a light and a dark palette.

const { themes: THEMES } = require('./themes.json');

const DEFAULT_THEME_ID = 'ink';
const MODES = ['system', 'light', 'dark'];

function themeById(id) {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME_ID);
}

/** WCAG relative luminance of #RRGGBB (alpha ignored). */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours, 1 to 21. */
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

module.exports = { THEMES, DEFAULT_THEME_ID, MODES, themeById, contrast };
