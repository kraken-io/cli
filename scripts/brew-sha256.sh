#!/usr/bin/env bash
# Prints the `url` and `sha256` lines for Formula/krakenio-cli.rb, taken from
# the tarball npm actually published. Run it after `npm publish`.
#
#   ./scripts/brew-sha256.sh            # current version from package.json
#   ./scripts/brew-sha256.sh 0.3.1      # a specific version
set -euo pipefail

cd "$(dirname "$0")/.."

name=$(node -p "require('./package.json').name")
version="${1:-$(node -p "require('./package.json').version")}"
pkg_base="${name##*/}"
url="https://registry.npmjs.org/${name}/-/${pkg_base}-${version}.tgz"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if ! curl -fsSL "$url" -o "$tmp/pkg.tgz"; then
  echo "error: ${name}@${version} is not on the npm registry yet." >&2
  echo "       Publish it first, then re-run this script." >&2
  exit 1
fi

sha=$(shasum -a 256 "$tmp/pkg.tgz" | awk '{print $1}')

echo "Paste into Formula/krakenio-cli.rb:"
echo
echo "  url \"${url}\""
echo "  sha256 \"${sha}\""
