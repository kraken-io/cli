# Homebrew formula for krakenio-cli.
#
# Publishing checklist (see RELEASING.md):
#   1. npm publish              — the formula installs from the npm tarball
#   2. scripts/brew-sha256.sh   — prints the url + sha256 to paste below
#   3. commit the updated url/sha256 to the tap
#
# Install from this repo without a tap:  brew install --formula ./Formula/krakenio-cli.rb
class KrakenioCli < Formula
  desc "Command-line client for the Kraken.io image API"
  homepage "https://github.com/kraken-io/cli"
  url "https://registry.npmjs.org/@kraken-io/cli/-/cli-0.5.0.tgz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    # Version reporting needs no credentials and no network.
    assert_match version.to_s, shell_output("#{bin}/krakenio --version")

    # A dry run exercises argument parsing, input resolution and output planning
    # end to end, still without a network call or an API key.
    (testpath/"photo.jpg").write "not a real jpeg, only the extension matters here"
    output = shell_output("#{bin}/krakenio optimize #{testpath}/photo.jpg --lossy --dry-run")
    assert_match "photo.kraked.jpg", output

    # Unknown flags must fail loudly (exit 2 = usage error) rather than be ignored.
    assert_match "unknown option", shell_output("#{bin}/krakenio optimize --nonsense 2>&1", 2)
  end
end
