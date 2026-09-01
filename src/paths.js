// Where does each result get written? Everything about input expansion and
// output naming lives here, and the whole plan is computed *before* the first
// request so conflicting flags and colliding filenames fail loudly and early
// instead of silently overwriting someone's photos.
import fs from 'node:fs';
import path from 'node:path';
import { isUrl } from './client.js';
import { SUPPORTED_EXTS, DEFAULT_SCAN_EXTS } from './config.js';
import { UsageError, predictExt, scanExts } from './params.js';

// Suffix each command stamps into the output filename.
export const SUFFIXES = { optimize: '.kraked', restore: '.restored', enhance: '.enhanced' };

// A file this CLI produced earlier. Folder scans skip these by default so a
// second run on the same directory doesn't re-optimize its own output into
// photo.kraked.kraked.jpg.
const GENERATED_RE = /\.(kraked|restored|enhanced)(\.[^.]+)*\.[^.]+$/i;
export const isGenerated = (p) => GENERATED_RE.test(path.basename(p));

function walk(dir, out, opts, exts, excluded) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { throw new UsageError(`cannot read directory '${dir}': ${e.message}`); }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue; // dotfiles and .git, node_modules stays opt-in
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full, out, opts, exts, excluded); continue; }
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!exts.has(ext)) {
      // A format the API could have handled, left out by the scan set. Counted
      // so the caller can tell the user how to opt it in, rather than dropping
      // it silently and letting them wonder where their PDFs went.
      if (SUPPORTED_EXTS.has(ext)) excluded.set(ext, (excluded.get(ext) || 0) + 1);
      continue;
    }
    if (!opts.includeGenerated && isGenerated(e.name)) continue;
    out.push(full);
  }
  return out;
}

// Expand args into work items. Each item remembers the root it came from, so
// --out-dir can mirror a folder's structure instead of flattening it.
export function resolveInputs(args, opts = {}) {
  const items = [];
  const seen = new Set();
  const skipped = [];
  const exts = opts.scanExts || scanExts(opts);
  // ext -> how many files that format the scan set left behind.
  const excluded = new Map();
  const add = (input, root) => {
    const key = isUrl(input) ? input : path.resolve(input);
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ input, root });
  };

  for (const a of args) {
    if (isUrl(a)) { add(a, null); continue; }
    let st;
    try { st = fs.statSync(a); }
    catch { skipped.push({ input: a, reason: 'not found' }); continue; }
    if (st.isDirectory()) {
      const found = walk(a, [], opts, exts, excluded);
      if (!found.length) skipped.push({ input: a, reason: 'no matching images inside' });
      for (const f of found) add(f, a);
    } else if (st.isFile()) {
      // An explicitly named file is always processed, even if it looks
      // generated or sits outside --types — the user asked for that exact file.
      if (!SUPPORTED_EXTS.has(path.extname(a).toLowerCase())) {
        skipped.push({ input: a, reason: 'unsupported file type' });
        continue;
      }
      add(a, null);
    } else {
      skipped.push({ input: a, reason: 'not a regular file' });
    }
  }
  return { items, skipped, excluded };
}

// Reject flag combinations that could only ever destroy data or contradict
// each other. Runs once, before any request.
export function assertOutputOptions(opts, items, { tagCount = 1 } = {}) {
  const n = items.length;
  const hasUrl = items.some((i) => isUrl(i.input));

  if (opts.out && opts.outDir) throw new UsageError('--out and --out-dir cannot be used together');
  if (opts.overwrite && opts.out) throw new UsageError('--overwrite and --out cannot be used together');
  if (opts.overwrite && opts.outDir) throw new UsageError('--overwrite and --out-dir cannot be used together');

  if (opts.save === false) {
    const conflicting = ['out', 'outDir', 'overwrite'].filter((k) => opts[k]);
    if (conflicting.length) {
      throw new UsageError('--no-save cannot be combined with --out, --out-dir or --overwrite');
    }
  }

  if (opts.out && n > 1) {
    throw new UsageError(
      `--out takes a single output path but ${n} inputs were given; use --out-dir <dir> instead`,
    );
  }
  if (opts.out && tagCount > 1) {
    throw new UsageError('--out cannot be used with multiple --resize sizes; use --out-dir <dir> instead');
  }
  if (opts.overwrite && tagCount > 1) {
    throw new UsageError('--overwrite cannot be used with multiple --resize sizes — one input cannot become several files');
  }
  if (opts.overwrite && hasUrl) {
    throw new UsageError('--overwrite needs local files; a URL input has nothing to overwrite');
  }
}

