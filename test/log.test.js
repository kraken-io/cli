// --log-file transcripts and --report exports.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RunLog, stripAnsi, buildReport, toCsv, writeReport,
  dailyLogName, dailyLogFile, pruneLogs, listLogs, readLog, parseLogLine, redactArgv,
} from '../src/log.js';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kio-log-')); });

const ESC = String.fromCharCode(27);

describe('stripAnsi', () => {
  test('removes colour codes and keeps the text', () => {
    assert.equal(stripAnsi(`${ESC}[31mred${ESC}[39m plain`), 'red plain');
    assert.equal(stripAnsi(`${ESC}[1m${ESC}[32m✔ ok${ESC}[0m`), '✔ ok');
  });

  test('leaves plain text untouched', () => {
    assert.equal(stripAnsi('nothing to strip'), 'nothing to strip');
  });
});

describe('RunLog', () => {
  test('writes timestamped, colour-free lines', () => {
    const file = path.join(dir, 'run.log');
    const log = new RunLog(file);
    log.write('info', `${ESC}[32m✔ done${ESC}[39m`);
    log.write('error', 'it broke');
    log.close();
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z {2}INFO {2}✔ done$/);
    assert.match(lines[1], /ERROR it broke$/);
    assert.equal(lines.join('').includes(ESC), false, 'no escape codes in the transcript');
  });

  test('appends across runs instead of truncating', () => {
    const file = path.join(dir, 'run.log');
    const a = new RunLog(file); a.write('info', 'first'); a.close();
    const b = new RunLog(file); b.write('info', 'second'); b.close();
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
  });

  test('creates missing parent directories', () => {
    const file = path.join(dir, 'deep', 'er', 'run.log');
    const log = new RunLog(file); log.write('info', 'x'); log.close();
    assert.ok(fs.existsSync(file));
  });

  test('a broken sink never throws at the caller', () => {
    const log = new RunLog(path.join(dir, 'run.log'));
    log.close();
    log.fd = 9999; // a closed/invalid descriptor
    assert.doesNotThrow(() => log.write('info', 'after close'));
    log.close();
  });
});

// A representative pair of results: one multi-resize success, one failure.
const RESULTS = [
  {
    input: '/photos/a.jpg',
    ok: true,
    raw: {
      success: true, _status: 200, _ms: 412,
      results: {
        '800x': { original_size: 1000, kraked_size: 400, kraked_width: 800, kraked_height: 600, kraked_url: 'https://dl/a-800.jpg' },
        '400x': { original_size: 1000, kraked_size: 200, kraked_width: 400, kraked_height: 300, kraked_url: 'https://dl/a-400.jpg' },
      },
    },
    saved: [
      { dest: '/photos/a.kraked.800x.jpg', bytes: 400, tag: '.800x' },
      { dest: '/photos/a.kraked.400x.jpg', bytes: 200, tag: '.400x' },
    ],
  },
  {
    input: '/photos/broken.png',
    ok: false,
    error: 'unsupported media type — Kraken.io cannot process this file format',
    raw: { success: false, _status: 415, _ms: 88 },
  },
];

