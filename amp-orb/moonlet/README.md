# moonlet

Open-source orbs for [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) agents.

An orb is a remote machine that belongs to one agent thread. The agent works there instead of on
your laptop, and the machine is paused when the thread goes idle and resumed when you send the next
message. Amp popularized the idea and lets you
[self-host the machines](https://ampcode.com/news/self-hosted-orbs), but the agent loop and the
in-orb runtime stay Amp's. moonlet replaces both:

- the **agent loop** is a pi-durable `Harness` on your control plane: one durable conversation per
  thread, stored in SQLite, with your model credentials;
- the **in-orb runtime** is `moonlet bootstrap` plus pi-env's daemon: the agent's tools (`read`,
  `write`, `edit`, `bash`) run in the orb through pi-env's `RemoteExecutionEnv`;
- the **machines** come from the same dispatch programs Amp uses. A dispatch script written for
  `amp orb provider` works with moonlet, and `dispatch/exe-dev.sh` works with both.

## How it works

```
 you ── CLI / web UI ──▶ moonlet server (control plane)
                          ├─ pi-durable Harness: threads, model calls, durable tool tasks
                          ├─ RemoteExecutionEnv ─▶ pi-env Connection ─▶ `moonlet relay` (child process)
                          │                                                  │ loopback WebSocket
                          ├─ orb manager ◀──── splice ─────────────────────── ┘
                          │     ▲  ▲ control socket, pipe sockets (outbound from the orb)
                          │     │  └──────────────── orb: `moonlet bootstrap` ── stdio ── `pi-env serve`
                          └─ job queue ─▶ dispatch program (in-process, or `moonlet provider` elsewhere)
                                            spawn / pause / delete a machine
```

1. You send a message. It is committed to the thread's durable conversation at once.
2. When the agent first needs its environment (to render the prompt or run a tool), pi-durable
   calls moonlet's `env` factory. If the orb is not connected, moonlet queues a `spawn` job with a
   fresh signed `ORB_TOKEN`. The dispatch program creates or resumes the machine and runs the
   bootstrap installer inside it.
3. The bootstrap dials the control plane (outbound only) and says hello. On first connect moonlet
   clones the thread's repository and runs `.agents/setup`, like Amp.
4. Every tool call goes through pi-env's framed protocol, end to end: pi-env's `Connection` spawns
   `moonlet relay` instead of `ssh`, the control plane asks the orb for a pipe, the orb starts
   `pi-env serve` and pipes its stdio over a WebSocket, and the control plane splices the two.
   moonlet never parses pi-env's frames.
5. After `--idle-minutes` with no run in progress, moonlet closes the pi-env connection, shuts the
   bootstrap down and queues `pause`. The next tool call resumes the orb with a new token.

Because the conversation is durable, a control-plane restart or an orb pause mid-turn is safe:
pi-durable resumes the run; a tool call cut off by a lost connection returns an error result to the
model, and replay-safe tools rerun.

## Quick start

Requirements: [Bun](https://bun.sh) 1.3+, and model credentials: a pi-ai `auth.json` (for example
from `bun run login` in the pi-durable examples, for a ChatGPT subscription) or `OPENAI_API_KEY` /
`ANTHROPIC_API_KEY`.

```bash
bun install
bun run build:orb          # the Linux binary orbs download (dist/moonlet-linux-x64)
```

**Local orbs** (processes on this machine, for development):

```bash
bun src/cli.ts server --dispatch dispatch/local.sh --auth-file ~/path/to/auth.json
bun src/cli.ts new "Create hello.txt with the output of uname -a, then show it"
```

**exe.dev orbs.** Orbs must be able to reach the control plane, so give it a public URL, for
example a tunnel (`cloudflared tunnel --url http://127.0.0.1:7400`) or run it on a server:

```bash
bun src/cli.ts server --public-url https://moonlet.example.com \
  --dispatch dispatch/exe-dev.sh --auth-file ~/path/to/auth.json
bun src/cli.ts new --repo https://github.com/you/project "Run the tests and fix what fails"
```

Then use the CLI or open the server's URL in a browser (paste the API token from
`~/.moonlet/server/config.json`).

