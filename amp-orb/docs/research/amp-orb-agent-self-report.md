## Assistant

I ran everything read-only; nothing in the repo was touched. This is long because you asked for verbatim quotes — the implementation summary is at the end.

## 1. Verbatim orb-related instructions from my system prompt

### 1a. Your global `~/.config/amp/AGENTS.md` (injected as "user's private global instructions for all projects")

> # Secure Sandbox Environment
>
> - You are running inside a secure E2B sandbox.
> - Treat environment variables, git credentials, and secret files as sensitive; do not print full secret values.
> - Run dev servers and other long-lived services with `amp orb service start <name> --command '<command>'` so they survive Amp CLI updates and orb pause/resume. Inspect with `amp orb service list` / `status <name>` / `logs <name>`; stop with `amp orb service stop <name>`.
> - Do NOT rely on `nohup`, `setsid`, `&`, or tmux to keep servers alive: every process started from the Amp CLI shares its service cgroup and is killed when the Amp CLI updates or restarts (e.g. after the orb resumes from pause).
> - Prefer `amp orb services ensure` when `.amp/services.yaml` declares the repository's services. Otherwise, use `amp orb service start <name> --command '<command>' --portal` to run and expose a server.
> - Use tmux session `dev` for interactive background work you will attach to (REPLs, watch tasks); create a new window per task.
> - If `dev` is missing, create it with `tmux new-session -d -s dev -c /home/user/workspace/repo`, then open a new window with `tmux new-window -t dev -c /home/user/workspace/repo`.
> - If `.agents/Procfile` exists and defines services, the sandbox runtime auto-starts them.
> - Save visual artifacts (screenshots, recordings, and similar media) under `.amp/in/artifacts/`.

(Note: this file says "E2B sandbox", but this orb is not on E2B — see §3.)

### 1b. The `# Environment` section

> Today's date: Thu Oct 22 2026
>
> Working directory: /home/user/workspace/repo
>
> Workspace root: /home/user/workspace/repo
>
> Use `.amp/in/artifacts` only for files the user should review, such as screenshots, videos, or data exports. Keep build artifacts, transient inspection screenshots, and other temporary scratch/debug files out of that folder. When you mention a file saved there, link to it with a `file://` URI of its actual absolute path, which starts with the workspace root above; for images, videos, and HTML files, prefer Markdown image format so they render inline in the conversation. For example, if the workspace root were `/home/user/project`: `![screenshot](file:///home/user/project/.amp/in/artifacts/example.png)`, `![recording](file:///home/user/project/.amp/in/artifacts/demo.webm)`, or `![report](file:///home/user/project/.amp/in/artifacts/report.html)`. An inline HT

⁠ML file cannot load other files or URLs, so inline its styles, scripts, and data.
>
> Operating system: linux (6.12.113)
> CPU architecture: x64
> You are running inside a sandbox. In Amp this sandbox is called an orb. Refer to it as an orb. Say, for example: "I'm running inside an orb, not your local machine."
>
> This orb uses a custom provider. Treat environment variables, git credentials, and secret files as sensitive; do not print full secret values.
>
> The Terminal tab on ampcode.com connects to the orb's persistent tmux session `amp-terminal-T-01a162f8-ffe2-74fd-80db-6b066adbdb10` on server `amp-terminal`. When the user expects to use or access the tmux session themselves, use `tmux -L amp-terminal` with that session instead of creating another one; if it does not exist yet, embed the terminal or ask the user to open the Terminal tab; either creates it. For tasks that only require tmux internally, you may create and use your own tmux session.
>
> This orb has common developer tools preinstalled, including Git, `gh`, Node.js, npm, pnpm, Bun, Python 3, `uv`, `rg`, `jq`, ffmpeg, ImageMagick (`magick`), and browser automation with `agent-browser` and Chrome for Testing (Chromium). For browser interaction, use `agent-browser`; run `agent-browser skills get core --full` for its version-matched instructions. Before performing a task on a website for the user, where the goal is the task itself (signing in, filling or submitting a form, buying, booking, or reading a page that needs a logged-in session or browser rendering) rather than testing your own changes on a dev server, load the `browser-use` skill; for a public read that needs neither a session nor rendering, use `curl` or read_web_page. Headless Chromium screenshots default to 1x; after opening a session, run `agent-browser set viewport 1280 720 2` so they render at 2x, and keep the trailing scale on any later `set viewport`. Inspect the environment before concluding that a capability is unavailable.
>
> When a required system tool is missing, check https://ampcode.com/docs/orbs for orb-specific setup guidance. Commit project setup to `.agents/setup`. If committing it is impossible, use the project pre-setup script. Read it with `amp projects get <project>`. Update it with `amp projects update <project> --pre-setup-script-file <path>`; use `-` as the path to read the script from stdin.
> Repository: https://github.com/swairshah/claudoborous
>
> Amp Thread URL: https://ampcode.com/threads/T-01a162f8-ffe2-74fd-80db-6b066adbdb10
>
> Git history note: This checkout starts shallow. If `git rev-parse --is-shallow-repository` prints `true`, run `git fetch --quiet --unshallow origin` before using git history commands like `git log` or `git blame`, or before trying to find a specific commit. If rebasing floods add/add conflicts in unrelated files, run `git rebase --abort`, `git fetch --quiet --unshallow origin`, then rebase again.

