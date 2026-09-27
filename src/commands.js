import fs from 'node:fs';
import path from 'node:path';
import { KrakenClient, isUrl, describeError } from './client.js';
import { getCreds, loadConfig, saveConfig, CONFIG_FILE, API_HOST, getLogging } from './config.js';
import {
  UsageError, PROVIDERS, buildOptimizeParams, buildRestoreParams, buildEnhanceParams,
  buildResize, assertStorageUsable, toInt,
  scanExts,
} from './params.js';
import {
  SUFFIXES, resolveInputs, assertOutputOptions, planRun, findCollisions, findClobbers, finalizeDest,
} from './paths.js';
import {
  c as pc, spinner, printResult, printSaved, printQuota, fmtBytes,
  ok, info, warn, fail, prompt, confirm, vlog, maskAuth, batchLine, printBatchSummary, notice,
  setLogSink,
} from './ui.js';
import {
  RunLog, buildReport, writeReport, dailyLogFile, dailyLogName,
  pruneLogs, listLogs, readLog, parseLogLine, redactArgv,
} from './log.js';
import { printBanner } from './logo.js';
import { createRequire } from 'node:module';

const VERSION = createRequire(import.meta.url)('../package.json').version;

// ─── availability ───────────────────────────────────────────────────────────

// AI restoration (`restore` / `enhance`) is built and tested end-to-end, but
// the /v1/*/restore endpoints are not part of the public Kraken.io API yet.
// Rather than let the commands fail against a 404 mid-batch — after the
// confirmation prompt, with a quota estimate already printed — they refuse up
// front. Flip this to `true` when the endpoints ship; nothing else changes.
export const RESTORE_AVAILABLE = false;

export class UnavailableError extends Error {
  constructor(command, detail) {
    super(`\`krakenio ${command}\` is not available in this release`);
    this.name = 'UnavailableError';
    this.detail = detail;
  }
}

function assertAvailable(command) {
  if (RESTORE_AVAILABLE) return;
  throw new UnavailableError(command, [
    'AI image restoration is not part of the public Kraken.io API yet, so this',
    'command is disabled instead of failing against an endpoint that will not',
    'answer. It will be enabled in a future release — no flags will change.',
    '',
    `Available today: ${pc.bold('krakenio optimize')} — compress, convert and resize.`,
  ]);
}

// ─── helpers ────────────────────────────────────────────────────────────────

function buildClient(opts) {
  const { api_key, api_secret } = getCreds(opts);
  if (!api_key || !api_secret) {
    throw new UsageError(
      'no API credentials. Run `krakenio login`, or set KRAKEN_API_KEY and KRAKEN_API_SECRET.',
    );
  }
  const timeout = (opts.timeout != null ? toInt(opts.timeout, '--timeout', { min: 5, max: 3600 }) : 120) * 1000;
  return new KrakenClient({ host: API_HOST, auth: { api_key, api_secret }, timeout });
}

const mask = (s) => (s.length > 8 ? s.slice(0, 4) + '…' + s.slice(-3) : '••••');
const rel = (p) => {
  const r = path.relative(process.cwd(), p);
  return !r || r.startsWith('..') ? p : r;
};
// Show the path, not just the basename: a recursive folder scan routinely turns
// up several files called a.jpg, and "a.jpg  ✓" three times tells you nothing.
const displayName = (input) => (isUrl(input) ? input : rel(input));

async function pool(items, concurrency, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await worker(items[idx], idx); }
  });
  await Promise.all(runners);
}

// Totals for the batch summary. In an image set every entry repeats the *same*
// original_size, so summing it would report a 4500×3000 photo as 3× its weight
// and inflate the savings percentage. Count the input once, the outputs each.
function inputBytes(raw) {
  if (!raw?.results) return raw?.original_size || 0;
  return Object.values(raw.results)[0]?.original_size || 0;
}

function outputBytes(raw) {
  if (!raw?.results) return raw?.kraked_size || 0;
  return Object.values(raw.results).reduce((a, r) => a + (r.kraked_size || 0), 0);
}

