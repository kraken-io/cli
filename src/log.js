// Two ways to get a run out of the terminal and into a file:
//
//   --log-file <path>  a timestamped, colour-free transcript of everything the
//                      CLI printed, plus the request/response detail that -V
//                      shows. Written even when the run fails, so it is the
//                      thing to attach to a bug report.
//   --report <path>    one machine-readable row per image (.json or .csv):
//                      what went in, what came out, how big, and why it failed.
//
// Both are append-safe and never take the run down with them: if the log file
// cannot be written we warn once and carry on optimizing.
import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
export const stripAnsi = (s) => String(s).replace(ANSI, '');

// Flags whose value is a credential. The command line is recorded at the top of
// every transcript, so anything passed this way must be redacted before it is
// written — a log is a file that outlives the shell it was typed in.
const SECRET_FLAGS = new Set(['--key', '--secret', '--s3-key', '--s3-secret', '--store']);

/**
 * Redact credential values from an argv slice, keeping the shape of the command
 * so the transcript still shows what was run.
 *
 *   --secret abc123        ->  --secret ***
 *   --key=abc123           ->  --key=***
 *   --store '{"s3_store"…' ->  --store ***
 *   --store @creds.json    ->  --store @creds.json   (a path, not a secret)
 */
export function redactArgv(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!SECRET_FLAGS.has(name)) { out.push(arg); continue; }

    const keep = (v) => v.startsWith('@'); // @file references are paths, not secrets
    if (eq !== -1) {
      out.push(keep(arg.slice(eq + 1)) ? arg : `${name}=***`);
      continue;
    }
    out.push(arg);
    // The value is the next token, unless the flag was given with none.
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('-')) {
      out.push(keep(next) ? next : '***');
      i++;
    }
  }
  return out;
}

export class RunLog {
  constructor(file) {
    this.file = path.resolve(file);
    this.broken = false;
    // Transcripts carry file paths and live result URLs, so they get the same
    // treatment as the credential store: owner-only. `mode` applies on creation,
    // so tighten explicitly too — but only for a file we created ourselves,
    // never one the user pointed --log-file at.
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const existed = fs.existsSync(this.file);
    this.fd = fs.openSync(this.file, 'a', 0o600);
    if (!existed) {
      try { fs.chmodSync(this.file, 0o600); } catch { /* best effort (e.g. Windows) */ }
    }
  }

  write(level, message) {
    if (this.broken) return;
    const stamp = new Date().toISOString();
    const text = stripAnsi(message).replace(/\s+$/, '');
    try {
      fs.writeSync(this.fd, `${stamp}  ${level.toUpperCase().padEnd(5)} ${text}\n`);
    } catch {
      this.broken = true; // a full disk shouldn't abort the images
    }
  }

  close() {
    if (this.fd == null) return;
    try { fs.closeSync(this.fd); } catch { /* already gone */ }
    this.fd = null;
  }
}

// ─── the default log directory ───────────────────────────────────────────────
//
// Every run appends to one file per day. That keeps a nightly job's history in
// one place while still being trivially prunable, and it is the shape logrotate
// and friends expect.

const DAILY_RE = /^krakenio-(\d{4}-\d{2}-\d{2})\.log$/;

export const dailyLogName = (date = new Date()) =>
  `krakenio-${date.toISOString().slice(0, 10)}.log`;

export const dailyLogFile = (dir, date = new Date()) => path.join(dir, dailyLogName(date));

/**
 * Delete old transcripts: anything older than `days`, then oldest-first until
 * the directory fits in `maxBytes`. The current day's file is never removed.
 *
 * Returns the names it deleted. Never throws — pruning is housekeeping, and a
 * read-only or missing directory must not take a run down.
 */
export function pruneLogs(dir, { days, maxBytes, now = new Date() } = {}) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }

  const files = [];
  for (const name of names) {
    const m = DAILY_RE.exec(name);
    if (!m) continue;
    // The date is in the filename, so pruning never depends on mtime — copying
    // or restoring a log directory doesn't reset its age.
    const day = Date.parse(m[1] + 'T00:00:00Z');
    if (Number.isNaN(day)) continue;
    let size = 0;
    try { size = fs.statSync(path.join(dir, name)).size; } catch { continue; }
    files.push({ name, day, size });
  }
  files.sort((a, b) => a.day - b.day); // oldest first

  const today = dailyLogName(now);
  const removed = [];
  const drop = (f) => {
    if (f.name === today) return false;
    try { fs.unlinkSync(path.join(dir, f.name)); } catch { return false; }
    removed.push(f.name);
    return true;
  };

  const keepAfter = Date.parse(now.toISOString().slice(0, 10) + 'T00:00:00Z') - days * 86400000;
  const survivors = [];
  for (const f of files) {
    if (days > 0 && f.day < keepAfter && drop(f)) continue;
    survivors.push(f);
  }

  if (maxBytes > 0) {
    let total = survivors.reduce((n, f) => n + f.size, 0);
    for (const f of survivors) {
      if (total <= maxBytes) break;
      if (drop(f)) total -= f.size;
    }
  }
  return removed;
}

