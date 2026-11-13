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

# Priors setups (a credit service for agents on Robinhood Chain). Read-only: no key, no funds.
npx --prefix "$ROOT" tsx "$ROOT/scripts/build-priors-fixtures.ts" "$H"
if [ -n "${CODEX_BIN:-}" ]; then
  mkdir -p "$H/priors-out/.codex"
  $NOMAD move "claude-code:$H/priors-claude/.claude" "codex:$H/priors-out/.codex" --yes --quiet
  CODEX_HOME="$H/priors-out/.codex" "$CODEX_BIN" mcp list | tee /dev/stderr | grep -q "priors-wallet"
  echo "codex: Priors servers from Claude Code accepted (env_vars forwarding, hosted url)"
fi
if [ -n "${CLAUDE_BIN:-}" ]; then
  mkdir -p "$H/priors-cc/.claude"
  $NOMAD move "hermes:$H/priors-hermes/.hermes" "claude-code:$H/priors-cc/.claude" --yes --quiet --approve-permissions
  (cd "$H/priors-cc" && HOME="$H/priors-cc" "$CLAUDE_BIN" mcp get priors-wallet | grep -q "@priors/mcp")
  echo "claude code: Priors servers from Hermes visible in user config"
fi
if [ -n "${PRIORS_MCP_BIN:-}" ]; then
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"nomad","version":"0"}}}' \
    | env -u PRIORS_KEY -u PRIORS_KEY_FILE PRIORS_STATE_DIR="$H/priors-state" timeout 20 "$PRIORS_MCP_BIN" 2>&1 >/dev/null | grep -q "read-only tools only"
  echo "priors-mcp: starts read-only without a key"
fi
