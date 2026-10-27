#!/usr/bin/env bash
# dispatch/exe-dev.sh: orbs as exe.dev VMs. Works for Amp (`amp orb provider`) and moonlet alike:
# it runs $ORB_BOOTSTRAP in the VM, which moonlet sets and Amp does not (falling back to
# `amp orb bootstrap`). Needs `ssh exe.dev` access and jq.
#
#   ORB_USER     user the bootstrap runs as: `exedev` on boldsoftware/exeuntu, `user` on Amp's image
#   ORB_CPUS     default 2;  ORB_MEMORY default 8G
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
ssh_opts=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
bootstrap="${ORB_BOOTSTRAP:-amp orb bootstrap}"
case "$ORB_IMAGE" in
*amp-orb*) default_user=user ;;
*) default_user=exedev ;;
esac
orb_user="${ORB_USER:-$default_user}"

status=$(ssh "${ssh_opts[@]}" exe.dev ls "$ORB_ID" --json |
	jq -r --arg id "$ORB_ID" '.vms[]? | select(.vm_name == $id) | .status')

case "$ORB_OPERATION" in
spawn)
	if [[ -z "$status" ]]; then
		# exe.dev splits arguments on spaces, so no value here may contain one.
		image=(--image="$ORB_IMAGE")
		# exe.dev's default image is listed as boldsoftware/exeuntu but is not a pullable name.
		[[ "$ORB_IMAGE" == boldsoftware/exeuntu || "$ORB_IMAGE" == default ]] && image=()
		ssh "${ssh_opts[@]}" exe.dev new --name="$ORB_ID" ${image[@]+"${image[@]}"} \
			--cpu="${ORB_CPUS:-2}" --memory="${ORB_MEMORY:-8G}" --tag=orb --no-email
	elif [[ "$status" != running ]]; then
		ssh "${ssh_opts[@]}" exe.dev resume "$ORB_ID" || ssh "${ssh_opts[@]}" exe.dev restart "$ORB_ID"
	fi
	# A fresh or resumed VM can drop the first SSH connections while it boots.
	for _ in $(seq 1 30); do
		ssh "${ssh_opts[@]}" "$ORB_ID.exe.xyz" true 2>/dev/null && break
		sleep 2
	done
	{
		printf 'export ORB_TOKEN=%q ORB_ID=%q ORB_USER=%q BOOTSTRAP=%q\n' "$ORB_TOKEN" "$ORB_ID" "$orb_user" "$bootstrap"
		printf 'export AMP_URL=%q ORB_SERVER_URL=%q\n' "${AMP_URL:-}" "${ORB_SERVER_URL:-}"
		cat <<'REMOTE'
[ -n "$AMP_URL" ] || unset AMP_URL
[ -n "$ORB_SERVER_URL" ] || unset ORB_SERVER_URL
# exe.dev VMs have no /dev/fd, which process substitution needs.
[ -e /dev/fd ] || sudo ln -s /proc/self/fd /dev/fd
sudo -u "$ORB_USER" --preserve-env=ORB_TOKEN,ORB_ID,AMP_URL,ORB_SERVER_URL,BOOTSTRAP bash -lc \
	'cd "$HOME"; nohup bash -c "$BOOTSTRAP" </dev/null >>"$HOME/.orb-bootstrap.log" 2>&1 &
	 sleep 2; tail -n 5 "$HOME/.orb-bootstrap.log"'
REMOTE
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
