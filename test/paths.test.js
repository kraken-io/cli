// Input expansion and — the part that can destroy someone's photos — where
// every result gets written.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SUFFIXES, isGenerated, resolveInputs, assertOutputOptions, outputName,
  planDestination, planRun, findCollisions, findClobbers, finalizeDest,
} from '../src/paths.js';
import { UsageError, scanExts } from '../src/params.js';

const usage = (fn, re) => assert.throws(fn, (e) => e instanceof UsageError && (!re || re.test(e.message)));
const OPT = SUFFIXES.optimize;

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kio-paths-')); });
const touch = (p, body = 'x') => {
  const full = path.join(dir, p);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
};
const item = (input, root = null) => ({ input, root });

describe('resolveInputs', () => {
  test('expands a folder recursively to supported images and keeps URLs', () => {
    touch('a.jpg'); touch('b.png'); touch('notes.txt'); touch('sub/c.webp');
    const { items } = resolveInputs([dir, 'https://x.com/d.jpg']);
    assert.deepEqual(items.map((i) => i.input).sort(), [
      'https://x.com/d.jpg', path.join(dir, 'a.jpg'), path.join(dir, 'b.png'), path.join(dir, 'sub', 'c.webp'),
    ].sort());
  });

  test('remembers the folder each file came from, for --out-dir mirroring', () => {
    touch('sub/c.webp');
    const { items } = resolveInputs([dir]);
    assert.equal(items[0].root, dir);
  });

  test('an explicit file has no root', () => {
    const f = touch('a.jpg');
    assert.equal(resolveInputs([f]).items[0].root, null);
  });

  test('skips formats the API would reject with 415, and says why', () => {
    touch('a.bmp'); touch('b.tiff');
    const { items, skipped } = resolveInputs([path.join(dir, 'a.bmp')]);
    assert.equal(items.length, 0);
    assert.deepEqual(skipped, [{ input: path.join(dir, 'a.bmp'), reason: 'unsupported file type' }]);
  });

  test('a folder scan accepts every documented image format', () => {
    for (const ext of ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.avif', '.heic', '.heif']) touch(`f${ext}`);
    assert.equal(resolveInputs([dir]).items.length, 9);
  });

  test('a folder scan leaves PDFs alone unless they are asked for', () => {
    touch('a.jpg'); touch('doc.pdf'); touch('report.pdf');
    const { items, excluded } = resolveInputs([dir]);
    assert.deepEqual(items.map((i) => path.basename(i.input)), ['a.jpg']);
    assert.equal(excluded.get('.pdf'), 2, 'the skipped PDFs are counted, not silently dropped');
  });

  test("--types +pdf adds PDFs to the default set", () => {
    touch('a.jpg'); touch('doc.pdf');
    const { items, excluded } = resolveInputs([dir], { scanExts: scanExts({ types: '+pdf' }) });
    assert.deepEqual(items.map((i) => path.basename(i.input)).sort(), ['a.jpg', 'doc.pdf']);
    assert.equal(excluded.size, 0, 'nothing supported was left behind');
  });

  test('--types with a plain list replaces the default set', () => {
    touch('a.jpg'); touch('b.png'); touch('c.webp');
    const { items, excluded } = resolveInputs([dir], { scanExts: scanExts({ types: 'jpg,png' }) });
    assert.deepEqual(items.map((i) => path.basename(i.input)).sort(), ['a.jpg', 'b.png']);
    assert.equal(excluded.get('.webp'), 1);
  });

  test("--types all picks up everything the API accepts", () => {
    for (const ext of ['.jpg', '.png', '.pdf', '.svg', '.heic']) touch(`f${ext}`);
    const { items, excluded } = resolveInputs([dir], { scanExts: scanExts({ types: 'all' }) });
    assert.equal(items.length, 5);
    assert.equal(excluded.size, 0);
  });

  test('a PDF named directly on the command line is still processed', () => {
    touch('doc.pdf');
    // --types governs directory scans; naming a file is an explicit request.
    const { items } = resolveInputs([path.join(dir, 'doc.pdf')]);
    assert.equal(items.length, 1);
  });

  test('an explicitly named file outside --types is still processed', () => {
    touch('a.png');
    const { items } = resolveInputs([path.join(dir, 'a.png')], { scanExts: scanExts({ types: 'jpg' }) });
    assert.equal(items.length, 1);
  });

  test('a missing path is skipped, not fatal', () => {
    const { items, skipped } = resolveInputs([path.join(dir, 'nope.jpg')]);
    assert.equal(items.length, 0);
    assert.equal(skipped[0].reason, 'not found');
  });

  test('the same file named twice is processed once', () => {
    const f = touch('a.jpg');
    assert.equal(resolveInputs([f, f, './' + path.relative(process.cwd(), f)]).items.length, 1);
  });

  test('a folder scan skips this CLI\'s own outputs so a re-run is idempotent', () => {
    touch('a.jpg'); touch('a.kraked.jpg'); touch('b.restored.png'); touch('c.enhanced.webp');
    touch('d.kraked.800x-landscape.jpg');
    const { items } = resolveInputs([dir]);
    assert.deepEqual(items.map((i) => path.basename(i.input)), ['a.jpg']);
  });

  test('--include-generated opts back in', () => {
    touch('a.jpg'); touch('a.kraked.jpg');
    assert.equal(resolveInputs([dir], { includeGenerated: true }).items.length, 2);
  });

  test('an explicitly named generated file is still processed', () => {
    const f = touch('a.kraked.jpg');
    assert.equal(resolveInputs([f]).items.length, 1);
  });

  test('dotfiles and dot-directories are ignored', () => {
    touch('.hidden.jpg'); touch('.git/x.jpg'); touch('ok.jpg');
    assert.deepEqual(resolveInputs([dir]).items.map((i) => path.basename(i.input)), ['ok.jpg']);
  });

  test('isGenerated recognises our suffixes and nothing else', () => {
    assert.equal(isGenerated('a.kraked.jpg'), true);
    assert.equal(isGenerated('a.kraked.800x.jpg'), true);
    assert.equal(isGenerated('a.restored.png'), true);
    assert.equal(isGenerated('a.enhanced.webp'), true);
    assert.equal(isGenerated('a.jpg'), false);
    assert.equal(isGenerated('kraked.jpg'), false);
  });
});

describe('output naming — the default never touches the input', () => {
  test('a local file becomes name.kraked.ext next to itself', () => {
    const dest = planDestination(item('/photos/a.jpg'), {}, { suffix: OPT, ext: '.jpg' });
    assert.equal(dest, path.join('/photos', 'a.kraked.jpg'));
  });

  test('a URL result lands in the cwd, named from the URL path', () => {
    assert.equal(planDestination(item('https://x.com/p/banner.png'), {}, { suffix: OPT, ext: '.png' }),
      'banner.kraked.png');
  });

  test('percent-encoded URL names are decoded', () => {
    assert.equal(outputName('https://x.com/my%20photo.jpg', { suffix: OPT, ext: '.jpg' }), 'my photo.kraked.jpg');
  });

  test('a URL with no filename still produces something sane', () => {
    assert.equal(outputName('https://x.com/', { suffix: OPT, ext: '.jpg' }), 'image.kraked.jpg');
  });

  test('multi-resize tags go between the suffix and the extension', () => {
    assert.equal(outputName('a.jpg', { suffix: OPT, tag: '.800x-landscape', ext: '.jpg' }),
      'a.kraked.800x-landscape.jpg');
  });

  test('--out is used verbatim', () => {
    assert.equal(planDestination(item('/photos/a.jpg'), { out: 'out/final.webp' }, { suffix: OPT, ext: '.webp' }),
      'out/final.webp');
  });

  test('--overwrite targets the input itself — that is the whole point of the flag', () => {
    assert.equal(planDestination(item('/photos/a.jpg'), { overwrite: true }, { suffix: OPT, ext: '.jpg' }),
      '/photos/a.jpg');
  });

  test('--out-dir mirrors the folder structure instead of flattening it', () => {
    const it = item('/photos/2024/a.jpg', '/photos');
    assert.equal(planDestination(it, { outDir: '/web' }, { suffix: OPT, ext: '.jpg' }),
      path.join('/web', '2024', 'a.kraked.jpg'));
  });

  test('--out-dir with a file listed directly puts it at the top level', () => {
    assert.equal(planDestination(item('/photos/a.jpg'), { outDir: '/web' }, { suffix: OPT, ext: '.jpg' }),
      path.join('/web', 'a.kraked.jpg'));
  });
});

describe('flag combinations that could destroy data are refused', () => {
  const two = [item('a.jpg'), item('b.jpg')];

  test('--out with more than one input', () => {
    usage(() => assertOutputOptions({ out: 'x.jpg' }, two), /--out takes a single output path but 2 inputs/);
  });

  test('--out with multiple sizes', () => {
    usage(() => assertOutputOptions({ out: 'x.jpg' }, [item('a.jpg')], { tagCount: 3 }),
      /--out cannot be used with multiple --resize/);
  });

  test('--out together with --out-dir', () => {
    usage(() => assertOutputOptions({ out: 'x.jpg', outDir: 'd' }, [item('a.jpg')]), /cannot be used together/);
  });

  test('--overwrite together with --out or --out-dir', () => {
    usage(() => assertOutputOptions({ overwrite: true, out: 'x.jpg' }, [item('a.jpg')]), /cannot be used together/);
    usage(() => assertOutputOptions({ overwrite: true, outDir: 'd' }, [item('a.jpg')]), /cannot be used together/);
  });

  test('--overwrite with multiple sizes — one input cannot become three files', () => {
    usage(() => assertOutputOptions({ overwrite: true }, [item('a.jpg')], { tagCount: 3 }),
      /--overwrite cannot be used with multiple --resize/);
  });

  test('--overwrite with a URL input, which has nothing to overwrite', () => {
    usage(() => assertOutputOptions({ overwrite: true }, [item('https://x.com/a.jpg')]), /needs local files/);
  });

  test('--no-save contradicts every destination flag', () => {
    for (const flag of [{ out: 'x' }, { outDir: 'd' }, { overwrite: true }]) {
      usage(() => assertOutputOptions({ save: false, ...flag }, [item('a.jpg')]), /--no-save cannot be combined/);
    }
  });

  test('the ordinary combinations are allowed', () => {
    assertOutputOptions({}, two);
    assertOutputOptions({ outDir: 'd' }, two, { tagCount: 3 });
    assertOutputOptions({ overwrite: true }, two);
    assertOutputOptions({ out: 'x.jpg' }, [item('a.jpg')]);
    assertOutputOptions({ save: false }, two);
  });
});

describe('collision detection', () => {
  test('two folders with the same filename would collide when flattened — and are caught', () => {
    // Without root-mirroring this is exactly the silent-overwrite bug.
    const plan = planRun(
      [item('/p/a/1.jpg', null), item('/p/b/1.jpg', null)],
      { outDir: '/web' },
      { suffix: OPT, tags: [''] },
    );
    const clashes = findCollisions(plan);
    assert.equal(clashes.length, 1);
    assert.equal(clashes[0].sources.length, 2);
  });

  test('mirroring the structure removes the collision', () => {
    const plan = planRun(
      [item('/p/a/1.jpg', '/p'), item('/p/b/1.jpg', '/p')],
      { outDir: '/web' },
      { suffix: OPT, tags: [''] },
    );
    assert.deepEqual(findCollisions(plan), []);
  });

  test('distinct names never collide', () => {
    const plan = planRun([item('/p/a.jpg'), item('/p/b.jpg')], {}, { suffix: OPT, tags: [''] });
    assert.deepEqual(findCollisions(plan), []);
  });

  test('multi-resize tags keep one input\'s outputs apart', () => {
    const plan = planRun([item('/p/a.jpg')], {}, { suffix: OPT, tags: ['.800x', '.400x'] });
    assert.equal(plan[0].outputs.length, 2);
    assert.deepEqual(findCollisions(plan), []);
  });
});

describe('clobber detection', () => {
  test('an existing output is reported so the user is warned before it is replaced', () => {
    const a = touch('a.jpg');
    touch('a.kraked.jpg');
    const plan = planRun([item(a)], {}, { suffix: OPT, tags: [''] });
    assert.deepEqual(findClobbers(plan, {}).map((c) => path.basename(c.dest)), ['a.kraked.jpg']);
  });

  test('nothing is reported when the output is new', () => {
    const a = touch('a.jpg');
    const plan = planRun([item(a)], {}, { suffix: OPT, tags: [''] });
    assert.deepEqual(findClobbers(plan, {}), []);
  });

  test('--overwrite is an explicit opt-in, so its inputs are not reported', () => {
    const a = touch('a.jpg');
    const plan = planRun([item(a)], { overwrite: true }, { suffix: OPT, tags: [''] });
    assert.deepEqual(findClobbers(plan, { overwrite: true }), []);
  });
});

describe('finalizeDest', () => {
  test('the real extension from the response wins over the predicted one', () => {
    assert.equal(finalizeDest('a.kraked.jpg', 'https://dl.kraken.io/x/a.webp', {}), 'a.kraked.webp');
  });

  test('a matching extension is left alone', () => {
    assert.equal(finalizeDest('a.kraked.jpg', 'https://dl.kraken.io/x/a.jpg', {}), 'a.kraked.jpg');
    assert.equal(finalizeDest('a.kraked.JPG', 'https://dl.kraken.io/x/a.jpg', {}), 'a.kraked.JPG');
  });

  test('--out and --overwrite paths are never rewritten', () => {
    assert.equal(finalizeDest('final.jpg', 'https://dl.kraken.io/x/a.webp', { out: 'final.jpg' }), 'final.jpg');
    assert.equal(finalizeDest('/p/a.jpg', 'https://dl.kraken.io/x/a.webp', { overwrite: true }), '/p/a.jpg');
  });

  test('a URL with no extension leaves the plan intact', () => {
    assert.equal(finalizeDest('a.kraked.jpg', 'https://dl.kraken.io/x/abc', {}), 'a.kraked.jpg');
    assert.equal(finalizeDest('a.kraked.jpg', '', {}), 'a.kraked.jpg');
  });
});


describe('a hostile API response cannot steer where files are written', () => {
  // saveOutputs falls back to composing a path from the response's result id
  // when it sees an id it did not plan for. That id is attacker-controlled if
  // the API is compromised, so it must not be able to escape the output folder.
  const compose = (outDir, base, id) =>
    path.join(outDir, path.basename(path.basename(base) + '.' + id));

  test('a traversing result id stays inside the output directory', () => {
    const dest = compose('/out/web', 'photo.kraked.jpg', '../../../../../../tmp/pwned');
    assert.equal(dest.startsWith(path.join('/out', 'web') + path.sep), true, dest);
    assert.equal(dest.includes('..'), false);
  });

  test('an absolute-looking result id cannot redirect the write', () => {
    const dest = compose('/out/web', 'photo.kraked.jpg', '/etc/cron.d/evil');
    assert.equal(dest.startsWith(path.join('/out', 'web') + path.sep), true, dest);
  });

  test('a normal resize id still composes the expected name', () => {
    assert.equal(compose('/out/web', 'photo.kraked.jpg', '800x'),
      path.join('/out/web', 'photo.kraked.jpg.800x'));
  });
});
