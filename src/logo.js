// The Kraken.io mark for the terminal.
//
// Decorative only: it is printed straight to stdout and never routed through
// ui.say(), so it stays out of the --log-file transcript (which is meant to be
// colour-free and greppable) and out of --json.

import pc from 'picocolors';
import { COLS, ROWS, palette, rows, mono } from './logo-data.js';

const RESET = '\x1b[0m';
const rgb = palette.map((h) => [
  parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16),
]);

// Character-cell index → palette entry, or null for a transparent half.
const at = (row, cell, half) => {
  const ch = rows[row][cell * 2 + half];
  if (ch === '.') return null;
  const n = ch.charCodeAt(0);
  return rgb[n < 58 ? n - 48 : n < 91 ? n - 29 : n - 87];
};

// xterm-256: the 6×6×6 colour cube, plus the 24-step grey ramp when a colour is
// close to neutral. Good enough for a six-row mark.
function to256([r, g, b]) {
  if (Math.max(r, g, b) - Math.min(r, g, b) < 12) {
    const grey = Math.round((r + g + b) / 3);
    if (grey < 8) return 16;
    if (grey > 248) return 231;
    return 232 + Math.round(((grey - 8) / 247) * 23);
  }
  const q = (v) => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

/**
 * How much colour this terminal can show: 'true' (24-bit), '256', or 'none'.
 * Exported and overridable so every branch is reachable from a test — picocolors
 * settles isColorSupported at import time, which a test cannot move afterwards.
 */
export function detectDepth() {
  if (!pc.isColorSupported) return 'none';
  const ct = process.env.COLORTERM || '';
  if (ct === 'truecolor' || ct === '24bit') return 'true';
  return /-256(color)?$/.test(process.env.TERM || '') ? '256' : 'true';
}

const fg = (c, d) => (d === 'true' ? `\x1b[38;2;${c[0]};${c[1]};${c[2]}m` : `\x1b[38;5;${to256(c)}m`);
const bg = (c, d) => (d === 'true' ? `\x1b[48;2;${c[0]};${c[1]};${c[2]}m` : `\x1b[48;5;${to256(c)}m`);

/** The mark alone, as an array of ROWS strings. */
export function markLines({ depth = detectDepth() } = {}) {
  const d = depth;
  if (d === 'none') return mono.map((l) => l.padEnd(COLS));

  const out = [];
  for (let r = 0; r < ROWS; r++) {
    let line = '';
    for (let x = 0; x < COLS; x++) {
      const top = at(r, x, 0), bot = at(r, x, 1);
      if (!top && !bot) { line += ' '; continue; }
      // '▀' paints the top half in fg and leaves the bottom to bg; with only a
      // bottom half, '▄' avoids emitting a background the terminal would draw
      // past the glyph.
      if (top && bot) line += fg(top, d) + bg(bot, d) + '▀' + RESET;
      else if (top) line += fg(top, d) + '▀' + RESET;
      else line += fg(bot, d) + '▄' + RESET;
    }
    out.push(line);
  }
  return out;
}

/**
 * The mark with the wordmark beside it. The wordmark is real text rather than
 * more block art — at six rows the terminal's own font renders it far better
 * than any downscale of the logotype could.
 */
export function bannerLines(subtitle = '', opts = {}) {
  const mark = markLines(opts);
  const text = ['', '', pc.bold('Kraken.io'), subtitle ? pc.dim(subtitle) : '', '', ''];
  return mark.map((m, i) => `  ${m}   ${text[i] || ''}`.trimEnd());
}

/**
 * Whether a banner belongs in this output at all. Decorative output is for a
 * human at a terminal: never in a pipe, a log, JSON, or --quiet.
 */
export function bannerEnabled(opts = {}) {
  if (opts.quiet || opts.json) return false;
  if (!process.stdout.isTTY) return false;
  if (process.env.KRAKEN_NO_LOGO) return false;
  return (process.stdout.columns || 80) >= COLS + 20;
}

/** Print the banner if this output should carry one. Returns whether it did. */
export function printBanner(opts = {}, subtitle = '') {
  if (!bannerEnabled(opts)) return false;
  console.log('');
  for (const line of bannerLines(subtitle)) console.log(line);
  return true;
}

export { to256 };