// ─── one image ──────────────────────────────────────────────────────────────

function paramsFor(entry, opts, ctx, outName) {
  const build = ctx.enhance ? buildEnhanceParams : ctx.restore ? buildRestoreParams : buildOptimizeParams;
  return build(opts, { outName });
}

async function saveOutputs(client, entry, raw, opts) {
  // The response is either one result or a `results` map keyed by resize id.
  const byTag = new Map(entry.outputs.map((o) => [o.tag, o]));
  // Resize ids are ours (buildResize generates them); anything else in the
  // response is not something to build a filesystem path out of.
  const SAFE_ID = /^[A-Za-z0-9._-]+$/;
  const targets = raw.results
    ? Object.entries(raw.results)
      .filter(([id]) => {
        if (SAFE_ID.test(id)) return true;
        warn(`ignoring unexpected result id from the API: ${JSON.stringify(id)}`);
        return false;
      })
      .map(([id, res]) => ({ res, tag: '.' + id }))
    : [{ res: raw, tag: entry.outputs[0]?.tag ?? '' }];

  const saved = [];
  const skipped = [];
  for (const { res, tag } of targets) {
    if (!res.kraked_url) continue;
    const planned = byTag.get(tag)?.dest
      // A resize id we didn't plan for (shouldn't happen, but never drop a
      // result). The id comes from the response, so it is not allowed to steer
      // where we write: basename() strips any separators it tries to smuggle in.
      ?? path.join(opts.outDir || (isUrl(entry.input) ? '' : path.dirname(entry.input)),
        path.basename(path.basename(entry.outputs[0]?.dest || 'image') + tag));
    const dest = finalizeDest(planned, res.kraked_url, opts);
    if (opts.clobber === false && fs.existsSync(dest)) { skipped.push(dest); continue; }
    const bytes = await client.download(res.kraked_url, dest);
    saved.push({ dest, bytes, tag });
  }
  return { saved, skipped };
}

// One request + optional download. Returns data; never throws.
async function runOne(client, entry, opts, ctx) {
  const outName = path.basename(entry.outputs[0]?.dest || '');
  let params;
  try { params = paramsFor(entry, opts, ctx, outName); }
  catch (e) { return { ...entry, ok: false, error: e.message }; }

  // vlog prints only under -V but always mirrors into the transcript, so a log
  // carries the request/response detail whether or not the run was verbose —
  // which is the whole point of having one to attach to a bug report.
  // Credentials are masked on the way in either direction.
  const ep = isUrl(entry.input)
    ? (ctx.restore ? '/v1/url/restore' : '/v1/url')
    : (ctx.restore ? '/v1/upload/restore' : '/v1/upload');
  const shown = { ...params, ...(isUrl(entry.input) ? { url: entry.input } : { file: path.basename(entry.input) }) };
  vlog(ctx.verbose, `POST ${client.host}${ep}`);
  vlog(ctx.verbose, JSON.stringify(maskAuth({ auth: client.auth, wait: true, ...shown })));

  const raw = await client.run(entry.input, { restore: ctx.restore, params, wait: true });
  vlog(ctx.verbose, `← HTTP ${raw._status} in ${raw._ms ?? '?'}ms`);
  if (!raw.success) return { ...entry, ok: false, error: describeError(raw), raw };

  if (opts.save === false) return { ...entry, ok: true, raw, saved: [], skipped: [] };
  try {
    const { saved, skipped } = await saveOutputs(client, entry, raw, opts);
    return { ...entry, ok: true, raw, saved, skipped };
  } catch (e) {
    // The sandbox returns a placeholder result URL that serves nothing, so a
    // failed download there is expected rather than a problem to chase.
    const saveError = opts.dev
      ? 'sandbox results are not downloadable (--dev returns a placeholder URL)'
      : e.message;
    return { ...entry, ok: true, raw, saved: [], skipped: [], saveError };
  }
}

// ─── single input ───────────────────────────────────────────────────────────

