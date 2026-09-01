#!/usr/bin/env node
import { Command } from 'commander';
import { createRequire } from 'node:module';
import * as cmd from '../src/commands.js';
import { UsageError } from '../src/params.js';
import { bannerEnabled, bannerLines } from '../src/logo.js';
import { c as pc } from '../src/ui.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const collect = (val, prev) => prev.concat([val]);

// Options shared by every image command.
function withCommon(command) {
  return command
    .option('-o, --out <path>', 'write the result to this exact path (single input only)')
    .option('--out-dir <dir>', 'write all results into this directory (folder structure is mirrored)')
    .option('-O, --overwrite', 'replace the input file(s) in place — originals are not kept')
    .option('--no-clobber', 'never replace a file that already exists; keep it and move on')
    .option('-n, --dry-run', 'show exactly what would be sent and written, then stop')
    .option('-y, --yes', 'skip confirmation prompts')
    .option('--concurrency <n>', 'parallel requests in batch mode', '5')
    .option('--include-generated', 'also process this CLI\'s own .kraked/.restored outputs when scanning folders')
    .option('--types <list>', 'formats to pick up when scanning folders: jpg,png,gif,webp,svg,avif,heic,pdf|all '
                              + "(prefix with + to add to the defaults, e.g. '+pdf'). PDFs are excluded by default")
    .option('--s3 <bucket[/path]>', 'store results in Amazon S3 (`config set-s3`)')
    .option('--s3-region <region>', 'S3 region override')
    .option('--s3-key <key>', 'S3 access key override')
    .option('--s3-secret <secret>', 'S3 secret override')
    .option('--gcs <bucket[/path]>', 'store in Google Cloud Storage (`config set-store gcs`)')
    .option('--cf <container[/path]>', 'store in Rackspace Cloud Files (`config set-store cf`)')
    .option('--azure <container[/path]>', 'store in Azure Blob Storage (`config set-store azure`)')
    .option('--sl <container[/path]>', 'store in SoftLayer Object Storage (`config set-store sl`)')
    .option('--store <json>', "raw storage object, e.g. '{\"gcs_store\":{…}}' or @store.json")
    .option('--no-save', 'do not download the results, just print their URLs')
    .option('--no-quota', 'do not show quota afterwards')
    .option('--dev', 'sandbox mode — no quota used, but results are randomized placeholders')
    .option('--log-file <path>', 'append a full colour-free transcript of this run to a file')
    .option('--no-log', 'do not write to the default log directory (see `krakenio config show`)')
    .option('--report <path>', 'write a per-image result report (.json or .csv)')
    .option('--quiet', 'minimal output')
    .option('--json', 'print the raw JSON response');
}

const program = new Command();

program
  .name('krakenio')
  .description('Command-line client for the Kraken.io image API — optimize, convert and resize images.')
  .version(pkg.version, '-v, --version', 'print version')
  .option('--key <key>', 'API key (overrides stored credentials and env)')
  .option('--secret <secret>', 'API secret (overrides stored credentials and env)')
  .option('--timeout <seconds>', 'per-request timeout in seconds', '120')
  .option('-V, --verbose', 'verbose output (request/response details + timing)')
  .showHelpAfterError();

withCommon(
  program
    .command('optimize')
    .alias('opt')
    .summary('optimize / convert / resize image(s)')
    .description('Compress, and optionally convert and resize, image(s). Accepts URLs, local files or folders.')
    .argument('<inputs...>', 'image URL(s), local file(s), or folder(s) to process')
    .option('-l, --lossy', 'lossy compression (much smaller; default is lossless)')
    .option('-q, --quality <n>', 'JPEG quality 1-100 (lossy only; omit to let Kraken.io choose)')
    .option('-r, --resize <WxH[,strategy]>', 'resize; repeatable for an image set (exact|portrait|landscape|auto|fit|crop|square|fill)', collect, [])
    .option('-c, --convert <fmt[,bg]>', 'convert to jpeg|png|gif|webp|avif (optional background color)')
    .option('--keep-extension', 'keep the original extension when converting')
    .option('--auto-orient', 'apply EXIF orientation losslessly, then strip the tag')
    .option('--sampling-scheme <s>', 'JPEG chroma subsampling: 4:2:0|4:2:2|4:4:4')
    .option('--preserve-meta <list>', 'keep metadata: profile,date,copyright,geotag,orientation')
).action((inputs, _o, command) => cmd.optimize(inputs, command.optsWithGlobals()));

