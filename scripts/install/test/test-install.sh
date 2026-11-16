#!/bin/sh
# Installs Nomad from freshly built bundles with the real install.sh, uses it, updates nothing,
# and removes it again. Runs in CI on Mac and Linux, in a throwaway home folder.
#
#   sh scripts/install/test/test-install.sh <folder with bundles and SHA256SUMS> <version>
set -eu

dist=$(CDPATH='' cd -- "$1" && pwd -P)
version=$2
here=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
failures=0
ok() { printf 'ok    %s\n' "$*"; }
bad() {
  printf 'FAIL  %s\n' "$*"
  failures=$((failures + 1))
}
check() { # label, command...
  label=$1
  shift
  if "$@" >/dev/null 2>&1; then ok "$label"; else bad "$label"; fi
}

HOME=$(mktemp -d)
export HOME
export SHELL=/bin/bash
# Without ~/.local/bin, so the installer has to add it.
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
unset XDG_DATA_HOME ZDOTDIR NOMAD_HOME 2>/dev/null || true
export NOMAD_INSTALL_SOURCE="$dist" NOMAD_INSTALL_VERSION="$version" NOMAD_INSTALL_NO_OPEN=1
root="$HOME/.local/share/nomad"
cmd="$HOME/.local/bin/nomad"
if [ "$(uname -s)" = Darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi

echo "== install"
sh "$here/install.sh"
check "the nomad command runs version $version" test "$("$cmd" --version)" = "$version"
check "the install folder has one version" test "$(ls "$root/app")" = "$version"
check "install.json names the installer" grep -q '"by": "nomad-installer"' "$root/install.json"
check "PATH line added once" test "$(grep -c 'Added by the Nomad installer' "$rc")" = 1

echo "== install again (repair)"
sh "$here/install.sh" >/dev/null
check "still runs" test "$("$cmd" --version)" = "$version"
check "PATH line still added once" test "$(grep -c 'Added by the Nomad installer' "$rc")" = 1
check "no temporary folders left" test -z "$(ls -d "$root"/tmp-* 2>/dev/null)"

echo "== use it"
check "the library opens (database module works)" "$cmd" list --json
if "$cmd" validate "$HOME/not-there.nomad" >/dev/null 2>&1; then bad "a failing command reports failure"; else ok "a failing command reports failure"; fi
check "arguments with spaces reach Nomad" "$cmd" --home "$HOME/a folder with spaces" list --json
check "the folder with spaces was used" test -d "$HOME/a folder with spaces"

if [ "$(uname -s)" = Darwin ]; then
  app="$HOME/Applications/Nomad.app"
  check "Nomad.app has a valid Info.plist" plutil -lint "$app/Contents/Info.plist"
  check "Nomad.app can start" test -x "$app/Contents/MacOS/Nomad"
  check "Nomad.app has its icon" test -s "$app/Contents/Resources/nomad.icns"
  check "the app launcher is executable" test -x "$root/bin/nomad-app.command"
else
  desktop="$HOME/.local/share/applications/nomad.desktop"
  check "apps menu entry exists" test -f "$desktop"
  check "apps menu icon exists" test -s "$root/bin/nomad.png"
  if command -v desktop-file-validate >/dev/null 2>&1; then check "apps menu entry is valid" desktop-file-validate "$desktop"; fi
fi

echo "== open the dashboard twice (the second finds the next port)"
"$cmd" ui --app --no-open >"$HOME/ui1.log" 2>&1 &
p1=$!
for _ in $(seq 1 60); do grep -q "is open at" "$HOME/ui1.log" 2>/dev/null && break; sleep 1; done
"$cmd" ui --app --no-open >"$HOME/ui2.log" 2>&1 &
p2=$!
for _ in $(seq 1 60); do grep -q "is open at" "$HOME/ui2.log" 2>/dev/null && break; sleep 1; done
url1=$(grep -o 'http://127.0.0.1:[0-9]*/app/session?token=[A-Za-z0-9_-]*' "$HOME/ui1.log" | head -n 1)
url2=$(grep -o 'http://127.0.0.1:[0-9]*/app/session?token=[A-Za-z0-9_-]*' "$HOME/ui2.log" | head -n 1)
check "the first window says how to stop" grep -q "close it to stop" "$HOME/ui1.log"
check "the second window uses another port" test -n "$url2" -a "${url1%%/app*}" != "${url2%%/app*}"
base=${url1%%/app*}
curl -s -c "$HOME/jar" -o /dev/null "$url1"
status=$(curl -s -b "$HOME/jar" "$base/api/app/update")
check "the dashboard knows it can update ($status)" test "$status" = "{\"installed\":true,\"current\":\"$version\"}"
check "the dashboard page loads" curl -sf -b "$HOME/jar" -o /dev/null "$base/app/settings"
kill "$p1" "$p2" 2>/dev/null || true
wait "$p1" "$p2" 2>/dev/null || true

echo "== a tampered download is refused"
bad_dist=$(mktemp -d)
cp "$dist"/* "$bad_dist/"
for f in "$bad_dist"/nomad-*.tar.gz; do printf 'x' >>"$f"; done
if NOMAD_INSTALL_SOURCE="$bad_dist" sh "$here/install.sh" >"$HOME/bad.log" 2>&1; then bad "tampered download refused"; else ok "tampered download refused"; fi
check "it says why" grep -q "does not match its published fingerprint" "$HOME/bad.log"
check "the installed Nomad still runs" test "$("$cmd" --version)" = "$version"

echo "== uninstall, keeping the library"
"$cmd" uninstall --yes
check "program removed" test ! -e "$root"
check "command removed" test ! -e "$cmd"
check "PATH line removed" test "$(grep -c 'Added by the Nomad installer' "$rc" || true)" = 0
check "Nomad.app or menu entry removed" test ! -e "$HOME/Applications/Nomad.app" -a ! -e "$HOME/.local/share/applications/nomad.desktop"
check "library kept" test -d "$HOME/.nomad"

echo "== install, then uninstall with the library"
sh "$here/install.sh" >/dev/null
"$cmd" uninstall --yes --remove-data
check "program removed" test ! -e "$root"
check "library removed" test ! -e "$HOME/.nomad"

rm -rf "$HOME" "$bad_dist"
if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed."
  exit 1
fi
echo "All install checks passed."
