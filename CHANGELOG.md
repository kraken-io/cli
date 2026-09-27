# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.2]

### Performance & Memory

- **Streaming downloads direct to disk.** Downloaded images are now piped directly to disk (`Readable.fromWeb` → `fs.createWriteStream`) rather than being buffered entirely in RAM (`arrayBuffer()` + `Buffer.from()`), drastically reducing memory consumption during batch operations.
- **Upload memory sanity check.** File size is now checked via `fs.statSync` before allocating Buffer memory, immediately refusing empty files and files exceeding Kraken.io's maximum supported limit (100 MB) without bloating the process heap.

### Housekeeping

- Cleaned up local workspace and assistant files; added `.claude/`, `.vscode/`, `.idea/` to `.gitignore`.
- Ensured executable bit on release scripts (`scripts/brew-sha256.sh`).

## [0.4.1] — 2026-09-01

### Security

- **Credentials passed as flags are redacted from transcripts.** Every log opens
  with the command line it was invoked as, so `--key`, `--secret`, `--s3-key`,
  `--s3-secret` and an inline `--store` object were written to disk in plaintext.
  Automatic logging (new in 0.4.0) made that the default rather than something
  you opted into. Values are now replaced with `***`; a `--store @file.json`
  reference is kept, since a path is not a secret.
- **Transcripts are owner-only.** Log files are created `0600` in a `0700`
  directory, matching the credential store. They carry local paths and
  `kraked_url` links — which grant access to your results for an hour — and were
  previously world-readable at `0644`. A pre-existing file you point `--log-file`
  at is left with the permissions you gave it.
- **A result id from the API can no longer steer where a file is written.** When
  a response contained a `results` key that was not planned for, it was
  concatenated into the output path, so an id like `../../../tmp/x` escaped the
  output directory. Ids are now validated, and the fallback path is reduced to a
  basename regardless.
- **Downloads must be served over HTTPS.** The result URL comes from the API
  response and decides what the machine fetches; a downgraded or unexpected
  scheme is refused. Loopback is exempt, which is how the suite serves real
  responses over HTTP.
- **Result downloads cannot be redirected through a planted symlink.** The temp
  file now takes an unpredictable name from `crypto.randomBytes` and is opened
  `wx` (`O_CREAT|O_EXCL`), so anything already at that path fails the write
  instead of being followed. It still lands with normal umask permissions, since
  it is renamed into place as your output image.
- **`krakenio config show` masks the API key**, which identifies the account on
  its own and was printed in full into output people paste into bug reports.
- `publishConfig.registry` pins publishing to npmjs.org, so a private registry in
  a developer's `~/.npmrc` cannot silently receive the package.

### Fixed

- A transcript now really does carry the request/response detail that `-V`
  prints, whether or not `-V` was passed — the documented behaviour, which the
  call sites had been gating away. Credentials are masked in that detail too.
- The test suite no longer writes into the developer's real log directory.

## [0.4.0] — 2026-09-01

Folder scans stop assuming, runs keep their own history, and the CLI looks like
Kraken.io.

### Added

- **`krakenio logs`** — browse the transcripts the CLI now keeps by itself:
  `logs` lists them with per-day run and error counts, `logs show [date|today|latest]`
  prints one (with `--errors`, `--grep`, `--tail` and `--json`), `logs path`
  prints the directory for scripting, and `logs clean` prunes on demand.
- **Automatic logging.** Every run is transcribed to
  `$XDG_STATE_HOME/krakenio/logs` (default `~/.local/state/krakenio/logs`), one
  appended file per day, so "what did the 3am cron job do?" is always answerable.
  Retention is 14 days and 20 MB by default, pruned after each run, oldest first;
  today's file is never removed and ages come from the filename rather than the
  mtime. Configurable with `KRAKEN_LOG_DIR`, `KRAKEN_LOG_DAYS`,
  `KRAKEN_LOG_MAX_BYTES` (or `log_dir` / `log_days` / `log_max_bytes`), and
  disabled with `--no-log` or `KRAKEN_NO_LOG`. A failing run prints the path to
  its own transcript on the way out.
- **`--types <list>`** — choose which formats a folder scan picks up.
  `--types +pdf` adds to the defaults, `--types jpg,png` replaces them, and
  `--types all` takes everything the API accepts. Names are validated up front
  against the supported list, and mixing the two styles (`jpg,+pdf`) is refused
  as ambiguous rather than guessed at.
- **The Kraken.io mark in the terminal**, rendered from the official media-kit
  logotype as Unicode half-blocks, on `--help`, `login` and `status`. Truecolor,
  256-colour and colour-free renderings; suppressed whenever output is piped or
  redirected, under `--quiet`/`--json`, in a narrow terminal, or with
  `KRAKEN_NO_LOGO`. `scripts/gen-logo.py` regenerates it from the brand asset.
- `scripts/release.sh` — one command to cut a release: it refuses a dirty tree,
  a branch other than `main`, being behind `origin`, or a missing changelog
  section, then lints, tests, bumps, tags and optionally pushes. The `version`
  npm hook (`scripts/sync-version.mjs`) folds the Homebrew formula URL and the
  changelog date into the release commit, so `package.json` and the tag cannot
  drift; `npm run version:check` reports it if they do.

### Changed

