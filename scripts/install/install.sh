#!/bin/sh
# Nomad installer for Mac and Linux.
#
#   curl -fsSL https://thenomad.website/install.sh | sh
#
# What it does: downloads Nomad for your system from the project's GitHub releases, checks it
# against its published SHA-256 fingerprint, and installs it in your user folder. No admin rights.
# It adds the nomad command, and Nomad to your Applications (Mac) or apps menu (Linux).
# It does not touch your agents. Remove it any time with: nomad uninstall
#
# Options, as environment variables:
#   NOMAD_INSTALL_VERSION=0.4.3   install this version instead of the newest
#   NOMAD_INSTALL_NO_OPEN=1       do not open Nomad at the end
set -eu

REPO="kadiri-seer/nomad"
MARK="Nomad installer"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'Nomad was not installed: %s\n' "$*" >&2
  exit 1
}
# Quote a value for sh, so a folder name can never be read as a command.
sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --proto '=https' --tlsv1.2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --https-only -O "$2" "$1"
  else
    fail "curl or wget is needed to download Nomad."
  fi
}

# NOMAD_INSTALL_SOURCE (a folder or https:// address holding the release files) is for testing.
fetch() {
  src="${NOMAD_INSTALL_SOURCE:-https://github.com/$REPO/releases/download/v$version}"
  case "$src" in
    https://*) download "$src/$1" "$2" ;;
    *) cp "$src/$1" "$2" ;;
  esac
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    fail "sha256sum or shasum is needed to check the download."
  fi
}

# version_lt 2.27 2.28 -> true
version_lt() {
  [ "$1" = "$2" ] && return 1
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t . -k 1,1n -k 2,2n -k 3,3n | head -n 1)" = "$1" ]
}

