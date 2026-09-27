// The client is exercised against a real local HTTP server: actual multipart
// bodies, actual status codes, actual downloads.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  KrakenClient,
  isUrl,
  describeError,
  STATUS_MESSAGES,
  isRetryableStatus,
  isRetryableError,
  parseRetryAfter,
} from '../src/client.js';

let server, base, handler, received;

before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received = { url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks) };
      handler(req, res, received);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

const json = (status, obj) => (req, res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const client = (opts = {}) => new KrakenClient({ base, host: base, auth: { api_key: 'K', api_secret: 'S' }, ...opts });

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kio-client-')); });

describe('isUrl', () => {
  test('http and https are URLs; paths are not', () => {
    assert.equal(isUrl('https://x.com/a.jpg'), true);
    assert.equal(isUrl('HTTP://1.2.3.4:8080/x'), true);
    assert.equal(isUrl('./photo.jpg'), false);
    assert.equal(isUrl('photo.jpg'), false);
    assert.equal(isUrl('/abs/photo.jpg'), false);
    assert.equal(isUrl('ftp://x.com/a.jpg'), false);
  });
});

describe('URL input', () => {
  test('posts JSON to /v1/url with auth, wait and the params', async () => {
    handler = json(200, { success: true, kraked_url: 'http://x/a.jpg' });
    const r = await client().run('https://site/a.jpg', { params: { lossy: true } });
    assert.equal(r.success, true);
    assert.equal(received.url, '/v1/url');
    assert.match(received.headers['content-type'], /application\/json/);
    assert.deepEqual(JSON.parse(received.body.toString()), {
      auth: { api_key: 'K', api_secret: 'S' }, wait: true, lossy: true, url: 'https://site/a.jpg',
    });
  });

  test('restore targets the restore endpoint', async () => {
    handler = json(200, { success: true });
    await client().run('https://site/a.jpg', { restore: true });
    assert.equal(received.url, '/v1/url/restore');
  });
});

describe('file input', () => {
  test('posts multipart with the documented data + upload fields', async () => {
    handler = json(200, { success: true, kraked_url: 'http://x/a.jpg' });
    const f = path.join(dir, 'photo.jpg');
    fs.writeFileSync(f, 'JPEGBYTES');
    const r = await client().run(f, { params: { lossy: true } });
    assert.equal(r.success, true);
    assert.equal(received.url, '/v1/upload');
    assert.match(received.headers['content-type'], /multipart\/form-data/);
    const body = received.body.toString();
    assert.match(body, /name="data"/);
    assert.match(body, /name="upload"; filename="photo\.jpg"/);
    assert.match(body, /JPEGBYTES/);
    assert.match(body, /"lossy":true/);
  });

  test('a missing file fails locally without a request', async () => {
    handler = json(500, {});
    const r = await client().run(path.join(dir, 'nope.jpg'));
    assert.equal(r.success, false);
    assert.match(r.error, /file not found/);
    assert.equal(r._status, 0);
  });

  test('an empty file is caught before it wastes a request', async () => {
    const f = path.join(dir, 'empty.jpg');
    fs.writeFileSync(f, '');
    const r = await client().run(f);
    assert.equal(r.success, false);
    assert.match(r.error, /file is empty/);
  });

  test('a file exceeding the maximum size limit is caught before reading into memory', async () => {
    const f = path.join(dir, 'huge.jpg');
    fs.writeFileSync(f, 'x');
    const origMax = KrakenClient.MAX_FILE_BYTES;
    try {
      KrakenClient.MAX_FILE_BYTES = 0.5;
      const r = await client().run(f);
      assert.equal(r.success, false);
      assert.match(r.error, /file too large/);
    } finally {
      KrakenClient.MAX_FILE_BYTES = origMax;
    }
  });
});

describe('error handling', () => {
  test('every documented status code becomes an actionable message', async () => {
    for (const code of [400, 401, 402, 403, 413, 415, 422, 500]) {
      handler = json(code, {});
      const r = await client().run('https://site/a.jpg');
      assert.equal(r.success, false, `status ${code}`);
      assert.equal(r._status, code);
      assert.equal(r.error, STATUS_MESSAGES[code]);
    }
  });

  test("the API's own message is kept and annotated with the status meaning", async () => {
    handler = json(422, { success: false, message: 'Invalid resize strategy' });
    const r = await client().run('https://site/a.jpg');
    assert.equal(describeError(r), 'Invalid resize strategy (unprocessable entity)');
  });

  test('a 200 body with success:false is still a failure', async () => {
    handler = json(200, { success: false, error: 'could not decode the image' });
    const r = await client().run('https://site/a.jpg');
    assert.equal(r.success, false);
    assert.equal(describeError(r), 'could not decode the image');
  });

  test('a non-JSON body does not crash the parse', async () => {
    handler = (req, res) => { res.writeHead(502, { 'content-type': 'text/html' }); res.end('<html>bad gateway</html>'); };
    const r = await client().run('https://site/a.jpg');
    assert.equal(r.success, false);
    assert.equal(r.error, '<html>bad gateway</html>');
  });

  test('an empty error body falls back to the status meaning', async () => {
    handler = (req, res) => { res.writeHead(503); res.end(''); };
    const r = await client().run('https://site/a.jpg');
    assert.equal(r.error, STATUS_MESSAGES[503]);
  });

  test('a connection failure is reported, not thrown', async () => {
    const dead = new KrakenClient({ host: 'http://127.0.0.1:1', auth: {}, timeout: 1000 });
    const r = await dead.run('https://site/a.jpg');
    assert.equal(r.success, false);
    assert.match(r.error, /could not reach/);
  });

  test('a stalled request times out instead of hanging the batch', async () => {
    handler = () => { /* never responds */ };
    const r = await client({ timeout: 150 }).run('https://site/a.jpg');
    assert.equal(r.success, false);
    assert.match(r.error, /timed out after/);
  });

  test('describeError copes with nothing useful at all', () => {
    assert.equal(describeError({}), 'unknown error');
    assert.equal(describeError({ _status: 418 }), 'HTTP 418');
  });
});

describe('status', () => {
  test('posts auth to /user_status', async () => {
    handler = json(200, { success: true, plan_name: 'Pro', quota_total: 100, quota_used: 5, quota_remaining: 95 });
    const s = await client().status();
    assert.equal(received.url, '/user_status');
    assert.deepEqual(JSON.parse(received.body.toString()), { auth: { api_key: 'K', api_secret: 'S' } });
    assert.equal(s.plan_name, 'Pro');
  });
});

describe('download', () => {
  test('writes the bytes and returns the length', async () => {
    handler = (req, res) => { res.writeHead(200); res.end('IMAGEDATA'); };
    const dest = path.join(dir, 'out', 'a.jpg');
    const n = await client().download(base + '/f.jpg', dest);
    assert.equal(n, 9);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'IMAGEDATA');
  });

  test('creates missing parent directories', async () => {
    handler = (req, res) => { res.writeHead(200); res.end('X'); };
    const dest = path.join(dir, 'deep', 'er', 'still', 'a.jpg');
    await client().download(base + '/f.jpg', dest);
    assert.ok(fs.existsSync(dest));
  });

  test('a failed download throws and leaves no partial file behind', async () => {
    handler = (req, res) => { res.writeHead(404); res.end('nope'); };
    const dest = path.join(dir, 'a.jpg');
    await assert.rejects(() => client().download(base + '/f.jpg', dest), /download failed \(HTTP 404\)/);
    assert.equal(fs.existsSync(dest), false);
  });

  test('an existing file is only replaced once the new bytes are complete', async () => {
    const dest = path.join(dir, 'a.jpg');
    fs.writeFileSync(dest, 'ORIGINAL');
    handler = (req, res) => { res.writeHead(500); res.end('boom'); };
    await assert.rejects(() => client().download(base + '/f.jpg', dest));
    assert.equal(fs.readFileSync(dest, 'utf8'), 'ORIGINAL', 'the original must survive a failed download');
    handler = (req, res) => { res.writeHead(200); res.end('NEWDATA'); };
    await client().download(base + '/f.jpg', dest);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'NEWDATA');
  });

  test('no .part leftovers after a successful download', async () => {
    handler = (req, res) => { res.writeHead(200); res.end('X'); };
    await client().download(base + '/f.jpg', path.join(dir, 'a.jpg'));
    assert.deepEqual(fs.readdirSync(dir), ['a.jpg']);
  });
});

