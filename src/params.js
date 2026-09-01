// Turns CLI flags into a Kraken.io API request body, validating everything the
// docs constrain *before* spending a request (and a slice of quota) on it.
import fs from 'node:fs';
import path from 'node:path';
import { getStore, TYPE_ALIASES, TYPE_NAMES, SUPPORTED_EXTS, DEFAULT_SCAN_EXTS } from './config.js';

// Thrown for anything the user can fix by re-typing the command. bin/krakenio.js
// prints these without a stack trace and exits 2.
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

// ─── documented value sets ──────────────────────────────────────────────────
// https://kraken.io/docs/image-resizing
export const RESIZE_STRATEGIES = ['exact', 'portrait', 'landscape', 'auto', 'fit', 'crop', 'square', 'fill'];
// https://kraken.io/docs/image-type-conversion
export const CONVERT_FORMATS = ['jpeg', 'png', 'gif', 'webp', 'avif'];
// https://kraken.io/docs/preserving-metadata
export const META_FIELDS = ['profile', 'date', 'copyright', 'geotag', 'orientation'];
// https://kraken.io/docs/chroma-subsampling
export const SAMPLING_SCHEMES = ['4:2:0', '4:2:2', '4:4:4'];

/**
 * Parse --types into the set of extensions a folder scan should pick up.
 *
 * Two styles, deliberately not mixable:
 *   --types jpg,png    an exact set — only these formats are scanned
 *   --types +pdf       the default set plus these
 *   --types all        every format the API accepts
 *
 * Mixing them ('jpg,+pdf') is ambiguous about whether the defaults survive, so
 * it is refused rather than guessed at. Returns null when --types was not
 * given, meaning "use the default set".
 */
export function parseTypes(spec) {
  if (spec == null || spec === '') return null;
  const raw = String(spec).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (!raw.length) throw new UsageError('--types needs at least one format, e.g. --types jpg,png');

  const additive = raw.filter((t) => t.startsWith('+'));
  if (additive.length && additive.length !== raw.length) {
    throw new UsageError(
      "--types cannot mix '+format' with a plain list: use '--types +pdf' to add to the "
      + "defaults, or '--types jpg,png,pdf' to set the list exactly.",
    );
  }

  const out = additive.length ? new Set(DEFAULT_SCAN_EXTS) : new Set();
  for (const entry of raw) {
    const name = (additive.length ? entry.slice(1) : entry).replace(/^\./, '');
    if (!name) throw new UsageError("--types got an empty format name (a stray '+' or ',')");
    if (name === 'all') { for (const e of SUPPORTED_EXTS) out.add(e); continue; }
    const exts = TYPE_ALIASES[name];
    if (!exts) {
      throw new UsageError(
        `unknown format for --types: '${name}'. Supported: ${TYPE_NAMES.join(', ')} (or 'all').`,
      );
    }
    for (const e of exts) out.add(e);
  }
  return out;
}

/** Extension set a folder scan should use for this run. */
export function scanExts(opts = {}) {
  return parseTypes(opts.types) || DEFAULT_SCAN_EXTS;
}

const oneOf = (list) => list.join(', ');

// ─── scalar parsing ─────────────────────────────────────────────────────────

export function toInt(value, flag, { min = -Infinity, max = Infinity } = {}) {
  const s = String(value).trim();
  if (!/^-?\d+$/.test(s)) throw new UsageError(`${flag} must be a whole number, got '${value}'`);
  const n = Number(s);
  if (n < min || n > max) throw new UsageError(`${flag} must be between ${min} and ${max}, got ${n}`);
  return n;
}

export function toFloat(value, flag, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(String(value).trim());
  if (!Number.isFinite(n)) throw new UsageError(`${flag} must be a number, got '${value}'`);
  if (n < min || n > max) throw new UsageError(`${flag} must be between ${min} and ${max}, got ${n}`);
  return n;
}

// ─── resize ─────────────────────────────────────────────────────────────────

