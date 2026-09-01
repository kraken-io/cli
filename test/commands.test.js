// Orchestration pieces that are easier to pin down directly than through the
// binary: batch totals, saving, and the AI-restore gate.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _internal, RESTORE_AVAILABLE, UnavailableError } from '../src/commands.js';

const { inputBytes, outputBytes, saveOutputs, assertAvailable } = _internal;

describe('batch totals', () => {
  test('a plain result counts its own sizes', () => {
    const raw = { original_size: 1000, kraked_size: 400 };
    assert.equal(inputBytes(raw), 1000);
    assert.equal(outputBytes(raw), 400);
  });

  test('an image set counts the original once and every output', () => {
    // Each entry repeats the same original_size; summing it would report a
    // 1000-byte photo as 3000 bytes and invent savings that never happened.
    const raw = {
      results: {
        '1920x': { original_size: 1000, kraked_size: 500 },
        '800x': { original_size: 1000, kraked_size: 200 },
        '400x': { original_size: 1000, kraked_size: 100 },
      },
    };
    assert.equal(inputBytes(raw), 1000);
    assert.equal(outputBytes(raw), 800);
  });

  test('missing numbers count as zero rather than NaN', () => {
    assert.equal(inputBytes({}), 0);
    assert.equal(outputBytes({}), 0);
    assert.equal(inputBytes(undefined), 0);
    assert.equal(outputBytes({ results: { a: {} } }), 0);
  });
});

describe('the AI restore gate', () => {
  test('restore is off in this release', () => {
    assert.equal(RESTORE_AVAILABLE, false);
  });

  test('it throws an UnavailableError that explains itself', () => {
    assert.throws(() => assertAvailable('restore'), (e) => {
      assert.ok(e instanceof UnavailableError);
      assert.match(e.message, /`krakenio restore` is not available in this release/);
      assert.ok(Array.isArray(e.detail) && e.detail.length > 0, 'carries an explanation');
      assert.match(e.detail.join(' '), /not part of the public Kraken\.io API yet/);
      return true;
    });
  });
});

describe('saveOutputs', () => {
  let dir;
  beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kio-save-'))); });

  // A client stub that "downloads" by writing the URL's marker text.
  const stubClient = (log = []) => ({
    async download(url, dest) {
      log.push({ url, dest });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const body = `bytes-of:${url}`;
      fs.writeFileSync(dest, body);
      return body.length;
    },
  });

  test('writes a single result to its planned destination', async () => {
    const dest = path.join(dir, 'a.kraked.jpg');
    const entry = { input: path.join(dir, 'a.jpg'), outputs: [{ tag: '', dest }] };
    const { saved } = await saveOutputs(stubClient(), entry, { kraked_url: 'https://dl/a.jpg' }, {});
    assert.equal(saved.length, 1);
    assert.equal(saved[0].dest, dest);
    assert.equal(saved[0].tag, '');
    assert.ok(fs.existsSync(dest));
  });

  test('an image set writes one file per size, each tagged', async () => {
    const entry = {
      input: path.join(dir, 'a.jpg'),
      outputs: [
        { tag: '.800x', dest: path.join(dir, 'a.kraked.800x.jpg') },
        { tag: '.400x', dest: path.join(dir, 'a.kraked.400x.jpg') },
      ],
    };
    const raw = {
      results: {
        '800x': { kraked_url: 'https://dl/800.jpg' },
        '400x': { kraked_url: 'https://dl/400.jpg' },
      },
    };
    const { saved } = await saveOutputs(stubClient(), entry, raw, {});
    assert.deepEqual(saved.map((s) => s.tag).sort(), ['.400x', '.800x']);
    assert.deepEqual(saved.map((s) => path.basename(s.dest)).sort(),
      ['a.kraked.400x.jpg', 'a.kraked.800x.jpg']);
  });

  test('the extension follows the response, so a convert lands correctly', async () => {
    const entry = { input: path.join(dir, 'a.png'), outputs: [{ tag: '', dest: path.join(dir, 'a.kraked.png') }] };
    const { saved } = await saveOutputs(stubClient(), entry, { kraked_url: 'https://dl/x/a.webp' }, {});
    assert.equal(path.basename(saved[0].dest), 'a.kraked.webp');
  });

  test('--no-clobber keeps an existing file and reports it as skipped', async () => {
    const dest = path.join(dir, 'a.kraked.jpg');
    fs.writeFileSync(dest, 'ORIGINAL');
    const entry = { input: path.join(dir, 'a.jpg'), outputs: [{ tag: '', dest }] };
    const { saved, skipped } = await saveOutputs(stubClient(), entry, { kraked_url: 'https://dl/a.jpg' }, { clobber: false });
    assert.deepEqual(saved, []);
    assert.deepEqual(skipped, [dest]);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'ORIGINAL');
  });

  test('without --no-clobber the existing file is replaced', async () => {
    const dest = path.join(dir, 'a.kraked.jpg');
    fs.writeFileSync(dest, 'ORIGINAL');
    const entry = { input: path.join(dir, 'a.jpg'), outputs: [{ tag: '', dest }] };
    await saveOutputs(stubClient(), entry, { kraked_url: 'https://dl/a.jpg' }, {});
    assert.notEqual(fs.readFileSync(dest, 'utf8'), 'ORIGINAL');
  });

  test('--overwrite writes over the input itself', async () => {
    const input = path.join(dir, 'a.jpg');
    fs.writeFileSync(input, 'ORIGINAL');
    const entry = { input, outputs: [{ tag: '', dest: input }] };
    const { saved } = await saveOutputs(stubClient(), entry, { kraked_url: 'https://dl/a.jpg' }, { overwrite: true });
    assert.equal(saved[0].dest, input);
    assert.equal(fs.readFileSync(input, 'utf8'), 'bytes-of:https://dl/a.jpg');
    assert.deepEqual(fs.readdirSync(dir), ['a.jpg'], 'no extra file is left behind');
  });

  test('a result with no URL is ignored rather than crashing', async () => {
    const entry = { input: 'a.jpg', outputs: [{ tag: '', dest: path.join(dir, 'a.kraked.jpg') }] };
    const { saved } = await saveOutputs(stubClient(), entry, { success: true }, {});
    assert.deepEqual(saved, []);
  });
});