describe('buildReport', () => {
  test('one row per output, failures included', () => {
    const r = buildReport(RESULTS, { command: 'optimize' });
    assert.equal(r.total, 3);
    assert.equal(r.command, 'optimize');
    assert.match(r.generated_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(r.rows.map((x) => x.status), ['ok', 'ok', 'error']);
  });

  test('each row is matched to the file it was actually written to', () => {
    const rows = buildReport(RESULTS).rows;
    assert.equal(rows.find((x) => x.size_id === '800x').saved_to, '/photos/a.kraked.800x.jpg');
    assert.equal(rows.find((x) => x.size_id === '400x').saved_to, '/photos/a.kraked.400x.jpg');
  });

  test('saved_bytes is derived when the API omits it', () => {
    assert.equal(buildReport(RESULTS).rows[0].saved_bytes, 600);
  });

  test('a failed row carries the reason and the HTTP status', () => {
    const row = buildReport(RESULTS).rows[2];
    assert.equal(row.status, 'error');
    assert.match(row.error, /unsupported media type/);
    assert.equal(row.http_status, 415);
    assert.equal(row.kraked_url, null);
    assert.equal(row.saved_to, null);
  });

  test('a single (non-resize) result produces one row with a null size_id', () => {
    const r = buildReport([{
      input: 'a.jpg', ok: true,
      raw: { success: true, _status: 200, original_size: 10, kraked_size: 4, kraked_url: 'https://dl/a.jpg' },
      saved: [{ dest: 'a.kraked.jpg', bytes: 4, tag: '' }],
    }]);
    assert.equal(r.total, 1);
    assert.equal(r.rows[0].size_id, null);
    assert.equal(r.rows[0].saved_to, 'a.kraked.jpg');
  });

  test('an empty run is still a valid report', () => {
    assert.deepEqual(buildReport([]).rows, []);
  });
});

describe('toCsv', () => {
  test('a header plus one line per row', () => {
    const csv = toCsv(buildReport(RESULTS));
    const lines = csv.trim().split('\n');
    assert.equal(lines.length, 4);
    assert.match(lines[0], /^input,size_id,status,error,original_size/);
  });

  test('fields containing commas or quotes are escaped', () => {
    const csv = toCsv(buildReport([{
      input: 'a,b.jpg', ok: false, error: 'he said "no"', raw: { _status: 400 },
    }]));
    assert.match(csv, /"a,b\.jpg"/);
    assert.match(csv, /"he said ""no"""/);
  });

  test('nulls become empty cells, not the text "null"', () => {
    const csv = toCsv(buildReport([{ input: 'a.jpg', ok: true, raw: { success: true } }]));
    assert.equal(csv.includes('null'), false);
  });
});

describe('writeReport', () => {
  test('.json gets JSON', () => {
    const at = writeReport(path.join(dir, 'r.json'), buildReport(RESULTS));
    const parsed = JSON.parse(fs.readFileSync(at, 'utf8'));
    assert.equal(parsed.total, 3);
  });

  test('.csv gets CSV', () => {
    const at = writeReport(path.join(dir, 'r.csv'), buildReport(RESULTS));
    assert.match(fs.readFileSync(at, 'utf8'), /^input,size_id,status/);
  });

  test('an unknown extension defaults to JSON', () => {
    const at = writeReport(path.join(dir, 'r.txt'), buildReport(RESULTS));
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(at, 'utf8')));
  });

  test('missing parent directories are created', () => {
    const at = writeReport(path.join(dir, 'a', 'b', 'r.json'), buildReport([]));
    assert.ok(fs.existsSync(at));
  });
});


describe('the default log directory', () => {
  const day = (iso) => new Date(iso + 'T12:00:00Z');
  const write = (name, bytes = 10) => fs.writeFileSync(path.join(dir, name), 'x'.repeat(bytes));
  const left = () => fs.readdirSync(dir).sort();

  test('one file per day, named by date', () => {
    assert.equal(dailyLogName(day('2026-09-01')), 'krakenio-2026-09-01.log');
    assert.equal(dailyLogFile('/var/log', day('2026-09-01')), path.join('/var/log', 'krakenio-2026-09-01.log'));
  });

  test('two runs on the same day append to one file', () => {
    const file = dailyLogFile(dir, day('2026-09-01'));
    for (const msg of ['first run', 'second run']) {
      const log = new RunLog(file);
      log.write('info', msg);
      log.close();
    }
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /first run$/);
    assert.match(lines[1], /second run$/);
  });

  test('files older than the retention window are deleted', () => {
    write('krakenio-2026-08-01.log');   // 31 days old
    write('krakenio-2026-08-25.log');   // 7 days old
    write('krakenio-2026-09-01.log');   // today
    const removed = pruneLogs(dir, { days: 14, maxBytes: 0, now: day('2026-09-01') });
    assert.deepEqual(removed, ['krakenio-2026-08-01.log']);
    assert.deepEqual(left(), ['krakenio-2026-08-25.log', 'krakenio-2026-09-01.log']);
  });

  test('age is read from the filename, so restoring a directory does not reset it', () => {
    write('krakenio-2020-01-01.log');
    // Freshly written, so mtime is now — only the name says it is old.
    pruneLogs(dir, { days: 14, maxBytes: 0, now: day('2026-09-01') });
    assert.deepEqual(left(), []);
  });

  test('once inside the window, the oldest go first until the size cap is met', () => {
    write('krakenio-2026-08-28.log', 100);
    write('krakenio-2026-08-29.log', 100);
    write('krakenio-2026-08-30.log', 100);
    const removed = pruneLogs(dir, { days: 14, maxBytes: 250, now: day('2026-09-01') });
    assert.deepEqual(removed, ['krakenio-2026-08-28.log']);
    assert.deepEqual(left(), ['krakenio-2026-08-29.log', 'krakenio-2026-08-30.log']);
  });

  test("today's log is never pruned, even over the size cap", () => {
    write('krakenio-2026-09-01.log', 10_000);
    const removed = pruneLogs(dir, { days: 14, maxBytes: 1, now: day('2026-09-01') });
    assert.deepEqual(removed, []);
    assert.deepEqual(left(), ['krakenio-2026-09-01.log']);
  });

  test('unrelated files in the directory are never touched', () => {
    write('krakenio-2020-01-01.log');
    write('notes.txt');
    write('krakenio.log');            // not date-stamped
    write('other-2020-01-01.log');
    pruneLogs(dir, { days: 1, maxBytes: 1, now: day('2026-09-01') });
    assert.deepEqual(left(), ['krakenio.log', 'notes.txt', 'other-2020-01-01.log']);
  });

  test('zero means keep forever', () => {
    write('krakenio-2001-01-01.log', 10_000);
    assert.deepEqual(pruneLogs(dir, { days: 0, maxBytes: 0, now: day('2026-09-01') }), []);
    assert.equal(left().length, 1);
  });

  test('a missing directory is not an error — pruning is housekeeping', () => {
    assert.deepEqual(pruneLogs(path.join(dir, 'nope'), { days: 14, maxBytes: 1 }), []);
  });
});