// "800x600" | "800x600,fit" | "800x" (width only) | "x600" (height only)
// | "400,square" | "400x400,square" (the square strategy takes one number)
export function parseResize(spec) {
  const raw = String(spec).trim();
  const [dims, strategy, ...extra] = raw.split(',');
  if (extra.length) throw new UsageError(`--resize '${raw}' has too many parts; expected WxH[,strategy]`);

  let s = null;
  if (strategy != null && strategy.trim() !== '') {
    s = strategy.trim().toLowerCase();
    if (!RESIZE_STRATEGIES.includes(s)) {
      throw new UsageError(`unknown resize strategy '${s}'. One of: ${oneOf(RESIZE_STRATEGIES)}`);
    }
  }

  const parts = dims.split(/x/i).map((p) => p.trim());
  if (parts.length > 2) throw new UsageError(`--resize '${raw}' must look like 800x600, 800x or x600`);

  // `square` crops to a square and takes a single `size`, not a width/height
  // pair — sending width/height gets a 422 back from the API.
  if (s === 'square') {
    const given = parts.filter(Boolean);
    if (given.length === 2 && given[0] !== given[1]) {
      throw new UsageError(`the 'square' strategy takes one size, but '${raw}' gives two different ones`);
    }
    if (given.length === 0) throw new UsageError(`--resize '${raw}' needs a size, e.g. 400,square`);
    return { strategy: 'square', size: toInt(given[0], `--resize size in '${raw}'`, { min: 1, max: 100000 }) };
  }

  if (parts.length !== 2) throw new UsageError(`--resize '${raw}' must look like 800x600, 800x or x600`);
  const [w, h] = parts;
  if (!w && !h) throw new UsageError(`--resize '${raw}' needs a width, a height, or both`);

  const r = {};
  if (w) r.width = toInt(w, `--resize width in '${raw}'`, { min: 1, max: 100000 });
  if (h) r.height = toInt(h, `--resize height in '${raw}'`, { min: 1, max: 100000 });

  // The API requires a strategy on every entry of a resize *set*, and leaving
  // it off a single resize is ambiguous. Infer the one that matches what the
  // dimensions asked for: a lone width means "this wide, keep the ratio".
  r.strategy = s ?? (r.width && r.height ? 'auto' : r.width ? 'landscape' : 'portrait');

  // The dimension-hungry strategies genuinely need both numbers server-side.
  if (['exact', 'fit', 'crop', 'fill', 'auto'].includes(r.strategy) && !(r.width && r.height)) {
    throw new UsageError(`resize strategy '${r.strategy}' needs both a width and a height (got '${raw}')`);
  }
  return r;
}

// Multi-resize needs a unique id per entry (https://kraken.io/docs/generating-image-sets).
// The id doubles as the filename tag, so keep it readable: "1920x1080-fit".
function resizeId(r, taken) {
  const dims = r.size != null ? String(r.size) : `${r.width || ''}x${r.height || ''}`;
  const base = `${dims}${r.strategy ? '-' + r.strategy : ''}`;
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  taken.add(id);
  return id;
}

export function buildResize(specs) {
  const list = [].concat(specs || []).filter((s) => s != null && s !== '');
  if (list.length === 0) return null;
  if (list.length === 1) return parseResize(list[0]);
  const taken = new Set();
  return list.map((s) => {
    const r = parseResize(s);
    r.id = resizeId(r, taken);
    return r;
  });
}

// ─── convert ────────────────────────────────────────────────────────────────

export function parseConvert(spec) {
  const [format, background, ...extra] = String(spec).split(',');
  if (extra.length) throw new UsageError(`--convert '${spec}' has too many parts; expected format[,background]`);
  const f = String(format).trim().toLowerCase();
  const normalized = f === 'jpg' ? 'jpeg' : f;
  if (!CONVERT_FORMATS.includes(normalized)) {
    throw new UsageError(`cannot convert to '${f}'. One of: ${oneOf(CONVERT_FORMATS)}`);
  }
  const cv = { format: normalized };
  if (background != null && background.trim() !== '') cv.background = background.trim();
  return cv;
}

// ─── external storage ───────────────────────────────────────────────────────

