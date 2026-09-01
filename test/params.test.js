// Request-body construction and the validation that guards it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  UsageError, toInt, toFloat, parseResize, buildResize, parseConvert,
  buildOptimizeParams, buildRestoreParams, buildEnhanceParams,
  buildStorage, splitStorageTarget, assertStorageUsable, predictExt,
  RESIZE_STRATEGIES, CONVERT_FORMATS, SAMPLING_SCHEMES,
  parseTypes, scanExts,
} from '../src/params.js';

const usage = (fn, re) => assert.throws(fn, (e) => e instanceof UsageError && (!re || re.test(e.message)));

describe('numbers', () => {
  test('toInt accepts whole numbers in range', () => {
    assert.equal(toInt('82', '--quality', { min: 1, max: 100 }), 82);
    assert.equal(toInt(5, '--concurrency', { min: 1 }), 5);
  });

  test('toInt rejects junk instead of sending NaN to the API', () => {
    usage(() => toInt('abc', '--quality'), /whole number/);
    usage(() => toInt('82.5', '--quality'), /whole number/);
    usage(() => toInt('', '--quality'), /whole number/);
    usage(() => toInt('1e3', '--quality'), /whole number/);
  });

  test('toInt enforces bounds', () => {
    usage(() => toInt('0', '--quality', { min: 1, max: 100 }), /between 1 and 100/);
    usage(() => toInt('101', '--quality', { min: 1, max: 100 }), /between 1 and 100/);
  });

  test('toFloat accepts fractions, rejects junk and out-of-range', () => {
    assert.equal(toFloat('0.7', '--strength', { min: 0, max: 1 }), 0.7);
    usage(() => toFloat('abc', '--strength'), /must be a number/);
    usage(() => toFloat('1.5', '--strength', { min: 0, max: 1 }), /between 0 and 1/);
    // Infinity parses as a Number but is not a usable value.
    usage(() => toFloat('Infinity', '--strength', { min: 0, max: 1 }), /must be a number/);
    usage(() => toFloat('NaN', '--strength', { min: 0, max: 1 }), /must be a number/);
  });
});

describe('parseResize', () => {
  test('both dimensions default to the auto strategy', () => {
    assert.deepEqual(parseResize('800x600'), { width: 800, height: 600, strategy: 'auto' });
  });

  test('an explicit strategy wins and is case-insensitive', () => {
    assert.deepEqual(parseResize('800x600,FIT'), { width: 800, height: 600, strategy: 'fit' });
  });

  test('a lone width means "this wide, keep the ratio" (landscape)', () => {
    assert.deepEqual(parseResize('1200x'), { width: 1200, strategy: 'landscape' });
  });

  test('a lone height means portrait', () => {
    assert.deepEqual(parseResize('x800'), { height: 800, strategy: 'portrait' });
  });

  test('every documented strategy is accepted', () => {
    for (const s of RESIZE_STRATEGIES) {
      // square takes one size, so give it a square box.
      const dims = s === 'square' ? '600x600' : '800x600';
      assert.equal(parseResize(`${dims},${s}`).strategy, s, s);
    }
  });

  test("the 'square' strategy sends a single size, which is what the API wants", () => {
    // width/height with square gets a 422: "For 'square' strategy image size must be set".
    assert.deepEqual(parseResize('400,square'), { strategy: 'square', size: 400 });
    assert.deepEqual(parseResize('400x400,square'), { strategy: 'square', size: 400 });
    assert.deepEqual(parseResize('400x,square'), { strategy: 'square', size: 400 });
    assert.deepEqual(parseResize('x400,square'), { strategy: 'square', size: 400 });
    for (const r of [parseResize('400,square'), parseResize('400x400,square')]) {
      assert.equal(r.width, undefined);
      assert.equal(r.height, undefined);
    }
  });

  test('square rejects two different sizes and none at all', () => {
    usage(() => parseResize('400x300,square'), /takes one size, but .* gives two different/);
    usage(() => parseResize('x,square'), /needs a size/);
  });

  test('a bare number without ,square is still an error', () => {
    usage(() => parseResize('400'), /must look like/);
  });

  test('unknown strategies are rejected with the valid list', () => {
    usage(() => parseResize('800x600,squish'), /unknown resize strategy 'squish'.*square/s);
  });

  test('malformed specs are rejected', () => {
    usage(() => parseResize('800'), /must look like/);
    usage(() => parseResize('x'), /needs a width, a height, or both/);
    usage(() => parseResize('800x600,fit,extra'), /too many parts/);
    usage(() => parseResize('-800x600'), /must be between/);
    usage(() => parseResize('axb'), /whole number/);
  });

  test('strategies that need both dimensions say so', () => {
    for (const s of ['exact', 'fit', 'crop', 'fill', 'auto']) {
      usage(() => parseResize(`800x,${s}`), /needs both a width and a height/);
    }
    // portrait/landscape are exactly the one-dimension strategies
    assert.deepEqual(parseResize('800x,landscape'), { width: 800, strategy: 'landscape' });
    assert.deepEqual(parseResize('x800,portrait'), { height: 800, strategy: 'portrait' });
  });
});