async function executeSingle(client, entry, opts, ctx) {
  const label = ctx.enhance ? 'Enhancing' : ctx.restore ? 'Restoring' : 'Optimizing';
  const sp = opts.json || opts.quiet ? null : spinner(`${label} ${pc.bold(displayName(entry.input))} …`);
  const res = await runOne(client, entry, opts, ctx);
  if (sp) sp.stop();

  if (opts.json) {
    console.log(JSON.stringify(res.raw ?? { success: false, error: res.error }, null, 2));
    if (!res.ok) process.exitCode = 1;
    return [res];
  }
  if (!res.ok) { fail(res.error); return [res]; }

  if (res.raw.results) {
    const ids = Object.entries(res.raw.results);
    console.log('\n  ' + pc.green(pc.bold(`✔ ${ids.length} outputs`)));
    for (const [id, r] of ids) {
      const dims = r.kraked_width ? `${r.kraked_width}×${r.kraked_height}  ` : '';
      const sz = r.kraked_size != null ? fmtBytes(r.kraked_size) + '  ' : '';
      console.log('  ' + pc.dim(id.padEnd(14)) + dims + sz + pc.cyan(r.kraked_url || ''));
    }
  } else {
    printResult(res.raw, { restored: ctx.restore || ctx.enhance });
  }
  for (const s of res.saved) printSaved(rel(s.dest), s.bytes);
  for (const s of res.skipped) info(`kept existing ${pc.bold(rel(s))} ${pc.dim('(--no-clobber)')}`);
  if (res.saveError) {
    warn('result is on Kraken.io, but the local download failed: ' + res.saveError);
    process.exitCode = 1;
  }
  if (opts.save === false && !res.raw.results && res.raw.kraked_url) {
    info(pc.dim('results stay on Kraken.io for one hour only'));
  }
  if (opts.quota !== false && !opts.quiet) { try { printQuota(await client.status()); } catch { /* quota is a nicety */ } }
  return [res];
}

// ─── batch ──────────────────────────────────────────────────────────────────

