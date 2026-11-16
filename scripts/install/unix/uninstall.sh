#!/bin/sh
# Removes Nomad installed from thenomad.website. Your agents are not touched.
# Runs through: nomad uninstall   (or: sh ~/.local/share/nomad/bin/uninstall.sh)
set -u

yes=0
remove_data=0
data_dir=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) yes=1 ;;
    --remove-data) remove_data=1 ;;
    --data-dir) shift; data_dir="${1:-}" ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

MARK="Nomad installer"
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P) || exit 1
if ! grep -q '"by": "nomad-installer"' "$root/install.json" 2>/dev/null; then
  echo "This folder does not look like a Nomad install: $root" >&2
  exit 1
fi
[ -n "$data_dir" ] || data_dir="${NOMAD_HOME:-$HOME/.nomad}"

ask() {
  printf '%s [y/N] ' "$1" >/dev/tty
  read -r answer </dev/tty || answer=""
  case "$answer" in y | Y | yes | Yes | YES) return 0 ;; *) return 1 ;; esac
}

if [ "$yes" -eq 0 ]; then
  if ! (: </dev/tty) 2>/dev/null; then
    echo "Run: nomad uninstall --yes" >&2
    exit 3
  fi
  echo "This removes Nomad from $root, with its shortcut and the nomad command."
  echo "Your agents are not touched."
  if ! ask "Remove Nomad?"; then
    echo "Nothing was removed."
    exit 0
  fi
  if [ "$remove_data" -eq 0 ] && [ -d "$data_dir" ]; then
    if ask "Also delete the library, backups and history in $data_dir? Backups cannot be restored after this."; then remove_data=1; fi
  fi
fi

# The nomad command
cmd="$HOME/.local/bin/nomad"
if [ -f "$cmd" ] && grep -q "$MARK" "$cmd" 2>/dev/null; then rm -f "$cmd"; fi

# The PATH line the installer added, if it added one. Other lines stay exactly as they are.
for rc in "${ZDOTDIR:-$HOME}/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
  if [ -f "$rc" ] && grep -q "# Added by the $MARK" "$rc" 2>/dev/null; then
    tmp=$(mktemp) || continue
    # Drop the marker and the PATH line under it, and only that exact line: anything else stays.
    awk -v mark="# Added by the $MARK" -v line='export PATH="$HOME/.local/bin:$PATH"' 'skip { skip = 0; if ($0 == line) next } index($0, mark) == 1 { skip = 1; next } { print }' "$rc" >"$tmp" && cat "$tmp" >"$rc"
    rm -f "$tmp"
  fi
done
fish="$HOME/.config/fish/conf.d/nomad.fish"
if [ -f "$fish" ] && grep -q "$MARK" "$fish" 2>/dev/null; then rm -f "$fish"; fi

# Nomad.app on a Mac, the menu entry on Linux
app="$HOME/Applications/Nomad.app"
if [ -f "$app/Contents/Info.plist" ] && grep -q "website.thenomad.app" "$app/Contents/Info.plist" 2>/dev/null; then rm -rf "$app"; fi
desktop="${XDG_DATA_HOME:-$HOME/.local/share}/applications/nomad.desktop"
if [ -f "$desktop" ] && grep -q "$MARK" "$desktop" 2>/dev/null; then rm -f "$desktop"; fi

# The program
rm -rf "$root"

# Library, backups and history, only when asked, and only from a folder that holds Nomad's library.
data_removed=0
if [ "$remove_data" -eq 1 ] && [ -d "$data_dir" ]; then
  full=$(CDPATH='' cd -- "$data_dir" && pwd -P)
  home=$(CDPATH='' cd -- "$HOME" && pwd -P)
  if [ -z "$full" ] || [ "$full" = "/" ] || [ "$full" = "$home" ] || [ ! -f "$full/nomad.db" ]; then
    echo "Not deleting $data_dir: it does not look like Nomad's data folder (no nomad.db in it)."
  else
    rm -rf "$full" && data_removed=1
  fi
fi

if [ -e "$root" ]; then
  echo "Some files could not be removed. Delete this folder: $root" >&2
  exit 1
fi
echo "Nomad has been removed."
if [ "$data_removed" -eq 1 ]; then
  echo "Its library, backups and history were deleted."
elif [ -d "$data_dir" ]; then
  echo "Your library, backups and history are still in $data_dir."
fi