// AI restoration is implemented but the endpoints are not public yet, so both
// commands stay listed (and clearly labelled) while refusing to run. See
// RESTORE_AVAILABLE in src/commands.js.
const unreleased = (s) => (cmd.RESTORE_AVAILABLE ? s : `${s}  ${pc.yellow('[not available yet]')}`);

withCommon(
  program
    .command('restore')
    .alias('res')
    .summary(unreleased('AI upscale / enhance image(s)'))
    .description('AI image restoration (upscale and enhance). Not available in this release.')
    .argument('<inputs...>', 'image URL(s), local file(s), or folder(s) to process')
    .option('-s, --strategy <name>', 'auto|smart|general|photo|anime|logo|denoise|face')
    .option('-x, --scale <n>', 'upscale factor 2|3|4')
    .option('-w, --width <px>', 'exact target width (overrides --scale)')
    .option('--height <px>', 'exact target height')
    .option('--denoise <0-1>', 'denoise strength for the general model (0=max, 1=none)')
    .option('--strength <0-1>', 'restoration strength (1=full model, 0=barely touch)')
).action((inputs, _o, command) => cmd.restore(inputs, command.optsWithGlobals()));

withCommon(
  program
    .command('enhance')
    .alias('enh')
    .summary(unreleased('one-button AI enhance + optimize'))
    .description('AI enhance followed by lossy optimization in a single request. Not available in this release.')
    .argument('<inputs...>', 'image URL(s), local file(s), or folder(s) to process')
    .option('--strength <0-1>', 'enhancement strength (1=max, 0=barely touch)')
    .option('-x, --scale <n>', 'upscale factor 2|4')
    .option('-w, --width <px>', 'exact target width (overrides --scale)')
    .option('--height <px>', 'exact target height')
    .option('-c, --convert <fmt[,bg]>', 'convert to jpeg|png|gif|webp|avif (optional background color)')
    .option('-q, --quality <n>', 'JPEG quality 1-100 for the optimize pass')
).action((inputs, _o, command) => cmd.enhance(inputs, command.optsWithGlobals()));

program
  .command('status')
  .description('Show your account plan and quota')
  .option('--quiet', 'minimal output')
  .option('--json', 'print the raw JSON response')
  .action((_o, command) => cmd.status(command.optsWithGlobals()));

program
  .command('login')
  .description('Store your API key and secret (verified against the API)')
  .action((_o, command) => cmd.login(command.optsWithGlobals()));

program.command('logout').description('Remove stored credentials').action(() => cmd.logout());

const logs = program
  .command('logs')
  .description('Browse the run transcripts krakenio keeps automatically')
  .option('--json', 'print the listing as JSON')
  .action((_o, command) => cmd.logsList(command.optsWithGlobals()));

logs.command('list', { isDefault: false })
  .description('List every stored transcript (the default when you run `krakenio logs`)')
  .option('--json', 'print the listing as JSON')
  .action((_o, command) => cmd.logsList(command.optsWithGlobals()));

logs.command('show')
  .argument('[when]', "log to read: a YYYY-MM-DD date, 'today', or 'latest'", 'latest')
  .description('Print a stored transcript')
  .option('--errors', 'only the lines that failed')
  .option('--grep <text>', 'only lines containing this text')
  .option('--tail <n>', 'only the last N lines')
  .option('--json', 'print the lines as JSON')
  .action((when, _o, command) => cmd.logsShow(when, command.optsWithGlobals()));

logs.command('path')
  .description('Print the log directory (composes: cd "$(krakenio logs path)")')
  .action((_o, command) => cmd.logsPath(command.optsWithGlobals()));

logs.command('clean')
  .description('Apply the retention policy now, or clear the directory')
  .option('--all', "remove every transcript except today's")
  .option('--days <n>', 'prune anything older than N days instead of the configured window')
  .action((_o, command) => cmd.logsClean(command.optsWithGlobals()));