describe('buildResize', () => {
  test('no resize flags produce no resize key', () => {
    assert.equal(buildResize([]), null);
    assert.equal(buildResize(undefined), null);
  });

  test('a single size stays an object', () => {
    assert.deepEqual(buildResize(['800x600,fit']), { width: 800, height: 600, strategy: 'fit' });
  });

  test('several sizes become an array, each with a unique id and a strategy', () => {
    const r = buildResize(['1920x', '800x', '400x']);
    assert.ok(Array.isArray(r));
    assert.deepEqual(r.map((x) => x.id), ['1920x-landscape', '800x-landscape', '400x-landscape']);
    // The API requires a strategy on every entry of an image set.
    assert.ok(r.every((x) => RESIZE_STRATEGIES.includes(x.strategy)));
  });

  test('a square entry gets a readable id from its size', () => {
    const r = buildResize(['400,square', '800x']);
    assert.deepEqual(r.map((x) => x.id), ['400-square', '800x-landscape']);
  });

  test('duplicate sizes still get unique ids', () => {
    const r = buildResize(['800x', '800x', '800x']);
    assert.deepEqual(r.map((x) => x.id), ['800x-landscape', '800x-landscape-2', '800x-landscape-3']);
    assert.equal(new Set(r.map((x) => x.id)).size, 3);
  });
});

describe('parseConvert', () => {
  test('every documented format is accepted', () => {
    for (const f of CONVERT_FORMATS) assert.deepEqual(parseConvert(f), { format: f });
  });

  test('jpg is normalized to jpeg', () => {
    assert.deepEqual(parseConvert('JPG'), { format: 'jpeg' });
  });

  test('background is optional and trimmed', () => {
    assert.deepEqual(parseConvert('png,#ffffff'), { format: 'png', background: '#ffffff' });
    assert.deepEqual(parseConvert('png,'), { format: 'png' });
  });

  test('unsupported formats are rejected', () => {
    usage(() => parseConvert('tiff'), /cannot convert to 'tiff'/);
    usage(() => parseConvert('webp,#fff,extra'), /too many parts/);
  });
});

describe('buildOptimizeParams', () => {
  test('the default request is minimal — lossless, nothing else', () => {
    assert.deepEqual(buildOptimizeParams({}), {});
  });

  test('full option set', () => {
    const p = buildOptimizeParams({
      lossy: true, quality: '82', convert: 'webp', resize: ['800x600,fit'],
      autoOrient: true, samplingScheme: '4:4:4', preserveMeta: 'profile, date',
    });
    assert.deepEqual(p, {
      lossy: true,
      quality: 82,
      convert: { format: 'webp' },
      auto_orient: true,
      sampling_scheme: '4:4:4',
      preserve_meta: ['profile', 'date'],
      resize: { width: 800, height: 600, strategy: 'fit' },
    });
  });

  test('every documented sampling scheme is accepted, others are not', () => {
    for (const s of SAMPLING_SCHEMES) {
      assert.equal(buildOptimizeParams({ samplingScheme: s }).sampling_scheme, s);
    }
    usage(() => buildOptimizeParams({ samplingScheme: '4:1:1' }), /unknown --sampling-scheme/);
  });

  test('preserve_meta values are validated against the documented list', () => {
    usage(() => buildOptimizeParams({ preserveMeta: 'profile,exif' }), /unknown --preserve-meta value\(s\): exif/);
    usage(() => buildOptimizeParams({ preserveMeta: ' , ' }), /at least one field/);
  });

  test('keep-extension requires a conversion', () => {
    usage(() => buildOptimizeParams({ keepExtension: true }), /only applies together with --convert/);
    const p = buildOptimizeParams({ convert: 'webp', keepExtension: true });
    assert.deepEqual(p.convert, { format: 'webp', keep_extension: true });
  });

  test('dev mode rides along as a top-level flag', () => {
    assert.deepEqual(buildOptimizeParams({ dev: true }), { dev: true });
  });
});