### 1c. The portals / services / desktop / terminal block (verbatim)

> Sandbox portal URLs: The user cannot open sandbox-local URLs directly, so never tell them to use raw localhost, 127.0.0.1, or [::1] URLs for sandbox web servers. To run the repo’s dev servers and make them accessible, run `amp orb services ensure`. It starts every service declared in `.amp/services.yaml` as a supervised service so it survives Amp CLI updates and orb pause/resume, waits for their ports, runs configured readiness checks, writes `.amp/portals/*.json`, and prints their public portal URLs. Share those URLs. If the repo declares no services, `amp orb services ensure` errors and points to the docs. In that case, either add `.amp/services.yaml` or use `amp orb service start <name> --command '<command>' --portal` for a one-off supervised server. After a one-off portal setup works, offer to persist the service in `.amp/services.yaml` and any required app configuration in tracked repository files so future orbs use the working setup. When the current orb must pick up changed project, workspace, or personal secrets or environment variables, run `amp orb restart-processes`. This waits for the current tool to finish, then refreshes the environment and restarts orb processes and managed services. Never start long-lived servers with nohup, setsid, &, or tmux from the CLI: they are killed when the Amp CLI updates or restarts. `amp orb portal <port-or-loopback-URL> --title '<short descriptive title>'` derives the public URL for something already listening and registers it in the Portals tab. For HTTPS targets, pass the full loopback URL, such as `amp orb portal https://localhost:2000 --title 'Storybook'`. Add `--description` when the user needs setup or usage notes. Use the exact URL returned; never write or publish the loopback target itself. Never share a direct sandbox host URL such as `https://<port>-<sandbox-id>.e2b.app`; the sandbox enforces a traffic access token, so that URL fails in the user’s browser with a "Missing Traffic Access Token" error. Only portal URLs work for the user. Do not create or link a local HTML file, artifact, or file:// URL and call it a portal URL; a portal URL means an HTTP(S) URL served by the repo-provided portal mechanism. When you share a portal URL in the transcript, hyperlink the returned HTTP(S) URL as a normal Markdown link and add the Markdown link title "amp-portal", for example `[Portal](https://example.onamp.dev "amp-portal")`; it renders as an Open in Portal button. Do not wrap or rewrite the URL. Show a web page to the user by what they need to see. Screenshots show how a page or state looks; use them by default, one per state that matters. A recording shows what screenshots cannot, such as hover and click feedback, motion, transitions, dragging, or the timing of an interaction; record one with agent-browser for those or when the user asks. An inline portal embeds the live page in the web transcript when you write the portal link in image format, `![Portal](https://example.onamp.dev "amp-portal")`. It loads slowly in a small frame and may show only the app’s sign-in page. For most results, including UI changes, screenshots or a recording show the user the same thing faster, so do not embed a portal for them. Embed one, next to the screenshots, only when the user needs the live page itself: to explore it with their own input, to leave review comments on it, or because they asked for it. Portal HTML pages get Amp’s review widget injected by default: a signed-in viewer can select an element on the page and send a review comment, which arrives in this thread as a user message starting with "Portal page comment from". When a user asks how to comment on or give feedback about a portal page, point them to the floating review button on the page itself; no setup is needed. A service can disable injection with `review: false` in `.amp/services.yaml`, or per page with an `x-amp-review-widget: off` response header. Show the user the Terminal, or send them to the Terminal tab, only when they ask for it or must do something in the orb that you cannot do yourself, such as entering a password, 2FA code, or device code at an interactive prompt like `gh auth login`. Embed the terminal live in your reply with `![Terminal](amp-terminal:)`; it shows the shared tmux session. Start a command that only needs the user's answers yourself in that session. When the user should start it, prefill it instead: at an idle prompt, clear the line with `tmux -L amp-terminal send-keys -t <session> C-u`, then type the command with `send-keys -l` and no Enter, so the user only presses Enter. Never prefill a secret. Say exactly what to enter or press. Run everything else yourself and report its output in your reply. To open a graphical program for the user in the Desktop, write a bash script that runs the program in the foreground, then link its absolute path with the `amp-desktop-run` URI scheme, for example `[Open chart](amp-desktop-run:///workspace/repo/.amp/open-chart.sh)`. The click opens the Desktop tab and runs the script with the Desktop's display, Wayland, and audio environment, so do not set those variables. When the user must act in the program, name that action in the link text and say exactly what to do once it opens. Append `?prominent` only when the click is the next step the user must take; it renders as a green button. Orbs do not expose KVM, so do not install or start Android emulators or AVDs. Use browser device emulation only for web apps and say that it is not a real Android device. Native Android app testing needs a connected Android runner or device.

