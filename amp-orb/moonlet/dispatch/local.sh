#!/usr/bin/env bash
# dispatch/local.sh: "orbs" as plain processes on this machine, each with its own HOME.
# For development: it exercises the whole control plane, relay and pi-env path without VMs.
# Pause stops the bootstrap and keeps the directory; delete removes it.
set -euo pipefail
root="${MOONLET_LOCAL_ORBS:-$HOME/.moonlet/local-orbs}"
home="$root/$ORB_ID"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pidfile="$home/.moonlet/bootstrap.pid"

stop() {
	if [[ -f "$pidfile" ]]; then
		kill "$(cat "$pidfile")" 2>/dev/null || true
		rm -f "$pidfile"
	fi
}

case "$ORB_OPERATION" in
spawn)
	stop
	mkdir -p "$home/.moonlet"
	pi_env=$(ls "$here"/node_modules/@earendil-works/pi-env/bin/pi-env-darwin-*/pi-env "$here"/node_modules/@earendil-works/pi-env/bin/pi-env-linux-x64/pi-env 2>/dev/null |
		grep -m1 "$(uname -s | tr '[:upper:]' '[:lower:]')")
	HOME="$home" MOONLET_PI_ENV="$pi_env" nohup bun "$here/src/cli.ts" bootstrap \
		>>"$home/.moonlet/bootstrap.log" 2>&1 </dev/null &
	echo $! >"$pidfile"
	echo "local orb $ORB_ID started in $home"
	;;
pause) stop ;;
delete)
	stop
	rm -rf "$home"
	;;
*) exit 1 ;;
esac
