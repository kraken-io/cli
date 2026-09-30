# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-09-30

### Official 1.0.0 Public Release

- **First official public release** of the Kraken.io CLI as `@kraken-io/cli`.
- Support for image compression (lossless and lossy), smart conversion (WebP, AVIF, JPEG, PNG, GIF), and advanced resize strategies.
- Official Homebrew tap support (`brew install kraken-io/tap/krakenio-cli`).
- Automatic retry with exponential backoff and streaming disk downloads.

## [0.5.0] — 2026-09-30

### Changed

- **Scoped package name `@kraken-io/cli`.** Published as an official scoped package under the `@kraken-io` organization on npm with public access.
- Updated npm tarball resolution in scripts and release workflows to support scoped packages.
- Streamlined documentation: moved maintainer release workflows from `README.md` to `RELEASING.md`.

## [0.4.2] — 2026-09-27

### Added

- **Automatic retry with exponential backoff.** Added automatic retry logic (up to 5 retries with exponential backoff and jitter) for transient connectivity issues and HTTP 429 (Rate Limit) / HTTP 504 (Gateway Timeout), respecting `Retry-After` headers.
- **Configurable batch concurrency.** Default parallel requests set to 10 with an allowable range up to 100 via `--concurrency` for high-throughput environments.
- **Download error diagnostics.** Local download failures in batch mode now display specific error causes and are accurately reflected in summary counts and process exit codes.

### Changed

- **Streaming downloads direct to disk.** Downloaded images are now streamed directly to disk (`Readable.fromWeb` → `fs.createWriteStream`) rather than buffered in memory, significantly reducing memory consumption during batch operations.
- **Upload memory sanity check.** File size is verified via `fs.statSync` prior to buffer allocation, preventing unnecessary memory allocation for files exceeding the 100 MB API limit.
- Updated `.gitignore` to exclude IDE and editor configurations (`.vscode/`, `.idea/`).

## [0.4.1] — 2026-09-01

### Security

- **Credential redaction in logs.** Command-line arguments containing sensitive credentials (`--key`, `--secret`, `--s3-key`, `--s3-secret`, and inline `--store` parameters) are masked as `***` in execution logs and transcripts.
- **Restrictive transcript permissions.** Log files are created with `0600` permissions inside a `0700` directory to match credential storage security standards.
- **Output path traversal prevention.** Validated API response identifiers to ensure downloaded files cannot escape the designated output directory.
- **Enforce HTTPS for result downloads.** Result download URLs returned from the API must use HTTPS (with loopback exemptions for local test environments).
- **Atomic file writes with collision protection.** Temporary files for downloads use cryptographically secure random names and `O_CREAT|O_EXCL` flags, preventing symlink redirection and truncation on interrupted transfers.
- **API key masking in configuration output.** `krakenio config show` masks the active API key to protect account credentials when sharing output.
- **Registry pinning.** Set `publishConfig.registry` to npmjs.org to prevent accidental publication to alternate registries.

### Fixed

- Request and response details are now reliably captured in execution transcripts when verbose logging is enabled.
- Isolated test suite execution to prevent writing into user-level log directories.

## [0.4.0] — 2026-09-01

### Added

- **`krakenio logs` command suite.** Added commands to inspect and manage execution transcripts:
  - `krakenio logs`: List transcripts with per-day execution counts and error summaries.
  - `krakenio logs show [date|today|latest]`: Display transcript logs with filtering (`--errors`, `--grep`, `--tail`, `--json`).
  - `krakenio logs path`: Print the active log directory path.
  - `krakenio logs clean`: Manually prune log files.
- **Automatic execution logging.** Daily execution transcripts are stored in `$XDG_STATE_HOME/krakenio/logs` (`~/.local/state/krakenio/logs` by default) with automatic retention (default 14 days / 20 MB). Configurable via `KRAKEN_LOG_DIR`, `KRAKEN_LOG_DAYS`, `KRAKEN_LOG_MAX_BYTES` or `--no-log`.
- **Selective folder scanning via `--types`.** Configure formats scanned during directory traversal (`--types +pdf`, `--types jpg,png`, or `--types all`).
- **Terminal branding.** Added Kraken.io ASCII/Unicode brand mark for `login`, `status`, and `--help` output with automatic suppression in non-interactive/piped environments or via `KRAKEN_NO_LOGO`.
- **Release management automation.** Added automated release checks and version synchronization scripts.