### 1d. Orb-relevant fragments elsewhere in the prompt

Secrets, from the `manage_amp` tool description:

> Manage Amp account configuration and projects in Puck or executor threads. Call `manage_amp(topic: 'secrets', operation: 'help')` to discover its operations, parameter schemas, allowed values, and safety rules before changing it. For model providers, list returns the connection types available to this user; for settings, get returns current and allowed values. When someone asks to be credited on commits, `manage_amp(topic: 'git_identity', operation: 'add-coauthor', parameters: { user_id })` returns their co-author trailer; never guess a name or email. To set a secret the user provides or create a model provider with an API key, omit the value; when private input is available, the tool asks the user to enter it. Otherwise, direct the user to Amp Settings. Never put those secrets in parameters or environment variables, and never ask the user to paste one into the thread. A secret value you generated yourself, such as a random token, may be passed to secrets set as generated_value. Get the user’s agreement before risky settings changes or permanent deletions.

Docs pointers, from "Investigate before acting":

> For questions about Amp itself, see https://ampcode.com/docs; about Amp plugins, see https://ampcode.com/docs/plugin-api; about orbs, which are Amp's sandboxed execution environments, see https://ampcode.com/docs/orbs.

Orb-specific verification guidance, from "Verification":

> Use existing rendering guidance and installed tooling; for web UI in an orb, try installed `agent-browser` before installing another browser package or reporting visual verification unavailable.

Orb snapshot/visibility notes in thread tools — `create_thread`:

> Threads run in an orb by default. Use a live runner only when the task depends on that runner's local state.
> executor: Where the thread executes. Defaults to orb (Amp cloud sandbox), which starts from the project's default branch and cannot see the user's machine, uncommitted changes, or local environment. When the task depends on the user's local state, use runner with a runner_id from list_runners, or ask the user; do not silently fall back to orb.
> orb_provider: Orb provider for orb threads: builtin for Amp's built-in orbs, or the name or config ID of a self-hosted orb provider from workspace settings, such as gpu-cluster. Omit it to use the workspace's default provider. Set it only when the user asks for a specific orb provider. Not valid for runner threads.
> orb_size: Orb size override for orb threads. Usually omit this field so the project default, or for no-project threads the user's personal project default, is used. Set it only for resource-intensive work the user explicitly requested, or during project setup when the user explicitly asks to find the right orb size. Not valid for runner threads.
> skip_setup: Orb-only diagnostic option. Starts from the base template, skips .agents/setup, and does not publish a project snapshot.
> multiplayer_ttl_seconds: Optional multiplayer duration in whole seconds, from 5 minutes through 7 days. Only valid for orb threads and shared runner threads in a workspace.

File transfer across orbs — `download_thread_file` and `upload_thread_file`:

> The remote path is relative to that thread's workspace root, for example .amp/data.db, or absolute. It must be inside that thread's workspace or one of its additional repositories; in an orb the primary repository is /home/user/workspace/repo and additional repositories are /home/user/workspace/repos/<name>, so a file in one is ../repos/<name>/<path> or /home/user/workspace/repos/<name>/<path>. A paused orb is resumed automatically, which can take a minute; an archived thread is not resumed, so download its files before archiving it. A CLI or runner thread works only while its executor is running.

