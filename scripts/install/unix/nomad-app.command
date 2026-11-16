#!/bin/sh
# Opens the Nomad dashboard. Used by Nomad.app in your Applications folder.
clear 2>/dev/null
exec "$(dirname -- "$0")/nomad" ui --app
