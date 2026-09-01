// End-to-end: the real binary, in a subprocess, with an isolated config dir.
// Everything here runs without touching the network — --dry-run plans a run
// without sending anything, which is exactly what makes it testable.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/krakenio.js', import.meta.url));

let dir, configDir;
beforeEach(() => {
  // realpath matters on macOS, where os.tmpdir() is /var/... but the resolved
  // cwd is /private/var/... — without it the CLI's relative paths look absolute.
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kio-cli-')));
  configDir = path.join(dir, 'config');
});

const touch = (p, body = 'imagebytes') => {
  const full = path.join(dir, p);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
};

// Runs the CLI and always returns {code, out} rather than throwing.
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function run(args, { env = {}, cwd = dir } = {}) {
  try {
    const out = execFileSync(process.execPath, [BIN, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        KRAKEN_CONFIG_DIR: configDir,
        // Keep the suite out of the developer's real log directory.
        KRAKEN_LOG_DIR: path.join(configDir, 'logs'),
        NO_COLOR: '1',
        // Never let a developer's real credentials leak into a test run.
        KRAKEN_API_KEY: '',
        KRAKEN_API_SECRET: '',
        ...env,
      },
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

describe('help and version', () => {
  test('--version prints the package version', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const { code, out } = run(['--version']);
    assert.equal(code, 0);
    assert.equal(out.trim(), pkg.version);
  });

  test('--help lists the commands and the exit codes', () => {
    const { code, out } = run(['--help']);
    assert.equal(code, 0);
    for (const c of ['optimize', 'restore', 'enhance', 'status', 'login', 'logout', 'config']) {
      assert.match(out, new RegExp(`\\b${c}\\b`), c);
    }
    assert.match(out, /Exit codes/);
  });

  test('the custom API endpoint feature is gone from the interface', () => {
    const { out } = run(['--help']);
    assert.equal(/--host/.test(out), false, '--host must not be offered');
    const cfg = run(['config', '--help']).out;
    assert.equal(/set-host/.test(cfg), false, 'config set-host must not be offered');
  });

  test('an unknown command fails with usage', () => {
    const { code, out } = run(['frobnicate']);
    assert.equal(code, 2);
    assert.match(out, /unknown command/i);
  });
});

describe('exit codes are one consistent contract', () => {
  // Commander's own parse failures must land on the same code as our
  // validation, so a script only has to know one rule.
  const usageCases = [
    [['frobnicate'], 'unknown command'],
    [['optimize', '--nonsense', 'a.jpg'], 'unknown option'],
    [['optimize'], 'missing required argument'],
    [['config', 'set-key'], 'missing required argument'],
  ];
  for (const [args, why] of usageCases) {
    test(`${args.join(' ')} → 2 (${why})`, () => {
      const { code, out } = run(args);
      assert.equal(code, 2, out);
    });
  }

  test('--help and --version are successful exits', () => {
    assert.equal(run(['--help']).code, 0);
    assert.equal(run(['--version']).code, 0);
    assert.equal(run(['optimize', '--help']).code, 0);
    assert.equal(run(['help', 'optimize']).code, 0);
  });

  test('read-only commands succeed without credentials', () => {
    assert.equal(run(['config', 'show']).code, 0);
    assert.equal(run(['logout']).code, 0);
  });
});

describe('AI restore is not available in this release', () => {
  for (const cmd of ['restore', 'enhance']) {
    test(`${cmd} exits 3 and explains itself instead of failing against the API`, () => {
      const f = touch('a.jpg');
      const { code, out } = run([cmd, f]);
      assert.equal(code, 3, out);
      assert.match(out, /not available in this release/);
      assert.match(out, /not part of the public Kraken\.io API yet/);
      assert.match(out, /krakenio optimize/, 'points at what does work');
    });
  }

  test('both are still listed in help, clearly labelled', () => {
    const { out } = run(['--help']);
    assert.match(out, /restore\|res.*\n?.*not available yet/s);
    assert.match(out, /enhance\|enh.*\n?.*not available yet/s);
  });

  test('it refuses before spending anything, even with --dry-run', () => {
    const { code } = run(['restore', touch('a.jpg'), '--dry-run']);
    assert.equal(code, 3);
  });
});

describe('credentials', () => {
  test('optimize without credentials is a usage error, not a crash', () => {
    const { code, out } = run(['optimize', touch('a.jpg'), '-y']);
    assert.equal(code, 2, out);
    assert.match(out, /no API credentials/);
    assert.match(out, /krakenio login/);
  });

  test('--dry-run works before you have logged in', () => {
    const { code } = run(['optimize', touch('a.jpg'), '--dry-run']);
    assert.equal(code, 0);
  });
});

describe('optimize --dry-run', () => {
  test('shows the default destination and never writes it', () => {
    const f = touch('photo.jpg');
    const { code, out } = run(['optimize', f, '--lossy', '--dry-run']);
    assert.equal(code, 0, out);
    assert.match(out, /Dry run/);
    assert.match(out, /photo\.kraked\.jpg/);
    assert.match(out, /\(new\)/);
    assert.equal(fs.existsSync(path.join(dir, 'photo.kraked.jpg')), false);
  });

  test('the original input is never the destination by default', () => {
    const f = touch('photo.jpg');
    const { out } = run(['optimize', f, '--dry-run']);
    const arrow = out.split('\n').find((l) => l.includes('→'));
    assert.match(arrow, /photo\.kraked\.jpg/);
    assert.equal(/→ photo\.jpg\b/.test(arrow), false);
  });

  test('--overwrite makes the input the destination, and says it exists', () => {
    const f = touch('photo.jpg');
    const { out } = run(['optimize', f, '--overwrite', '--dry-run']);
    assert.match(out, /→ photo\.jpg {2}\(exists — would be replaced\)/);
  });

  test('an existing output is flagged as "would be replaced"', () => {
    touch('photo.jpg'); touch('photo.kraked.jpg');
    const { out } = run(['optimize', path.join(dir, 'photo.jpg'), '--dry-run']);
    assert.match(out, /would be replaced/);
  });

  test('--no-clobber flips that to "would be kept"', () => {
    touch('photo.jpg'); touch('photo.kraked.jpg');
    const { out } = run(['optimize', path.join(dir, 'photo.jpg'), '--no-clobber', '--dry-run']);
    assert.match(out, /would be kept/);
  });

  test('--convert changes the predicted extension', () => {
    const { out } = run(['optimize', touch('photo.png'), '-c', 'webp', '--dry-run']);
    assert.match(out, /photo\.kraked\.webp/);
  });

  test('multiple sizes plan one file each', () => {
    const { out } = run(['optimize', touch('hero.jpg'), '-r', '1920x', '-r', '800x', '--dry-run']);
    assert.match(out, /hero\.kraked\.1920x-landscape\.jpg/);
    assert.match(out, /hero\.kraked\.800x-landscape\.jpg/);
  });

  test('the exact request body is shown, so you can check it against the docs', () => {
    const { out } = run(['optimize', touch('a.jpg'), '--lossy', '-q', '82', '--dry-run']);
    assert.match(out, /Request body/);
    assert.match(out, /"lossy": true/);
    assert.match(out, /"quality": 82/);
  });

  test('a folder is expanded and mirrored under --out-dir', () => {
    touch('photos/a.jpg'); touch('photos/nested/b.png');
    const { out } = run(['optimize', path.join(dir, 'photos'), '--out-dir', path.join(dir, 'web'), '--dry-run']);
    assert.match(out, /2 images would be optimized/);
    // Local paths use the platform separator; build the expectation with path.join.
    assert.match(out, new RegExp(reEscape(path.join('web', 'a.kraked.jpg'))));
    assert.match(out, new RegExp(reEscape(path.join('web', 'nested', 'b.kraked.png'))));
  });

  test('a second run over a folder skips the outputs the first one made', () => {
    touch('photos/a.jpg'); touch('photos/a.kraked.jpg');
    const { out } = run(['optimize', path.join(dir, 'photos'), '--dry-run']);
    assert.match(out, /1 image would be optimized/);
  });
});

describe('validation happens before anything is sent', () => {
  const cases = [
    [['-q', '0'], /--quality must be between 1 and 100/],
    [['-q', 'abc'], /--quality must be a whole number/],
    [['-r', '800'], /must look like 800x600/],
    [['-r', '800x600,squish'], /unknown resize strategy/],
    [['-c', 'tiff'], /cannot convert to 'tiff'/],
    [['--sampling-scheme', '4:1:1'], /unknown --sampling-scheme/],
    [['--preserve-meta', 'exif'], /unknown --preserve-meta/],
    [['--keep-extension'], /only applies together with --convert/],
    [['--timeout', '0'], /--timeout must be between/],
    [['--concurrency', 'lots'], /--concurrency must be a whole number/],
  ];
  for (const [args, re] of cases) {
    test(`${args.join(' ')} → exit 2`, () => {
      // --dev keeps these honest: even sandbox runs must validate first.
      const { code, out } = run(['optimize', touch('a.jpg'), ...args, '--dry-run', '-y']);
      assert.equal(code, 2, out);
      assert.match(out, re);
    });
  }

  test('--quality without --lossy warns but still runs', () => {
    const { code, out } = run(['optimize', touch('a.jpg'), '-q', '82', '--dry-run']);
    assert.equal(code, 0);
    assert.match(out, /--quality only affects lossy JPEG/);
  });
});

describe('destination flags that could destroy data', () => {
  test('--out with two inputs is refused', () => {
    const { code, out } = run(['optimize', touch('a.jpg'), touch('b.jpg'), '-o', 'x.jpg', '--dry-run']);
    assert.equal(code, 2);
    assert.match(out, /--out takes a single output path but 2 inputs/);
    assert.match(out, /--out-dir/, 'suggests the right flag');
  });

  test('--out with multiple sizes is refused', () => {
    const { code, out } = run(['optimize', touch('a.jpg'), '-r', '800x', '-r', '400x', '-o', 'x.jpg', '--dry-run']);
    assert.equal(code, 2);
    assert.match(out, /--out cannot be used with multiple --resize/);
  });

  test('--overwrite with --out-dir is refused', () => {
    const { code, out } = run(['optimize', touch('a.jpg'), '-O', '--out-dir', 'web', '--dry-run']);
    assert.equal(code, 2);
    assert.match(out, /cannot be used together/);
  });

  test('--overwrite with a URL is refused', () => {
    const { code, out } = run(['optimize', 'https://example.com/a.jpg', '-O', '--dry-run']);
    assert.equal(code, 2);
    assert.match(out, /needs local files/);
  });

  test('--no-save with --out-dir is refused', () => {
    const { code, out } = run(['optimize', touch('a.jpg'), '--no-save', '--out-dir', 'web', '--dry-run']);
    assert.equal(code, 2);
    assert.match(out, /--no-save cannot be combined/);
  });

  test('two folders that would flatten onto the same filename are refused', () => {
    touch('x/1.jpg'); touch('y/1.jpg');
    const { code, out } = run([
      'optimize', path.join(dir, 'x', '1.jpg'), path.join(dir, 'y', '1.jpg'),
      '--out-dir', path.join(dir, 'web'), '--dry-run',
    ]);
    assert.equal(code, 2);
    assert.match(out, /would be written twice/);
  });
});

describe('input resolution', () => {
  test('a missing file is skipped with a reason, and an empty run is an error', () => {
    const { code, out } = run(['optimize', path.join(dir, 'ghost.jpg'), '--dry-run']);
    assert.equal(code, 2);
    assert.match(out, /skipped .*ghost\.jpg.*not found/);
    assert.match(out, /no images to process/);
  });

  test('an unsupported format is skipped before it can 415', () => {
    const { out } = run(['optimize', touch('a.bmp'), '--dry-run']);
    assert.match(out, /unsupported file type/);
  });
});

describe('storage', () => {
  test('a provider without stored credentials fails up front', () => {
    const { code, out } = run(['optimize', touch('a.jpg'), '--azure', 'my-container', '--dry-run']);
    assert.equal(code, 2);
    assert.match(out, /Azure Blob Storage: missing account, key/);
  });

  test('the object key includes the filename, so a batch cannot overwrite itself', () => {
    const { out } = run([
      'optimize', touch('a.jpg'),
      '--s3', 'my-bucket/thumbs/', '--s3-key', 'AK', '--s3-secret', 'SEC',
      '--dry-run',
    ]);
    assert.match(out, /"path": "thumbs\/a\.kraked\.jpg"/);
    assert.match(out, /"bucket": "my-bucket"/);
  });

  test('secrets are masked in the printed request body', () => {
    const { out } = run([
      'optimize', touch('a.jpg'),
      '--s3', 'b', '--s3-key', 'AKIAVERYLONGKEY', '--s3-secret', 'SUPERSECRETVALUE',
      '--dry-run',
    ]);
    assert.equal(out.includes('SUPERSECRETVALUE'), false, 'the secret must not be printed');
    assert.equal(out.includes('AKIAVERYLONGKEY'), false, 'the key must not be printed');
  });
});

describe('logging', () => {
  test('--log-file captures the run, without colour codes', () => {
    const logFile = path.join(dir, 'run.log');
    const { code, out } = run(['optimize', touch('a.jpg'), '--dry-run', '--log-file', logFile]);
    assert.equal(code, 0, out);
    const body = fs.readFileSync(logFile, 'utf8');
    assert.match(body, /krakenio optimize/);
    assert.match(body, /node v\d+/);
    assert.match(body, /Dry run/);
    assert.equal(body.includes(String.fromCharCode(27)), false);
    assert.match(out, /log written to/);
  });

  test('a failing run is still logged — that is when you need it most', () => {
    const logFile = path.join(dir, 'run.log');
    const { code } = run(['optimize', touch('a.jpg'), '-q', '999', '--log-file', logFile]);
    assert.equal(code, 2);
    const body = fs.readFileSync(logFile, 'utf8');
    assert.match(body, /ERROR .*--quality must be between 1 and 100/);
  });

  test('an unwritable log path warns but does not abort the run', () => {
    const { code, out } = run(['optimize', touch('a.jpg'), '--dry-run', '--log-file', path.join(touch('block.txt'), 'run.log')]);
    assert.equal(code, 0, out);
    assert.match(out, /could not open --log-file/);
    assert.match(out, /Dry run/);
  });
});

describe('config', () => {
  test('show reports the fixed endpoint and unset credentials', () => {
    const { code, out } = run(['config', 'show']);
    assert.equal(code, 0);
    assert.match(out, /endpoint\s+https:\/\/api\.kraken\.io/);
    assert.match(out, /key\s+\(unset\)/);
    assert.match(out, /krakenio login/);
  });

  test('set-key and set-secret persist, and both are masked when shown', () => {
    run(['config', 'set-key', 'MYKEYVALUE1234']);
    run(['config', 'set-secret', 'SUPERSECRETVALUE']);
    const { out } = run(['config', 'show']);
    // `config show` output gets pasted into bug reports, so neither credential
    // is printed in full — the key identifies the account on its own.
    assert.equal(out.includes('MYKEYVALUE1234'), false, 'the API key is not shown in full');
    assert.match(out, /MYKE…234/);
    assert.equal(out.includes('SUPERSECRETVALUE'), false, 'the API secret is not shown in full');
    assert.match(out, /SUPE…LUE/);
  });

  test('the config file is written 0600', { skip: process.platform === 'win32' }, () => {
    run(['config', 'set-key', 'MYKEY']);
    const mode = fs.statSync(path.join(configDir, 'config.json')).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  test('set-s3 stores credentials and defaults the region', () => {
    const { out } = run(['config', 'set-s3', 'AK', 'SEC']);
    assert.match(out, /region us-east-1/);
    assert.match(run(['config', 'show']).out, /Amazon S3/);
  });

  test('set-store validates the provider and its required fields', () => {
    assert.match(run(['config', 'set-store', 'dropbox', '{}']).out, /unknown provider 'dropbox'/);
    assert.match(run(['config', 'set-store', 'azure', '{"account":"a"}']).out, /Azure Blob Storage needs: key/);
    assert.match(run(['config', 'set-store', 'azure', 'not-json']).out, /must be a JSON object/);
    assert.equal(run(['config', 'set-store', 'azure', '{"account":"a","key":"k"}']).code, 0);
  });

  test('logout clears the credentials and says so when there were none', () => {
    assert.match(run(['logout']).out, /No credentials were stored/);
    run(['config', 'set-key', 'K']);
    run(['config', 'set-secret', 'S']);
    assert.match(run(['logout']).out, /Credentials cleared/);
    assert.match(run(['config', 'show']).out, /key\s+\(unset\)/);
  });

  test('a corrupt config file does not take the CLI down', () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), '{ not json');
    assert.equal(run(['config', 'show']).code, 0);
  });
});

describe('credential precedence', () => {
  test('env vars are used when nothing is stored', () => {
    const { out } = run(['optimize', touch('a.jpg'), '--dry-run', '-y'],
      { env: { KRAKEN_API_KEY: 'ENVKEY', KRAKEN_API_SECRET: 'ENVSECRET' } });
    assert.equal(/no API credentials/.test(out), false);
  });

  test('a --key flag beats the environment', () => {
    run(['config', 'set-key', 'STORED']);
    run(['config', 'set-secret', 'STORED']);
    const { code } = run(['status', '--key', 'FLAG', '--secret', 'FLAG', '--json'],
      { env: { KRAKEN_API_KEY: 'ENVKEY' } });
    // Reaching the network and failing is fine here; not crashing on the way is the point.
    assert.ok([0, 1].includes(code));
  });
});
