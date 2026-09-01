# Releasing

Two distribution channels: **npm** (the source of truth) and **Homebrew** (a
formula that installs the published npm tarball). Homebrew always follows npm,
never the other way round.

## 1. Prepare

```bash
npm run lint      # syntax-check every source file
npm test          # the full suite — no network required
```

Update `CHANGELOG.md` with a new version section, then bump the version. This
creates the commit and the `v0.3.1` tag in one step:

```bash
npm version patch     # or: minor | major
```

Check what will actually ship — the tarball must contain `bin/`, `src/`,
`README.md`, `CHANGELOG.md` and `LICENSE`, and nothing else:

```bash
npm pack --dry-run
```

## 2. Verify the tarball before publishing

Install the real artifact into a scratch directory and run it. This catches
missing `files` entries, a bad shebang and broken imports — the failures that
only appear once the package leaves the repo.

```bash
npm pack
mkdir -p /tmp/krakenio-verify && cd /tmp/krakenio-verify
npm install "$OLDPWD"/krakenio-cli-*.tgz
./node_modules/.bin/krakenio --version
echo x > photo.jpg && ./node_modules/.bin/krakenio optimize photo.jpg --dry-run
```

## 3. Publish to npm

Pushing the tag is the publish. `.github/workflows/publish.yml` fires on
`v*.*.*`, and before it publishes it checks that the tag matches
`package.json`, that the version is not already on the registry, that
`CHANGELOG.md` has a section for it, and that lint and the suite pass.

```bash
./scripts/release.sh patch --push     # bump, tag, push — CI publishes
```

It needs one secret: `NPM_TOKEN`, an npm **Automation** token (Automation
bypasses 2FA, which a CI publish cannot answer interactively). Add it under
Settings → Secrets and variables → Actions.

Only a tag triggers it, so a merge to `main` can never ship a release by
accident. To publish by hand instead — the first release, or if CI is down:

```bash
npm publish            # prepublishOnly runs lint + tests again
git push --follow-tags
```

## 4. Update the Homebrew formula

The formula pins the exact npm tarball and its checksum, so it can only be
updated after the publish has landed.

```bash
./scripts/brew-sha256.sh
```

Paste the printed `url` and `sha256` into `Formula/krakenio-cli.rb`, then verify
locally before pushing to the tap:

```bash
brew install --formula --build-from-source ./Formula/krakenio-cli.rb
brew test krakenio-cli
brew audit --strict --formula ./Formula/krakenio-cli.rb
brew uninstall krakenio-cli
```

Commit the formula to the tap repository (`kraken-io/homebrew-tap`), which makes
`brew install kraken-io/tap/krakenio-cli` resolve to the new version.

## Enabling AI restore

`restore` and `enhance` are complete but gated, because the
`/v1/upload/restore` and `/v1/url/restore` endpoints are not part of the public
API yet. When they ship:

1. Set `RESTORE_AVAILABLE = true` in `src/commands.js`.
2. Drop the "not available" expectations in `test/cli.test.js` and
   `test/commands.test.js`, and add live coverage for the new endpoints.
3. Move the **Not available yet** section of `README.md` into the main command
   documentation.

Nothing else changes: the flags, request bodies, output naming (`.restored`,
`.enhanced`) and their tests are already in place.
