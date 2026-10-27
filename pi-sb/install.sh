#!/usr/bin/env bash
# Installs pi-sb: builds sbx, installs the extension's dependencies, lists the
# extension FIRST in ~/.pi/agent/settings.json "packages" (pi keeps the first
# registration of a tool name, so pi-sb must load before other extensions that
# override edit/write/bash), and links the CLI as ~/.local/bin/pi-sb.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
settings="${PI_AGENT_DIR:-$HOME/.pi/agent}/settings.json"

make -C "$here" all
(cd "$here/extension" && npm install --silent --omit=dev)

mkdir -p "$(dirname "$settings")"
[ -f "$settings" ] || echo '{}' > "$settings"
cp "$settings" "$settings.bak-pi-sb"
node - "$settings" "$here/extension" <<'JS'
const fs = require("fs");
const [file, ext] = process.argv.slice(2);
const s = JSON.parse(fs.readFileSync(file, "utf8"));
const strip = (a) => (a ?? []).filter((p) => p !== ext);
s.packages = [ext, ...strip(s.packages)];
s.extensions = strip(s.extensions);
fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
JS

mkdir -p "$HOME/.local/bin"
ln -sf "$here/bin/sbx-darwin-arm64" "$HOME/.local/bin/pi-sb"

if [ ! -f "$HOME/.pi/agent/sb.json" ]; then
  cp "$here/sb.example.json" "$HOME/.pi/agent/sb.json"
  echo "wrote ~/.pi/agent/sb.json (edit \"read\" to choose what the sandbox may read)"
fi
echo "installed: pi --sb, pi --sb --remote, and the pi-sb CLI (settings backup: $settings.bak-pi-sb)"
