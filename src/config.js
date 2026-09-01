// Credential + settings store: ~/.config/krakenio/config.json (0600).
// Precedence for every value: CLI flag > env var > config file > built-in default.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// The one and only endpoint. Kraken.io is a hosted service; there is no
// self-hosted deployment to point at, so the base URL is not configurable.
export const API_HOST = 'https://api.kraken.io';

const WIN = process.platform === 'win32';

// %APPDATA% on Windows, ~/.config elsewhere.
const DIR = process.env.KRAKEN_CONFIG_DIR
  || (WIN && process.env.APPDATA
    ? path.join(process.env.APPDATA, 'krakenio')
    : path.join(os.homedir(), '.config', 'krakenio'));
export const CONFIG_FILE = path.join(DIR, 'config.json');

// Run transcripts: %LOCALAPPDATA% on Windows, $XDG_STATE_HOME (the spec's home
// for logs, default ~/.local/state) elsewhere.
export const LOG_DIR = process.env.KRAKEN_LOG_DIR
  || (WIN && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'krakenio', 'Logs')
    : path.join(
      process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'),
      'krakenio', 'logs',
    ));

// Retention: one file per day, pruned by age and then by total size, so an
// unattended cron job can never fill a disk. Both are overridable.
export const LOG_DEFAULTS = { days: 14, maxBytes: 20 * 1024 * 1024 };

const posInt = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

/**
 * Resolve the automatic-logging settings for this run.
 * Off when --no-log, KRAKEN_NO_LOG, or `"log": false` in the config file;
 * superseded by an explicit --log-file, which the caller handles.
 */
export function getLogging(opts = {}) {
  const cfg = loadConfig();
  const enabled = opts.log !== false
    && !process.env.KRAKEN_NO_LOG
    && cfg.log !== false;
  return {
    enabled,
    dir: opts.logDir || process.env.KRAKEN_LOG_DIR || cfg.log_dir || LOG_DIR,
    days: posInt(process.env.KRAKEN_LOG_DAYS ?? cfg.log_days, LOG_DEFAULTS.days),
    maxBytes: posInt(process.env.KRAKEN_LOG_MAX_BYTES ?? cfg.log_max_bytes, LOG_DEFAULTS.maxBytes),
  };
}

export function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch {
    return {};
  }
}

export function saveConfig(cfg) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* best effort (e.g. Windows) */ }
}

export function getCreds(opts = {}) {
  const cfg = loadConfig();
  return {
    api_key: opts.key || process.env.KRAKEN_API_KEY || cfg.api_key || null,
    api_secret: opts.secret || process.env.KRAKEN_API_SECRET || cfg.api_secret || null,
  };
}

// Stored cloud-storage credentials for a provider (s3|gcs|cf|azure|sl).
// S3 also honors --s3-key/--s3-secret/--s3-region and KRAKEN_S3_* env vars.
export function getStore(name, opts = {}) {
  const c = loadConfig()[name] || {};
  if (name === 's3') {
    const store = {
      key: opts.s3Key || process.env.KRAKEN_S3_KEY || c.key || null,
      secret: opts.s3Secret || process.env.KRAKEN_S3_SECRET || c.secret || null,
    };
    // `region` is only mandatory when the bucket is not in us-east-1, but
    // sending it always is harmless and avoids a class of confusing errors.
    const region = opts.s3Region || process.env.KRAKEN_S3_REGION || c.region;
    if (region) store.region = region;
    if (c.acl) store.acl = c.acl;
    return store;
  }
  return { ...c };
}

// Input formats the Kraken.io API accepts, per the public docs:
// JPG, PNG, WebP (animated), GIF (animated), SVG, AVIF, HEIC and PDF.
// Anything else is rejected server-side with 415, so folder scans skip it.
export const SUPPORTED_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.avif', '.heic', '.heif', '.pdf',
]);

// The names --types accepts, and the extensions each one covers. Keyed by what
// people actually type, so both 'jpg' and 'jpeg' work and neither needs a dot.
export const TYPE_ALIASES = {
  jpg:  ['.jpg', '.jpeg'],
  jpeg: ['.jpg', '.jpeg'],
  png:  ['.png'],
  gif:  ['.gif'],
  webp: ['.webp'],
  svg:  ['.svg'],
  avif: ['.avif'],
  heic: ['.heic', '.heif'],
  heif: ['.heic', '.heif'],
  pdf:  ['.pdf'],
};

// Shown in help and in error messages; one entry per distinct format.
export const TYPE_NAMES = ['jpg', 'png', 'gif', 'webp', 'svg', 'avif', 'heic', 'pdf'];

// What a folder scan picks up when --types is not given: images only.
//
// PDF is supported by the API but it is a document format, and a stray PDF in a
// photo directory is almost never something you meant to spend quota on — so it
// is opt-in (`--types +pdf`) rather than opt-out. Naming a PDF directly on the
// command line still works; this governs directory scans only.
export const DEFAULT_SCAN_EXTS = new Set(
  [...SUPPORTED_EXTS].filter((e) => e !== '.pdf'),
);