async function executeBatch(client, plan, opts, ctx) {
  const n = plan.length;
  let remaining = null;
  try { const s = await client.status(); if (s.success) remaining = s.quota_remaining; } catch { /* offline is fine */ }

  // Kraken bills quota in bytes of input data. URL inputs are unknown until
  // fetched; enhance is billed as two operations (restore + optimize).
  let estBytes = 0, urls = 0;
  for (const p of plan) {
    if (isUrl(p.input)) { urls++; continue; }
    try { estBytes += fs.statSync(p.input).size; } catch { /* counted as unknown */ }
  }
  if (ctx.enhance) estBytes *= 2;

  const verb = ctx.enhance ? 'enhance' : ctx.restore ? 'restore' : 'optimize';
  console.log();
  info(`${pc.bold(n)} image${n > 1 ? 's' : ''} to ${verb}`);
  plan.slice(0, 8).forEach((p) => console.log('    ' + pc.dim('• ' + displayName(p.input))));
  if (n > 8) console.log('    ' + pc.dim(`… and ${n - 8} more`));
  console.log();

  if (opts.dev) {
    info('Sandbox mode — no quota is used and the returned images are randomized, not real optimizations.');
  } else {
    let line = `Will use roughly ${pc.bold(fmtBytes(estBytes))} of quota`;
    if (ctx.enhance) line += pc.dim('  (2× — restore + optimize)');
    if (urls) line += pc.dim(`  (+${urls} URL${urls > 1 ? 's' : ''}, size unknown)`);
    if (remaining != null) line += pc.dim(`  —  ${fmtBytes(remaining)} left`);
    info(line);
    if (remaining != null && estBytes > remaining) {
      warn(`This may exceed your quota: ~${fmtBytes(estBytes)} needed, only ${fmtBytes(remaining)} left.`);
    }
  }

  const clobbers = opts.save === false ? [] : findClobbers(plan, opts);
  if (clobbers.length && opts.clobber !== false) {
    warn(`${clobbers.length} existing file${clobbers.length > 1 ? 's' : ''} will be replaced ` +
      pc.dim(`(e.g. ${rel(clobbers[0].dest)}) — pass --no-clobber to keep them`));
  }
  if (opts.overwrite) warn(`Inputs will be replaced in place ${pc.dim('(--overwrite)')} — originals are not kept.`);

  const go = await confirm('Continue?', { yes: opts.yes });
  if (!go) { info('Aborted.'); return []; }
  console.log();

  const conc = opts.concurrency != null ? toInt(opts.concurrency, '--concurrency', { min: 1, max: 100 }) : 10;
  let done = 0;
  const results = [];
  await pool(plan, conc, async (entry) => {
    const res = await runOne(client, entry, opts, { ...ctx, verbose: false });
    done++;
    let detail = null;
    if (res.ok) {
      detail = res.raw.results
        ? `${Object.keys(res.raw.results).length} outputs`
        : (res.raw.original_size != null && res.raw.kraked_size != null
          ? `${fmtBytes(res.raw.original_size)}→${fmtBytes(res.raw.kraked_size)}`
          : 'ok');
      if (res.skipped?.length) detail += ' (kept existing)';
      if (res.saveError) detail += pc.yellow(` — download failed: ${res.saveError}`);
    }
    batchLine(done, n, displayName(entry.input), res.ok ? { ok: true, info: detail } : { ok: false, error: res.error });
    results.push(res);
  });

  const okRes = results.filter((r) => r.ok && !r.saveError);
  printBatchSummary({
    ok: okRes.length,
    failed: results.length - okRes.length,
    totalOrig: okRes.reduce((a, r) => a + inputBytes(r.raw), 0),
    totalKraked: okRes.reduce((a, r) => a + outputBytes(r.raw), 0),
    outDir: opts.outDir || null,
  });
  if (results.length - okRes.length > 0) process.exitCode = 1;
  if (opts.quota !== false && !opts.quiet) { try { printQuota(await client.status()); } catch { /* */ } }
  return results;
}

// ─── dry run ────────────────────────────────────────────────────────────────

function printDryRun(plan, opts, ctx) {
  const verb = ctx.enhance ? 'enhance' : ctx.restore ? 'restore' : 'optimize';
  console.log();
  info(`${pc.bold('Dry run')} — nothing will be sent to Kraken.io and no files will be written.`);
  console.log();
  console.log('  ' + pc.bold(`${plan.length} image${plan.length === 1 ? '' : 's'} would be ${verb}d`));
  for (const p of plan) {
    console.log('  ' + pc.dim('•') + ' ' + displayName(p.input));
    for (const o of p.outputs) {
      const exists = opts.save !== false && fs.existsSync(o.dest);
      const mark = opts.save === false
        ? pc.dim('(not saved — --no-save)')
        : exists
          ? (opts.clobber === false ? pc.yellow('(exists — would be kept)') : pc.yellow('(exists — would be replaced)'))
          : pc.green('(new)');
      console.log('      ' + pc.dim('→ ') + rel(o.dest) + '  ' + mark);
    }
  }
  const example = plan[0];
  if (example) {
    let params;
    try { params = paramsFor(example, opts, ctx, path.basename(example.outputs[0].dest)); }
    catch { params = null; }
    if (params) {
      console.log();
      console.log('  ' + pc.bold('Request body') + pc.dim('  (for the first image)'));
      for (const line of JSON.stringify(maskAuth(params), null, 2).split('\n')) console.log('  ' + pc.dim(line));
    }
  }
  console.log();
}

// ─── dispatch ───────────────────────────────────────────────────────────────

