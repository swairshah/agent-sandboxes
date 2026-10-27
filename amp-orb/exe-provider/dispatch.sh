#!/usr/bin/env bash
# dispatch.sh: Amp self-hosted orb provider for exe.dev.
#
# `amp orb provider` runs this once per job with ORB_OPERATION set to
# spawn, pause, or delete. Each orb is one exe.dev VM named $ORB_ID.
# Every operation is idempotent and should finish well under five minutes.
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log="$here/jobs.log"
ssh_opts=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)

# Record each job (never the token) so we can see what Amp asks for.
printf '%s op=%s id=%s image=%s snapshot=%s amp_url=%s\n' \
	"$(date -u +%FT%TZ)" "$ORB_OPERATION" "$ORB_ID" "${ORB_IMAGE:-}" \
	"${ORB_SNAPSHOT_ID:-}" "${AMP_URL:-}" >>"$log"

vm_status() {
	ssh "${ssh_opts[@]}" exe.dev ls "$1" --json |
		jq -r --arg id "$1" '.vms[]? | select(.vm_name == $id) | .status'
}

status=$(vm_status "$ORB_ID")

case "$ORB_OPERATION" in
spawn)
	if [[ -z "$status" ]]; then
		ssh "${ssh_opts[@]}" exe.dev new --name="$ORB_ID" --image="$ORB_IMAGE" \
			--cpu="${ORB_CPUS:-2}" --memory="${ORB_MEMORY:-8G}" \
			--tag=amp-orb --no-email
	elif [[ "$status" == paused || "$status" == stopped ]]; then
		ssh "${ssh_opts[@]}" exe.dev resume "$ORB_ID" ||
			ssh "${ssh_opts[@]}" exe.dev restart "$ORB_ID"
	fi
	# A fresh or resumed VM can drop the first SSH connections while it boots.
	for _ in $(seq 1 30); do
		ssh "${ssh_opts[@]}" "$ORB_ID.exe.xyz" true 2>/dev/null && break
		sleep 2
	done
	# Start the bootstrap as the image's default user, fully detached from
	# this SSH session. Any old bootstrap from before a pause is replaced.
	{
		printf 'export ORB_TOKEN=%q\n' "$ORB_TOKEN"
		if [[ -n "${AMP_URL:-}" ]]; then
			printf 'export AMP_URL=%q\n' "$AMP_URL"
		fi
		cat <<'BOOTSTRAP'
# exe.dev VMs have no /dev/fd, which breaks process substitution in Amp's setup hook.
[ -e /dev/fd ] || ln -s /proc/self/fd /dev/fd
pkill -u user -f 'amp orb bootstrap' || true
sudo -u user --preserve-env=ORB_TOKEN,AMP_URL bash -lc \
	'cd "$HOME"; setsid -f amp orb bootstrap </dev/null >>.amp-bootstrap.log 2>&1'
BOOTSTRAP
	} | ssh "${ssh_opts[@]}" "$ORB_ID.exe.xyz" bash -s
	;;
pause)
	if [[ "$status" == running ]]; then
		ssh "${ssh_opts[@]}" exe.dev pause "$ORB_ID"
	fi
	;;
delete)
	if [[ -n "$status" ]]; then
		ssh "${ssh_opts[@]}" exe.dev rm "$ORB_ID"
	fi
	;;
*)
	echo "unknown ORB_OPERATION: $ORB_OPERATION" >&2
	exit 1
	;;
esac
