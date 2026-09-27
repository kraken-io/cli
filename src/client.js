// Thin Kraken.io API client built on Node 18+ global fetch / FormData / Blob
// (no HTTP dependency). Handles url-vs-file input and maps the API's documented
// status codes onto messages a human can act on. Every request is bounded by a
// timeout so one stalled call can't hang a whole batch.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function isUrl(input) {
  return /^https?:\/\//i.test(input);
}

// https://kraken.io/docs/http-status-codes — the API is explicit about what
// each code means, and the JSON body is often terse ("error": "..."), so we
// prefer these over a bare "HTTP 413".
export const STATUS_MESSAGES = {
  400: 'bad request — the API rejected the request body as invalid JSON',
  401: 'unauthorized — check your API key and secret (`krakenio login`)',
  402: 'payment required — this Kraken.io account is overdue',
  403: 'forbidden — this Kraken.io account is suspended',
  413: "file too large — it exceeds your plan's per-file size limit",
  415: 'unsupported media type — Kraken.io cannot process this file format',
  422: 'unprocessable entity — one or more request parameters are invalid',
  429: 'too many requests — slow down (try a lower --concurrency)',
  500: 'Kraken.io server error — try again in a moment',
  502: 'Kraken.io is unreachable right now (bad gateway)',
  503: 'Kraken.io is temporarily unavailable',
  504: 'Kraken.io gateway timeout',
};

// Pick the most useful message out of a response: the API's own error text
// when present, otherwise our mapping of the status code.
export function describeError(json) {
  const own = json?.error || json?.message;
  const mapped = STATUS_MESSAGES[json?._status];
  if (own && mapped) return `${own} (${mapped.split(' — ')[0]})`;
  return own || mapped || (json?._status ? `HTTP ${json._status}` : 'unknown error');
}

export class KrakenClient {
  // Kraken.io API plans enforce a per-file upload limit (up to 100 MB).
  // Checking this via statSync avoids reading multi-gigabyte files into RAM Buffer.
  static MAX_FILE_BYTES = 100 * 1024 * 1024;

  constructor({ host, auth, timeout = 120000 }) {
    this.host = String(host).replace(/\/+$/, '');
    this.auth = auth;
    this.timeout = timeout;
  }

  async _fetch(url, init) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeout);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
  }

  async _post(pathname, body, file) {
    const url = this.host + pathname;
    const t0 = Date.now();
    let init;
    if (file) {
      // Field names are ours to choose per the docs; `data` + `upload` mirrors
      // the official cURL example exactly.
      const form = new FormData();
      form.append('data', JSON.stringify(body));
      form.append('upload', new Blob([file.bytes]), file.name);
      init = { method: 'POST', body: form };
    } else {
      init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    }
    let res;
    try {
      res = await this._fetch(url, init);
    } catch (e) {
      const msg = e.name === 'AbortError'
        ? `timed out after ${Math.round(this.timeout / 1000)}s`
        : `could not reach ${url}: ${e.message}`;
      return { success: false, error: msg, _status: 0, _ms: Date.now() - t0 };
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { success: res.ok, error: text.trim() || undefined };
    }
    if (json === null || typeof json !== 'object') json = { success: res.ok };
    if (json.success === undefined) json.success = res.ok;
    // A 2xx with success:true is the only real success; everything else gets a
    // message, even when the body didn't carry one.
    if (!res.ok) json.success = false;
    json._status = res.status;
    json._ms = Date.now() - t0;
    if (!json.success && !json.error && !json.message) json.error = STATUS_MESSAGES[res.status] || `HTTP ${res.status}`;
    return json;
  }

  // Optimize/convert/resize. `restore: true` targets the AI restoration
  // endpoints, which are not part of the public API yet (see src/commands.js).
  async run(input, { restore = false, params = {}, wait = true } = {}) {
    const body = { auth: this.auth, wait, ...params };
    if (isUrl(input)) {
      return this._post(restore ? '/v1/url/restore' : '/v1/url', { ...body, url: input });
    }
    let st;
    try {
      st = fs.statSync(input);
    } catch (e) {
      const why = e.code === 'ENOENT' ? 'file not found' : e.code === 'EACCES' ? 'permission denied' : e.message;
      return { success: false, error: `${why}: ${input}`, _status: 0 };
    }
    if (st.size === 0) return { success: false, error: `file is empty: ${input}`, _status: 0 };
    if (st.size > KrakenClient.MAX_FILE_BYTES) {
      const mb = (st.size / (1024 * 1024)).toFixed(1);
      return { success: false, error: `file too large (${mb} MB exceeds Kraken.io maximum limit of 100 MB): ${input}`, _status: 0 };
    }
    let bytes;
    try {
      bytes = fs.readFileSync(input);
    } catch (e) {
      const why = e.code === 'ENOENT' ? 'file not found' : e.code === 'EACCES' ? 'permission denied' : e.message;
      return { success: false, error: `${why}: ${input}`, _status: 0 };
    }
    return this._post(restore ? '/v1/upload/restore' : '/v1/upload', body, {
      bytes,
      name: path.basename(input),
    });
  }

  async status() {
    return this._post('/user_status', { auth: this.auth });
  }

  // Download a kraked_url to `dest`. Streams directly to disk via a temp file +
  // atomic rename so an interrupted download can never leave a truncated image
  // behind, and memory is not held up buffering large images.
  async download(url, dest) {
    // The URL comes from the API response, so it decides what this machine
    // fetches. Refuse anything that isn't HTTPS rather than follow a downgrade
    // or an unexpected scheme into the local network.
    let parsed;
    try { parsed = new URL(url); }
    catch { throw new Error(`download failed (malformed result URL)`); }
    // Loopback is exempt: it cannot be intercepted on the network, and the test
    // suite serves real responses over plain HTTP from 127.0.0.1.
    const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      throw new Error(
        `refusing to download over ${parsed.protocol.replace(':', '')} — results must be served over HTTPS`,
      );
    }

    const res = await this._fetch(parsed.href, {});
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
    const full = path.resolve(dest);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    // An unpredictable name opened with 'wx' (O_CREAT|O_EXCL): if anything is
    // already at that path — including a symlink someone planted in a shared
    // output directory — the write fails instead of following it.
    const tmp = `${full}.krakenio-${crypto.randomBytes(8).toString('hex')}.part`;
    let bytes = 0;
    try {
      const fileStream = fs.createWriteStream(tmp, { flags: 'wx' });
      const source = res.body ? Readable.fromWeb(res.body) : Readable.from([]);
      await pipeline(source, fileStream);
      bytes = fs.statSync(tmp).size;
      fs.renameSync(tmp, full);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
      throw e;
    }
    return bytes;
  }
}