describe('host normalization', () => {
  test('a trailing slash never produces a double slash', async () => {
    handler = json(200, { success: true });
    const c = new KrakenClient({ host: base + '///', auth: {} });
    await c.status();
    assert.equal(received.url, '/user_status');
  });
});


describe('download hardening', () => {
  test('refuses a non-HTTPS result URL rather than following a downgrade', async () => {
    const c = new KrakenClient({ host: 'https://api.kraken.io', auth: {} });
    // kraked_url comes from the API response, so it decides what this machine
    // fetches — an http:// or file:// target must not be followed.
    await assert.rejects(() => c.download('http://evil.example/x.jpg', '/tmp/x.jpg'), /must be served over HTTPS/);
    await assert.rejects(() => c.download('ftp://evil.example/x.jpg', '/tmp/x.jpg'), /must be served over HTTPS/);
  });

  test('a malformed result URL is refused, not passed to fetch', async () => {
    const c = new KrakenClient({ host: 'https://api.kraken.io', auth: {} });
    await assert.rejects(() => c.download('not a url', '/tmp/x.jpg'), /malformed result URL/);
  });

  test('plain HTTP to loopback is allowed — it cannot be intercepted', async () => {
    // Proven by the download tests above, which all serve over http://127.0.0.1.
    const c = new KrakenClient({ host: 'https://api.kraken.io', auth: {} });
    await assert.rejects(
      () => c.download('http://127.0.0.1:1/nope.jpg', '/tmp/x.jpg'),
      (e) => !/must be served over HTTPS/.test(e.message),
      'loopback is rejected by the connection failing, not by the scheme check',
    );
  });
});