// ─── reading the log directory back ─────────────────────────────────────────

// Each run opens with the command line it was invoked as, so counting those
// lines counts runs. Levels are written by RunLog.write and padded to 5.
const RUN_RE = /^\S+\s+INFO\s+krakenio\s/;
const LEVEL_RE = /^(\S+)\s{2}([A-Z]+)\s{1,}(.*)$/;

/** Every daily transcript in `dir`, newest first, with a summary of each. */
export function listLogs(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }

  const out = [];
  for (const name of names) {
    const m = DAILY_RE.exec(name);
    if (!m) continue;
    const file = path.join(dir, name);
    let size, body;
    try {
      size = fs.statSync(file).size;
      body = fs.readFileSync(file, 'utf8');
    } catch { continue; }
    let runs = 0, errors = 0;
    for (const line of body.split('\n')) {
      if (RUN_RE.test(line)) runs++;
      else if (/^\S+\s+ERROR\s/.test(line)) errors++;
    }
    out.push({ name, date: m[1], file, size, runs, errors });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Read one transcript back.
 *   errorsOnly  keep only ERROR lines
 *   grep        keep lines matching this (case-insensitive) substring
 *   tail        keep only the last N lines, applied after filtering
 */
export function readLog(file, { errorsOnly = false, grep = '', tail = 0 } = {}) {
  let body;
  try { body = fs.readFileSync(file, 'utf8'); }
  catch { return null; }

  let lines = body.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (errorsOnly) lines = lines.filter((l) => /^\S+\s+ERROR\s/.test(l));
  if (grep) {
    const needle = grep.toLowerCase();
    lines = lines.filter((l) => l.toLowerCase().includes(needle));
  }
  if (tail > 0) lines = lines.slice(-tail);
  return lines;
}

/** Split a transcript line into its parts, for colourised display. */
export function parseLogLine(line) {
  const m = LEVEL_RE.exec(line);
  if (!m) return { stamp: null, level: null, text: line };
  return { stamp: m[1], level: m[2], text: m[3] };
}

// ─── report ─────────────────────────────────────────────────────────────────

// One row per (input, output). `outputs` is flattened so a multi-resize image
// contributes one row per size.
export function buildReport(results, meta = {}) {
  const rows = [];
  for (const r of results) {
    const outs = r.raw?.results
      ? Object.entries(r.raw.results).map(([id, res]) => ({ id, res }))
      : [{ id: null, res: r.raw || {} }];
    // saveOutputs tags each written file with the resize id it belongs to, so
    // rows stay correct even when some sizes failed to download.
    const savedByTag = new Map((r.saved || []).map((s) => [s.tag ?? '', s]));
    outs.forEach((o) => {
      const saved = savedByTag.get(o.id == null ? '' : '.' + o.id);
      rows.push({
        input: r.input,
        size_id: o.id,
        status: r.ok ? 'ok' : 'error',
        error: r.ok ? null : (r.error ?? null),
        original_size: o.res.original_size ?? null,
        kraked_size: o.res.kraked_size ?? null,
        saved_bytes: o.res.saved_bytes
          ?? (o.res.original_size != null && o.res.kraked_size != null
            ? Math.max(0, o.res.original_size - o.res.kraked_size)
            : null),
        kraked_width: o.res.kraked_width ?? null,
        kraked_height: o.res.kraked_height ?? null,
        kraked_url: o.res.kraked_url ?? null,
        saved_to: saved?.dest ?? null,
        http_status: r.raw?._status ?? null,
        duration_ms: r.raw?._ms ?? null,
      });
    });
  }
  return { ...meta, generated_at: new Date().toISOString(), total: rows.length, rows };
}

const CSV_COLUMNS = [
  'input', 'size_id', 'status', 'error', 'original_size', 'kraked_size', 'saved_bytes',
  'kraked_width', 'kraked_height', 'kraked_url', 'saved_to', 'http_status', 'duration_ms',
];

export function toCsv(report) {
  const cell = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of report.rows) lines.push(CSV_COLUMNS.map((k) => cell(row[k])).join(','));
  return lines.join('\n') + '\n';
}

// Format is chosen by extension; .csv gets CSV, anything else gets JSON.
export function writeReport(file, report) {
  const full = path.resolve(file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const body = path.extname(full).toLowerCase() === '.csv'
    ? toCsv(report)
    : JSON.stringify(report, null, 2) + '\n';
  fs.writeFileSync(full, body);
  return full;
}
