#!/usr/bin/env bash
# Cuts a release: checks the tree, runs the suite, bumps the version, syncs the
# files that carry it, and creates the release commit and tag.
#
#   ./scripts/release.sh patch           # 0.3.0 -> 0.3.1
#   ./scripts/release.sh minor|major
#   ./scripts/release.sh 1.0.0           # an exact version
#   ./scripts/release.sh patch --push    # also push the branch and the tag
#   ./scripts/release.sh patch --dry-run # print the plan, change nothing
#
# package.json stays the single source of truth for the version; the tag is
# derived from it, so the two can never drift. See RELEASING.md for what comes
# after the tag (npm publish, then the Homebrew formula).
set -euo pipefail

cd "$(dirname "$0")/.."

BUMP=""; PUSH=0; DRY=0; BRANCH_OK=0
for arg in "$@"; do
  case "$arg" in
    --push)         PUSH=1 ;;
    --dry-run|-n)   DRY=1 ;;
    --any-branch)   BRANCH_OK=1 ;;
    -h|--help)      sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)             echo "error: unknown option '$arg'" >&2; exit 2 ;;
    *)              [ -z "$BUMP" ] || { echo "error: give one version bump, not two" >&2; exit 2; }
                    BUMP="$arg" ;;
  esac
done
[ -n "$BUMP" ] || { echo "error: usage: $0 <patch|minor|major|X.Y.Z> [--push] [--dry-run]" >&2; exit 2; }

say()  { printf '\033[1m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

# ── preflight ───────────────────────────────────────────────────────────────
git rev-parse --git-dir >/dev/null 2>&1 || fail "not a git repository"

branch=$(git branch --show-current)
if [ "$BRANCH_OK" -eq 0 ] && [ "$branch" != "main" ]; then
  fail "releases are cut from main, not '$branch' (override with --any-branch)"
fi

[ -z "$(git status --porcelain)" ] || fail "working tree is dirty — commit or stash first"

if git remote get-url origin >/dev/null 2>&1; then
  GIT_TERMINAL_PROMPT=0 git fetch --quiet origin "$branch" 2>/dev/null || true
  if git rev-parse --verify --quiet "origin/$branch" >/dev/null; then
    behind=$(git rev-list --count "HEAD..origin/$branch")
    [ "$behind" -eq 0 ] || fail "$branch is $behind commit(s) behind origin — pull first"
  fi
fi

current=$(node -p "require('./package.json').version")
next=$(node -e '
  const [cur, bump] = process.argv.slice(1);
  if (/^\d+\.\d+\.\d+([-+].*)?$/.test(bump)) { console.log(bump); process.exit(0); }
  const [a, b, c] = cur.split(".").map(Number);
  const next = { major: [a + 1, 0, 0], minor: [a, b + 1, 0], patch: [a, b, c + 1] }[bump];
  if (!next) { console.error(`bump must be major, minor, patch or an exact X.Y.Z (got "${bump}")`); process.exit(1); }
  console.log(next.join("."));
' "$current" "$BUMP")

tag="v$next"
git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null && fail "tag $tag already exists"

# The release notes are written by hand; refuse to tag a version nobody documented.
grep -q "^## \[$next\]" CHANGELOG.md \
  || fail "CHANGELOG.md has no '## [$next]' section — write the release notes first"

say "releasing $current -> $next  (tag $tag)"

if [ "$DRY" -eq 1 ]; then
  say "dry run — stopping before any change"
  echo
  echo "  would run:  npm run lint && npm test"
  echo "  would run:  npm version $next -m 'krakenio-cli v%s'"
  echo "              (the version hook syncs Formula/ and CHANGELOG.md into that commit)"
  [ "$PUSH" -eq 1 ] && echo "  would run:  git push origin $branch --follow-tags"
  exit 0
fi

# ── verify ──────────────────────────────────────────────────────────────────
say "linting"
npm run --silent lint
say "running the test suite"
npm test --silent >/dev/null || fail "tests failed — nothing was changed"

# ── bump ────────────────────────────────────────────────────────────────────
# npm version writes package.json, runs the `version` hook (which syncs the
# formula and dates the changelog, then stages them) and makes the commit + tag.
say "bumping and tagging"
npm version "$next" -m 'krakenio-cli v%s' >/dev/null

say "created $(git log -1 --format='%h %s') and tag $tag"

if [ "$PUSH" -eq 1 ]; then
  say "pushing $branch and $tag"
  git push origin "$branch" --follow-tags
else
  echo
  echo "  Not pushed. When you are ready:"
  echo "    git push origin $branch --follow-tags"
fi

cat <<EOF

  Next (see RELEASING.md):
    pushing the tag triggers .github/workflows/publish.yml, which publishes to
    npm once the tag, changelog, lint and tests all check out.
    To publish by hand instead: npm publish

    ./scripts/brew-sha256.sh    # then paste url + sha256 into Formula/krakenio-cli.rb
EOF