```
moonlet threads                     moonlet show <thread>
moonlet send <thread> "message"     moonlet watch <thread>
moonlet send <thread> --steer "…"   moonlet pause|abort|rm <thread>
```

**Container orbs** (several isolated orbs on one machine). `dispatch/docker.sh` runs each orb as a
Docker container with its own files, processes and CPU and memory limits; pause stops the container
and keeps its files. The image is built from `dispatch/docker/Dockerfile` on first use. Containers
reach the server through the Docker host, so listen on all interfaces:

```bash
bun src/cli.ts server --port 8000 --host 0.0.0.0 --public-url http://host.docker.internal:8000 \
  --dispatch dispatch/docker.sh --image moonlet-orb --auth-file ~/.moonlet/auth.json
```

A new container orb connects in about 3 s. Orbs on one machine share its CPU and memory.

## From pi

`pi/` is a [pi](https://pi.dev) extension that hands tasks to orbs, the way Amp's CLI runs threads in
orbs. Install it with `pi install ./pi` and point it at a server in `~/.moonlet/client.json`
(mode 600):

```json
{ "url": "https://moonlet.example.com", "token": "<apiToken from the server's config.json>" }
```

The model then has these tools:

| tool | does |
|---|---|
| `orb_dispatch(task, title?, repo?, size?, files?)` | starts a thread in a new orb (after copying `files` there) and returns its id at once |
| `orb_status(id?, wait?)` | lists the session's tasks, or reports one: running or idle, portals, and its steps since the last check |
| `orb_send(id, message, steer?)` | sends a follow-up |
| `orb_stop(id)` | stops the current run |
| `orb_changes(id, patch?)` | what the orb changed since it started: committed, uncommitted and new files |
| `orb_sync(id)` | applies those changes to this directory (`git apply`, three-way in a repository) |
| `orb_ship(id, mode?)` | asks the orb to ship: `trunk` (rebase, test, push), `branch` (push and open a PR) or `commit` |
| `orb_upload(id, files)` / `orb_download(id, path)` | copy files into or out of the orb |
| `orb_schedule(id, …)` | wakes the task later with a message, once or every N minutes |

Commands: `/orbs` lists the session's tasks, `/orb-term [id]` opens the orb's shared tmux session in
this terminal (detach with ctrl-b d to return to pi), and `/orb-open [id]` opens its portals and
desktop in the browser.

A task is a durable thread on the server, so it keeps running when the pi session ends or the laptop
sleeps. The session records its tasks; after `pi -c` the model can check on them, and `/orbs` lists
them. While a session is open it holds a socket to `/api/client`:

- tasks it started get `local_read`, `local_ls`, `local_find` and `local_grep`, which read files in
  the session's directory on your machine (read-only; paths outside it are refused). With no session
  connected, a call waits up to 15 minutes (`MOONLET_LOCAL_WAIT_MINUTES`) for one, then fails so the
  agent carries on;
- the session hears when a task finishes and shows its last message.

The same `~/.moonlet/client.json` points the `moonlet` CLI at that server.

### Running providers elsewhere

Like `amp orb provider`, the machine that creates orbs can be separate from the control plane. It
only needs outbound HTTPS:

```bash
moonlet provider ./dispatch.sh --server https://moonlet.example.com --token <providerToken>
```

## Dispatch contract

Each job runs the dispatch program once, with no arguments and these variables. They match Amp's
contract, plus two moonlet additions:

| Variable | Value |
|---|---|
| `ORB_OPERATION` | `spawn`, `pause`, or `delete` |
| `ORB_ID` | the orb's name, e.g. `moonlet-a27b5e6c`; use it as the machine name |
| `ORB_IMAGE` | image to boot (`--image`, default exe.dev's `boldsoftware/exeuntu`) |
| `ORB_TOKEN` | spawn only: signed, expiring credential for this spawn's bootstrap |
| `ORB_SERVER_URL` | spawn only: the control plane's public URL (Amp: `AMP_URL`) |
| `ORB_BOOTSTRAP` | spawn only: the shell command to run in the orb as its default user, detached (Amp: `amp orb bootstrap`) |

`spawn` makes the machine run (creating or resuming it) and runs `$ORB_BOOTSTRAP` with
`ORB_TOKEN`, `ORB_SERVER_URL` and `ORB_ID` set. `pause` stops it and keeps its disk; `delete`
removes it. Every operation must be safe to repeat and finish within five minutes. A spawn counts
only once the bootstrap connects, not when the program exits 0.

moonlet's bootstrap command downloads `/orb/install.sh`, which fetches the `moonlet` and `pi-env`
binaries for the machine's architecture (checked by SHA-256, cached in `~/.moonlet/bin`) and starts
`moonlet bootstrap`. An image needs only bash, curl and coreutils.

## Security model

- Orbs never accept connections. They dial the control plane with an HMAC-signed token bound to
  the orb and its spawn generation; a token of an older spawn is refused, which retires stale
  bootstraps after a resume.
- Model credentials and conversation storage stay on the control plane. The orb sees file contents
  and command output, as the agent's tools need.
- The API needs the `apiToken`, providers the `providerToken`; both live in the server's
  `config.json` (mode 600). The internal relay endpoint accepts only loopback requests without
  proxy headers, with a per-process key.
- `MOONLET_GIT_TOKEN` (optional) lets setup clone private GitHub repositories. It is passed to the
  clone command only, not stored in the orb's git config.

## In the orb

The orb agent has pi-durable's `read`, `write`, `edit` and `bash`, and moonlet's tools:

| tool | does |
|---|---|
| `service` | supervised long-running processes: `ensure` (start everything in `.amp/services.yaml` or `.moonlet/services.yaml`), `start`, `stop`, `restart`, `logs`, `list`. A server gets `$PORT`, `$PUBLIC_URL` and a portal, and is started again after a pause |
| `portal` | a URL for something already listening on a port |
| `desktop` | a Linux desktop with Chrome (display `:1`): the user watches and takes over through a noVNC portal; the agent drives Chrome over DevTools on port 9222 |
| `thread_create`, `thread_send`, `thread_status` | start other agents in their own orbs and follow them |
| `schedule` | wake this thread later, once or repeatedly |
| `local_read`, `local_ls`, `local_find`, `local_grep` | read the user's directory (threads started from pi) |

**Portals** are ports 4000–7999 of the server's machine (`MOONLET_PORTAL_PORTS`), one per (orb, port),
forwarded byte for byte through a pipe the orb's bootstrap opens to that port on its loopback; a
visit to a paused orb wakes it. On an exe.dev VM, `--portal-host <vm>.exe.xyz` gives
`https://<vm>.exe.xyz:<port>/` URLs that only people with access to the VM can open.

**Services** follow Amp's `.amp/services.yaml` (`command`, `cwd`, `port`, `env` with
`${services.<name>.publicURL}`, `health`, `portal`, `platforms`). Each runs under a restart loop in
its own process group; logs are in `~/.moonlet/services/<name>.log`.

**Lifecycle.** `.agents/setup` runs once per orb, `.agents/resume` after every wake (10 s, then in the
background). After a successful setup of a repository, the orb is saved as a project snapshot
(`docker commit`); new orbs for that repository start from it for 72 hours and only fast-forward the
checkout. A paused orb is first frozen (`docker pause`: processes, services and terminals carry on
after a resume) and stopped after two hours (`MOONLET_DEEP_PAUSE_MINUTES`). Sizes: `small` (1 CPU,
2 GB), `medium` (2, 4 GB, the default), `large` (4, 8 GB), `xlarge` (4, 14 GB).

**Secrets and env vars** (`moonlet secrets set NAME < value`, `--plain` for visible values) reach every
process in every orb through the environment of its pi-env daemon, never the orb's disk. Secret values
are masked in tool output before the model sees it. A `GITHUB_TOKEN` also authenticates `git` and `gh`
(through git's `GIT_CONFIG_*` environment), so orbs can push and open pull requests.

**Changes.** Every workspace is a git repository whose starting commit is recorded; the changes are
everything since, from a throwaway index (`GET /api/threads/<id>/changes`). Files copied in from the
user's machine join the starting commit, so syncing back does not recreate them.

**Terminal.** `moonlet term <thread>` (or `/orb-term` in pi) attaches to the tmux session `moonlet` in
the orb through a pi-env pseudo-terminal; the agent can use the same session.

## Compared with Amp orbs

See [`../docs/amp-orb-internals.md`](../docs/amp-orb-internals.md) for how Amp's orbs work inside, and
[`../docs/research/amp-orbs-features.md`](../docs/research/amp-orbs-features.md) for their features.

| | Amp | moonlet |
|---|---|---|
| Agent loop | Amp's thread actor | pi-durable Harness on your control plane |
| In-orb runtime | `amp orb bootstrap` + `amp --headless` executor | `moonlet bootstrap` + `pi-env serve` |
| Tool transport | executor JSON-RPC over a Rivet WebSocket, with leases | pi-env's framed protocol over spliced WebSockets |
| Machines | your dispatch program | the same dispatch program |
| Clients | web, macOS, iOS, CLI | pi (extension), CLI, a minimal web page |
| Setup, resume hooks | `.agents/setup`, `.agents/resume`, pre-clone and pre-setup scripts | `.agents/setup`, `.agents/resume` |
| Project snapshots | per project and size, 72 h | per repository, 72 h (Docker dispatch) |
| Pause | hosted: memory kept; self-hosted: disk | frozen (memory kept), stopped after 2 h |
| Services, portals | `.amp/services.yaml`, `*.onamp.dev`, review widget, public links, custom domains | the same file; `<vm>.exe.xyz:<port>`, private to the VM's users; no widget or public links |
| Terminal, desktop | tmux tab; Wayland desktop with Chrome | tmux via `moonlet term`; X desktop with Chrome via noVNC |
| Changes, Sync, Ship | Changes view, `amp sync`, Ship and Restack prompts | `orb_changes`, `orb_sync` (one-off), `orb_ship` prompts |
| Secrets | workspace, project, personal; masked; OIDC tokens | one set per server; masked; no OIDC |
| Agent to agent, schedules | yes | yes |
| Multiplayer, Space, Slack, Linear, Amp Net | yes | no (single user) |

## Layout

```
src/cli.ts              CLI: server, provider, bootstrap, relay, thread commands
src/orb-main.ts         entry point of the binary orbs download (bootstrap only)
src/bootstrap.ts        in-orb: control socket, pipes to pi-env
src/relay.ts            control plane: stdio ↔ loopback WebSocket for pi-env's Connection
src/protocol.ts         messages, dispatch variables
src/tokens.ts           signed orb tokens
src/dispatch.ts         running dispatch programs; the provider loop
src/server/main.ts      HTTP API, WebSockets, downloads
src/server/orbs.ts      orb lifecycle, jobs, pipes, idle pause
src/server/threads.ts   pi-durable Harness, threads, setup
src/server/store.ts     threads, orbs and jobs in SQLite
src/server/clients.ts   users' pi sessions: local tool calls, finish notices
src/server/portals.ts   portal ports, forwarded to orb ports
src/server/services.ts  supervised services, services.yaml, .agents/resume
src/server/changes.ts   an orb's diff since its starting commit
src/server/secrets.ts   env for orbs, masking in tool output
src/server/terminals.ts terminals into the orb's tmux session
src/server/schedules.ts messages that wake threads later
dispatch/docker.sh      containers on the server's machine (image: dispatch/docker/Dockerfile)
dispatch/exe-dev.sh     exe.dev VMs (works for Amp too)
dispatch/local.sh       local processes, for development
pi/index.ts             the pi extension
```