describe('reading the log directory back', () => {
  const seed = (name, lines) => fs.writeFileSync(path.join(dir, name), lines.join('\n') + '\n');
  const RUN = (cmd) => `2026-09-01T10:00:00.000Z  INFO  krakenio ${cmd}`;
  const ERR = (msg) => `2026-09-01T10:00:01.000Z  ERROR ${msg}`;
  const INFO = (msg) => `2026-09-01T10:00:02.000Z  INFO  ${msg}`;

  test('lists transcripts newest first', () => {
    seed('krakenio-2026-08-30.log', [RUN('opt a')]);
    seed('krakenio-2026-09-01.log', [RUN('opt b')]);
    seed('krakenio-2026-08-31.log', [RUN('opt c')]);
    assert.deepEqual(listLogs(dir).map((e) => e.date), ['2026-09-01', '2026-08-31', '2026-08-30']);
  });

  test('counts runs and errors per day', () => {
    seed('krakenio-2026-09-01.log', [
      RUN('opt a'), INFO('done'),
      RUN('opt b'), ERR('unsupported media type'), ERR('timeout'),
    ]);
    const [e] = listLogs(dir);
    assert.equal(e.runs, 2, 'each invocation opens with its command line');
    assert.equal(e.errors, 2);
    assert.ok(e.size > 0);
  });

  test('ignores files that are not daily transcripts', () => {
    seed('krakenio-2026-09-01.log', [RUN('opt a')]);
    seed('notes.txt', ['hello']);
    seed('krakenio.log', [RUN('opt b')]);
    assert.deepEqual(listLogs(dir).map((e) => e.name), ['krakenio-2026-09-01.log']);
  });

  test('a missing directory lists as empty rather than throwing', () => {
    assert.deepEqual(listLogs(path.join(dir, 'nope')), []);
  });

  test('readLog returns the lines, without a trailing blank', () => {
    const f = path.join(dir, 'krakenio-2026-09-01.log');
    seed('krakenio-2026-09-01.log', [RUN('opt a'), INFO('done')]);
    assert.deepEqual(readLog(f), [RUN('opt a'), INFO('done')]);
  });

  test('--errors keeps only the failures', () => {
    const f = path.join(dir, 'krakenio-2026-09-01.log');
    seed('krakenio-2026-09-01.log', [RUN('opt a'), ERR('boom'), INFO('done')]);
    assert.deepEqual(readLog(f, { errorsOnly: true }), [ERR('boom')]);
  });

  test('--grep matches case-insensitively', () => {
    const f = path.join(dir, 'krakenio-2026-09-01.log');
    seed('krakenio-2026-09-01.log', [INFO('Photo.JPG saved'), INFO('other.png saved')]);
    assert.deepEqual(readLog(f, { grep: 'photo.jpg' }), [INFO('Photo.JPG saved')]);
  });

  test('--tail is applied after filtering, not before', () => {
    const f = path.join(dir, 'krakenio-2026-09-01.log');
    seed('krakenio-2026-09-01.log', [ERR('first'), INFO('a'), INFO('b'), INFO('c'), ERR('second')]);
    assert.deepEqual(readLog(f, { errorsOnly: true, tail: 1 }), [ERR('second')]);
  });

  test('reading a missing file is null, not a throw', () => {
    assert.equal(readLog(path.join(dir, 'gone.log')), null);
  });

  test('parseLogLine splits a transcript line into its parts', () => {
    assert.deepEqual(parseLogLine('2026-09-01T10:00:01.000Z  ERROR it broke'), {
      stamp: '2026-09-01T10:00:01.000Z', level: 'ERROR', text: 'it broke',
    });
  });

  test('parseLogLine passes anything unrecognised straight through', () => {
    assert.deepEqual(parseLogLine('not a log line'), { stamp: null, level: null, text: 'not a log line' });
  });
});


