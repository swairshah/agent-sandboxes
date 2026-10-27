#!/usr/bin/env bash
# Run `amp orb provider` with the exe.dev dispatch program.
# The provider token lives in .env (mode 600, never committed).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -a
# shellcheck disable=SC1091
source "$here/.env"
set +a
exec amp orb provider "$here/dispatch.sh"