// Every Kraken.io storage provider, data-driven. `container` is the name of the
// bucket/container key in that provider's *_store object; `required` lists the
// credential fields the docs mark mandatory.
export const PROVIDERS = {
  s3: { store: 's3_store', container: 'bucket', label: 'Amazon S3', required: ['key', 'secret'], setup: 'config set-s3 <key> <secret> [region]' },
  gcs: { store: 'gcs_store', container: 'bucket', label: 'Google Cloud Storage', required: ['credentials'], setup: `config set-store gcs '{"credentials":"@sa.json"}'` },
  cf: { store: 'cf_store', container: 'container', label: 'Rackspace Cloud Files', required: ['user', 'key'], setup: `config set-store cf '{"user":"…","key":"…"}'` },
  azure: { store: 'azure_store', container: 'container', label: 'Azure Blob Storage', required: ['account', 'key'], setup: `config set-store azure '{"account":"…","key":"…"}'` },
  sl: { store: 'sl_store', container: 'container', label: 'SoftLayer Object Storage', required: ['user', 'key', 'region'], setup: `config set-store sl '{"user":"…","key":"…","region":"…"}'` },
};

// Kraken's `path` is the *full* destination key, filename included — not a
// directory prefix. So "bucket/thumbs/" + a.jpg becomes "thumbs/a.jpg", and a
// batch no longer piles every image onto one object. A spec whose last segment
// carries an extension is taken literally (single input only).
export function splitStorageTarget(spec, flag) {
  const raw = String(spec).trim().replace(/^\/+/, '');
  if (!raw) throw new UsageError(`${flag} needs a bucket or container name`);
  const [container, ...rest] = raw.split('/');
  if (!container) throw new UsageError(`${flag} needs a bucket or container name`);
  const tail = rest.join('/');
  const last = rest[rest.length - 1] || '';
  const exact = tail !== '' && /\.[A-Za-z0-9]+$/.test(last);
  return {
    container,
    prefix: exact ? tail.slice(0, tail.length - last.length) : tail === '' ? '' : tail.replace(/\/*$/, '/'),
    exactPath: exact ? tail : null,
  };
}

// `credentials` may be inline JSON or "@/path/to/service-account.json".
function resolveCredentials(creds) {
  if (typeof creds.credentials === 'string' && creds.credentials.startsWith('@')) {
    const file = creds.credentials.slice(1);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) { throw new UsageError(`could not read Google credentials file '${file}': ${e.message}`); }
    try { return { ...creds, credentials: JSON.parse(text) }; }
    catch { throw new UsageError(`'${file}' is not valid JSON`); }
  }
  return creds;
}

// Which providers a command actually asked for, validated once up-front so a
// batch fails before the first request rather than on file 1 of 400.
export function selectedProviders(o) {
  return Object.keys(PROVIDERS).filter((name) => o[name]);
}

export function assertStorageUsable(o) {
  for (const name of selectedProviders(o)) {
    const def = PROVIDERS[name];
    splitStorageTarget(o[name], `--${name}`);
    const creds = getStore(name, o);
    const missing = def.required.filter((f) => !creds[f]);
    if (missing.length) {
      throw new UsageError(
        `${def.label}: missing ${missing.join(', ')}. Run \`krakenio ${def.setup}\`.`,
      );
    }
    resolveCredentials(creds);
  }
  if (o.store) parseRawStore(o.store);
}

function parseRawStore(raw) {
  let text = raw;
  if (text.startsWith('@')) {
    const file = text.slice(1);
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) { throw new UsageError(`could not read --store file '${file}': ${e.message}`); }
  }
  let obj;
  try { obj = JSON.parse(text); }
  catch { throw new UsageError('--store must be a JSON object or @file.json'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new UsageError('--store must be a JSON object');
  return obj;
}

// `outName` is the filename this particular input will produce, used to build a
// unique object key per image.
export function buildStorage(o, { outName = '' } = {}) {
  const store = {};
  for (const name of selectedProviders(o)) {
    const def = PROVIDERS[name];
    const { container, prefix, exactPath } = splitStorageTarget(o[name], `--${name}`);
    const creds = resolveCredentials(getStore(name, o));
    const obj = { ...creds, [def.container]: container };
    const key = exactPath || (outName ? prefix + outName : prefix.replace(/\/*$/, ''));
    if (key) obj.path = key;
    store[def.store] = obj;
  }
  if (o.store) Object.assign(store, parseRawStore(o.store));
  return store;
}

// ─── request bodies ─────────────────────────────────────────────────────────

export function buildOptimizeParams(o, { outName = '' } = {}) {
  const p = {};
  if (o.lossy) p.lossy = true;
  if (o.quality != null) p.quality = toInt(o.quality, '--quality', { min: 1, max: 100 });
  if (o.convert) p.convert = parseConvert(o.convert);
  if (o.keepExtension) {
    if (!p.convert) throw new UsageError('--keep-extension only applies together with --convert');
    p.convert.keep_extension = true;
  }
  if (o.autoOrient) p.auto_orient = true;
  if (o.samplingScheme) {
    const s = String(o.samplingScheme).trim();
    if (!SAMPLING_SCHEMES.includes(s)) {
      throw new UsageError(`unknown --sampling-scheme '${s}'. One of: ${oneOf(SAMPLING_SCHEMES)}`);
    }
    p.sampling_scheme = s;
  }
  if (o.preserveMeta) {
    const fields = String(o.preserveMeta).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const bad = fields.filter((f) => !META_FIELDS.includes(f));
    if (bad.length) throw new UsageError(`unknown --preserve-meta value(s): ${bad.join(', ')}. One of: ${oneOf(META_FIELDS)}`);
    if (!fields.length) throw new UsageError('--preserve-meta needs at least one field');
    p.preserve_meta = fields;
  }
  if (o.dev) p.dev = true;
  const resize = buildResize(o.resize);
  if (resize) p.resize = resize;
  Object.assign(p, buildStorage(o, { outName }));
  return p;
}

// ─── AI restoration (endpoint not public yet — see src/commands.js) ─────────
// Kept complete and tested so enabling the feature is a one-line change once
// the endpoint ships.

export function buildRestoreParams(o, { outName = '' } = {}) {
  const r = {};
  if (o.strategy) r.strategy = String(o.strategy).trim().toLowerCase();
  if (o.scale != null) r.scale = toInt(o.scale, '--scale', { min: 2, max: 4 });
  if (o.width != null) r.width = toInt(o.width, '--width', { min: 1, max: 100000 });
  if (o.height != null) r.height = toInt(o.height, '--height', { min: 1, max: 100000 });
  if (o.denoise != null) r.denoise = toFloat(o.denoise, '--denoise', { min: 0, max: 1 });
  if (o.strength != null) r.strength = toFloat(o.strength, '--strength', { min: 0, max: 1 });
  const params = { restore: Object.keys(r).length ? r : true };
  if (o.dev) params.dev = true;
  Object.assign(params, buildStorage(o, { outName }));
  return params;
}

// enhance = ONE request that AI-restores (smart strategy) and then optimizes
// (lossy). Restore settings nest under `restore`; optimize settings stay
// top-level and the API chains them server-side.
export function buildEnhanceParams(o, { outName = '' } = {}) {
  const r = { strategy: 'smart' };
  if (o.strength != null) r.strength = toFloat(o.strength, '--strength', { min: 0, max: 1 });
  if (o.scale != null) r.scale = toInt(o.scale, '--scale', { min: 2, max: 4 });
  if (o.width != null) r.width = toInt(o.width, '--width', { min: 1, max: 100000 });
  if (o.height != null) r.height = toInt(o.height, '--height', { min: 1, max: 100000 });
  const p = { restore: r, lossy: true };
  if (o.quality != null) p.quality = toInt(o.quality, '--quality', { min: 1, max: 100 });
  if (o.convert) p.convert = parseConvert(o.convert);
  if (o.dev) p.dev = true;
  Object.assign(p, buildStorage(o, { outName }));
  return p;
}

// The extension an output will end up with, known before the request is sent.
// Used to plan (and collision-check) destination paths up-front.
export function predictExt(input, o) {
  const current = path.extname(input.replace(/[?#].*$/, '')) || '.img';
  if (!o.convert) return current;
  const { format } = parseConvert(o.convert);
  if (o.keepExtension) return current;
  return format === 'jpeg' ? '.jpg' : `.${format}`;
}
