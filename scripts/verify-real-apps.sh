#!/usr/bin/env bash
# Checks Nomad's output with the real applications, when they are installed.
# Uses a throwaway home directory; your real configuration is never touched.
#   CODEX_BIN=/path/to/codex CLAUDE_BIN=/path/to/claude scripts/verify-real-apps.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
H="$(mktemp -d "${TMPDIR:-$HOME}/nomad-real.XXXX")"
trap 'rm -rf "$H"' EXIT
export NOMAD_FAKE_HOME="$H" NOMAD_HOME="$H/.nomad"
NOMAD="node $ROOT/apps/cli/dist/nomad.js"
npx --prefix "$ROOT" tsx -e "import('$ROOT/tests/fixtures/platforms.ts').then(m => m.buildAll('$H'))"

if [ -n "${CODEX_BIN:-}" ]; then
  mkdir -p "$H/fresh/.codex"
  $NOMAD migrate --from claude-code --to codex --dest-dir "$H/fresh/.codex" --yes --quiet
  $NOMAD migrate --from hermes --to codex --dest-dir "$H/fresh/.codex" --yes --quiet --approve-permissions
  CODEX_HOME="$H/fresh/.codex" "$CODEX_BIN" mcp list | tee /dev/stderr | grep -q filesystem
  echo "codex: config.toml accepted, migrated MCP servers listed"
fi

if [ -n "${CLAUDE_BIN:-}" ]; then
  $NOMAD migrate --from hermes --to claude-code --yes --quiet --approve-permissions
  (cd "$H" && HOME="$H" "$CLAUDE_BIN" mcp get filesystem | grep -q "Command: npx")
  echo "claude code: migrated MCP server visible in user config"
fi