describe('automatic retry logic', () => {
  test('isRetryableStatus identifies 429 and 504 specifically', () => {
    assert.equal(isRetryableStatus(429), true);
    assert.equal(isRetryableStatus(504), true);
    assert.equal(isRetryableStatus(200), false);
    assert.equal(isRetryableStatus(400), false);
    assert.equal(isRetryableStatus(404), false);
    assert.equal(isRetryableStatus(500), false);
  });

  test('isRetryableError handles network errors and excludes AbortError and ECONNREFUSED', () => {
    assert.equal(isRetryableError(new TypeError('fetch failed')), true);
    assert.equal(isRetryableError({ name: 'AbortError' }), false);
    assert.equal(isRetryableError({ code: 'ECONNREFUSED' }), false);
    assert.equal(isRetryableError({ cause: { code: 'ECONNREFUSED' } }), false);
    assert.equal(isRetryableError({ cause: { message: 'bad port' } }), false);
    assert.equal(isRetryableError({ cause: { code: 'ECONNRESET' } }), true);
    assert.equal(isRetryableError({ cause: { code: 'ETIMEDOUT' } }), true);
    assert.equal(isRetryableError(null), false);
  });

  test('parseRetryAfter parses seconds and HTTP dates', () => {
    assert.equal(parseRetryAfter('5'), 5000);
    assert.equal(parseRetryAfter('0'), 0);
    assert.equal(parseRetryAfter(null), null);
    assert.equal(parseRetryAfter('invalid'), null);
    const future = new Date(Date.now() + 10000).toUTCString();
    const parsed = parseRetryAfter(future);
    assert.ok(parsed > 0 && parsed <= 10000);
  });

  test('retries on HTTP 429 and succeeds on subsequent attempt', async () => {
    let calls = 0;
    handler = (req, res) => {
      calls++;
      if (calls < 3) {
        res.writeHead(429, { 'retry-after': '0' });
        res.end(JSON.stringify({ success: false, error: 'too many requests' }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, kraked_url: 'http://site/b.jpg' }));
      }
    };
    const c = new KrakenClient({ host: base, auth: {}, retryDelay: 5, maxRetries: 5 });
    const r = await c.run('https://site/a.jpg');
    assert.equal(calls, 3);
    assert.equal(r.success, true);
    assert.equal(r.kraked_url, 'http://site/b.jpg');
  });

  test('retries on HTTP 504 and succeeds on subsequent attempt', async () => {
    let calls = 0;
    handler = (req, res) => {
      calls++;
      if (calls < 2) {
        res.writeHead(504);
        res.end('gateway timeout');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      }
    };
    const c = new KrakenClient({ host: base, auth: {}, retryDelay: 5, maxRetries: 5 });
    const r = await c.run('https://site/a.jpg');
    assert.equal(calls, 2);
    assert.equal(r.success, true);
  });

  test('exhausts retries on persistent 429', async () => {
    let calls = 0;
    handler = (req, res) => {
      calls++;
      res.writeHead(429, { 'retry-after': '0' });
      res.end(JSON.stringify({ success: false, error: 'rate limited' }));
    };
    const c = new KrakenClient({ host: base, auth: {}, retryDelay: 5, maxRetries: 3 });
    const r = await c.run('https://site/a.jpg');
    assert.equal(calls, 4); // initial + 3 retries
    assert.equal(r.success, false);
    assert.equal(r._status, 429);
  });

  test('download retries on 504 and completes successfully', async () => {
    let calls = 0;
    handler = (req, res) => {
      calls++;
      if (calls === 1) {
        res.writeHead(504);
        res.end('gateway timeout');
      } else {
        res.writeHead(200);
        res.end('RETRY_IMAGE_DATA');
      }
    };
    const c = new KrakenClient({ host: base, auth: {}, retryDelay: 5, maxRetries: 3 });
    const dest = path.join(dir, 'retry-test.jpg');
    const bytes = await c.download(`${base}/img.jpg`, dest);
    assert.equal(calls, 2);
    assert.equal(bytes, 16);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'RETRY_IMAGE_DATA');
  });
});

