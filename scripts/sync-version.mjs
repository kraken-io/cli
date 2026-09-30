#!/usr/bin/env node
// Propagates package.json's version into the other files that carry it.
//
// Run automatically by the `version` npm lifecycle hook, which fires after the
// bump and before the release commit — so everything this touches is staged
// into that one commit. package.json stays the single source of truth; nothing
// here invents a version of its own.
//
//   node scripts/sync-version.mjs [--check]
//
// --check reports what is out of sync and exits 1 instead of writing. It asserts
// what must be true at any commit — the formula points at this version, and the
// changelog has a section for it — but not the release date, which is stamped
// when the release is actually cut.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const check = process.argv.includes('--check');

const { name, version } = JSON.parse(read('package.json'));
const today = new Date().toISOString().slice(0, 10);
const edits = [];

// 1. The Homebrew formula pins the exact npm tarball. The checksum can only be
//    known after `npm publish`, so reset it to the placeholder that
//    scripts/brew-sha256.sh fills in — never leave the previous release's.
const FORMULA = 'Formula/krakenio-cli.rb';
const PLACEHOLDER = '0'.repeat(64);
{
  const before = read(FORMULA);
  const pkgBase = name.startsWith('@') ? name.split('/')[1] : name;
  const after = before
    .replace(/url "https:\/\/registry\.npmjs\.org\/.*?\.tgz"/,
      `url "https://registry.npmjs.org/${name}/-/${pkgBase}-${version}.tgz"`)
    .replace(/sha256 "[0-9a-f]{64}"/, `sha256 "${PLACEHOLDER}"`);
  if (after !== before) edits.push([FORMULA, after]);
}

// 2. Stamp the changelog heading for this version with today's date, if the
//    section exists and is not dated yet. A missing section is a release-blocker
//    rather than something to generate: what changed is for a human to write.
const CHANGELOG = 'CHANGELOG.md';
{
  const before = read(CHANGELOG);
  const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\](.*)$`, 'm');
  const m = heading.exec(before);
  if (!m) {
    console.error(`${CHANGELOG} has no "## [${version}]" section — write the release notes first.`);
    process.exit(1);
  }
  // The date is stamped when the release is cut, not carried as an invariant:
  // --check would otherwise report every already-shipped version as drift.
  if (!check && !m[1].trim()) {
    edits.push([CHANGELOG, before.replace(heading, `## [${version}] — ${today}`)]);
  }
}

if (check) {
  if (!edits.length) {
    console.log(`in sync at v${version}`);
    process.exit(0);
  }
  for (const [file] of edits) console.error(`out of sync: ${file}`);
  console.error('\nRun `node scripts/sync-version.mjs` to fix.');
  process.exit(1);
}

for (const [file, body] of edits) {
  fs.writeFileSync(path.join(root, file), body);
  console.log(`updated ${file} → ${version}`);
}
if (!edits.length) console.log(`already in sync at v${version}`);
