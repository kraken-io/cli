// Presentation layer: colors, spinners, byte/quota formatting, prompts.
import pc from 'picocolors';
import ora from 'ora';
import readline from 'node:readline';

export const c = pc;

// When --log-file is set, everything the CLI prints is mirrored (colour-free)
// into the transcript as well. The sink is deliberately a module-level hook so
// no call site has to thread a logger through.
let sink = null;
export function setLogSink(fn) { sink = fn; }
function tee(level, text) { if (sink) { try { sink(level, text); } catch { /* logging must never break a run */ } } }

// Print to stdout and mirror to the transcript.
export function say(level, text) { console.log(text); tee(level, text); }

export function spinner(text) {
  return ora({ text, spinner: 'dots', color: 'cyan' }).start();
}

export function fmtBytes(n) {
  if (n == null || isNaN(n)) return '?';
  const neg = Number(n) < 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let x = Math.abs(Number(n)), i = 0;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  const v = i === 0 ? String(x) : x.toFixed(x < 10 ? 1 : 0);
  return `${neg ? '-' : ''}${v.replace(/\.0$/, '')} ${u[i]}`;
}

const row = (k, v) => '  ' + pc.dim(k.padEnd(8)) + v;

export function printResult(r, { restored = false } = {}) {
  say('info', '');
  say('info', '  ' + pc.green(pc.bold(restored ? '✦ Restored' : '✔ Optimized')));
  if (r.file_name) say('info', row('file', r.file_name));
  if (r.original_size != null && r.kraked_size != null) {
    const saved = r.saved_bytes ?? Math.max(0, r.original_size - r.kraked_size);
    const pct = r.original_size ? Math.round((100 * saved) / r.original_size) : 0;
    const delta = saved > 0
      ? pc.green(`  −${pct}%  (saved ${fmtBytes(saved)})`)
      : pc.yellow('  (already optimal)');
    say('info', row('size', `${fmtBytes(r.original_size)} ${pc.dim('→')} ${pc.bold(fmtBytes(r.kraked_size))}${delta}`));
  }
  if (r.kraked_width && r.kraked_height) say('info', row('dims', `${r.kraked_width}×${r.kraked_height}`));
  if (r.restore_model) say('info', row('model', `${r.restore_model} ${pc.dim('(' + (r.restore_strategy || '?') + ')')}`));
  if (r.kraked_url) say('info', row('url', pc.cyan(r.kraked_url)));
}

export function printSaved(dest, bytes) {
  say('info', row('saved', pc.bold(dest) + pc.dim(`  (${fmtBytes(bytes)})`)));
}

// Kraken quota is measured in bytes of data, so show it as data (MB/GB/TB).
export function printQuota(s) {
  if (!s || !s.success) return;
  const { plan_name, active, quota_total: total, quota_used: used, quota_remaining: rem } = s;
  const over = (rem != null && rem < 0) || (total != null && used != null && used > total);
  say('info', '');
  say('info', row('plan', (plan_name || '—') + (active === false ? pc.red('  (inactive)') : '')));
  if (total) {
    const w = 22;
    const ratio = (used || 0) / total;
    const filled = Math.max(0, Math.min(w, Math.round(w * ratio)));
    const col = over ? pc.red : (ratio >= 0.9 ? pc.yellow : pc.cyan);
    const bar = pc.dim('[') + col('█'.repeat(filled)) + pc.dim('░'.repeat(w - filled) + ']') + pc.dim(` ${Math.round(100 * ratio)}%`);
    const left = over ? '' : pc.dim('  ·  ') + pc.bold(fmtBytes(rem)) + pc.dim(' left');
    say('info', row('quota', `${fmtBytes(used)} ${pc.dim('/')} ${fmtBytes(total)}${left}  ${bar}`));
    if (over) {
      const overBy = used != null && total != null ? used - total : Math.abs(rem || 0);
      say('warn', '  ' + pc.red(pc.bold('⚠ over quota by ' + fmtBytes(overBy))));
    }
  } else {
    say('info', row('quota', `${pc.bold(fmtBytes(rem))} left`));
  }
}

export function ok(msg) { say('info', '  ' + pc.green('✔ ') + msg); }
export function info(msg) { say('info', '  ' + pc.cyan('ℹ ') + msg); }
export function warn(msg) { say('warn', '  ' + pc.yellow('⚠ ') + msg); }
export function notice(msg) { say('info', '  ' + pc.dim('→ ' + msg)); }
export function fail(msg, code = 1) {
  const line = '\n  ' + pc.red(pc.bold('✖ ')) + pc.red(msg);
  console.error(line);
  tee('error', line);
  process.exitCode = code;
}
// Detail lines. Printed only with -V, but always written to --log-file so the
// transcript is useful without re-running the whole batch in verbose mode.
export function vlog(verbose, ...args) {
  const line = '  ' + pc.dim('· ' + args.join(' '));
  if (verbose) console.log(line);
  tee('debug', line);
}

// deep-mask api_secret/api_key/secret/key for verbose request dumps
export function maskAuth(obj) {
  const walk = (v) => {
    if (!v || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (/secret|api_key|^key$|credentials|password|token/i.test(k) && typeof val === 'string' && val.length > 6) {
        out[k] = val.slice(0, 3) + '…' + val.slice(-2);
      } else out[k] = walk(val);
    }
    return out;
  };
  return walk(obj);
}

export async function confirm(question, { yes = false } = {}) {
  if (yes) return true;
  if (!process.stdin.isTTY) return false; // non-interactive without -y -> decline
  const a = await prompt(`  ${pc.yellow('?')} ${question} ${pc.dim('[y/N]')} `);
  return /^y(es)?$/i.test(a.trim());
}

// compact per-file line for batch mode
export function batchLine(i, total, name, st) {
  const idx = pc.dim(`[${String(i).padStart(String(total).length)}/${total}]`);
  if (st.ok) say('info', `  ${idx} ${pc.green('✓')} ${name}${st.info ? '  ' + pc.dim(st.info) : ''}`);
  else say('error', `  ${idx} ${pc.red('✗')} ${name}${st.error ? '  ' + pc.red(st.error) : ''}`);
}

export function printBatchSummary(s) {
  say('info', '');
  say('info', '  ' + pc.bold('Summary'));
  say('info', row('done', `${pc.green(s.ok + ' ok')}${s.failed ? '  ' + pc.red(s.failed + ' failed') : ''} ${pc.dim('/ ' + (s.ok + s.failed))}`));
  if (s.totalOrig && s.totalKraked != null) {
    const saved = Math.max(0, s.totalOrig - s.totalKraked);
    const pct = s.totalOrig ? Math.round((100 * saved) / s.totalOrig) : 0;
    say('info', row('size', `${fmtBytes(s.totalOrig)} ${pc.dim('→')} ${pc.bold(fmtBytes(s.totalKraked))}  ${pc.green('−' + pct + '%')} ${pc.dim('(saved ' + fmtBytes(saved) + ')')}`));
  }
  if (s.outDir) say('info', row('out', s.outDir));
}

// readline prompt; hidden=true mutes echo (for secrets).
export function prompt(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const onData = () => { rl.output.write('\x1B[2K\x1B[200D' + question); };
      rl._writeToOutput = onData; // suppress echo
    }
    rl.question(question, (answer) => { rl.close(); if (hidden) console.log(); resolve(answer.trim()); });
  });
}