// The filename part of a result: photo.kraked.jpg, photo.kraked.800x-landscape.webp
export function outputName(input, { suffix, tag = '', ext }) {
  const src = isUrl(input) ? urlPathname(input) : input;
  const base = path.basename(src) || 'image';
  const stem = base.replace(/\.[^./\\]+$/, '') || 'image';
  return `${stem}${suffix}${tag}${ext}`;
}

function urlPathname(u) {
  try { return decodeURIComponent(new URL(u).pathname); } catch { return u; }
}

// Full destination for one (input, tag) pair, before the response is seen.
export function planDestination(item, opts, { suffix, tag = '', ext }) {
  const { input, root } = item;
  if (opts.out) return opts.out;
  if (opts.overwrite) return input;

  const name = outputName(input, { suffix, tag, ext });
  if (opts.outDir) {
    // Mirror the folder structure under the out-dir so photos/a/1.jpg and
    // photos/b/1.jpg don't both land on out/1.kraked.jpg.
    const sub = root && !isUrl(input) ? path.dirname(path.relative(root, input)) : '';
    return path.join(opts.outDir, sub === '.' ? '' : sub, name);
  }
  if (isUrl(input)) return name; // URLs have no local directory — use the cwd
  return path.join(path.dirname(input), name);
}

// The complete input → outputs mapping for a run.
export function planRun(items, opts, { suffix, tags = [''] }) {
  return items.map((item) => ({
    ...item,
    outputs: tags.map((tag) => ({
      tag,
      dest: planDestination(item, opts, { suffix, tag, ext: predictExt(displaySource(item.input), opts) }),
    })),
  }));
}

const displaySource = (input) => (isUrl(input) ? urlPathname(input) : input);

// Two inputs planning to write the same file would silently destroy one of the
// results. Refuse the whole run rather than produce a half-wrong output set.
export function findCollisions(plan) {
  const byDest = new Map();
  for (const p of plan) {
    for (const o of p.outputs) {
      const key = path.resolve(o.dest);
      if (!byDest.has(key)) byDest.set(key, []);
      byDest.get(key).push(p.input);
    }
  }
  return [...byDest.entries()]
    .filter(([, sources]) => sources.length > 1)
    .map(([dest, sources]) => ({ dest, sources }));
}

// Outputs that would replace a file already on disk. `--overwrite` opts into
// exactly this for the inputs themselves, so those are not reported.
export function findClobbers(plan, opts) {
  if (opts.overwrite) return [];
  const hits = [];
  for (const p of plan) {
    for (const o of p.outputs) {
      if (fs.existsSync(o.dest)) hits.push({ dest: o.dest, input: p.input });
    }
  }
  return hits;
}

// The API decides the real extension (a convert may or may not have applied),
// so swap it in at write time while keeping the planned directory and stem.
export function finalizeDest(planned, krakedUrl, opts) {
  if (opts.out || opts.overwrite || !krakedUrl) return planned;
  let actual = '';
  try { actual = path.extname(new URL(krakedUrl).pathname); } catch { /* keep the plan */ }
  if (!actual) return planned;
  const current = path.extname(planned);
  if (current.toLowerCase() === actual.toLowerCase()) return planned;
  return planned.slice(0, planned.length - current.length) + actual;
}