describe('credentials never reach a transcript', () => {
  test('--secret and --key values are redacted from the recorded command line', () => {
    const argv = ['optimize', 'a.jpg', '--key', 'AAAA1111', '--secret', 'SSSS2222'];
    assert.deepEqual(redactArgv(argv),
      ['optimize', 'a.jpg', '--key', '***', '--secret', '***']);
  });

  test('the --flag=value form is redacted too', () => {
    assert.deepEqual(redactArgv(['--secret=SSSS2222', '--key=AAAA1111']),
      ['--secret=***', '--key=***']);
  });

  test('S3 credentials are redacted', () => {
    assert.deepEqual(redactArgv(['--s3-key', 'AKIAEXAMPLE', '--s3-secret', 'shhh']),
      ['--s3-key', '***', '--s3-secret', '***']);
  });

  test('an inline --store object is redacted — it can carry provider secrets', () => {
    const argv = ['--store', '{"s3_store":{"secret":"shhh"}}'];
    assert.deepEqual(redactArgv(argv), ['--store', '***']);
  });

  test('a --store @file reference is kept — a path is not a secret', () => {
    assert.deepEqual(redactArgv(['--store', '@creds.json']), ['--store', '@creds.json']);
    assert.deepEqual(redactArgv(['--store=@creds.json']), ['--store=@creds.json']);
  });

  test('everything else is passed through untouched', () => {
    const argv = ['optimize', './photos', '--lossy', '-r', '800x', '--out-dir', './web', '-y'];
    assert.deepEqual(redactArgv(argv), argv);
  });

  test('a credential flag with no value does not swallow the next flag', () => {
    assert.deepEqual(redactArgv(['--secret', '--lossy']), ['--secret', '--lossy']);
    assert.deepEqual(redactArgv(['--key']), ['--key']);
  });

  test('the whole command line as written to a log carries no secret', () => {
    const file = path.join(dir, 'krakenio-2026-09-01.log');
    const log = new RunLog(file);
    log.write('info', `krakenio ${redactArgv(['opt', 'a.jpg', '--secret', 'SUPERSECRET']).join(' ')}`);
    log.close();
    const body = fs.readFileSync(file, 'utf8');
    assert.equal(body.includes('SUPERSECRET'), false);
    assert.match(body, /--secret \*\*\*/);
  });
});

// Windows has no POSIX mode bits — chmod only toggles a read-only flag — so the
// files inherit the user profile's ACL instead. Nothing to assert there.
describe('transcript permissions', { skip: process.platform === 'win32' && 'POSIX modes only' }, () => {
  test('a log this CLI creates is owner-only, like the credential store', () => {
    const file = path.join(dir, 'sub', 'krakenio-2026-09-01.log');
    const log = new RunLog(file);
    log.write('info', 'hello');
    log.close();
    // Logs carry file paths and live result URLs; other local users must not read them.
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  });

  test('a pre-existing file the user pointed --log-file at is left as it is', () => {
    const file = path.join(dir, 'mine.log');
    fs.writeFileSync(file, '', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    const log = new RunLog(file);
    log.write('info', 'hello');
    log.close();
    assert.equal(fs.statSync(file).mode & 0o777, 0o644, 'we do not re-permission a file we did not create');
  });
});