async function dispatch(args, opts, ctx) {
  if (ctx.restore || ctx.enhance) assertAvailable(ctx.enhance ? 'enhance' : 'restore');

  // Every run is transcribed. --log-file picks the path explicitly; otherwise it
  // goes to one file per day in the default log directory, pruned by age and
  // size so it can be left alone forever. --no-log opts out entirely.
  const logging = getLogging(opts);
  const explicit = Boolean(opts.logFile);
  const target = opts.logFile || (logging.enabled ? dailyLogFile(logging.dir) : null);

  // Start the transcript before anything can fail, so a usage error that
  // happens two lines from now still lands in the log file.
  let log = null;
  if (target) {
    try {
      log = new RunLog(target);
      setLogSink((level, text) => log.write(level, text));
      log.write('info', `krakenio ${redactArgv(process.argv.slice(2)).join(' ')}`);
      log.write('info', `node ${process.version} on ${process.platform}`);
    } catch (e) {
      log = null;
      // An unwritable default directory is not the user's problem to solve
      // mid-run; only a path they asked for by name is worth a warning.
      if (explicit) warn(`could not open --log-file: ${e.message}`);
    }
  }
  try {
    return await dispatchInner(args, opts, ctx, log);
  } catch (e) {
    log?.write('error', e?.message || String(e));
    // On the way out, point at the transcript they didn't know they had.
    if (log && !explicit && !opts.quiet) notice(`full transcript: ${rel(log.file)}`);
    throw e;
  } finally {
    setLogSink(null);
    if (log) {
      log.close();
      if (explicit && !opts.quiet) notice(`log written to ${rel(log.file)}`);
      if (!explicit) pruneLogs(logging.dir, logging);
    }
  }
}

// A folder scan only picks up the formats in the scan set. Anything supported
// that it walked past is reported with the exact flag that would include it —
// silently dropping a directory full of PDFs is the kind of surprise this CLI
// is built to avoid.
function reportExcluded(excluded, opts) {
  if (!excluded || excluded.size === 0) return;
  const parts = [...excluded.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([ext, n]) => `${n} ${ext.slice(1).toUpperCase()}${n === 1 ? '' : 's'}`);
  const how = opts.types
    ? `not in --types ${opts.types}`
    : 'excluded by default';
  const fix = opts.types ? `--types ${opts.types},pdf` : '--types +pdf';
  info(
    `${parts.join(', ')} skipped ${pc.dim(`(${how})`)} — include with ${pc.bold(
      excluded.size === 1 && excluded.has('.pdf') ? fix : '--types all',
    )}`,
  );
}