describe('storage targets', () => {
  test('bucket only — the filename becomes the object key', () => {
    assert.deepEqual(splitStorageTarget('my-bucket', '--s3'), { container: 'my-bucket', prefix: '', exactPath: null });
  });

  test('a trailing slash is a prefix', () => {
    assert.deepEqual(splitStorageTarget('my-bucket/thumbs/', '--s3'),
      { container: 'my-bucket', prefix: 'thumbs/', exactPath: null });
  });

  test('a directory-looking tail is treated as a prefix', () => {
    assert.deepEqual(splitStorageTarget('my-bucket/a/b', '--s3'),
      { container: 'my-bucket', prefix: 'a/b/', exactPath: null });
  });

  test('a tail with an extension is an exact object key', () => {
    assert.deepEqual(splitStorageTarget('my-bucket/a/final.jpg', '--s3'),
      { container: 'my-bucket', prefix: 'a/', exactPath: 'a/final.jpg' });
  });

  test('an empty target is rejected', () => {
    usage(() => splitStorageTarget('', '--s3'), /needs a bucket or container/);
    usage(() => splitStorageTarget('/', '--s3'), /needs a bucket or container/);
  });
});

describe('buildStorage', () => {
  const s3 = { s3: 'my-bucket/thumbs/', s3Key: 'AK', s3Secret: 'SEC', s3Region: 'eu-central-1' };

  test('the object key includes the output filename, so a batch cannot collide', () => {
    const a = buildStorage(s3, { outName: 'a.kraked.jpg' });
    const b = buildStorage(s3, { outName: 'b.kraked.jpg' });
    assert.equal(a.s3_store.path, 'thumbs/a.kraked.jpg');
    assert.equal(b.s3_store.path, 'thumbs/b.kraked.jpg');
    assert.notEqual(a.s3_store.path, b.s3_store.path);
  });

  test('credentials and bucket land in the documented fields', () => {
    const { s3_store } = buildStorage(s3, { outName: 'a.jpg' });
    assert.deepEqual(s3_store, {
      key: 'AK', secret: 'SEC', region: 'eu-central-1', bucket: 'my-bucket', path: 'thumbs/a.jpg',
    });
  });

  test('an exact key is used verbatim', () => {
    const { s3_store } = buildStorage({ ...s3, s3: 'my-bucket/final.webp' }, { outName: 'ignored.jpg' });
    assert.equal(s3_store.path, 'final.webp');
  });

  test('--store merges a raw provider object', () => {
    const g = buildStorage({ store: '{"gcs_store":{"bucket":"b"}}' });
    assert.deepEqual(g.gcs_store, { bucket: 'b' });
  });

  test('--store rejects non-objects and bad JSON', () => {
    usage(() => buildStorage({ store: 'nope' }), /JSON object or @file/);
    usage(() => buildStorage({ store: '[1,2]' }), /must be a JSON object/);
  });

  test('--store reads @file.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kio-store-'));
    const file = path.join(dir, 'store.json');
    fs.writeFileSync(file, '{"azure_store":{"container":"c"}}');
    assert.deepEqual(buildStorage({ store: '@' + file }).azure_store, { container: 'c' });
    usage(() => buildStorage({ store: '@' + path.join(dir, 'missing.json') }), /could not read --store file/);
  });

  test('a provider named without credentials fails before any request', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kio-cfg-'));
    const prev = process.env.KRAKEN_CONFIG_DIR;
    process.env.KRAKEN_CONFIG_DIR = dir;
    try {
      usage(() => assertStorageUsable({ azure: 'my-container' }), /Azure Blob Storage: missing account, key/);
      usage(() => assertStorageUsable({ cf: 'my-container' }), /Rackspace Cloud Files: missing user, key/);
      usage(() => assertStorageUsable({ sl: 'my-container' }), /SoftLayer.*missing user, key, region/);
      usage(() => assertStorageUsable({ gcs: 'my-bucket' }), /Google Cloud Storage: missing credentials/);
    } finally {
      if (prev === undefined) delete process.env.KRAKEN_CONFIG_DIR; else process.env.KRAKEN_CONFIG_DIR = prev;
    }
  });
});

