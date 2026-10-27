#!/usr/bin/env bash
# dispatch/docker.sh: orbs as Docker containers on the control plane's machine, each with its own files,
# processes and CPU and memory limits. The server must be reachable from containers: run it with
# --host 0.0.0.0 and --public-url http://host.docker.internal:<port>.
#
#   ORB_IMAGE         default moonlet-orb, built from dispatch/docker/Dockerfile when missing
#   ORB_CPUS          default 2;  ORB_MEMORY default 4G
#   ORB_PAUSE         freeze (docker pause: processes and memory kept) or stop (only the disk kept; default)
#   ORB_SNAPSHOT_ID   snapshot: save the container as image moonlet-snap:<id>; spawn: start a new orb from it
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
image="${ORB_IMAGE:-moonlet-orb}"
[[ "$image" == boldsoftware/exeuntu || "$image" == default ]] && image=moonlet-orb
cpus="${ORB_CPUS:-2}"
memory="${ORB_MEMORY:-4G}"
snapshot="${ORB_SNAPSHOT_ID:+moonlet-snap:$ORB_SNAPSHOT_ID}"

state=$(docker container inspect -f '{{.State.Status}}' "$ORB_ID" 2>/dev/null || true)

case "$ORB_OPERATION" in
spawn)
	if [[ -z "$state" ]]; then
		if [[ -n "$snapshot" ]] && docker image inspect "$snapshot" >/dev/null 2>&1; then
			image="$snapshot"
			echo "starting from snapshot $ORB_SNAPSHOT_ID"
		elif [[ "$image" == moonlet-orb ]] && ! docker image inspect moonlet-orb >/dev/null 2>&1; then
			# One build at a time when several orbs spawn at once.
			flock "$here/docker/.build.lock" bash -c \
				'docker image inspect moonlet-orb >/dev/null 2>&1 || docker build -q -t moonlet-orb "$1"' _ "$here/docker"
		fi
		docker run -d --name "$ORB_ID" --hostname "$ORB_ID" --init \
			--cpus "$cpus" --memory "$memory" --memory-swap "$memory" --pids-limit 4096 \
			--add-host host.docker.internal:host-gateway --label moonlet.orb=1 \
			"$image" sleep infinity >/dev/null
	else
		docker update --cpus "$cpus" --memory "$memory" --memory-swap "$memory" "$ORB_ID" >/dev/null || true
		case "$state" in
		paused) docker unpause "$ORB_ID" >/dev/null ;;
		running) ;;
		*) docker start "$ORB_ID" >/dev/null ;;
		esac
	fi
	# Taken from this environment (-e NAME), so the token is not on a command line.
	export ORB_TOKEN ORB_ID ORB_SERVER_URL
	docker exec -d -e ORB_TOKEN -e ORB_ID -e ORB_SERVER_URL "$ORB_ID" \
		bash -lc "cd ~ && { ${ORB_BOOTSTRAP:?}; } >>~/.orb-bootstrap.log 2>&1"
	echo "container $ORB_ID running"
	;;
pause)
	if [[ "${ORB_PAUSE:-stop}" == freeze ]]; then
		if [[ "$state" == running ]]; then docker pause "$ORB_ID" >/dev/null; fi
	else
		if [[ "$state" == paused ]]; then docker unpause "$ORB_ID" >/dev/null; state=running; fi
		if [[ "$state" == running ]]; then docker stop -t 10 "$ORB_ID" >/dev/null; fi
	fi
	echo "paused (${ORB_PAUSE:-stop})"
	;;
snapshot)
	[[ -n "$snapshot" ]] || { echo "ORB_SNAPSHOT_ID is required" >&2; exit 1; }
	# Without --pause the orb keeps working while its disk is copied.
	docker commit --pause=false "$ORB_ID" "$snapshot" >/dev/null
	echo "saved $snapshot"
	;;
delete)
	if [[ -n "$state" ]]; then
		docker rm -f "$ORB_ID" >/dev/null
	fi
	;;
*)
	echo "unknown ORB_OPERATION: $ORB_OPERATION" >&2
	exit 1
	;;
esac