- **Folder scans no longer pick up PDFs by default.** PDF is a document format
  the API happens to accept, and a stray PDF in a photo directory is rarely
  something you meant to spend quota on. Anything a scan walks past is now
  *reported* with the flag that would include it, rather than silently dropped:
  `2 PDFs skipped (excluded by default) — include with --types +pdf`. Naming a
  PDF directly on the command line still works, with no flag: `--types` governs
  directory scans only.
- `krakenio config show` also reports the log directory and the retention policy.
- The README documents the report and `--json` payloads with real output, and
  covers formats, logging and the `logs` commands.

## [0.3.0]

The output-safety and correctness release. Several of these are breaking, all of
them replace a silent wrong answer with a loud one.

### Added

- `--dry-run` (`-n`) — print the exact request body and every destination path,
  then stop. Costs nothing and needs no credentials.
- `--log-file <path>` — append a timestamped, colour-free transcript of the run,
  including the request/response detail that `-V` shows. Written even when the
  run fails.
- `--report <path>` — export one row per output as JSON or CSV (chosen by file
  extension): sizes, savings, dimensions, destination, HTTP status, duration and
  the reason for every failure.
- `--no-clobber` — never replace a file that already exists; keep it and move on.
- `--include-generated` — opt back in to processing this CLI's own
  `.kraked`/`.restored` outputs during a folder scan.
- `--sampling-scheme <4:2:0|4:2:2|4:4:4>` — JPEG chroma subsampling.
- `--keep-extension` — keep the original extension when converting
  (`convert.keep_extension`).
- Exit codes are now distinct and documented: `0` success, `1` one or more images
  failed, `2` usage error, `3` command not available in this release.
- Full validation of every flag against the Kraken.io documentation, before any
  request is sent: quality range, resize dimensions and strategies, convert
  formats, metadata fields, sampling schemes, numeric bounds.

### Changed

- **`--out-dir` mirrors the source folder structure** instead of flattening it.
  Previously `photos/a/1.jpg` and `photos/b/1.jpg` both wrote to
  `out/1.kraked.jpg` and one result was silently lost.
- **Cloud-storage object keys now include the filename.** Kraken's `path` is the
  full destination key, not a directory prefix, so `--s3 bucket/thumbs/`
  previously piled an entire batch onto a single object. `bucket/thumbs/` now
  becomes `thumbs/<name>.kraked.jpg`; a target ending in a filename
  (`bucket/final.jpg`) is still used verbatim.
- **Image sets send a `strategy` on every entry**, which the API requires, and
  ids are guaranteed unique even when the same size is requested twice.
- A resize with only one dimension now infers the matching strategy
  (`800x` → `landscape`, `x600` → `portrait`) rather than sending none.
- The `square` strategy sends the single `size` the API requires instead of a
  width/height pair, which used to come back as
  `422 For 'square' strategy image size must be set`. Write it as `-r 400,square`.
- Folder scans skip files this CLI produced earlier, so re-running on a directory
  no longer creates `photo.kraked.kraked.jpg`.
- Batch summaries count the original once per image instead of once per output
  size, which previously inflated the reported savings for image sets.
- Downloads are written to a temp file and renamed, so an interrupted transfer
  can never truncate an existing file — including your original under
  `--overwrite`.
- HTTP status codes are mapped to actionable messages (401 unauthorized, 402
  overdue, 403 suspended, 413 too large, 415 unsupported, 422 invalid params, …).
- Batch progress lists paths rather than bare basenames, so several files named
  `a.jpg` are distinguishable.
- `--overwrite` on a single file now asks for confirmation first.
- `--dev` explains that sandbox results are randomized placeholders and that the
  returned URL is not downloadable.
- Folder scans accept `.heic` and `.pdf` and no longer pick up `.bmp`/`.tiff`,
  matching the formats the API actually supports.
- `krakenio config show` masks the stored secret and reports the fixed endpoint.
- The multipart upload uses the `data` + `upload` field names from the official
  cURL example.

### Removed

- **The custom API endpoint.** `--host`, `KRAKEN_HOST` and `config set-host` are
  gone; the CLI always talks to `https://api.kraken.io`.
- **`restore` and `enhance` are not available in this release.** The AI
  restoration endpoints are not part of the public Kraken.io API yet, so both
  commands stay listed and clearly labelled, and exit `3` with an explanation
  instead of failing against an endpoint that will not answer. The flags,
  request bodies and tests are all in place; enabling them is a one-line change.

### Fixed

- `--out` with more than one input wrote every result to the same path,
  destroying all but the last. It is now refused with a pointer to `--out-dir`.
- Invalid numeric flags (`--quality abc`) were sent to the API as `NaN`.
- `--overwrite` was silently ignored for URL inputs and for image sets; both are
  now refused up front.
- `--no-save` combined with a destination flag silently ignored the destination.
- Colliding destination paths are detected before the first request rather than
  discovered as missing files afterwards.
- A corrupt config file no longer takes the CLI down.
- An empty or unreadable input file is reported locally instead of burning a
  request.

## [0.2.0]

- Per-request timeout so a stalled call cannot hang a batch.
- Quota reported in data units (MB/GB/TB) with an over-quota warning.
- First-class storage for Google Cloud Storage, Rackspace Cloud Files, Azure
  Blob Storage and SoftLayer.

## [0.1.0]

- Initial release: `optimize`, `restore`, `enhance`, `status`, `login`/`logout`
  and `config`.