async function dispatchInner(args, opts, ctx, log) {
  // Parse --types before the scan so an unknown format fails immediately,
  // rather than after walking a large tree and finding nothing.
  const exts = scanExts(opts);
  const { items, skipped, excluded } = resolveInputs(Array.isArray(args) ? args : [args], { ...opts, scanExts: exts });
  for (const s of skipped) warn(`skipped ${s.input} ${pc.dim('(' + s.reason + ')')}`);
  reportExcluded(excluded, opts);
  if (items.length === 0) throw new UsageError('no images to process.');

  // Validate every flag before touching the network, so a bad --quality fails
  // in milliseconds rather than after a 400-image confirmation.
  const resize = buildResize(opts.resize);
  const tags = Array.isArray(resize) ? resize.map((r) => '.' + r.id) : [''];
  assertOutputOptions(opts, items, { tagCount: tags.length });
  assertStorageUsable(opts);

  // Build the request body once purely to validate it, and check the transport
  // numbers too. Doing this here — rather than lazily at send time — means a
  // typo fails identically whether or not --dry-run was passed.
  paramsFor({ input: items[0].input }, opts, ctx, 'probe.jpg');
  if (opts.timeout != null) toInt(opts.timeout, '--timeout', { min: 5, max: 3600 });
  if (opts.concurrency != null) toInt(opts.concurrency, '--concurrency', { min: 1, max: 100 });

  if (opts.quality != null && !opts.lossy && !ctx.enhance) {
    warn('--quality only affects lossy JPEG output; add --lossy for it to take effect.');
  }

  const suffix = SUFFIXES[ctx.enhance ? 'enhance' : ctx.restore ? 'restore' : 'optimize'];
  const plan = planRun(items, opts, { suffix, tags });

  if (opts.save !== false) {
    const collisions = findCollisions(plan);
    if (collisions.length) {
      const lines = collisions.slice(0, 5)
        .map((c) => `  ${rel(c.dest)}  ←  ${c.sources.map(displayName).join(', ')}`);
      throw new UsageError(
        `${collisions.length} output path${collisions.length > 1 ? 's' : ''} would be written twice:\n` +
        lines.join('\n') +
        (collisions.length > 5 ? `\n  … and ${collisions.length - 5} more` : '') +
        '\nRun the folders separately, or drop --out-dir to write next to each input.',
      );
    }
  }

  if (opts.dryRun) return printDryRun(plan, opts, ctx);

  // Building the client validates credentials and --timeout.
  const client = buildClient(opts);

  if (opts.dev && opts.save !== false && !opts.quiet) {
    warn('Sandbox mode (--dev): the downloaded images are randomized placeholders, not real optimizations.');
  }
  log?.write('debug', `plan: ${plan.length} input(s) → ${plan.reduce((a, p) => a + p.outputs.length, 0)} output(s)`);

  let results = [];
  if (plan.length === 1) {
    if (opts.overwrite && !opts.quiet) {
      const go = await confirm(`Replace ${pc.bold(displayName(plan[0].input))} in place?`, { yes: opts.yes });
      if (!go) { info('Aborted.'); return []; }
    }
    results = await executeSingle(client, plan[0], opts, ctx);
  } else {
    results = await executeBatch(client, plan, opts, ctx);
  }

  if (opts.report) {
    const report = buildReport(results, {
      command: ctx.enhance ? 'enhance' : ctx.restore ? 'restore' : 'optimize',
      endpoint: API_HOST,
      sandbox: !!opts.dev,
    });
    try {
      const at = writeReport(opts.report, report);
      if (!opts.quiet) notice(`report written to ${rel(at)}`);
    } catch (e) {
      warn(`could not write --report: ${e.message}`);
    }
  }
}

export const optimize = (args, opts) => dispatch(args, opts, { restore: false, verbose: !!opts.verbose });
export const restore = (args, opts) => dispatch(args, opts, { restore: true, verbose: !!opts.verbose });
export const enhance = (args, opts) => dispatch(args, opts, { restore: false, enhance: true, verbose: !!opts.verbose });

// ─── account / config ───────────────────────────────────────────────────────

export async function status(opts) {
  const client = buildClient(opts);
  const sp = opts.json || opts.quiet ? null : spinner('Fetching account status …');
  const s = await client.status();
  if (sp) sp.stop();
  if (opts.json) { console.log(JSON.stringify(s, null, 2)); if (!s.success) process.exitCode = 1; return; }
  if (!s.success) return fail(describeError(s));
  printBanner(opts, `official CLI · v${VERSION}`);
  printQuota(s);
}

export async function login(opts) {
  info(`Authenticating against ${pc.bold(API_HOST)}`);
  const api_key = (opts.key || (await prompt('  API key:    '))).trim();
  const api_secret = (opts.secret || (await prompt('  API secret: ', { hidden: true }))).trim();
  if (!api_key || !api_secret) throw new UsageError('API key and secret are both required.');
  const client = new KrakenClient({ host: API_HOST, auth: { api_key, api_secret } });
  const sp = spinner('Verifying credentials …');
  const s = await client.status();
  sp.stop();
  if (!s.success) return fail('Credentials rejected: ' + describeError(s));
  const cfg = loadConfig();
  cfg.api_key = api_key;
  cfg.api_secret = api_secret;
  saveConfig(cfg);
  ok(`Credentials saved to ${pc.bold(CONFIG_FILE)} ${pc.dim('(mode 0600)')}`);
  printBanner(opts, 'signed in');
  printQuota(s);
}

export function configSet(field, value) {
  const map = { key: 'api_key', secret: 'api_secret' };
  if (!map[field]) throw new UsageError(`unknown setting: ${field}`);
  if (!value) throw new UsageError(`${field} cannot be empty`);
  const cfg = loadConfig();
  cfg[map[field]] = value;
  saveConfig(cfg);
  ok(`Set ${field}.`);
}

