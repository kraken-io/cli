<div align="center">

<a href="https://kraken.io">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://assets.kraken.io/assets/images/media-kit/logotypes/downloads/krakenio-horizontal-mono.png">
    <img src="https://assets.kraken.io/assets/images/media-kit/logotypes/downloads/krakenio-horizontal-full.png" alt="Kraken.io" width="340">
  </picture>
</a>

# @kraken-io/cli

### The official command-line client for [Kraken.io](https://kraken.io)

**Optimize, convert and resize images from your terminal — the same image API that powers Kraken.io, with a CLI built around never surprising you about your files.**

[![npm](https://img.shields.io/npm/v/@kraken-io/cli.svg?color=0b7285&label=npm)](https://www.npmjs.com/package/@kraken-io/cli)
[![node](https://img.shields.io/node/v/@kraken-io/cli.svg?color=0b7285)](https://nodejs.org)
[![ci](https://github.com/kraken-io/cli/actions/workflows/ci.yml/badge.svg)](https://github.com/kraken-io/cli/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/kraken-io/cli.svg?color=0b7285)](LICENSE)

[Install](#install) · [Quick start](#quick-start) · [Output rules](#output-what-gets-written-and-where) · [Commands](#command-reference) · [Cloud storage](#cloud-storage) · [Recipes](#recipes) · [Troubleshooting](#troubleshooting)

</div>

---

```text
$ krakenio optimize ./photos --lossy --out-dir ./web -y

  ℹ 12 images to optimize
  ℹ Will use roughly 24 MB of quota  —  4.9 GB left

  [ 1/12] ✓ photos/IMG_0001.jpg   2.4 MB→612 KB
  [ 2/12] ✓ photos/IMG_0002.jpg   1.1 MB→380 KB
  …
  [12/12] ✓ photos/team/anna.jpg  3.0 MB→902 KB

  Summary
  done    12 ok / 12
  size    24 MB → 7.2 MB  −70%  (saved 17 MB)
  out     ./web

  plan    Advanced
  quota   32 MB / 5 GB  ·  4.9 GB left  [█░░░░░░░░░░░░░░░░░░░░░ 1%]
```

## Contents

- [Why this CLI](#why-this-cli)
- [Install](#install)
- [Quick start](#quick-start)
- [Which files get picked up](#which-files-get-picked-up)
- [Output: what gets written, and where](#output-what-gets-written-and-where)
- [Command reference](#command-reference)
  - [`optimize`](#krakenio-optimize-inputs)
  - [Resize strategies](#resize-strategies)
  - [Global flags](#global-flags)
  - [Account and configuration commands](#account-and-configuration-commands)
- [Logs, reports and machine-readable output](#logs-reports-and-machine-readable-output)
  - [Automatic logging](#automatic-logging)
  - [`krakenio logs`](#krakenio-logs)
  - [`--log-file`](#--log-file-path--a-transcript-somewhere-specific)
  - [`--report`](#--report-path--the-machine-readable-result-set)
  - [`--json`](#--json--raw-api-responses)
- [Cloud storage](#cloud-storage)
- [Configuration](#configuration)
- [Exit codes and error handling](#exit-codes-and-error-handling)
- [Recipes](#recipes)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Not available yet](#not-available-yet)
- [Development](#development)
- [Support](#support)

## Why this CLI

This is the official client, maintained alongside the [Kraken.io](https://kraken.io)
image API. Every flag maps to a documented API parameter, and every parameter is
validated against the API's own rules before a request leaves your machine.

Three principles shape it:

- **It never surprises you about files.** Your input is never modified unless you
  ask. Every destination is planned *before* the first request, so colliding
  outputs are refused rather than silently overwritten — and `--dry-run` shows
  you the whole plan for free.
- **It fails in milliseconds, not after 400 images.** Flags are validated up
  front: quality ranges, resize strategies, convert formats, storage
  credentials. A typo costs you nothing.
- **It tells you what happened.** A `--log-file` transcript for humans, a
  `--report` CSV/JSON for machines, real quota accounting, and distinct exit
  codes for scripts.

## Install

```bash
# npm — needs Node 18.17+
npm install -g @kraken-io/cli

# Homebrew
brew install kraken-io/tap/krakenio-cli

# Homebrew, straight from this repo
brew install --formula ./Formula/krakenio-cli.rb
```

Or run from a clone:

```bash
git clone https://github.com/kraken-io/cli.git
cd cli && npm install && npm link
```

Verify the install:

```bash
krakenio --version
krakenio --help
```

## Quick start

```bash
krakenio login                       # paste your API key + secret (stored 0600)
krakenio optimize photo.jpg --lossy  # → photo.kraked.jpg, the original untouched
krakenio status                      # plan & quota
```

Get your key and secret from your
[Kraken.io API credentials page](https://kraken.io/account/api-credentials).

Prefer not to store them? Every command accepts `--key` / `--secret`, and reads
`KRAKEN_API_KEY` / `KRAKEN_API_SECRET` from the environment — see
[Configuration](#configuration).

## Which files get picked up

Naming a file processes that file. Naming a **folder** scans it recursively, and
what the scan picks up is deliberately narrower than what the API accepts.

| | Formats |
|---|---|
| **Scanned by default** | JPG, JPEG, PNG, GIF, WebP, SVG, AVIF, HEIC, HEIF |
| **Supported, but opt-in** | PDF |
| **Not supported** | everything else — BMP, TIFF, RAW … the API rejects them with `415` |

PDF is a document format that the Kraken.io API happens to accept. A stray PDF
in a photo directory is almost never something you meant to spend quota on, so a
scan walks past it — and **tells you it did**, with the flag that would include
it:

```text
$ krakenio optimize ./photos

  ℹ 2 PDFs skipped (excluded by default) — include with --types +pdf
```

### `--types`

`--types` controls the scan set. Two styles, which cannot be mixed:

| Form | Meaning |
|---|---|
| `--types +pdf` | the **defaults plus** these formats |
| `--types jpg,png` | **exactly** these formats, replacing the defaults |
| `--types all` | every format the API accepts, PDF included |

```bash
krakenio optimize ./photos --types +pdf      # images and PDFs
krakenio optimize ./photos --types jpg       # JPEGs only
krakenio optimize ./assets --types png,svg   # just the two
krakenio optimize ./mixed  --types all       # everything supported
```

Names are `jpg`, `png`, `gif`, `webp`, `svg`, `avif`, `heic`, `pdf` (or `all`).
`jpg` and `jpeg` both cover `.jpg` and `.jpeg`; `heic` covers `.heif` too. A
leading dot, stray whitespace and capitals are all tolerated, and an unknown
name is refused up front with the list of valid ones:

```text
$ krakenio optimize ./photos --types tiff

  ✖ unknown format for --types: 'tiff'. Supported: jpg, png, gif, webp, svg, avif, heic, pdf (or 'all').
```

Mixing the two styles (`--types jpg,+pdf`) is ambiguous about whether the
defaults survive, so it is refused rather than guessed at.

> [!NOTE]
> `--types` governs **folder scans only**. A file you name on the command line is
> an explicit request and is always processed — `krakenio optimize report.pdf`
> works without any flag.

## Output: what gets written, and where

This is the part worth reading once.

**By default nothing you own is modified.** The result is downloaded *next to*
your input with a `.kraked` marker in the name:

| Input | Default output |
|---|---|
| `photo.jpg` | `photo.kraked.jpg` |
| `photo.png` + `--convert webp` | `photo.kraked.webp` |
| `photo.jpg` + `-r 800x -r 400x` | `photo.kraked.800x-landscape.jpg`, `photo.kraked.400x-landscape.jpg` |
| `https://site.com/a.png` | `a.kraked.png` in the current directory |

### Choosing a destination

Four flags change that, and they are mutually exclusive:

| Flag | Where the result goes |
|---|---|
| *(none)* | Next to the input, as `name.kraked.ext` |
| `-o, --out <path>` | Exactly that path. **Single input, single size only** — with more inputs the CLI refuses instead of writing them all to one file |
| `--out-dir <dir>` | Into `<dir>`, **mirroring the source folder structure** (`photos/team/anna.jpg` → `web/team/anna.kraked.jpg`) |
| `-O, --overwrite` | **Replaces the input in place.** Asks for confirmation, needs local files, and is refused with multiple `--resize` sizes |

**If a destination already exists it is replaced, and you are told so** — in a
batch the count appears above the confirmation prompt, in `--dry-run` each path
is marked `(exists — would be replaced)`. Pass `--no-clobber` to keep existing
files and skip those results instead.

### Three safety nets you get for free

- **Collision detection.** If two inputs would write to the same path, the whole
  run is refused before anything is sent — you never get a half-correct output
  set. This is why `--out-dir` mirrors your folder structure: flattening it would
  make `photos/a/1.jpg` and `photos/b/1.jpg` fight over one destination.
- **Atomic writes.** Results download to a temp file and are renamed into place,
  so an interrupted transfer cannot truncate an existing file. Your original
  survives even a failed `--overwrite`.
- **No re-processing.** Folder scans skip files this CLI produced earlier, so
  running `krakenio optimize ./photos` twice does the right thing instead of
  creating `photo.kraked.kraked.jpg`. Use `--include-generated` if you really
  want them.

### See it before you spend anything

```bash
$ krakenio optimize ./photos -c webp --out-dir ./web --dry-run

  ℹ Dry run — nothing will be sent to Kraken.io and no files will be written.

  2 images would be optimized
  • photos/a.jpg
      → web/a.kraked.webp  (new)
  • photos/team/anna.jpg
      → web/team/anna.kraked.webp  (exists — would be replaced)

  Request body  (for the first image)
  {
    "convert": { "format": "webp" }
  }
```

`--dry-run` needs no credentials, sends nothing and uses no quota. It is the
fastest way to answer "what is this command about to do to my folder?"

## Command reference

| Command | What it does |
|---|---|
| `krakenio optimize <inputs…>` (alias `opt`) | Compress, and optionally convert and resize, image(s) |
| `krakenio status` | Account plan and quota |
| `krakenio login` / `logout` | Store / clear API credentials (verified on login) |
| `krakenio config show \| set-key \| set-secret \| set-s3 \| set-store` | Manage saved settings |
| `krakenio logs \| logs show \| logs path \| logs clean` | Browse the transcripts kept automatically |
| `krakenio restore` / `enhance` | **[Not available yet](#not-available-yet)** |

### `krakenio optimize <inputs…>`

`<inputs…>` are **image URLs**, **local files**, or **folders** (expanded
recursively). The right endpoint (`/v1/url` vs `/v1/upload`) is chosen
automatically, and more than one input switches to batch mode.

Supported input formats — the ones the API accepts: **JPG, PNG, WebP, GIF, SVG,
AVIF, HEIC/HEIF, PDF**. Anything else in a folder is skipped rather than sent off to
be rejected.

> [!TIP]
> **Batch & Bulk Processing:** When multiple files or folders are provided, the CLI processes them concurrently using an asynchronous worker pool:
> - **Parallel requests:** Default is **10** concurrent requests; customize with `--concurrency <1..100>` (e.g. `--concurrency 25`).
> - **Total batch size:** There is no hard limit on the total number of images in a folder — thousands of images are automatically queued and processed without blowing process memory.
> - **Resilience:** Automatic exponential backoff retries transient network errors and rate limits (`HTTP 429` / `504`).


| Flag | Meaning |
|---|---|
| `-l, --lossy` | Lossy compression — typically 50–60% smaller. **Default is lossless** |
| `-q, --quality <n>` | JPEG quality 1–100. Only affects lossy output; omit it and Kraken.io picks the best quality-to-size ratio per image |
| `-r, --resize <WxH[,strategy]>` | Resize. **Repeatable** — several sizes become one image-set request |
| `-c, --convert <fmt[,bg]>` | Convert to `jpeg`, `png`, `gif`, `webp` or `avif`, with an optional background for transparent sources |
| `--keep-extension` | Keep the original extension when converting |
| `--auto-orient` | Apply EXIF orientation losslessly, then strip the tag |
| `--sampling-scheme <s>` | JPEG chroma subsampling: `4:2:0` (default, smallest), `4:2:2`, `4:4:4` |
| `--preserve-meta <list>` | Keep metadata that is otherwise stripped: `profile,date,copyright,geotag,orientation` |

### Resize strategies

Written as `WxH,strategy` — for example `-r 800x600,fit`.

| Strategy | Effect |
|---|---|
| `exact` | Exact width and height; aspect ratio is not maintained |
| `portrait` | Exact height, width follows the aspect ratio |
| `landscape` | Exact width, height follows the aspect ratio |
| `auto` | Picks `portrait` or `landscape` by aspect ratio |
| `fit` | Crops and resizes to fit the given box |
| `crop` | Crops to exactly the given size |
| `square` | Crops by the shorter side to a square, then resizes. Takes **one** size: `-r 400,square` |
| `fill` | Resizes to fit the bounds, preserving the aspect ratio |

Omit the strategy and the CLI infers the one that matches what you asked for:
`800x` → `landscape`, `x600` → `portrait`, `800x600` → `auto`. Strategies that
need both dimensions say so instead of failing server-side, and `square` is
translated to the single `size` the API expects rather than a width/height pair.

Repeat `-r` to build a responsive set in a single request and a single quota
charge:

```bash
krakenio opt hero.jpg -r 1920x -r 800x -r 400x
```

### Global flags

Available on `optimize` (and on `restore` / `enhance` once released).

**Destination**

| Flag | Meaning |
|---|---|
| `-o, --out <path>` | Write to this exact path (single input, single size) |
| `--out-dir <dir>` | Write into this directory, mirroring the source structure |
| `-O, --overwrite` | Replace the input file in place (asks first) |
| `--no-clobber` | Never replace an existing file; keep it and move on |
| `--no-save` | Don't download results, just print their URLs |

**Control**

| Flag | Meaning |
|---|---|
| `-n, --dry-run` | Show the request body and every destination, then stop |
| `-y, --yes` | Skip confirmation prompts |
| `--types <list>` | Which formats a folder scan picks up ([details](#--types)). PDFs are excluded by default |
| `--include-generated` | Also process this CLI's own `.kraked` outputs when scanning folders |
| `--concurrency <n>` | Parallel requests in batch mode (default 10, max 100) |
| `--timeout <seconds>` | Per-request timeout (default 120) — a stalled call fails instead of hanging the batch |
| `--dev` | Sandbox mode — no quota used, but results are randomized placeholders |

**Output and diagnostics**

| Flag | Meaning |
|---|---|
| `--log-file <path>` | Append a full colour-free transcript of the run |
| `--no-log` | Skip the automatic log for this run |
| `--report <path>` | Export a per-image result report (`.json` or `.csv`) |
| `-V, --verbose` | Request/response details and timing |
| `--quiet` | Minimal output |
| `--json` | Raw JSON response, for scripting |
| `--no-quota` | Don't show quota afterwards |

**Credentials** — `--key`, `--secret`, and the storage flags documented under
[Cloud storage](#cloud-storage).

### Account and configuration commands

```bash
krakenio status                  # plan, quota used, quota left
krakenio login                   # prompts for key + secret, verifies them, stores 0600
krakenio logout                  # removes stored credentials
krakenio config show             # current settings, with the secret masked
krakenio config set-key <key>
krakenio config set-secret <secret>
krakenio config set-s3 <key> <secret> [region]
krakenio config set-store <gcs|cf|azure|sl> <json>

krakenio logs                    # every stored transcript
krakenio logs show [when]        # print one — a date, 'today', or 'latest'
krakenio logs path               # the log directory
krakenio logs clean [--all]      # prune now
```

`login` verifies the credentials against the API before saving them, so a typo
is caught immediately rather than on your next batch.

## Logs, reports and machine-readable output

Four different jobs, four different mechanisms.

| | For | Written |
|---|---|---|
| **Automatic log** | "what happened last Tuesday?" | always, to the log directory |
| `--log-file <path>` | a transcript at a path you choose | on request |
| `--report <path>` | one row per image, for a spreadsheet or a script | on request |
| `--json` | the raw API response | to stdout |

### Automatic logging

**Every run is transcribed to disk, without being asked.** One file per day,
appended to, in a directory that prunes itself — so the answer to "what did that
cron job do at 3am?" is always available, and the directory never grows without
bound.

```text
~/.local/state/krakenio/logs/krakenio-2026-09-01.log
```

The location follows the [XDG Base Directory
spec](https://specifications.freedesktop.org/basedir-spec/latest/), which puts
logs under `$XDG_STATE_HOME` (default `~/.local/state`). `krakenio config show`
always prints the resolved path and the current policy:

```text
$ krakenio config show

  endpoint https://api.kraken.io
  key      abcd…890
  secret   fedc…210
  file     /Users/you/.config/krakenio/config.json
  logs     /Users/you/.local/state/krakenio/logs
  keep     14 days, 20 MB  (one file per day, pruned automatically)
```

**Retention.** After each run, transcripts older than the window are deleted;
if the directory is still over the size cap, the oldest go first until it fits.
Today's log is never removed. Ages come from the filename, not the mtime, so
copying or restoring the directory does not reset the clock.

| Setting | Default | Environment | Config key |
|---|---|---|---|
| Directory | `$XDG_STATE_HOME/krakenio/logs` | `KRAKEN_LOG_DIR` | `log_dir` |
| Keep for | 14 days | `KRAKEN_LOG_DAYS` | `log_days` |
| Size cap | 20 MB | `KRAKEN_LOG_MAX_BYTES` | `log_max_bytes` |
| Enabled | yes | `KRAKEN_NO_LOG` | `log: false` |

Set either limit to `0` to keep everything forever. Turn it off for one run with
`--no-log`, or permanently with `KRAKEN_NO_LOG=1`.

Credentials are masked in every transcript — both in the request detail and in
the command line recorded at the top, so `--secret abc123` is written as
`--secret ***`. Logs are created `0600` in a `0700` directory, the same as the
credential store, because they carry local paths and result URLs. A log is safe
to attach to a bug report.

Logging never takes a run down: an unwritable directory or a full disk is
silently tolerated and the images still get optimized.

When a run fails, the CLI points at the transcript on the way out:

```text
  ✖ unknown format for --types: 'tiff'. Supported: jpg, png, gif, webp, svg, avif, heic, pdf (or 'all').
  → full transcript: ~/.local/state/krakenio/logs/krakenio-2026-09-01.log
```

### `krakenio logs`

Browse what has been collected, without knowing where any of it lives.

```bash
krakenio logs                  # list every stored transcript
krakenio logs show             # print the most recent one
krakenio logs show 2026-08-28  # …or a specific day
krakenio logs show today
krakenio logs show --errors    # only the lines that failed
krakenio logs show --grep hero.jpg
krakenio logs show --tail 50
krakenio logs path             # print the directory, for scripting
krakenio logs clean            # apply the retention policy right now
krakenio logs clean --all      # clear everything except today
krakenio logs clean --days 3   # prune to a tighter window, one time
```

```text
$ krakenio logs

  date        runs  errors  size
  2026-09-01     7       1   184 KB
  2026-08-31    12       0   402 KB
  2026-08-30     3       0    96 KB

  3 file(s), 682 KB in /Users/you/.local/state/krakenio/logs
  `krakenio logs show` prints the latest; `logs show --errors` just the failures.
```

`logs show` colourises levels at a terminal and emits the raw lines when piped,
so `krakenio logs show | grep …` behaves exactly as you would expect. `--json`
works on both `logs` and `logs show` for scripting:

```bash
krakenio logs --json | jq -r '.logs[] | select(.errors > 0) | .date'
cd "$(krakenio logs path)"
```

Filters compose, and `--tail` applies **after** filtering — `--errors --tail 1`
is the last failure, not "the last line, if it was an error".

### `--log-file <path>` — a transcript somewhere specific

Same content as the automatic log, at a path you choose, and not subject to
pruning. It also carries the request/response detail that `-V` shows *even when
you didn't pass `-V`*, and it is written when the run fails too. Appends, so a
nightly job builds one continuous file.

```bash
krakenio optimize ./photos --lossy -y --log-file ~/krakenio.log
```

```text
2026-09-01T10:22:14.881Z  INFO  krakenio optimize ./photos --lossy -y
2026-09-01T10:22:14.882Z  INFO  node v22.14.0 on darwin
2026-09-01T10:22:14.903Z  DEBUG plan: 12 input(s) → 12 output(s)
2026-09-01T10:22:15.140Z  DEBUG POST https://api.kraken.io/v1/upload
2026-09-01T10:22:15.140Z  DEBUG {"auth":{"api_key":"abc…90","api_secret":"fed…10"},"wait":true,"lossy":true}
2026-09-01T10:22:16.902Z  DEBUG ← HTTP 200 in 1762ms
2026-09-01T10:22:16.903Z  INFO  [ 1/12] ✓ photos/IMG_0001.jpg  2.4 MB→612 KB
2026-09-01T10:22:17.455Z  ERROR [ 2/12] ✗ photos/broken.png  unsupported media type
```

### `--report <path>` — the machine-readable result set

One row per output, successes and failures alike. The format follows the
extension: `.csv` for a spreadsheet, anything else for JSON.

```bash
krakenio optimize ./photos --lossy -y --report run.json
```

```json
{
  "command": "optimize",
  "version": "0.3.0",
  "generated_at": "2026-09-01T16:43:42.993Z",
  "total": 2,
  "rows": [
    {
      "input": "photos/IMG_0001.jpg",
      "size_id": null,
      "status": "ok",
      "error": null,
      "original_size": 2517901,
      "kraked_size": 626688,
      "saved_bytes": 1891213,
      "kraked_width": 4000,
      "kraked_height": 3000,
      "kraked_url": "https://dl.kraken.io/api/3f/2a/9c/abc123/IMG_0001.jpg",
      "saved_to": "web/IMG_0001.kraked.jpg",
      "http_status": 200,
      "duration_ms": 1762
    },
    {
      "input": "photos/broken.png",
      "size_id": null,
      "status": "error",
      "error": "unsupported media type — Kraken.io cannot process this file format",
      "original_size": null,
      "kraked_size": null,
      "saved_bytes": null,
      "kraked_width": null,
      "kraked_height": null,
      "kraked_url": null,
      "saved_to": null,
      "http_status": 415,
      "duration_ms": 210
    }
  ]
}
```

The same run as `--report run.csv` — identical columns, one header row:

```csv
input,size_id,status,error,original_size,kraked_size,saved_bytes,kraked_width,kraked_height,kraked_url,saved_to,http_status,duration_ms
photos/IMG_0001.jpg,,ok,,2517901,626688,1891213,4000,3000,https://dl.kraken.io/api/3f/2a/9c/abc123/IMG_0001.jpg,web/IMG_0001.kraked.jpg,200,1762
photos/broken.png,,error,unsupported media type — Kraken.io cannot process this file format,,,,,,,,415,210
```

| Column | |
|---|---|
| `input` | The source file or URL |
| `size_id` | The resize id, for image sets (empty otherwise) |
| `status` | `ok` or `error` |
| `error` | Why it failed |
| `original_size`, `kraked_size`, `saved_bytes` | Bytes |
| `kraked_width`, `kraked_height` | Output dimensions |
| `kraked_url` | The result URL on Kraken.io |
| `saved_to` | Where it was written locally |
| `http_status`, `duration_ms` | Per-request diagnostics |

A multi-size run contributes one row per size, with `size_id` naming it — so
`-r 800x -r 400x` over 10 images gives 20 rows.

### `--json` — raw API responses

`--json` prints what the API returned, unchanged, and suppresses the human
output. It works on every command.

```bash
krakenio status --json
```

```json
{
  "success": true,
  "plan_name": "Advanced",
  "active": true,
  "quota_total": 5368709120,
  "quota_used": 33554432,
  "quota_remaining": 5335154688
}
```

```bash
krakenio optimize photo.jpg --lossy --json --no-save
```

```json
{
  "success": true,
  "file_name": "photo.jpg",
  "original_size": 2517901,
  "kraked_size": 626688,
  "saved_bytes": 1891213,
  "kraked_url": "https://dl.kraken.io/api/3f/2a/9c/abc123/photo.jpg"
}
```

Useful one-liners:

```bash
# just the URL
krakenio optimize photo.jpg --json --no-save | jq -r .kraked_url

# quota left, in GB
krakenio status --json | jq '.quota_remaining / 1024 / 1024 / 1024 | floor'

# fail a build if the account is over quota
krakenio status --json | jq -e '.quota_remaining > 0' >/dev/null

# every file a batch failed on
krakenio opt ./photos -y --report r.json && jq -r '.rows[] | select(.status=="error") | .input' r.json
```

> [!IMPORTANT]
> **Results live on Kraken.io for one hour.** The CLI downloads them for you by
> default; with `--no-save` you are responsible for fetching the URLs in time.

## Cloud storage

Push results straight into your bucket — all five providers the API supports.
Save the credentials once, then use the matching flag:

| Provider | Save credentials | Use |
|---|---|---|
| Amazon S3 | `krakenio config set-s3 <key> <secret> [region]` | `--s3 my-bucket/path/` |
| Google Cloud Storage | `krakenio config set-store gcs '{"credentials":"@service-account.json"}'` | `--gcs my-bucket/path/` |
| Rackspace Cloud Files | `krakenio config set-store cf '{"user":"…","key":"…","region":"iad"}'` | `--cf my-container/path/` |
| Azure Blob Storage | `krakenio config set-store azure '{"account":"…","key":"…"}'` | `--azure my-container/path/` |
| SoftLayer | `krakenio config set-store sl '{"user":"…","key":"…","region":"…"}'` | `--sl my-container/path/` |

```bash
krakenio config set-s3 AKIA…KEY SECRET… eu-central-1
krakenio optimize ./photos --s3 my-bucket/optimized/ -y
```

### How the object key is built

Kraken's `path` is the *full* destination key, filename included — not a
directory prefix. The CLI handles that for you:

| `--s3` value | Object key for `photo.jpg` |
|---|---|
| `my-bucket` | `photo.kraked.jpg` |
| `my-bucket/thumbs/` | `thumbs/photo.kraked.jpg` |
| `my-bucket/thumbs` | `thumbs/photo.kraked.jpg` |
| `my-bucket/thumbs/final.webp` | `thumbs/final.webp` — used verbatim, single input only |

Missing credentials are caught before the first request, not on image 1 of 400.

For full control over provider-specific options (`acl`, `headers`, `metadata`,
`tags`) pass the raw object:

```bash
krakenio optimize photo.jpg --store '{"s3_store":{"key":"…","secret":"…","bucket":"b","acl":"public_read","headers":{"Cache-Control":"public, max-age=31536000"}}}'
krakenio optimize photo.jpg --store @store.json
```

## Configuration

Every value resolves as **CLI flag → environment variable → config file → default**.

| Setting | Flag | Environment | Config key |
|---|---|---|---|
| API key | `--key` | `KRAKEN_API_KEY` | `api_key` |
| API secret | `--secret` | `KRAKEN_API_SECRET` | `api_secret` |
| S3 key | `--s3-key` | `KRAKEN_S3_KEY` | `s3.key` |
| S3 secret | `--s3-secret` | `KRAKEN_S3_SECRET` | `s3.secret` |
| S3 region | `--s3-region` | `KRAKEN_S3_REGION` | `s3.region` |
| Log directory | — | `KRAKEN_LOG_DIR` | `log_dir` |
| Log retention (days) | — | `KRAKEN_LOG_DAYS` | `log_days` |
| Log size cap (bytes) | — | `KRAKEN_LOG_MAX_BYTES` | `log_max_bytes` |
| Automatic logging | `--no-log` | `KRAKEN_NO_LOG` | `log` (`false` to disable) |

Locations follow each platform's convention:

| | Config | Logs |
|---|---|---|
| Linux / macOS | `~/.config/krakenio/config.json` | `$XDG_STATE_HOME/krakenio/logs` (default `~/.local/state`) |
| Windows | `%APPDATA%\krakenio\config.json` | `%LOCALAPPDATA%\krakenio\Logs` |

Override either with `KRAKEN_CONFIG_DIR` / `KRAKEN_LOG_DIR` (useful in CI).
`krakenio config show` prints both resolved paths. The API endpoint is fixed at
`https://api.kraken.io`.

Two more environment switches:

- `KRAKEN_DEBUG=1` — print a stack trace on unexpected failures.
- `KRAKEN_NO_LOGO=1` — suppress the Kraken.io mark that `--help`, `login` and
  `status` show at a terminal. It is already omitted whenever output is piped,
  `--quiet`/`--json` is set, the terminal is narrow, or `NO_COLOR` is in effect.

In CI, skip `login` entirely:

```bash
export KRAKEN_API_KEY=… KRAKEN_API_SECRET=…
krakenio optimize ./assets --lossy -y --report artifacts/krakenio.json
```

## Exit codes and error handling

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | One or more images failed (the rest still completed) |
| `2` | Usage error — bad flags or arguments; nothing was sent |
| `3` | The command is not available in this release |

A batch never aborts on a single bad file: failures are marked `✗` with the
reason, counted in the summary, and the process exits `1`.

```text
  [3/12] ✗ photos/broken.png  unsupported media type — Kraken.io cannot process this file format
  …
  Summary
  done    11 ok  1 failed / 12
```

Every documented API status code becomes an actionable message:

| Status | What the CLI tells you |
|---|---|
| `400` | Bad request — the API rejected the request body as invalid JSON |
| `401` | Unauthorized — check your API key and secret |
| `402` | Payment required — this account is overdue |
| `403` | Forbidden — this account is suspended |
| `413` | File too large — over your plan's per-file size limit |
| `415` | Unsupported media type |
| `422` | Unprocessable entity — one or more parameters are invalid |
| `429` | Too many requests — try a lower `--concurrency` |
| `500` `502` `503` `504` | Kraken.io is erroring or unreachable — retry in a moment |

The API's own error text is preferred when it is more specific than the generic
mapping, so you get the most useful of the two rather than a bare `HTTP 413`.

## Recipes

```bash
# lossy compression, saved next to the original
krakenio optimize photo.jpg --lossy

# from a URL, converted to WebP, exact output name
krakenio optimize https://example.com/a.png -c webp -o a.webp

# a responsive image set in one request
krakenio opt hero.jpg -r 1920x -r 800x -r 400x

# a whole folder into ./web, mirroring its structure
krakenio optimize ./photos --lossy --out-dir ./web -y

# replace the originals in place (asks first)
krakenio opt ./photos --lossy --overwrite

# square thumbnails, faster, keeping existing files
krakenio opt ./photos -r 400,square --out-dir ./thumbs --no-clobber -y --concurrency 10

# straight to S3, one object per image, with a run report
krakenio opt ./photos --s3 my-bucket/img/ -y --report s3-run.csv

# print URLs only, download nothing
krakenio optimize photo.jpg --json --no-save

# keep copyright and colour profile
krakenio opt artwork.png --lossy --preserve-meta profile,copyright

# check what a build step would do, without credentials or quota
krakenio opt ./dist/assets -c webp --out-dir ./dist/web --dry-run

# a folder of scanned documents, PDFs included
krakenio opt ./scans --types +pdf --out-dir ./compressed -y

# only the PNGs in a mixed asset folder
krakenio opt ./assets --types png --lossy -y

# what went wrong in last night's run
krakenio logs show --errors
```

### In a build pipeline

```yaml
# .github/workflows/images.yml
- name: Optimize images
  env:
    KRAKEN_API_KEY: ${{ secrets.KRAKEN_API_KEY }}
    KRAKEN_API_SECRET: ${{ secrets.KRAKEN_API_SECRET }}
  run: |
    npx @kraken-io/cli optimize ./public/img \
      --lossy --out-dir ./public/img-optimized -y \
      --concurrency 10 \
      --report krakenio-report.json \
      --log-file krakenio.log
```

The step fails the build on exit `1` (an image failed) or `2` (a bad flag), and
both artifacts are written either way.

On an ephemeral CI runner the automatic log directory disappears with the
machine, so pass `--log-file` (as above) when you want the transcript kept as a
build artifact — or `--no-log` if you would rather it never touch the disk.

## Security

**Credentials.** They live in `~/.config/krakenio/config.json`, written `0600`.
`krakenio config show` masks both the key and the secret. Prefer
`KRAKEN_API_KEY` / `KRAKEN_API_SECRET` in CI over `--key` / `--secret`, since
flags are visible to anyone who can list processes on the machine — the CLI
redacts them from its own transcripts, but it cannot redact them from `ps`.

**Transcripts.** Logs are `0600` in a `0700` directory on Linux and macOS. Windows
has no POSIX mode bits, so they inherit the ACL of `%LOCALAPPDATA%`, which is
already restricted to your account. They contain the command
line (with credential flags redacted), local file paths, and `kraked_url`
links — which grant access to your results for an hour. Treat a log as
account-adjacent: safe to attach to a bug report, not to publish.

**What the CLI trusts.** It talks to exactly one host, `https://api.kraken.io`;
there is no configurable endpoint to point elsewhere. Result downloads must be
served over HTTPS, results are written through an exclusively-created temp file
so a planted symlink cannot redirect them, and nothing in an API response is
allowed to decide a path outside the directory you chose.

**Reporting.** For a vulnerability in the CLI, please open a
[security advisory](https://github.com/kraken-io/cli/security/advisories/new)
rather than a public issue.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `no API credentials` | Run `krakenio login`, or set `KRAKEN_API_KEY` and `KRAKEN_API_SECRET` |
| `401 unauthorized` | The stored key/secret is wrong — `krakenio login` re-verifies before saving |
| `422 For 'square' strategy image size must be set` | Pass one size, not two: `-r 400,square` |
| `--out with multiple inputs` is refused | `-o` names one exact file. Use `--out-dir` for a batch |
| Outputs named `photo.kraked.kraked.jpg` | You asked for `--include-generated`; drop it and folder scans skip prior outputs |
| A folder produced nothing | Only the [scanned formats](#which-files-get-picked-up) are picked up; the CLI reports what it walked past |
| PDFs in a folder were skipped | That is the default. `--types +pdf` includes them; naming a PDF directly always works |
| `unknown format for --types` | Valid names are `jpg png gif webp svg avif heic pdf` and `all` — BMP, TIFF and RAW are not supported by the API |
| `--types jpg,+pdf` is refused | Pick one style: `+pdf` adds to the defaults, a plain list replaces them |
| Where are my logs? | `krakenio logs` lists them, `krakenio logs path` prints the directory |
| The run hangs on one image | Lower `--timeout`; a stalled request then fails that image instead of the batch |
| Results look random in testing | `--dev` is sandbox mode — placeholders, not real output, and the URL is not downloadable |

Still stuck? The last run is already on disk — `krakenio logs show --errors`
shows what failed, and `krakenio logs path` finds the file. Credentials are
masked in every transcript, so it is safe to attach to an issue.

## Not available yet

`krakenio restore` and `krakenio enhance` — AI upscaling and one-button enhance —
are **implemented but disabled**, because the restoration endpoints are not part
of the public Kraken.io API yet.

Both commands stay listed in `--help`, clearly labelled, and exit `3` with an
explanation rather than failing against an endpoint that will not answer:

```text
$ krakenio restore old.jpg

  ✖ `krakenio restore` is not available in this release

    AI image restoration is not part of the public Kraken.io API yet, so this
    command is disabled instead of failing against an endpoint that will not
    answer. It will be enabled in a future release — no flags will change.

    Available today: krakenio optimize — compress, convert and resize.
```

Their flags, request bodies and output naming (`.restored`, `.enhanced`) are
already built and covered by tests; enabling them is a one-line change once the
endpoints ship. See [RELEASING.md](RELEASING.md).

## Development

```bash
npm install
npm test          # no network required
npm run lint      # syntax-check every source file
```

CI runs the suite on Linux, macOS and Windows, and on the oldest supported Node
(18.17) as well as current.

| File | Responsibility |
|---|---|
| `bin/krakenio.js` | Argument parsing, help text, exit codes |
| `src/commands.js` | Orchestration: dispatch, single vs. batch, dry run |
| `src/params.js` | Request bodies and all flag validation |
| `src/paths.js` | Input expansion, destination planning, collision detection |
| `src/client.js` | HTTP, multipart uploads, status-code mapping, downloads |
| `src/config.js` | Credentials and settings (`0600`) |
| `src/log.js` | Transcripts, log retention, `--report` exports |
| `src/logo.js` | The Kraken.io mark for the terminal (`src/logo-data.js` is generated) |
| `src/ui.js` | Colours, spinners, formatting, prompts |

Tests use the real binary in a subprocess and a real local HTTP server; nothing
is mocked at the network boundary.

For instructions on releasing new versions, versioning workflow and updating the Homebrew formula, see [RELEASING.md](RELEASING.md).

`scripts/gen-logo.py` regenerates `src/logo-data.js` from the official media-kit
logotype, and is the only thing in the repo that needs Python.

## Support

- **Bugs and feature requests for the CLI** — [open an issue](https://github.com/kraken-io/cli/issues)
  on this repository.
- **API behaviour, plans, quota and billing** — the [Kraken.io documentation](https://kraken.io/docs/getting-started)
  and [Kraken.io support](https://kraken.io/contact).
- **API credentials** — your [account page](https://kraken.io/account/api-credentials).

## License

[MIT](LICENSE) © Kraken.io
