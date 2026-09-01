// The terminal mark: gating rules, cell decoding and the colour-free fallback.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { markLines, bannerLines, bannerEnabled, detectDepth } from '../src/logo.js';
import { COLS, ROWS, palette, rows, mono } from '../src/logo-data.js';

const ESC = String.fromCharCode(27);
const stripAnsi = (s) => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');

// bannerEnabled() reads live process state, so each test restores what it touched.
const saved = { isTTY: process.stdout.isTTY, columns: process.stdout.columns, env: { ...process.env } };
afterEach(() => {
  process.stdout.isTTY = saved.isTTY;
  process.stdout.columns = saved.columns;
  process.env = { ...saved.env };
});

const asTty = (columns = 120) => { process.stdout.isTTY = true; process.stdout.columns = columns; };

describe('logo data', () => {
  test('every row carries two palette indices per cell', () => {
    assert.equal(rows.length, ROWS);
    for (const r of rows) assert.equal(r.length, COLS * 2, 'two halves per character cell');
  });

  test('every index resolves to a colour in the palette', () => {
    const CH = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (const r of rows) {
      for (const ch of r) {
        if (ch === '.') continue;
        const i = CH.indexOf(ch);
        assert.notEqual(i, -1, `unknown index character: ${ch}`);
        assert.ok(i < palette.length, `index ${ch} is outside the palette`);
      }
    }
  });

  test('the palette is hex colours', () => {
    for (const c of palette) assert.match(c, /^#[0-9a-f]{6}$/);
  });

  test('the mono silhouette has one line per row', () => {
    assert.equal(mono.length, ROWS);
    for (const l of mono) assert.ok(l.length <= COLS);
  });
});

describe('markLines', () => {
  test('renders one line per row', () => {
    assert.equal(markLines().length, ROWS);
  });

  for (const depth of ['true', '256', 'none']) {
    test(`every line is COLS cells wide at ${depth}-colour depth`, () => {
      for (const line of markLines({ depth })) {
        assert.equal([...stripAnsi(line)].length, COLS, 'the mark must not wrap or drift');
      }
    });
  }

  test('24-bit depth emits truecolor escapes', () => {
    const out = markLines({ depth: 'true' }).join('');
    assert.match(out, new RegExp(`${ESC}\\[38;2;\\d+;\\d+;\\d+m`));
    assert.equal(new RegExp(`${ESC}\\[38;5;`).test(out), false);
  });

  test('256-colour depth emits indexed escapes within the xterm range', () => {
    const out = markLines({ depth: '256' }).join('');
    assert.match(out, new RegExp(`${ESC}\\[38;5;\\d+m`));
    assert.equal(new RegExp(`${ESC}\\[38;2;`).test(out), false);
    for (const m of out.matchAll(new RegExp(`${ESC}\\[[34]8;5;(\\d+)m`, 'g'))) {
      const n = Number(m[1]);
      assert.ok(n >= 16 && n <= 255, `xterm index out of range: ${n}`);
    }
  });

  test('falls back to the colour-free silhouette when colour is unsupported', () => {
    const lines = markLines({ depth: 'none' });
    assert.equal(lines.join('').includes(ESC), false, 'no escape codes without colour');
    for (const line of lines) assert.match(line, /^[█▀▄ ]*$/);
  });

  test('every coloured cell is reset, so colour never leaks into later output', () => {
    for (const line of markLines({ depth: 'true' })) {
      // One reset per painted cell; a cell is painted iff it is not a space.
      const painted = [...stripAnsi(line)].filter((ch) => ch !== ' ').length;
      const resets = [...line.matchAll(new RegExp(`${ESC}\\[0m`, 'g'))].length;
      assert.equal(resets, painted, 'each painted cell closes its own colour');
      // Anything after the final reset is unpainted padding, never live colour.
      const tail = line.slice(line.lastIndexOf(`${ESC}[0m`) + 4);
      assert.match(tail, /^ *$/, 'colour is closed before the end of the line');
    }
  });

  test('renders only block glyphs and spaces', () => {
    for (const line of markLines({ depth: 'true' })) {
      assert.match(stripAnsi(line), /^[█▀▄ ]+$/);
    }
  });
});

describe('detectDepth', () => {
  test('reports one of the three supported depths', () => {
    assert.ok(['true', '256', 'none'].includes(detectDepth()));
  });
});

describe('bannerLines', () => {
  test('puts the wordmark beside the mark, not below it', () => {
    const lines = bannerLines('official CLI · v9.9.9', { depth: 'none' });
    assert.equal(lines.length, ROWS);
    assert.ok(lines.some((l) => stripAnsi(l).includes('Kraken.io')));
    assert.ok(lines.some((l) => stripAnsi(l).includes('official CLI · v9.9.9')));
  });

  test('the wordmark is real text, so it survives colour being stripped', () => {
    const text = bannerLines('sub', { depth: 'true' }).map(stripAnsi).join('\n');
    assert.match(text, /Kraken\.io/);
  });

  test('omitting the subtitle leaves no stray blank column', () => {
    for (const line of bannerLines('', { depth: 'none' })) assert.equal(line, line.trimEnd());
  });
});

describe('bannerEnabled', () => {
  test('shows for a human at a wide enough terminal', () => {
    asTty();
    assert.equal(bannerEnabled({}), true);
  });

  test('never in a pipe — decorative output must not reach a file or another program', () => {
    process.stdout.isTTY = false;
    assert.equal(bannerEnabled({}), false);
  });

  test('never with --quiet or --json', () => {
    asTty();
    assert.equal(bannerEnabled({ quiet: true }), false);
    assert.equal(bannerEnabled({ json: true }), false);
  });

  test('never when the terminal is too narrow for it', () => {
    asTty(COLS + 19);
    assert.equal(bannerEnabled({}), false);
    asTty(COLS + 20);
    assert.equal(bannerEnabled({}), true);
  });

  test('KRAKEN_NO_LOGO opts out entirely', () => {
    asTty();
    process.env.KRAKEN_NO_LOGO = '1';
    assert.equal(bannerEnabled({}), false);
  });
});
