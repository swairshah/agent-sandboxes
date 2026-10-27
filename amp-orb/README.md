# amp-orb sandbox

Self-hosted Amp orbs on exe.dev, and an open-source replacement for the part that runs in the orb.

- [`exe-provider/`](exe-provider/): Amp's orb provider for exe.dev. `run-provider.sh` runs
  `amp orb provider` with `dispatch.sh`; the provider token is in `.env` (mode 600). The provider is
  registered as `exe-dev` in the `swairshah` Amp workspace (Settings → Orbs). Pick it under
  Orb → Self-Hosted in a new thread.
- [`docs/amp-orb-internals.md`](docs/amp-orb-internals.md): how Amp's orbs work inside: the provider
  job API, `amp orb bootstrap`, the headless executor and its tool protocol, lifecycle.
- [`moonlet/`](moonlet/): open-source orbs for pi-durable agents. Same dispatch contract, so the same
  exe.dev script drives both. See its README.
- The moonlet server runs on the exe.dev VM `moonlet` (`https://moonlet.exe.xyz`, public; the API needs
  the token) as the systemd service `moonlet`, with orbs as Docker containers on that VM. Its data and
  model login are in `~/.moonlet` there. Your pi has the `moonlet/pi` extension installed and reads
  `~/.moonlet/client.json`. To deploy changes: `rsync -az --exclude node_modules --exclude dist
  moonlet/ moonlet.exe.xyz:moonlet/ && ssh moonlet.exe.xyz sudo systemctl restart moonlet`.

Notes from setting this up:

- exe.dev VMs have no `/dev/fd`; Amp's setup hook needs it. Both dispatch scripts create it.
- exe.dev splits `ssh exe.dev new` arguments on spaces, so no flag value may contain one.
- A fresh or resumed exe.dev VM can drop the first SSH connection; the scripts retry until SSH works.
- exe.dev's default image is listed as `boldsoftware/exeuntu` but cannot be passed to `--image`.
- The Individual plan caps an account at 50 VMs and 4 vCPUs / 16 GB in total, which limits how
  many orbs can exist and run at once.