main() {
  [ -n "${HOME:-}" ] && [ -d "$HOME" ] || fail "HOME is not set."

  # Which system
  case "$(uname -s)" in
    Darwin) os=macos ;;
    Linux) os=linux ;;
    *) fail "this installer is for Mac and Linux. On Windows, run in PowerShell: irm https://thenomad.website/install.ps1 | iex" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "$(uname -m) processors are not supported yet. You can use npm instead: npm install -g thenomad" ;;
  esac
  if [ "$os" = macos ]; then
    # An Intel terminal on an Apple Silicon Mac still gets the faster Apple Silicon build.
    [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ] && arch=arm64
    mac=$(sw_vers -productVersion 2>/dev/null || echo 0)
    version_lt "$mac" 13.5 && fail "Nomad needs macOS 13.5 or newer. This Mac has $mac."
  else
    if ldd --version 2>&1 | grep -qi musl || ls /lib/ld-musl-* >/dev/null 2>&1; then
      fail "Linux with musl (such as Alpine) is not supported yet. You can use npm instead: npm install -g thenomad"
    fi
    glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{ print $2 }')
    [ -n "$glibc" ] && version_lt "$glibc" 2.28 && fail "Nomad needs glibc 2.28 or newer. This system has $glibc."
  fi
  target="$os-$arch"
  asset="nomad-$target.tar.gz"

  # Which version
  if [ -n "${NOMAD_INSTALL_VERSION:-}" ]; then
    version="$NOMAD_INSTALL_VERSION"
  elif [ -n "${NOMAD_INSTALL_SOURCE:-}" ]; then
    fail "set NOMAD_INSTALL_VERSION together with NOMAD_INSTALL_SOURCE."
  else
    say "Finding the newest Nomad..."
    tmpjson=$(mktemp)
    download "https://api.github.com/repos/$REPO/releases/latest" "$tmpjson" || fail "could not reach GitHub. Check your connection and try again."
    version=$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' "$tmpjson" | head -n 1)
    rm -f "$tmpjson"
  fi
  case "$version" in
    "" | *[!0-9.]* | .* | *.) fail "could not tell which version to install." ;;
  esac

  if [ "$os" = linux ]; then
    root="${XDG_DATA_HOME:-$HOME/.local/share}/nomad"
  else
    root="$HOME/.local/share/nomad"
  fi
  mkdir -p "$root/app" "$root/bin"
  work=$(mktemp -d "$root/tmp-XXXXXX")
  trap 'rm -rf "$work"' EXIT INT TERM

  # Download and check
  say "Downloading Nomad $version for $target..."
  fetch SHA256SUMS "$work/SHA256SUMS" || fail "could not download the fingerprint list for Nomad $version."
  fetch "$asset" "$work/$asset" || fail "could not download $asset."
  expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print tolower($1) }' "$work/SHA256SUMS" | head -n 1)
  [ -n "$expected" ] || fail "the release has no fingerprint for $asset."
  actual=$(sha256 "$work/$asset" | tr 'A-F' 'a-f')
  [ "$actual" = "$expected" ] || fail "the download does not match its published fingerprint. Nothing was changed."
  say "Fingerprint checked."

  # Unpack next to any version already installed, and check it runs before switching to it.
  mkdir "$work/app"
  tar -xzf "$work/$asset" -C "$work/app" || fail "could not unpack the download."
  got=$("$work/app/node" "$work/app/node_modules/thenomad/dist/nomad.js" --version 2>&1) || fail "the downloaded Nomad did not start: $got"
  [ "$got" = "$version" ] || fail "the download says it is version $got, not $version."
  rm -rf "$root/app/$version"
  mv "$work/app" "$root/app/$version"

  for f in "$root/app/$version/launcher/"*; do
    cp "$f" "$root/bin/"
  done
  chmod 755 "$root/bin/nomad" "$root/bin/uninstall.sh"
  [ -f "$root/bin/nomad-app.command" ] && chmod 755 "$root/bin/nomad-app.command"

  printf '%s' "$version" >"$work/current"
  mv -f "$work/current" "$root/current"
  printf '{\n  "by": "nomad-installer",\n  "target": "%s",\n  "version": "%s"\n}\n' "$target" "$version" >"$root/install.json"
  for old in "$root/app/"*; do
    [ "$old" = "$root/app/$version" ] || rm -rf "$old"
  done

  # The nomad command, in ~/.local/bin
  other=$(command -v nomad 2>/dev/null || true)
  mkdir -p "$HOME/.local/bin"
  cmd="$HOME/.local/bin/nomad"
  if [ -e "$cmd" ] && ! grep -q "$MARK" "$cmd" 2>/dev/null; then
    say "Note: $cmd already exists and is not from this installer, so it was left alone."
    say "      Run Nomad with: $root/bin/nomad"
  else
    printf '#!/bin/sh\n# Nomad command, added by the %s (remove with: nomad uninstall)\nexec %s "$@"\n' "$MARK" "$(sq "$root/bin/nomad")" >"$cmd"
    chmod 755 "$cmd"
  fi
  case ":${PATH:-}:" in
    *":$HOME/.local/bin:"*) on_path=1 ;;
    *) on_path=0 ;;
  esac
  if [ "$on_path" -eq 0 ]; then
    case "$(basename "${SHELL:-sh}")" in
      zsh) rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
      bash) if [ "$os" = macos ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
      fish) rc="" ;;
      *) rc="$HOME/.profile" ;;
    esac
    if [ -z "$rc" ]; then
      mkdir -p "$HOME/.config/fish/conf.d"
      # shellcheck disable=SC2016 # written as is, for the shell to expand later
      printf '# Added by the %s (remove with: nomad uninstall)\nfish_add_path -g "$HOME/.local/bin"\n' "$MARK" >"$HOME/.config/fish/conf.d/nomad.fish"
      say "Added ~/.local/bin to your PATH in ~/.config/fish/conf.d/nomad.fish."
    elif ! grep -q "# Added by the $MARK" "$rc" 2>/dev/null; then
      # Start on a new line if the file does not end with one.
      [ -s "$rc" ] && [ -n "$(tail -c 1 "$rc")" ] && printf '\n' >>"$rc"
      # shellcheck disable=SC2016 # written as is, for the shell to expand later
      printf '# Added by the %s (remove with: nomad uninstall)\nexport PATH="$HOME/.local/bin:$PATH"\n' "$MARK" >>"$rc"
      say "Added ~/.local/bin to your PATH in $rc."
    fi
  fi

  # Nomad in Applications (Mac) or the apps menu (Linux)
  if [ "$os" = macos ]; then
    app="$HOME/Applications/Nomad.app"
    if [ -e "$app" ] && ! grep -q "website.thenomad.app" "$app/Contents/Info.plist" 2>/dev/null; then
      say "Note: $app already exists and is not from this installer, so it was left alone."
    else
      rm -rf "$app"
      mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
      cp "$root/bin/nomad.icns" "$app/Contents/Resources/nomad.icns"
      cat >"$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>website.thenomad.app</string>
  <key>CFBundleName</key><string>Nomad</string>
  <key>CFBundleDisplayName</key><string>Nomad</string>
  <key>CFBundleExecutable</key><string>Nomad</string>
  <key>CFBundleIconFile</key><string>nomad</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>13.5</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
      # Opens a Terminal window running the dashboard: close that window to stop Nomad.
      printf '#!/bin/sh\n# Added by the %s.\nexec /usr/bin/open -a Terminal %s\n' "$MARK" "$(sq "$root/bin/nomad-app.command")" >"$app/Contents/MacOS/Nomad"
      chmod 755 "$app/Contents/MacOS/Nomad"
      touch "$app"
    fi
  else
    apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
    case "$root" in
      *[\"\`\$\\%]*) say "Note: no apps menu entry, because the folder name $root has characters menus cannot use." ;;
      *)
        mkdir -p "$apps"
        cat >"$apps/nomad.desktop" <<DESKTOP
[Desktop Entry]
# Added by the $MARK (remove with: nomad uninstall)
Type=Application
Name=Nomad
Comment=Move your AI agents between platforms
Exec="$root/bin/nomad" ui --app
Icon=$root/bin/nomad.png
Terminal=true
Categories=Development;Utility;
DESKTOP
        command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$apps" >/dev/null 2>&1 || true
        ;;
    esac
  fi

  say ""
  say "Nomad $version is installed."
  if [ "$os" = macos ]; then
    say "Open it any time from Nomad in your Applications folder or Launchpad."
  else
    say "Open it any time from Nomad in your apps menu."
  fi
  if [ "$on_path" -eq 1 ]; then
    say "In a terminal, type: nomad"
  else
    say "In a new terminal window, type: nomad"
  fi
  say "Remove it with: nomad uninstall"
  if [ -n "$other" ] && [ "$other" != "$cmd" ] && ! grep -q "$MARK" "$other" 2>/dev/null; then
    say "Note: another nomad command is at $other (probably from npm). The one found first in PATH runs."
  fi

  if [ -z "${NOMAD_INSTALL_NO_OPEN:-}" ] && [ "$os" = macos ] && [ -d "$HOME/Applications/Nomad.app" ]; then
    say "Opening Nomad..."
    /usr/bin/open "$HOME/Applications/Nomad.app" >/dev/null 2>&1 || true
  fi
}

main "$@"