describe('AI restore params (endpoint not public yet, but kept correct)', () => {
  test('no options means restore:true', () => {
    assert.deepEqual(buildRestoreParams({}), { restore: true });
  });

  test('options nest under restore', () => {
    assert.deepEqual(buildRestoreParams({ strategy: 'Face', scale: '4' }), { restore: { strategy: 'face', scale: 4 } });
  });

  test('width/height and dev', () => {
    assert.deepEqual(buildRestoreParams({ width: '2000', height: '1500', dev: true }),
      { restore: { width: 2000, height: 1500 }, dev: true });
  });

  test('numeric ranges are enforced', () => {
    usage(() => buildRestoreParams({ scale: '8' }), /--scale must be between 2 and 4/);
    usage(() => buildRestoreParams({ denoise: '2' }), /--denoise must be between 0 and 1/);
    usage(() => buildRestoreParams({ strength: 'high' }), /--strength must be a number/);
  });

  test('enhance chains a smart restore with a lossy optimize in one body', () => {
    assert.deepEqual(buildEnhanceParams({}), { restore: { strategy: 'smart' }, lossy: true });
    assert.deepEqual(buildEnhanceParams({ strength: '0.7', scale: '2', quality: '80', convert: 'webp' }), {
      restore: { strategy: 'smart', strength: 0.7, scale: 2 },
      lossy: true,
      quality: 80,
      convert: { format: 'webp' },
    });
  });
});

describe('predictExt', () => {
  test('without a conversion the extension is unchanged', () => {
    assert.equal(predictExt('photo.JPG', {}), '.JPG');
  });

  test('a conversion changes it, and jpeg writes .jpg', () => {
    assert.equal(predictExt('photo.png', { convert: 'webp' }), '.webp');
    assert.equal(predictExt('photo.png', { convert: 'jpeg' }), '.jpg');
  });

  test('--keep-extension keeps the original', () => {
    assert.equal(predictExt('photo.png', { convert: 'webp', keepExtension: true }), '.png');
  });

  test('query strings and extensionless names are handled', () => {
    assert.equal(predictExt('photo.jpg?v=2', {}), '.jpg');
    assert.equal(predictExt('noext', {}), '.img');
  });
});


describe('parseTypes', () => {
  const names = (set) => [...set].sort().join(',');

  test('no --types means the default set', () => {
    assert.equal(parseTypes(undefined), null);
    assert.equal(parseTypes(''), null);
  });

  test('the default set is images only — PDF is opt-in', () => {
    const d = scanExts({});
    assert.ok(d.has('.jpg') && d.has('.png') && d.has('.heic'));
    assert.equal(d.has('.pdf'), false, 'a stray PDF is never scanned by default');
  });

  test('a plain list is the exact set', () => {
    assert.equal(names(parseTypes('jpg,png')), '.jpeg,.jpg,.png');
  });

  test('jpg and jpeg both cover the two extensions', () => {
    assert.equal(names(parseTypes('jpeg')), '.jpeg,.jpg');
    assert.equal(names(parseTypes('jpg')), '.jpeg,.jpg');
  });

  test('heic covers heif too', () => {
    assert.equal(names(parseTypes('heic')), '.heic,.heif');
  });

  test("'+' adds to the defaults instead of replacing them", () => {
    const t = parseTypes('+pdf');
    assert.ok(t.has('.pdf'), 'the added format is there');
    assert.ok(t.has('.jpg') && t.has('.png'), 'the defaults survive');
  });

  test('leading dots and stray whitespace are tolerated', () => {
    assert.equal(names(parseTypes(' .png , jpg ')), '.jpeg,.jpg,.png');
  });

  test('case does not matter', () => {
    assert.equal(names(parseTypes('PNG')), '.png');
  });

  test("'all' is every format the API accepts", () => {
    const t = parseTypes('all');
    assert.ok(t.has('.pdf') && t.has('.svg') && t.has('.avif') && t.has('.heif'));
  });

  test('mixing +format with a plain list is refused rather than guessed at', () => {
    assert.throws(() => parseTypes('jpg,+pdf'), UsageError);
    assert.throws(() => parseTypes('jpg,+pdf'), /cannot mix/);
  });

  test('an unknown format names the valid ones', () => {
    assert.throws(() => parseTypes('tiff'), UsageError);
    assert.throws(() => parseTypes('tiff'), /unknown format for --types: 'tiff'/);
    assert.throws(() => parseTypes('tiff'), /jpg, png, gif, webp, svg, avif, heic, pdf/);
  });

  test('a separator with no format is a usage error, not an empty scan', () => {
    assert.throws(() => parseTypes(','), UsageError);
    assert.throws(() => parseTypes('+'), UsageError);
  });

  test('bmp and tiff are rejected — the API cannot process them', () => {
    assert.throws(() => parseTypes('bmp'), UsageError);
    assert.throws(() => parseTypes('tiff'), UsageError);
  });
});