> Works without that thread's executor, so it recovers work from paused, archived, or lost orbs. (`download_thread_changes`)

Librarian in orbs:

> In an orb, the Librarian may clone a repository into a temporary directory and report that path in its answer. You can then read or search that clone directly with your own tools.

MCP reload in orbs:

> In an orb, reloading affects only this thread. On a shared local runner, it can also interrupt MCP calls in other threads using that runner.

Tool-connection failures:

> For Amp's own tool connection failures, do not assume the tool did not run. The outcome may be unknown and the tool may still execute. Wait for executor connectivity to stabilize, then inspect the relevant state before deciding whether to retry.

Orb-relevant skill descriptions (verbatim from the skill tool list):

> **browser-use**: Use websites to accomplish specific tasks on the web on the user’s behalf (not for testing a local dev server): sign in, fill and submit forms, buy, book, download, or read pages that need a session or JavaScript, in the orb’s Chrome with agent-browser…
> **creating-artifacts**: … Writes each one as a skimmable, self-contained HTML page that shows its content in diagrams, charts, and before-and-after pictures, serves it from the orb, and shares a portal link where readers can comment on any block…
> **creating-webhooks**: Creates durable webhook handlers in Amp plugins running in Orbs. Use when asked to create, configure, or test a plugin webhook.
> **orb-setup**: Prepare a repository to run in Amp orbs. Use when creating or updating .agents/setup, .agents/resume, or a project's pre-setup script, or when debugging orb environment setup.
> **using-agent-browser**: Drives the preinstalled agent-browser Chromium in an orb for browser interaction, UI inspection, screenshots, recordings, and web E2E checks. Use before any agent-browser work: covers localhost dev servers, sessions that survive pause/resume, 2x screenshots, hover and touch emulation limits, and known command pitfalls.

Also, this turn's user message carried an injected push-access block:

> As of this message, Amp cannot push to the following repositories with the credentials this orb uses:
> - `git push` to https://github.com/swairshah/claudoborous will be denied. Amp pushes to GitHub through the Amp GitHub App, which does not have access to swairshah/claudoborous, so Amp's token cannot push there. Install it on swairshah (or add swairshah/claudoborous to its repositories) from https://ampcode.com/settings/integrations (GitHub → Configure).
> Before any push, tell the user this and how to fix it. Do not work around it with other credentials or tokens; commit locally and offer to push once the user has fixed access. If the user says they have fixed it, a push may now succeed.

## 2. My tools, one line each

Local execution and files
- `shell_command` — run a shell command, optionally long-lived in background, with a cwd and wait timeout.
- `shell_command_status` — stream/collect new output from a background PID started by `shell_command`.
- `shell_command_kill` — SIGTERM then SIGKILL a background PID and its children.
- `create_file` — create or overwrite a file.
- `edit_file` — exact string replacement in an existing file, returns a diff.

Search and understanding
- `finder` — subagent for multi-step codebase discovery in the local workspace.
- `librarian` — subagent that reads GitHub/Amp-hosted repos and issues outside this workspace.
- `oracle` — read-only expert reviewer on a stronger model for reviews and hard judgment calls.
- `web_search` — web search for external facts.
- `read_web_page` — fetch a URL as Markdown, optionally excerpt-filtered by objective.
- `view_media` — view/analyze an image, PDF, audio, or video, locally or by URL.

Agents and threads
- `Task` — spawn a general-purpose subagent (sync or async) with my same tool set.
- `subagent_stop` — stop a background `Task` subagent.
- `create_thread` — start a new Amp thread in an orb or on a runner, with mode/features/executor options.
- `send_thread_message` — send a message (or named prompt) to another thread.
- `wait_for_threads` — block until listed threads settle (idle, awaiting approval, error, or dialog).
- `read_thread` — read/query another thread's history, full or current context window.
- `download_thread_changes` — pull another thread's changed files from its Changes capture.
- `download_thread_file` — pull one arbitrary file from another thread's workspace.
- `upload_thread_file` — push one workspace file (≤4 MiB) into another thread's workspace.

