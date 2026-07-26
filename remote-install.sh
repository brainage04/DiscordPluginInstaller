#!/usr/bin/env bash
set -euo pipefail

if (( $# < 3 )); then
  printf 'Usage: %s SSH_COORDINATOR <vencord|revenge> <install|reinstall|uninstall> [options]\n' "$0" >&2
  exit 2
fi

coordinator=$1
shift
printf -v quoted_arguments '%q ' "$@"
if [[ -n ${DISCORD_PLUGIN_INSTALLER_DIR:-} ]]; then
  printf -v quoted_directory '%q' "$DISCORD_PLUGIN_INSTALLER_DIR"
else
  quoted_directory='$HOME/01_TM/Coding/Discord\ Plugins/DiscordPluginInstaller'
fi
exec ssh "$coordinator" "cd $quoted_directory && npm start -- $quoted_arguments"
