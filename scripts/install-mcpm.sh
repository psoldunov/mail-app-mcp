#!/bin/sh
set -eu

fail() {
    printf '%s\n' "$*" >&2
    exit 1
}

[ "$#" -eq 1 ] || fail "Usage: scripts/install-mcpm.sh <40-character Git commit SHA>"
revision=$1
[ "${#revision}" -eq 40 ] || fail "Revision must be a full 40-character hexadecimal Git commit SHA."
case "$revision" in
    *[!0-9a-fA-F]*) fail "Revision must be a full 40-character hexadecimal Git commit SHA." ;;
esac

[ "$(uname -s)" = Darwin ] || fail "Apple Mail MCP requires macOS."
command -v uv >/dev/null 2>&1 || fail "Install uv before running this helper."
command -v mcpm >/dev/null 2>&1 || fail "Install mcpm before running this helper."

uv tool install "git+https://github.com/psoldunov/mail-app-mcp.git@$revision" \
    || fail "uv could not install the pinned revision."
bin_dir=$(uv tool dir --bin) || fail "uv could not locate its executable directory."
case "$bin_dir" in
    /*) ;;
    *) fail "uv returned a non-absolute executable directory." ;;
esac
binary="$bin_dir/mail-app-mcp"
[ -f "$binary" ] && [ -x "$binary" ] || fail "Installed mail-app-mcp executable was not found: $binary"

# MCPM_FORCE can overwrite an existing server even without --force.
MCPM_FORCE=false mcpm new mail-app --type stdio --command "$binary" \
    || fail "MCPM registration failed; inspect its error above."