### Changed

- **Default folder scan format exclusions.** Directory scans exclude PDF files by default to preserve quota during image batch runs. PDFs can still be processed explicitly via direct path or with `--types +pdf`.
- `krakenio config show` displays configured log directory and retention settings.
- Expanded documentation for reporting formats and JSON output schemas.

## [0.3.0]

### Added

- **Dry-run mode (`--dry-run` / `-n`).** Inspect request parameters and destination paths without sending API calls or consuming quota.
- **Execution transcript export (`--log-file <path>`).** Export structured run transcripts including full request/response diagnostics.
- **Batch summary reporting (`--report <path>`).** Generate per-file CSV or JSON reports containing dimensions, original and optimized sizes, savings, duration, and error details.
- **File collision safeguards (`--no-clobber`).** Option to prevent overwriting existing files at destination paths.
- **Self-referential scan protection.** Scans automatically skip previously optimized `.kraked` and `.restored` files (can be included using `--include-generated`).
- **JPEG chroma subsampling control.** Added support for `--sampling-scheme <4:2:0|4:2:2|4:4:4>`.
- **Format conversion extension retention.** Added `--keep-extension` flag (`convert.keep_extension`).
- **Deterministic exit codes.** Standardized process exit codes (`0` success, `1` image failure, `2` parameter/usage error, `3` command unavailable).
- **Client-side parameter validation.** Pre-flight validation for dimensions, quality bounds, format options, and resize strategies before making network requests.

### Changed

- **Directory structure preservation.** `--out-dir` preserves relative directory structures instead of flattening nested folders.
- **Cloud storage path handling.** Cloud destination paths now preserve source filenames appropriately under target prefixes.
- **Image set resize strategies.** Added validation to ensure each entry in an image set includes a valid resize strategy.
- **Single-dimension resize strategy inference.** Single dimensions (`800x`, `x600`) automatically infer `landscape` or `portrait` strategies.
- **Square resize strategy formatting.** The `square` strategy correctly formats single-dimension size parameters.
- **Accurate batch summary calculation.** Batch statistics count original sizes once per source image rather than per output variation.
- **Atomic write workflows.** Downloads write to temporary files before moving to destination paths, preventing partial or corrupted files upon interrupted transfers.
- **Enhanced HTTP status mapping.** Actionable error messaging for API status codes (401, 402, 403, 413, 415, 422).
- **Interactive overwrite confirmation.** Prompts for confirmation when overwriting a single file in interactive terminal sessions.
- **Sandbox environment guidance.** Added explanatory messaging for sandbox test modes.
- **Expanded directory format detection.** Added support for `.heic` and `.pdf` while removing legacy unsupported formats.
- **Secret masking in CLI output.** Configuration dumps mask stored API credentials.

### Removed

- **Custom API endpoint flags.** Removed `--host`, `KRAKEN_HOST`, and `config set-host`; requests consistently route through official Kraken.io endpoints.
- **Gated unreleased AI endpoints.** Gated unreleased AI restoration endpoints (`restore`, `enhance`) with clear status messaging and distinct exit codes until publicly available.

### Fixed

- Multi-input jobs targeting `--out` now report an error guiding usage toward `--out-dir`.
- Validated numeric inputs to prevent `NaN` values from propagating to API parameters.
- Prevented invalid `--overwrite` usage on URL inputs and image sets.
- Fixed handling of `--no-save` when combined with external storage destinations.
- Pre-flight detection of destination path collisions.
- Graceful handling of corrupted configuration files.
- Local validation for empty or unreadable input files before dispatching API requests.

## [0.2.0]

- Configurable request timeouts to prevent stalled network connections.
- Quota reporting formatted in human-readable units (MB, GB, TB) with threshold alerts.
- Support for external storage providers: Google Cloud Storage, Rackspace Cloud Files, Azure Blob Storage, and SoftLayer.

## [0.1.0]

- Initial release: core CLI architecture supporting `optimize`, `status`, `login`, `logout`, and `config`.