export function configSetS3(key, secret, region) {
  if (!key || !secret) throw new UsageError('both an access key and a secret are required');
  const cfg = loadConfig();
  cfg.s3 = { key, secret, ...(region ? { region } : (cfg.s3?.region ? { region: cfg.s3.region } : {})) };
  saveConfig(cfg);
  ok(`Amazon S3 credentials saved${cfg.s3.region ? ` (region ${cfg.s3.region})` : ' (region us-east-1)'}.`);
}

// Credentials for gcs|cf|azure|sl, as a provider-specific JSON object.
export function configSetStore(provider, json) {
  const def = PROVIDERS[provider];
  if (!def) throw new UsageError(`unknown provider '${provider}'. One of: ${Object.keys(PROVIDERS).join(', ')}`);
  let obj;
  try { obj = JSON.parse(json); }
  catch { throw new UsageError('credentials must be a JSON object'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new UsageError('credentials must be a JSON object');
  const missing = def.required.filter((f) => !obj[f]);
  if (missing.length) throw new UsageError(`${def.label} needs: ${missing.join(', ')}`);
  const cfg = loadConfig();
  cfg[provider] = obj;
  saveConfig(cfg);
  ok(`${def.label} credentials saved.`);
}

// ─── logs ───────────────────────────────────────────────────────────────────

const LEVEL_COLOUR = { ERROR: pc.red, WARN: pc.yellow, DEBUG: pc.dim, INFO: (t) => t };

// Resolve what the user asked for into one entry from the log directory.
// Accepts a date, 'today', 'latest', or nothing (which means latest).
function pickLog(which, entries) {
  if (!entries.length) return null;
  const want = (which || 'latest').toLowerCase();
  if (want === 'latest') return entries[0];
  const date = want === 'today' ? dailyLogName().slice(9, 19) : want;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new UsageError(`not a log date: '${which}'. Use YYYY-MM-DD, 'today', or 'latest'.`);
  }
  return entries.find((e) => e.date === date) || null;
}

export function logsList(opts = {}) {
  const { dir, enabled } = getLogging(opts);
  const entries = listLogs(dir);

  if (opts.json) {
    console.log(JSON.stringify({ dir, enabled, logs: entries }, null, 2));
    return;
  }
  if (!entries.length) {
    console.log();
    notice(`No logs yet in ${pc.bold(dir)}`);
    if (!enabled) notice('Logging is currently disabled.');
    return;
  }

  const total = entries.reduce((n, e) => n + e.size, 0);
  console.log();
  console.log('  ' + pc.dim('date        runs  errors  size'));
  for (const e of entries) {
    const errs = e.errors ? pc.red(String(e.errors).padStart(6)) : pc.dim('     0');
    console.log(
      '  ' + pc.bold(e.date) + '  ' + String(e.runs).padStart(4) + '  ' + errs
      + '  ' + fmtBytes(e.size).padStart(8),
    );
  }
  console.log();
  console.log('  ' + pc.dim(`${entries.length} file(s), ${fmtBytes(total)} in ${dir}`));
  console.log('  ' + pc.dim("`krakenio logs show` prints the latest; `logs show --errors` just the failures."));
}

export function logsShow(which, opts = {}) {
  const { dir } = getLogging(opts);
  const entries = listLogs(dir);
  const entry = pickLog(which, entries);
  if (!entry) {
    if (!entries.length) return notice(`No logs yet in ${pc.bold(dir)}`);
    throw new UsageError(
      `no log for '${which}'. Available: ${entries.slice(0, 5).map((e) => e.date).join(', ')}`
      + (entries.length > 5 ? ', …' : ''),
    );
  }

  const tail = opts.tail != null ? toInt(opts.tail, '--tail', { min: 1, max: 1e6 }) : 0;
  const lines = readLog(entry.file, { errorsOnly: Boolean(opts.errors), grep: opts.grep || '', tail });
  if (lines == null) throw new UsageError(`cannot read ${entry.file}`);

  if (opts.json) {
    console.log(JSON.stringify({ file: entry.file, date: entry.date, lines }, null, 2));
    return;
  }
  if (!lines.length) {
    return notice(opts.errors ? `No errors in ${entry.date}.` : `Nothing matched in ${entry.date}.`);
  }
  // Piped output stays exactly as it was written, so grep and friends still work.
  if (!process.stdout.isTTY) return void console.log(lines.join('\n'));

  for (const line of lines) {
    const { stamp, level, text } = parseLogLine(line);
    if (!level) { console.log(line); continue; }
    const paint = LEVEL_COLOUR[level] || ((t) => t);
    console.log(pc.dim(stamp) + '  ' + paint(level.padEnd(5)) + ' ' + paint(text));
  }
}

export function logsPath(opts = {}) {
  const { dir } = getLogging(opts);
  // Bare, so it composes: cd "$(krakenio logs path)"
  console.log(dir);
}

export function logsClean(opts = {}) {
  const cfg = getLogging(opts);
  const dir = cfg.dir;
  const before = listLogs(dir);
  if (!before.length) return notice(`No logs to clean in ${pc.bold(dir)}`);

  // --all wipes everything but today's; otherwise apply the normal policy now.
  const days = opts.all ? 0 : (opts.days != null ? toInt(opts.days, '--days', { min: 0, max: 3650 }) : cfg.days);
  const maxBytes = opts.all ? 1 : cfg.maxBytes;
  const removed = pruneLogs(dir, { days: opts.all ? 1 : days, maxBytes });

  if (!removed.length) return notice('Nothing to prune — every log is within the retention policy.');
  ok(`Removed ${removed.length} log file(s) from ${pc.bold(dir)}`);
  if (opts.verbose) for (const r of removed) console.log('  ' + pc.dim(r));
}

export function configShow() {
  const cfg = loadConfig();
  const r = (k, v) => console.log('  ' + pc.dim(k.padEnd(9)) + v);
  console.log();
  r('endpoint', API_HOST);
  // Masked like the secret: `config show` output ends up pasted into bug
  // reports and screenshots, and the key alone identifies the account.
  r('key', cfg.api_key ? pc.dim(mask(cfg.api_key)) : pc.dim('(unset)'));
  r('secret', cfg.api_secret ? pc.dim(mask(cfg.api_secret)) : pc.dim('(unset)'));
  for (const [name, def] of Object.entries(PROVIDERS)) {
    const c = cfg[name];
    if (c && Object.keys(c).length) {
      const extra = name === 's3' && c.key ? ` ${mask(c.key)} @ ${c.region || 'us-east-1'}` : '';
      r(name, pc.dim('configured' + extra) + pc.dim(`  (${def.label})`));
    }
  }
  r('file', pc.dim(CONFIG_FILE));

  const lg = getLogging({});
  if (lg.enabled) {
    const keep = [
      lg.days > 0 ? `${lg.days} days` : null,
      lg.maxBytes > 0 ? fmtBytes(lg.maxBytes) : null,
    ].filter(Boolean).join(', ') || 'forever';
    r('logs', pc.dim(lg.dir));
    r('keep', pc.dim(`${keep}  (one file per day, pruned automatically)`));
  } else {
    r('logs', pc.dim('disabled'));
  }

  if (!cfg.api_key || !cfg.api_secret) {
    console.log();
    notice('Run `krakenio login` to store your API credentials.');
  }
}

export function logout() {
  const cfg = loadConfig();
  const had = cfg.api_key || cfg.api_secret;
  delete cfg.api_key;
  delete cfg.api_secret;
  saveConfig(cfg);
  ok(had ? 'Credentials cleared.' : 'No credentials were stored.');
}

// exported for tests
export const _internal = { paramsFor, saveOutputs, buildClient, assertAvailable, inputBytes, outputBytes };