Amp platform and extensions
- `manage_amp` — manage Amp settings, secrets, env vars, projects, model providers, git identity, MCP servers, OAuth clients, prompts.
- `tool_search` — search deferred Amp/MCP/plugin functions exposed as importable JS modules.
- `code_exec` — run JavaScript that imports and calls those deferred functions.
- `read_mcp_resource` — read a resource URI from an MCP server.
- `reload_mcp` — restart MCP connections and report server/tool status.
- `load_plugin` — load/reload one plugin file.
- `reload_plugins` — restart all plugins and refetch global ones.
- `skill` — load a named skill's instructions and bundled resources.
- `reload_skills` — rescan and re-sync skills.
- `load_prompt` — expand a named built-in or saved prompt into this thread.

Interaction and media
- `ask_user_choice` — present a 2–5 option multiple-choice dialog (only when explicitly invited to ask).
- `painter` — generate or edit images, with optional transparent background and reference images.

The deferred `amp` module (via `tool_search`/`code_exec`) adds 21 functions: `find_thread`, `public_artifact_url`, `thread_file_url`, `thread_portal_login_url`, `get_current_user_identity`, `get_schedule`, `set_schedule`, `update_schedule`, `clear_schedule`, `list_linear_subscriptions`, `create_linear_subscription`, `delete_linear_subscription`, `list_linear_agent_routing`, `update_linear_agent_routing`, `comment_on_linear_issue`, `list_agent_modes`, `list_runners`, `list_workspace_members`, `find_shared_plugins_and_skills`, `update_thread`, `get_thread_status`.

## 3. What the orb features are, and how they're implemented here

### CLI surface (from `--help`)

`amp orb` subcommands: `provider` (run self-hosted orbs by pulling lifecycle jobs from Amp over HTTPS), `bootstrap` (connect this orb to its thread actor), `system-metrics`, `portal` (+ `portal access`), `service`/`services` (`ensure`, `start`, `restart`, `stop`, `status`, `logs`, `list`), `simulator serve` (macOS iOS Simulator), `desktop ensure`, `restart-processes`, `id-token` (mint a short-lived OIDC token with a caller-chosen audience), `redact-output` (filter stdin for known token formats, thread secrets, and `AMP_SECRET_ENV_NAMES` values).

`amp orb portal` options reveal the portal model: a manifest written to `.amp/portals/<name>.json` with `--name`/`--title`/`--description`, a portal domain from `AMP_PORTAL_DOMAIN` (default `onamp.dev`), and `--hostname` to pin a managed hostname `<name>--<namespace>.onamp.dev` or a custom domain, with `--take-over` to steal a hostname from another thread's portal.

`amp orb desktop ensure` starts the Desktop and its Google Chrome and prints a CDP endpoint for `agent-browser --cdp`.

### What this machine actually is

Not E2B and not systemd, despite what the guidance files assume.

- PID 1 is `/exe.dev/bin/exe-init`, with a child `exe-init guestd`. `/exe.dev/shelley.json` names `box_host: exe.xyz`, links to `https://amp-01a162f8-….exe.xyz`, and a terminal URL `https://amp-01a162f8-….xterm.exe.xyz?d=WORKING_DIR`. `/exe.dev/bin` also ships `dtach`, `exe-scroll`, `sh`, and `/exe.dev/etc/ssh` host keys + `authorized_keys`.
- `systemctl --version` prints 252 but refuses: "System has not been booted with systemd as init system (PID 1)."
- Root is a plain `/dev/vda` ext4 on a 6.12.113 KVM-ish guest, 2 vCPU, 7.7 GiB RAM, no swap, `/proc/self/cgroup` is `0::/` (no per-service cgroup split visible).
- `AMP_ORB_PROVIDER=unsupported`, `AMP_EXECUTOR=sandbox`, `AMP_ORB=1`.

So the self-hosted provider runs the orb as an exe.dev microVM guest, not an E2B sandbox. Two pieces of Amp's own tooling are built for systemd and are inert here:

- `/usr/local/bin/amp-headless-apply-env` restarts `amp-headless.service` via `systemctl` and tracks an applied-env hash in `/run/amp-headless-env.applied.sha256` with a `flock` on `/run/lock/amp-headless-env.lock`. On this box there is no such unit.
- `/usr/local/bin/amp-run-workload` wraps commands in `sudo systemd-run --scope --slice=amp-workload.slice` with `OOMPolicy` and `oom_score_adj=500` (or `continue`/neutral when `AMP_WORKLOAD_AGENT=1`), relaying signals via `systemctl kill --kill-whom=all`. That's the "every process shares the service cgroup" model your AGENTS.md warns about — it can't work without systemd here. (`sudo` itself is passwordless `(ALL) NOPASSWD: ALL`, and there's a `Defaults!/usr/bin/systemd-run !use_pty` rule, confirming the intended design.)

### Process model as actually running

```diagram
┌──────────────────────────────┐
│ /exe.dev/bin/exe-init (PID 1)│
│   └─ exe-init guestd         │
└───────────┬──────────────────┘
            │
   ┌────────▼─────────────────────────────┐
   │ http-headless-supervisor.sh (bash)   │  restart loop, 10s backoff
   │  pidfile ~/.amp/http-headless-*.pid  │
   └────────┬─────────────────────────────┘
            │  sources /home/user/.env, runs amp-headless-update-binary
   ┌────────▼────────────────────────────────────────────┐
   │ amp --dangerously-allow-all --headless=T-01a162f8-… │
   │  127.0.0.1:58321 direct terminal                    │
   │  127.0.0.1:58322 direct desktop                     │
   │  127.0.0.1:58323 Amp Net server                     │
   │  127.0.0.1:58324 Amp Net proxy                      │
   │   └─ amp run plugin-runtime.ts (official-modes)     │
   └─────────────────────────────────────────────────────┘

   amp orb bootstrap  (separate PID 1 child, 1 socket → WS to ampcode.com)
```

The supervisor (`~/.amp/http-headless-supervisor.sh`) is the whole "service manager": an infinite loop that re-sources `/home/user/.env`, runs `amp-headless-update-binary`, `cd`s to `$AMP_WORKING_DIRECTORY`, starts the headless agent, `wait`s, sleeps 10, repeats. Traps on TERM/INT remove both pidfiles and kill the child.

`amp-headless-update-binary` is the self-update path: it materializes `/home/user/.amp/bin/amp` (dereferencing a symlink into a real file so the running binary can be replaced), honors `~/.amp/skip-next-headless-update` and `~/.amp/prepared-headless-release` markers (`release <ver> <sha256>` or `template <ver>`), compares against `https://static.ampcode.com/cli/cli-version.txt`, runs `amp update`, falls back to `curl https://ampcode.com/install.sh | bash`, and refuses the installer fallback on exit 65 / "Release signature verification failed" while recording `~/.amp/update-signature-failure.json`. It then relinks `/home/user/.local/share/amp/bin/amp` and `/usr/local/bin/amp`. The binary is 160 MB and was replaced at 11:22 today; `amp --version` reports `0.0.1792684837-g5097b1` released 0 seconds before I checked — i.e. this orb tracks tip-of-tree.

### Feature-by-feature, as implemented here

**Terminal** — `AMP_DIRECT_TERMINAL=1`, `AMP_DIRECT_TERMINAL_HOST=127.0.0.1`. The headless process logs `direct terminal server listening port 58321`. It answers HTTP 404 on `/`, so it's a path-routed endpoint, not a generic server. Amp reaches it over the outbound WebSocket from the headless process, not an inbound port. No tmux server exists yet (`/tmp/tmux-1000/amp-terminal` absent) — the session named in my prompt is created lazily when the Terminal tab is opened. `/usr/local/bin/tmux-sync-env` is the glue that injects `$REPO_ROOT/.env` plus a client's `/proc/<pid>/environ` into tmux's global environment, skipping `PWD`, `SHLVL`, `TMUX`, `TMUX_PANE`, `_`.

**Desktop** — `AMP_DIRECT_DESKTOP=1`, host `127.0.0.1`, server on **58322**. The stack is in `/opt/amp-wayland`: `labwc` (a Wayland compositor), `labnag`, `lab-sensible-terminal`, `di-edid-decode`, `wayland-scanner`, plus Amp's own `waymote-gateway` (6.8 MB) and `libexec/waymote-streamd` (4 MB) — gateway terminates the browser-side protocol, streamd pumps frames. `share/wayland-sessions/labwc.desktop` and `share/xdg-desktop-portal/labwc-portals.conf` complete it. Nothing is running: no `labwc`, no `waymote`, no Chrome. It's started on demand by `amp orb desktop ensure`, which then hands back a CDP endpoint. The `amp-desktop-run:` URI scheme from my prompt executes a script with that session's display/Wayland/audio env.

**Amp Net** — server on **58323** and a proxy on **58324** (`{"message":"Amp Net server listening","host":"127.0.0.1","port":58323,"proxyHost":"127.0.0.1","proxyPort":58324}`). 58324 returns HTTP 400 on a plain `GET /`, consistent with an HTTP forward proxy expecting absolute-form requests or CONNECT. `AMP_DIRECT_NET_HOST=127.0.0.1`. This is the egress path for `--share-network`/`--share-browser`, where an orb borrows a runner's network and Chrome cookies.

**Portals and services** — nothing is registered in this orb: no `.amp/` directory in the repo at all, no `.amp/portals/`, no `.amp/services.yaml`, no `.agents/`. The portal flow is: a service or ad-hoc process listens on a loopback port; `amp orb portal <port>` asks the Amp control plane to assign `<something>.onamp.dev`, writes `.amp/portals/<name>.json`, and ingress terminates at ampcode.com and tunnels back through the orb's outbound connection. The HTML review-widget injection and `x-amp-review-widget: off` header handling happen in that ingress layer, not in the orb. Supervision for services is nominally the `amp-workload.slice` systemd design above; since systemd is absent here, services would be supervised by the Amp CLI process itself.

**Setup and snapshots** — `~/.cache/amp/logs/setup.log` shows this orb's project setup script ran as `/tmp/amp-<uuid>.sh` and hit `line 76: /dev/fd/63: No such file or directory` (a process-substitution failure, likely the `/exe.dev/bin/sh` shell), plus `amp orb redact-output: redacting known token formats only: no thread`. Six such `/tmp/amp-*.sh` scripts exist from different runs. `~/workspace/PROJECTS.md` is the clone manifest listing `swair/claudoborous`. "Snapshot" in the logs is not a VM snapshot — it's protocol messages: `executor_environment_snapshot`, `executor_guidance_snapshot` (fileCount 1, the AGENTS.md), `executor_git_diff_snapshot`/`_result` with `baseRevision`/`headRevision`/`diffHash`, which is how the Changes tab is populated.

**Secrets and identity** — `/home/user/.env` is generated by the "Amp sandbox manager" and merges runtime vars with Secrets & Env Vars from personal/project/workspace scopes (personal > project > workspace). Sensitive names present: `AMP_THREAD_IDENTITY_AUTH` and `AMP_WORKLOAD_IDENTITY_REQUEST_TOKEN` (the latter feeds `amp orb id-token` for OIDC exchange). `AMP_SECRET_ENV_NAMES` is empty here — and notably, echoing it still tripped Amp's redaction layer, which is the `amp orb redact-output` mechanism applied to tool output.

Git identity is wired three ways: a shell-function credential helper for a scoped `AMP_GITHUB_BOOTSTRAP_TOKEN` (only fires for `https`+`github.com`+the exact bootstrap repo path), `amp git-credential-helper` as the general helper, and commit signing via `/etc/gitconfig.d/amp-signing` — `gpg.format=ssh`, `gpg.ssh.program=amp-sign-commit`, `user.signingkey=amp-managed`, `commit.gpgSign=true`, included only for gitdirs under `/home/user/workspace/`. `/usr/local/bin/amp-sign-commit` intercepts `-Y sign` and forwards to `amp sign-commit`, else execs real `ssh-keygen`. `~/.amp/bin/gh` shadows `gh` to block `gh auth setup-git` (it would clobber the Amp credential helper) and to lift a token out of `git credential fill` into `GH_TOKEN`.

**Toolchain** — `/usr/local/bin` holds node 150 MB, bun, pnpm/yarn/npm, uv/uvx, rg, magick, websocat, gh 41 MB, plus a full Nix install symlinked from `~/.nix-profile`, and `git` from `/opt/git`. User is uid 1000 in groups `sudo`, `users`, `docker`.

### What I'd replicate if I were you

The minimum viable orb is smaller than the CLI surface suggests: a microVM or container with a persistent home, one supervisor loop that keeps a single long-lived agent process alive and self-updating, that agent holding one outbound WebSocket to the control plane, and four loopback servers (terminal, desktop, net, net-proxy) multiplexed over that one connection. Everything user-visible — portals, Terminal tab, Desktop tab, Changes — is control-plane ingress plus protocol messages over that socket. There are no inbound ports and no systemd on this host; the systemd pieces (`amp-headless.service`, `amp-workload.slice`) are an artifact of the built-in provider's image that the self-hosted exe.dev provider doesn't supply.