const config = program.command('config').description('Manage saved settings (~/.config/krakenio/config.json)');
config.command('show').description('Show current settings').action(() => cmd.configShow());
config.command('set-key').argument('<key>').description('Save your API key').action((v) => cmd.configSet('key', v));
config.command('set-secret').argument('<secret>').description('Save your API secret').action((v) => cmd.configSet('secret', v));
config.command('set-s3').argument('<key>').argument('<secret>').argument('[region]')
  .description('Save Amazon S3 credentials for --s3')
  .action((key, secret, region) => cmd.configSetS3(key, secret, region));
config.command('set-store').argument('<provider>').argument('<json>')
  .description("Save credentials for gcs|cf|azure|sl, e.g. set-store gcs '{\"credentials\":\"@sa.json\"}'")
  .action((provider, json) => cmd.configSetStore(provider, json));

// A banner on --help, but only for a human at a terminal: bannerEnabled() drops
// it whenever help is piped, redirected or narrow.
program.addHelpText('beforeAll', () =>
  bannerEnabled() ? '\n' + bannerLines(`official CLI · v${pkg.version}`).join('\n') + '\n' : '');

program.addHelpText('after', `
${pc.bold('Examples')}
  ${pc.dim('# one-time setup')}
  $ krakenio login

  ${pc.dim('# optimize a local file → photo.kraked.jpg (the original is untouched)')}
  $ krakenio optimize photo.jpg --lossy

  ${pc.dim('# see what would happen, without spending quota')}
  $ krakenio opt ./photos --lossy --out-dir ./web --dry-run

  ${pc.dim('# from a URL, convert to WebP, exact output name')}
  $ krakenio optimize https://example.com/a.png -c webp -o a.webp

  ${pc.dim('# an image set: three sizes in one request')}
  $ krakenio opt hero.jpg -r 1920x -r 800x -r 400x

  ${pc.dim('# a whole folder, mirroring its structure into ./web')}
  $ krakenio optimize ./photos --lossy --out-dir ./web -y

  ${pc.dim('# replace the originals in place (asks first)')}
  $ krakenio opt ./photos --lossy --overwrite

  ${pc.dim('# straight to Amazon S3, one object per image')}
  $ krakenio config set-s3 AKIA… SECRET… eu-central-1
  $ krakenio optimize ./photos --s3 my-bucket/optimized/ -y

  ${pc.dim('# scripting: machine-readable, nothing written to disk')}
  $ krakenio optimize photo.jpg --json --no-save

  ${pc.dim('# account quota')}
  $ krakenio status

${pc.bold('Exit codes')}
  ${pc.dim('0')} success   ${pc.dim('1')} one or more images failed   ${pc.dim('2')} usage error   ${pc.dim('3')} command not available yet
`);

// Commander exits 1 for every parse problem. Route those through die() too so
// "bad flags" is always exit 2, whether it was Commander or our own validation
// that caught it — scripts get one rule instead of two.
function takeOverExits(command) {
  command.exitOverride();
  for (const sub of command.commands) takeOverExits(sub);
}
takeOverExits(program);

function die(e) {
  if (e?.name === 'CommanderError') {
    // --help and --version are a successful, already-printed exit.
    process.exit(e.exitCode === 0 ? 0 : 2);
  }
  if (e instanceof UsageError) {
    console.error('\n  ' + pc.red(pc.bold('✖ ')) + pc.red(e.message));
    console.error(pc.dim('\n  Run `krakenio --help` for usage.\n'));
    process.exit(2);
  }
  if (e?.name === 'UnavailableError') {
    console.error('\n  ' + pc.yellow(pc.bold('✖ ')) + pc.bold(e.message));
    console.error();
    for (const line of e.detail || []) console.error('    ' + pc.dim(line));
    console.error();
    process.exit(3);
  }
  console.error('\n  ' + pc.red(pc.bold('✖ ')) + pc.red(e?.message || String(e)));
  if (process.env.KRAKEN_DEBUG && e?.stack) console.error(pc.dim(e.stack));
  process.exit(1);
}

process.on('unhandledRejection', die);
program.parseAsync(process.argv).catch(die);
