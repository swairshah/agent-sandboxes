# Amp Orbs: user-facing capabilities (research notes)

Research date: 2026-10-22. Purpose: list every user-facing capability of Amp's "orbs" so an open-source equivalent can be built on the pi coding agent. All text below is a summary in my own words. Short quotes are marked. Raw page dumps used for this file were kept in a scratch folder, not in the repo.

Main sources: the X thread by Thorsten Ball (fetched through api.fxtwitter.com), the ampcode.com news posts, the ampcode.com docs (the old `/manual/*` URLs now redirect to `/docs/*`), three Chronicle notes, the "What Are Orbs?" page (including its talk transcript), a Wayback copy of the July 2026 manual page, and one Hacker News thread.

---

## 0. The X post (Thorsten Ball, 22 Oct 2026)

The link points to the 7th post in a 7-post thread that Thorsten posted to himself at 05:29 UTC on 22 Oct 2026. I read every post through `api.fxtwitter.com/thorstenball/status/<id>` by walking the `replying_to_status` chain up to the root. Each image was downloaded and looked at.

| # | Post ID | Text (summary; short quotes) | Media |
|---|---|---|---|
| 1 (root) | 2113140757410521159 | Announces that orbs can now be self-hosted and that this is "free for individuals and teams". Links to https://ampcode.com/news/self-hosted-orbs | Screenshot of the top of the "Self-Hosted Orbs" news post: the four compute requirements (start fast, sleep and resume fast, keep machines for a long time, scale to zero) and the diagram (1. `amp orb provider` opens a connection to ampcode.com, 2. Amp sends events, 3. the provider spawns one orb per thread, 4. orbs connect back, with "no inbound ports"). The bottom shows the `$ amp orb provider ./dispatch.sh` command and the provider tabs (Docker, E2B, K8s, Apple containers, Modal, Vercel, Daytona, exe.dev). |
| 2 | 2113140762183635177 | Says the interface was made open so anyone can bring their own infrastructure, if it has machines that are fast to start, can be snapshotted and resumed quickly, and scale to zero. "That's what makes them orbs!" Then shows Docker as an example. | Screenshot of the Docker `dispatch.sh` (a `case "$ORB_OPERATION"` with `spawn` = `docker start` or `docker run ... "$ORB_IMAGE" sleep infinity` followed by `docker exec -d --env ORB_TOKEN "$ORB_ID" amp orb bootstrap`, `pause` = `docker stop`, `delete` = `docker rm -f`). Below it: the text about the prebuilt `ORB_IMAGE`, the "Custom Orb Provider" workspace setting, `export AMP_ORB_PROVIDER_TOKEN=...`, and a composer screenshot. The "Choose where to run..." picker (Ctrl+M) lists Orbs > Linux sizes a1.tiny to a1.3xlarge (a1.xxlarge marked Default), a "Self-Hosted" group with `our-k8s-orbs` selected, and "Runners > Connect a machine...". |
| 3 | 2113140767107797173 | Shows E2B, which the Amp team says it loves "for its memory/filesystem snapshots" and which Amp uses for its own hosted orbs. | Screenshot of the E2B `dispatch.mjs` (same code as in the docs; see section 24). |
| 4 | 2113140771478294560 | You can also spawn new exe.dev machines as orbs. | Screenshot of the exe.dev `dispatch.sh` (`ssh exe.dev new/resume/pause/rm`, then pipes a bootstrap script into `ssh "$ORB_ID.exe.xyz" bash -s`, which runs `amp orb bootstrap` as `user` under `nohup`). The script notes that pause and resume need exe.dev support to enable access. |
| 5 | 2113140775634755800 | "Or try @modal". | Screenshot of the Modal `dispatch.py` (Modal has no pause, so `pause` saves a filesystem snapshot into a `modal.Dict` and terminates the sandbox, and `spawn` restores from it). |
| 6 | 2113140780072423833 | "Or @vercel sandboxes". | Screenshot of the Vercel `dispatch.mjs` (`Sandbox.getOrCreate` with `persistent: true` and `keepLastSnapshots`). |
| 7 | 2113140784837063005 | "Or @daytonaio". | Screenshot of the Daytona `dispatch.py`. |
| 8 (linked) | 2113140789253689530 | Getting started is easy, and here is a video of setting up a new orb provider on an exe.dev VM that uses Docker to spawn machines. | A 4 min 53 s video (1920x1080). No alt text. The thumbnail shows Thorsten's webcam over Chrome, which has the ampcode.com docs page "Self-Hosted Orbs" open next to tabs titled "harmonica-cycling \| exe.dev" and "exedev@harmonica-cycling...". So the video appears to show this flow: create an exe.dev VM, install Docker on it, write the Docker dispatch script, and run `amp orb provider`. I could not watch the video. Engagement at fetch time: about 3k views and 45 likes. |

Not retrieved: replies from other people, and any later replies by Thorsten under these posts. fxtwitter does not list child replies, and x.com needs sign-in.

---

## 1. One thread = one orb (the core model)

**What the user can do**
- Click New Thread on ampcode.com (or in the macOS or iOS app), make sure the executor says "New Orb", pick a project, and send a prompt. Amp creates a fresh remote Linux machine, clones the repo, runs the setup hooks, and starts the agent there.
- Close the laptop while the agent keeps working. Follow the thread or reply from any device.
- Start many orbs at once with no local conflicts (no worktrees, no port clashes, no disk filling up). The marketing line is that orbs "are infinite".
- Come back days or weeks later. The orb wakes with the conversation, the files, and (on Amp-hosted orbs) the running processes still there.

**How it appears to work**
- Each thread has an executor. The options are `local` (the CLI on your machine), `orb`, or `runner:<id>`. An orb thread's ID looks like `T-<uuid>`. The self-hosted contract uses `ORB_ID = amp-<thread id>`.
- Amp runs the agent loop and model inference on its own servers ("durable execution for the agent loop", introduced in the May 2026 rebuild). The orb only runs tools such as file reads and edits and shell commands. Inside the orb, `amp orb bootstrap` connects back to Amp over HTTPS and WSS. Portals, Terminal, and Desktop go through `tunnel.ampcode.com` ("Amp Tunnel").
- Amp-hosted orbs run on E2B microVMs in Google Cloud us-west1. When paused they keep both memory and disk.
- The orb is Debian 12. The repo is checked out at `/home/user/workspace/repo`, and additional repos go under `../repos/`.

Sources: https://ampcode.com/docs/orbs, https://ampcode.com/docs/orbs/getting-started, https://ampcode.com/what-are-orbs, https://ampcode.com/notes/orbs-explained, https://ampcode.com/news/agents-in-orbs, https://ampcode.com/docs/orbs/self-hosted ("What Leaves Your Network"), https://ampcode.com/docs/orbs/customizing (Archil section)

---

## 2. Where to start an orb (entry points)

**What the user can do**
- **Web or app composer**: an executor picker ("Choose where to run...", shortcut Ctrl+M). It has an Orb section with a size list and a Self-Hosted group, a Runners section, and "Connect a machine...". There is also a project picker (including "No Project" and "Create Project") and a mode picker.
- **CLI execute mode**: `amp -ox "prompt"`, short for `--orb-execute -x`. It prints the thread URL and exits while the agent keeps working. Stdin is included in the prompt (`git diff main | amp -ox "..."`). Flags:
  - `--project <namespace/name | owner/repo | URL>`. By default the CLI matches the Git remotes of the current directory.
  - `--orb-size a1.large`, `--orb-provider <self-hosted name>`
  - `--attach <file>` (can be repeated)
  - `--mode`, `--fast`, `--title`
  - `--stream-json`, which stays attached and streams events in the same format as local `-x --stream-json`. It archives the thread at the end of the turn unless you pass `--no-archive-after-execute`.
  - `--stream-json-input` is not supported with `-ox`.
- **Continue an orb thread from a script or CI**: `amp threads continue T-... -ox "message"` sends one message to that thread's own orb and wakes it.
- **Interactive TUI**: `amp --executor orb` waits for the first prompt before it creates the orb. The command palette (Ctrl+O) has `thread: new in orb`, `project: select`, and `project: create`.
- **Plugin API**: `agent.createThread({ executor: 'orb', project, visibility, multiplayerTTLSeconds })`.
- **Agents and Puck** can start orb threads (see sections 18 and 23). So can Slack mentions, Linear assignment, GitHub or Linear "orb spawners", and webhooks (section 20).
- **Non-interactive auth**: `AMP_API_KEY=sgamp_...`, an access token from Settings. The short-lived session token from `amp login` is rejected.

Sources: https://ampcode.com/docs/cli/spawning-orbs, https://ampcode.com/docs/cli/execute-mode, https://ampcode.com/docs/cli, https://ampcode.com/docs/plugin-api, X post #2 screenshot

---

## 3. Projects (what an orb is built from)

**What the user can do**
- Create a project that ties a repository to Amp. The repo can be a GitHub repo, a public or private repo on another Git host, or an Amp-hosted blank repo ("Start From Scratch"). The owner is either you (private) or the workspace (visible to all members).
- Add up to 20 additional repositories. They are checked out next to the main repo, and the Changes pane shows a diff across all of them. Only the primary repo's `.agents/setup` runs.
- Project settings:
  - name, icon, description
  - Git repository and Git Remote Aliases, so the CLI can match mirrors or SSH remotes
  - Base Branch (the branch orbs check out and Ship targets)
  - Commit Author
  - Public Read-Only Code Access (for Amp-hosted repos)
  - Ship Behavior
  - Orb Size, Pre-clone Script, Pre-setup Script, and Desktop resume script
  - Secrets & Env Vars
  - a post-receive webhook (for Amp-hosted repos)
- Start a thread with "No Project" to get a clean orb with no repo. This is useful for research or work that starts from attached files.
- CLI commands:
  - `amp projects create acme/widgets | <url> | --amp-hosted --name x | --push` (`--push` turns a local-only repo into an Amp-hosted project and pushes it)
  - `amp projects update ...` with flags for base branch, remote URLs, additional repositories, ship behavior, scripts, and repository mode
  - `amp projects snapshots list|delete`
  - `amp clone owner/project`, which also installs Amp as a Git credential helper
- A project page shows recent commits, the threads for that project, and a file browser.
- Puck can change project settings for you.

**How it appears to work**: a project bundles a repo source, shared configuration, and a snapshot cache keyed by orb size. Amp-hosted repos are served by Amp's own Git server.

Sources: https://ampcode.com/docs/projects, https://ampcode.com/news/multi-repo-projects, https://ampcode.com/docs/cli/clone

---

## 4. Orb lifecycle hooks and project snapshots

**What the user can do**
- Commit `.agents/setup` (an executable script). It runs once when a project snapshot is being prepared. Use it to install dependencies and tools. It must be idempotent, it has a 20-minute limit, and long-running processes it starts are killed.
- Commit `.agents/resume`. It runs after first activation and after every wake. Use it for quick work such as authentication, tunnels, and mounts. Amp blocks on it for at most 10 seconds and then lets it keep running in the background.
- Set scripts in project settings instead of the repo:
  - **Pre-clone script**: runs from `/home/user/workspace` before the clone. Use it for things like Git LFS, certificates, proxies, or a credential helper.
  - **Pre-setup script**: runs just before `.agents/setup`. This is "Setup Without a Commit". You can ask Amp, "Set up orbs for this project. Don't commit anything." Amp writes and tests the script and stores it in project settings. It can also write `.agents/resume` or `.amp/services.yaml` into the checkout and hide them with `.git/info/exclude`.
- Use the "Set Up with Amp" button (in the Set Up Orbs notice). It starts a thread that writes both scripts, runs them in the orb, and commits them.
- Delete cached snapshots in project settings, or with `amp projects snapshots delete <project> [--resource a1.small]`.
- Read the hook logs at `/home/user/.cache/amp/logs/setup.log` and `resume.log`.
- `AMP_ORB=1` is set for every process in an orb, so scripts can tell they are running in one.

**How it appears to work** (documented flow)
1. Look for a project snapshot for the chosen size.
2. If it matches the current repo source and shared config, restore it and skip setup.
3. Otherwise start from a base or older snapshot, then run pre-clone, clone or update, pre-setup, and `.agents/setup`.
4. If setup succeeds, save the result as the new project snapshot.
5. Apply the thread's environment and workload-identity credentials.
6. Run `.agents/resume`.
7. Start the agent.

- A snapshot can be reused for up to 72 hours. (It was 24 hours in July.) Changing `.agents/setup` does not by itself invalidate a snapshot.
- Setup never receives user or thread credentials. It only gets a setup request token at `/run/amp/workload-identity-request-token`, which can mint project- or workspace-scoped OIDC tokens. Amp removes that token before saving the snapshot.
- Orbs started later in the same project start much faster.

Sources: https://ampcode.com/docs/orbs/customizing, https://ampcode.com/news/setup-without-a-commit, https://ampcode.com/notes/putting-an-agent-in-an-orb

---

## 5. What's in an orb (base image)

- Debian 12 with passwordless sudo for the user `user`.
- Preinstalled: `amp` and `gh` (both authenticated after activation), Git, SSH, tmux, Bun, Node, npm, pnpm, Yarn, Python, pip, uv, `agent-browser`, ffmpeg, ImageMagick, jq, fzf, ripgrep, vim, unzip, zstd, lsof, and websocat. The July 2026 manual also listed PostgreSQL 17, Redis, and ast-grep.
- Docker is not installed. The documented pattern is to install it in setup and run the daemon as an orb service: `amp orb service start docker-daemon --command 'sudo dockerd'`.
- Any Linux FUSE filesystem can be mounted. Archil is the documented example for shared or extra storage.
- Every size has 60 GB of disk. (It was 20 GB, then 40 GB in July, then 60 GB.)
- The system prompt tells the agent that it is in an orb. Teams add orb-specific guidance to `~/.config/amp/AGENTS.md` from their setup script.

Sources: https://ampcode.com/docs/orbs/customizing, https://ampcode.com/notes/putting-an-agent-in-an-orb, Wayback copy of https://ampcode.com/manual/orbs (20 Jul 2026)

---

## 6. Sizes, billing, pausing, and limits

**What the user can do**
- Pick a size per thread, a default per project (a1.medium by default; a1.small for Megawatt personal projects), or a default per workspace or for personal settings. Ask an agent to use smaller orbs for fan-out work.

| Size | CPU | RAM | Price per hour |
|---|---|---|---|
| a1.tiny | 1 | 2 GB | $0.08 |
| a1.small | 2 | 4 GB | $0.17 |
| a1.medium | 4 | 8 GB | $0.33 |
| a1.large | 8 | 16 GB | $0.66 |
| a1.xxlarge | 16 | 32 GB | $1.32 |
| a1.3xlarge | 16 | 44 GB | $2.13 (Gigawatt and Enterprise only) |

- Billing is per minute while the orb runs. A paused orb costs $0.
- **Auto-pause** happens when the agent has been idle for 5 minutes AND you have not interacted for 20 minutes. It is whichever comes later. Archiving a thread pauses its orb at once.
  - Interactions that keep an orb awake: sending a message, using Files, Terminal, or Desktop, and any authorized request to a portal.
  - Agent work that keeps it awake: results from other agents, automations or webhooks, plugin leases from `amp.system.executor.keepAlive()`, and queued messages.
  - A dev server alone does not keep the orb awake.
- **Waking** an orb happens when you open an unarchived orb thread, open a portal, or send a message. **Orb Saver Mode** (Settings, Usage, Orbs) stops a thread from waking its orb just because you opened it.
- **Spawn pacing**: each user gets a burst of 20 metered orbs, then one new orb every 5 minutes. Later starts wait in a queue (the thread shows the expected wait) rather than failing.
- The thread's actions menu shows whether the orb is running or paused, its size, and the thread's cost.
- **Plans** (as of Sep 2026):
  - Hobby is free, with pay-as-you-go orbs.
  - Individual is $20/month (Megawatt) and includes "45,000 minutes of orbin' time". Gigawatt is a higher tier.
  - Teams has no extra charge and pools credits.
  - Enterprise uses custom pricing. Self-hosted orbs are free for everyone except Enterprise, which pays the standard rate starting 29 Oct 2026. The formula is CPUs x $0.0504/h + GB RAM x $0.0162/h.
  - Runners are always free. Model tokens can come from ChatGPT or Claude subscriptions or from your own keys (BYOK) without Amp fees, but orbs are always paid.

**History**: the original sizes were a0.tiny to a0.large ($0.10 to $1.66/h), with a0.large as the default, a 15-minute auto-pause, and Enterprise paying 50% more. Prices were cut 20% on 27 Jul 2026. The a1 sizes and the 5-minute pause arrived on 7 Aug 2026.

Sources: https://ampcode.com/docs/orbs/sizes-and-costs, https://ampcode.com/news/size-the-orbs-of-production, https://ampcode.com/news/more-orb-sizes, https://ampcode.com/docs/pricing, https://ampcode.com/news/free-agent, https://ampcode.com/docs/orbs (spawn pacing)

---

## 7. Secrets and environment variables

**What the user can do**
- Add env vars and secrets at three levels: workspace, project, and personal. On a name clash, personal beats project, and project beats workspace.
- Mark values as secret. Secret values are hidden after saving, and every occurrence of a secret value is masked in the orb's shell output. Settings warns before saving a short or common word as a secret.
- Manage them from the CLI with `amp secrets ...` and `amp secrets history`. Amp records who created or changed each entry, without showing values.
- When the agent needs a secret you already have, it opens a **private dialog** so the value never appears in the thread. When the agent generates a new value itself, such as a webhook signing secret, it stores it directly.
- Refresh a running orb with `amp orb restart-processes`. This waits for the current command, then restarts the executor and the managed services with the new values.
- The `amp` CLI in the orb signs in with a rotating, short-lived **thread identity**. The user's `AMP_API_KEY` is being removed from orbs.
- Runners can opt in to the same variables with `--amp-env` (section 16).

Sources: https://ampcode.com/docs/orbs/handling-secrets, https://ampcode.com/docs/collaborate/workspaces

---

## 8. OIDC workload identity ("Secrets of the Orb")

**What the user can do**
- Run `amp orb id-token --audience <aud> [--ttl-seconds 60..3600] [--subject-scope thread|user|project|workspace]` inside an orb to get a signed JWT. Use it to get short-lived access to GCP, AWS, Azure, Tailscale, internal services, or HTTP MCP servers, with no stored keys.
- The token is RS256. Issuer: `https://ampcode.com/api/workload-identity`. It publishes a discovery document and JWKS.
- Claims include `workspace_id`, `project_id`, `user_id`, `thread_id`, `email`, and `token_use=exchanged`. The `sub` has the form `workspace:<id>:project:<id>:user:<id>:thread:<id>`, and it is cut down from the right for broader scopes.
- Recipes in the docs: GCP Workload Identity Federation, AWS `AssumeRoleWithWebIdentity`, Tailscale trust credentials, Entra ID. Ideas from the news post: SOPS plus KMS, PAM escalation, oauth2-proxy.
- MCP: putting `${amp:id-token}` in an HTTPS MCP server header makes Amp inject a token whose audience is the server's origin.

Sources: https://ampcode.com/docs/orbs/handling-secrets, https://ampcode.com/news/secrets-of-the-orb, https://ampcode.com/docs/customize/mcp

---

## 9. Services (`.amp/services.yaml`)

**What the user can do**
- Commit `.amp/services.yaml` to declare long-running dev processes. Amp supervises them, and they survive CLI updates and orb pause and resume. Each service can have these fields:
  - `command` (required; run through a login shell, and must listen on `$PORT` if the service has a portal)
  - `cwd`, `port` (fixed, or auto-assigned and stable across restarts), `env`
  - `health` (an HTTP path; a 2xx or 3xx response means ready)
  - `portal` and `portals` (links, optionally grouped in folders)
  - `review` (turns the review widget on or off)
  - `platforms: [linux|darwin]`
- `env` can reference another service's public URL with `${services.web.publicURL}`. Amp starts the referenced service first and rejects cycles.
- Amp manages `PORT`, `PUBLIC_URL`, and `AMP_THREAD_ID`.
- Commands:
  - `amp orb services ensure [--json]` starts whatever is missing, waits for readiness, and prints the portal URLs. The Portal tab also runs `ensure` when you open a portal that has not started yet.
  - `amp orb service list|status|logs|restart|stop <name>`
  - `amp orb service start <name> --command '...' [--portal --title --description --cwd --port]` for a one-off service in this thread only. It waits up to 60 seconds for the port.
- Amp writes the generated `.amp/portals/*.json` files and they should be gitignored. You can also write custom link manifests by hand.

**Note on `.agents/Procfile`**: I found no mention of a `.agents/Procfile` anywhere: not in the current docs, the news posts, the notes, the July 2026 Wayback manual, or web search. Services have only ever been declared in `.amp/services.yaml`. An older version of the format had a per-service `access: any-amp-user | same-as-thread` key. It has been removed, and the docs now say not to add access settings there.

Sources: https://ampcode.com/docs/orbs/portals, https://ampcode.com/news/portals, Wayback manual (20 Jul 2026)

---

## 10. Portals (HTTP into the orb)

**What the user can do**
- Ask "show me in a portal". The agent writes or updates `services.yaml`, runs `ensure`, and the app opens in the thread's **Portal tab**, an embedded browser with navigation.
- **Annotate and comment**: a floating review widget lets you select an element on the page and send a comment to the agent. The comment includes the selected text, the page location, and the source location when the app can provide one. You can turn it off per service (`review: false`) or per response (header `x-amp-review-widget: off`).
- **URLs**: by default they look like `t-<thread>-p<port>.onamp.dev`. You can choose friendly names such as `<name>--<namespace>.onamp.dev`, or a host on your own custom domain (set up in personal or workspace Domains settings, with DNS verification). A workspace can make its domain the default for portals. Use `amp orb portal <port> --hostname <h> [--take-over]` to assign or move a hostname. Custom hostnames survive archiving.
- **Access**: only people who can view the thread can open a portal, and multiplayer participants are included. "Make Public For" 1 hour, 3 hours, 1 day, or 7 days gives anyone with the link access to that one port, without access to the thread. Public sharing is not available on self-hosted orbs or when the workspace turns it off.
- **Identity headers** are added to proxied requests:
  - `X-Amp-Authenticated: amp-user=yes|no, workspace-member=yes|no, collaborator=yes|no`
  - `X-Amp-User-ID`, `-Display-Name`, `-Email`, `-URL` (sent to workspace members and collaborators)
- **Hairpin**: inside the orb, requests to the thread's own portal URL go straight to the local service, so `PUBLIC_URL` works for curl and browser automation without signing in.
- **Wake on request**: any authorized portal request wakes a paused orb and starts a new 20-minute window.
- **Framework help**: Vite gets `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` so the portal host is allowed. There is a Laravel recipe. The docs recommend a dev-only magic-link route, `/__dev/log-me-in/<email>?returnTo=`, and the `$AMP_USER_EMAIL` placeholder in portal URLs.
- A link with `target="_amp"` inside a portal opens an Amp page in the surrounding app.
- Shared portal links unfurl in Slack with an "Open Portal" button.
- Puck's MCP server has an `orbs` tool that lists running orbs with their portal links.
- **Limits**: cross-origin requests between two portal hosts are not supported, because CORS preflights do not carry portal auth. Proxy API calls through the frontend dev server instead.

**How it appears to work**: an authenticating reverse proxy on `*.onamp.dev`. The `p<port>` in the hostname refers to Amp's proxy, not the app's own port. Traffic reaches the orb through Amp Tunnel over outbound WSS. Forwarded HTTPS headers and the public Host are passed to the app.

Sources: https://ampcode.com/docs/orbs/portals, https://ampcode.com/news/portals, https://ampcode.com/news/friendly-urls-for-sharing-orbs, https://ampcode.com/docs/puck

---

## 11. Changes view: review, Restack, Ship, Sync

**What the user can do**
- **Changes pane**: shows committed and uncommitted changes since the merge base, across all repos in the project.
  - Rich diffs that detect duplicated blocks.
  - "Request changes" on a specific section, and interactive staging.
  - Works on desktop and mobile.
- **Intelligent file ordering**: Amp reads the diff and puts the files that explain the change first. Tests, fixtures, and generated files are muted. If the order changes during review, a blue dot appears instead of the files jumping around. You can switch back to alphabetical. Intelligent ordering is off for diffs over 500 files.
- **Review**: walks you through the diff. An agentic reviewer also exists.
- **Restack**: the agent rewrites local commit history into a cleaner set of commits. The final file contents stay the same and nothing is pushed. A commit picker lets you review each commit.
- **Ship** (the main button). The default is trunk-based: commit, fetch, rebase onto `origin/<base>`, run the full test suite, push to the base branch, and retry on conflicts. The agent asks you before resolving substantive conflicts. Projects can choose instead:
  - **Push to Branch**: create a feature branch, push it, and report the PR URL.
  - **Custom Ship**: a free-text prompt of up to 10,000 characters, with no template variables. It can be set with `amp projects update --ship-behavior custom --custom-ship-prompt-file ship.md`.
  - A confirmation dialog shows the target. After shipping, an Archive button appears.
- **Saved prompts as buttons**: built-in prompts (`ship`, `update-base`, `refactor-commits`, `review`) and your own named prompts can show as buttons in the Changes tab. You can also send them by name through Puck or another thread.
- **Sync**: `amp sync <thread>` mirrors the orb's changes into your local checkout while the agent keeps working. The menu item Orb > Copy Sync CLI Command copies the command with the thread ID filled in.
- Commits carry an `Amp-Thread-ID:` trailer, and optionally `Co-authored-by: Amp`.

**How it appears to work**: Ship and Restack are prompts sent to the agent, not server-side Git operations. The diff is computed in the orb and sent to Amp. For a self-hosted bring-your-own checkout, `origin` and `origin/HEAD` must be set so Changes and Ship can find the base branch.

Sources: https://ampcode.com/docs/orbs/shipping, https://ampcode.com/docs/threads, https://ampcode.com/news/diffs, https://ampcode.com/news/intelligently-ordered-diffs, https://ampcode.com/news/first-things-first-faster, https://ampcode.com/news/restack-your-changes, https://ampcode.com/docs/puck

---

## 12. Files pane, attachments, and uploads

**What the user can do**
- **Files tab**: browse and open any file in the orb without downloading the repo.
- **Upload into the orb**:
  - Drag files onto the Files tab: drop on a folder to put them there, or anywhere else for the repo root. There is also a toolbar upload button and an "Upload Files..." item in the folder context menu.
  - Paste or drop into the Terminal: Amp uploads the file and types its absolute path at the cursor.
  - Uploads can be up to 512 MB each.
- **Thread attachments**: use the attach button, drag, or paste. Up to 100 MB, or 512 MB for users with the higher limit. The model can read images, PDFs, audio, and video directly. Other file types are downloaded into the orb when needed. Attachments stay private to the thread.
- iOS can attach a Take Screenshot or a screen recording (Record Screen). The share sheet on macOS and iOS sends to Puck.
- Ask the agent to attach a generated file to its reply, or to "publish" it as a public URL for sharing outside the thread.
- From the CLI: `--attach <path>`.

Sources: https://ampcode.com/docs/orbs, https://ampcode.com/docs/orbs/files-and-attachments, https://ampcode.com/news/attach-anything, https://ampcode.com/docs/macos-and-ios

---

## 13. Terminal

- A Terminal tab gives you a shell in the orb that shares the filesystem with the agent.
- It runs in a **shared tmux session**, so the agent can see the output and work with long-running commands in the same session.
- Amp can also "embed the terminal live in its reply", which lets you type into it from inside the conversation.
- Software installed by hand in the terminal stays in that orb only. Put it in `.agents/setup` if every orb needs it.
- The terminal goes through Amp Tunnel. A self-hosted image needs tmux 2.9 or later for it.

Sources: https://ampcode.com/docs/orbs, https://ampcode.com/docs/orbs/self-hosted (image requirements)

---

## 14. Desktop (Linux GUI in the orb)

**What the user can do**
- Open the **Desktop tab** to get a high-resolution, interactive Linux desktop in the orb. The first time, it opens Google Chrome at `about:blank`.
- Ask Amp to work in the desktop while you watch. When Amp does things on websites for you, it drives this same Chrome window. You can take over to sign in or solve a CAPTCHA. Amp records the run and reports back with screenshots.
- Uses: Linux apps, the Android emulator, Chrome extensions, checking .docx output in LibreOffice, CAD. Computer use is possible but described as "early and unsupported".
- Click apps in the dock. They are installed the first time you open them. You can also run `sudo -n /opt/amp-desktop/install-app chrome|firefox|code|blender|terminal`.
- Customize startup with a **Desktop resume script**, either in project settings or committed as `.agents/desktop/resume`. The repo file wins. CLI: `amp projects create|update ... --desktop-resume-script-file`. After editing the script, run `sudo systemctl restart amp-desktop`.
- "Fun Games" adds TuxRacer, ioquake3, and LinCity-NG to the dock.
- The agent can run `amp orb desktop ensure`.

**How it appears to work**: a Wayland stack at `/opt/amp-wayland`: a headless compositor (labwc on runners), xwayland, dbus, PulseAudio, and ffmpeg. It is streamed by "Waymote" (`waymote-gateway`, `waymote-streamd`) through Amp Tunnel. A self-hosted image needs all of these.

Sources: https://ampcode.com/docs/orbs/desktop, https://ampcode.com/news/desktop, https://ampcode.com/docs/cli/runners (Linux details), https://ampcode.com/docs/orbs/self-hosted (BYO image table)

---

## 15. Networking: Amp Net, sharing a browser, Tailscale, and exit nodes

**What the user can do**
- **Amp Net (experimental; enable it under Experimental Features)**: route an orb's traffic through your own machine and copy your browser cookies into it. This helps with sites that block cloud IPs or need you signed in.
  - Start a runner with `amp --no-tui --runner-id home-mac --share-network --share-browser`. In the Mac app, turn on "Share This Mac's Network Connection" and "Allow Sharing Chrome Cookies".
  - In the orb thread's menu, choose Orb > Network Routing > home-mac, then Orb > Sync Browser.
  - Agent-side commands: `amp net route home-mac`, `amp orb desktop ensure`, `amp sync browser`. The docs suggest putting these in AGENTS.md.
  - Each sync copies the cookies from your default Chrome profile. On macOS this needs "Always Allow" for Chrome Safe Storage. Windows can share its network but not its cookies.
  - Warning: anyone who can control the orb, multiplayer contributors included, can copy the synced cookies.
- **Tailscale**: there is a full recipe. Install tailscaled in setup but keep it disabled. In resume, log in with an OIDC token (`--client-id=...?ephemeral=true&preauthorized=true`, `--advertise-tags=tag:amp-orb`). Use `--accept-routes` to reach private subnets.
  - The docs say **do not use `--exit-node`**. It sends all orb traffic, including the orb's connection to Amp, through the tailnet, and the orb can lose contact with Amp.
  - Amp keeps its own host-to-orb traffic off the tailnet.
  - E2B orbs only have a link-local IPv4 interface, so the recipe needs `TS_ASSUME_NETWORK_UP_FOR_TEST`.
- **Self-hosted orbs** can reach whatever your private network allows (section 24).

Sources: https://ampcode.com/docs/cli/runners (Share Your Network and Browser), https://ampcode.com/docs/macos-and-ios/runner, https://ampcode.com/docs/orbs/customizing (Use Tailscale, Connect to a Shared Network), https://ampcode.com/docs/orbs/desktop

---

## 16. Runners (bring your own long-lived machine) and remote control

Runners are the counterpart to orbs: one machine you already have, shared by many threads. They matter here because orbs and runners share one executor picker and one feature set.

**What the user can do**
- `amp --no-tui [--runner-id <hostname-like id>]` starts a headless runner. It accepts threads created on ampcode.com, on your phone, by Puck, or by other agents.
- Serve several directories:
  - `--dir <path>` (can be repeated)
  - `--discover-dirs[=<path>]` finds Git checkouts and worktrees up to 2 levels deep (up to 500, watched live)
  - `--discover-depth`, `--discover-exclude`, `--no-serve-cwd`
  - `amp runner dirs add|list|remove` while the runner is running
- From the web picker: create a **New Directory**, a **New Project** (Amp-hosted repo, `git init`, and origin set), or a **New Worktree** (`git worktree add` as a sibling `<repo>-<name>` on a new branch; the runner fetches first). "Archive and Remove Worktree" cleans up but never forces removal.
- `--amp-env` (or `amp.runner.env.enabled`): the runner pulls the ampcode.com Secrets & Env Vars into each thread's commands, MCP servers, and plugins. Priority: personal, then project, then workspace, then the runner process environment.
- `--share` shares the runner with the workspace. Members see it under "Shared Runners" with the owner's avatar and a thread count. Their threads run as the owner's OS user. Admins can turn sharing off.
- `--remote-control-terminal` enables the web Terminal for runner threads.
- `--desktop` streams the macOS display (or a virtual labwc desktop on Linux) to the Desktop tab over WebRTC. It falls back to a TURN relay or Amp's relay.
  - macOS needs Screen Recording and Accessibility permissions for "Amp Desktop Helper".
  - Check with `amp runner desktop status|allow ...`.
- The runner updates itself about every hour and restarts when idle (at most every 12 hours).
- The **Mac app is a runner**. It wraps `amp --no-tui --no-serve-cwd --runner-id <mac>-amp-app --discover-dirs=...`. It has a "Keep This Mac Awake" option and toggles for Allow Terminal Access and Share This Mac's Display.
- **TUI as runner**: set `"amp.remoteThreadCreation.enabled": true`, or run the palette command `amp: enable remote creation of threads`.
- **Cross-client access**: continue a local CLI thread from the web or phone. It can require recent passkey authentication.
- Runner support for orb features: Changes and Files are automatic, Terminal needs the flag, Portal is rolling out through Amp Tunnel, Desktop needs `--desktop`, and Multiplayer works only on shared runners.

Sources: https://ampcode.com/docs/cli/runners, https://ampcode.com/docs/macos-and-ios/runner, https://ampcode.com/docs/cli/remote-control, https://ampcode.com/news/agents-anywhere, https://ampcode.com/news/one-runner-is-now-enough, https://ampcode.com/news/one-runner-many-worktrees, https://ampcode.com/news/the-mac-app-is-your-runner, https://ampcode.com/news/shared-runners, https://ampcode.com/news/runner-desktop

---

## 17. Multiplayer and Space

**What the user can do**
- **Turn on Multiplayer** with the joystick button in the thread bar. It lasts 7 days by default and you can change how long it lasts. You can also choose "Contribute" for workspace or group members in the Share dialog.
- Every workspace member can then send prompts to the agent and use the orb's portals, terminal, files, and secrets.
- **@-tag a teammate** in the composer. This invites them and turns multiplayer on.
- Teammates in the same thread can chat with each other.
- Costs are billed to the thread owner.
- Multiplayer works only on non-private threads in an orb or on a shared runner. Turning it on for a private thread shares the thread with the workspace.
- Per MCP server, you can turn off "Allow Use by Contributors in Multiplayer Threads".
- The plugin API takes `multiplayerTTLSeconds` (from 5 minutes to 7 days) when creating threads.
- **Space**: every thread has a voice, video, and screen-share call. It does not need multiplayer. It keeps running in a floating window when you move to another thread, and plays hold music while you are alone. Admins can turn it off.

Sources: https://ampcode.com/docs/collaborate/multiplayer, https://ampcode.com/docs/collaborate/space, https://ampcode.com/news/multiplayer, https://ampcode.com/news/pass-the-orb-to-the-left-hand-side, https://ampcode.com/news/space, https://ampcode.com/docs/threads

---

## 18. Agent to agent

**What the user can do**
- Ask an agent to start other agents. Each child gets its own thread, context, working copy, and orb. The child can also run in another project or on a runner.
- Fan out work with "Run four low-mode threads in parallel...", optionally on a smaller size, then collect and summarize the results.
- Send files and findings between threads with explicit transfers. Messages alone do not move files or commits.
- Pull files from an old thread into the current one.
- Use fresh orbs as evals, to check whether AGENTS.md and the setup scripts are good enough for an agent working without hints. Thorsten's talk describes spawning about 10 eval orbs with control groups.

**How it appears to work**: tools such as `create_thread`, wait-for-threads, read-thread, send-message, and file upload and download between threads. The talk shows calls named "create thread", "wait for threads", "read the other thread", "sends a message", and "downloads the files". Plugin equivalent: `amp.getBuiltinAgent(...).createThread({ executor, project, ... })` and `waitForResponse`. The `create_thread` tool takes `executor: "runner"`, `runner_id`, and a worktree name.

Sources: https://ampcode.com/docs/orbs/agent-to-agent, https://ampcode.com/news/from-agent-to-agent, https://ampcode.com/what-are-orbs (talk transcript, sections 22:00 and 29:05), https://ampcode.com/docs/cli/runners

---

## 19. Automations (schedules) and snooze

**What the user can do**
- Describe a schedule in plain language: "every morning at 9", "in two days", "every ten minutes until it finishes". There is no cron syntax.
- Each thread can have one schedule, either one-time or repeating. When it fires, the agent wakes in the **same thread with its full context**, reads the saved prompt with a `get_schedule` tool, and resumes the orb if it needs the repo.
- An automation indicator shows the title, the schedule, the next run, and the saved prompt. It has a pause or resume switch and a delete button. You can also manage it by talking to the agent ("change this to weekdays at 8:30").
- If a run fails, the automation pauses and shows the error.
- **Snooze** hides a thread until the next reply, until 8am, until Monday, or forever. Automations and event deliveries keep running quietly. The prompt can tell the agent to un-snooze the thread when it needs you.
- A schedule can also start a new thread for each run.

Sources: https://ampcode.com/docs/orbs/automations, https://ampcode.com/news/schedule, https://ampcode.com/docs/threads

---

## 20. Event-driven orbs: webhooks, GitHub, Linear, and Slack

**Generic webhooks (Plugin API)**
- An orb plugin calls `amp.createWebhook({ key, headers: ['x-hub-signature-256'], handler })` and gets back a stable public POST URL. The URL survives plugin reloads and orb restarts.
- Amp stores each event before it returns 200, then wakes the owning orb and calls the handler.
- Delivery rules:
  - At least once, so handlers should dedupe on `event.id`.
  - The handler gets 30 seconds.
  - A handler that throws gets retried with backoff from 5 seconds up to 5 minutes, and the event is dropped after 1 hour.
  - Order is not guaranteed.
  - Rate limit: a burst of 10, refilling at 10 per minute, at most 100 queued, HTTP 429 with Retry-After, 1 MB maximum body, and an `Idempotency-Key` header is supported.
- Only the headers you list are passed through. Amp does not verify signatures for you.
- Archiving the owning thread makes the URL return 404 and pauses delivery. Trigger settings can pause or delete a webhook.
- From a handler you can append to the owning thread (`ctx.thread`) or start a new orb thread.
- In a project, the webhook registration belongs to the user, project, plugin, and key.

**GitHub (first-class)**: install the Amp GitHub App. Then you can ask Amp or Puck to:
- **Follow** an issue or PR (comments, reviews, merge queue) or the **CI of an exact commit** (check rollup, a named workflow, or a named check). Results arrive in the same thread and steer the agent.
- Create an **orb spawner** that starts a new orb for each new issue or PR, optionally filtered by label. Each spawned thread is subscribed to later comments.
- When Amp opens a PR, it subscribes automatically to the PR's comments, reviews, and CI.
- Manage all of these in Settings > Integrations & MCP > GitHub, which shows deliveries and the orbs each spawner created. Amp creates and removes the repo webhook itself.

**Linear**: assign or mention @Amp on an issue to start a Linear Agent Session and an orb. Routing rules choose the project, mode, and orb provider. Subscriptions can start an orb for each new issue in a team.

**Slack**: mention @Amp to talk to your Puck, which can start orb threads.

Sources: https://ampcode.com/docs/orbs/event-driven, https://ampcode.com/news/event-driven-orbs, https://ampcode.com/docs/github, https://ampcode.com/news/github-listeners, https://ampcode.com/docs/integrations, https://ampcode.com/news/assign-it-to-amp, https://ampcode.com/docs/puck/slack-integration

---

## 21. GitHub and Git inside orbs

- Connect GitHub through the Amp GitHub App. Amp then clones private repos and pushes or opens PRs **as you**.
- Inside the orb, a Git credential helper asks Amp for a **short-lived token** for each Git operation. Tokens are never written to disk or saved in snapshots.
- `gh` is authenticated the same way. SSH remotes are rewritten to HTTPS.
- The initial clone is shallow and single-branch.
- Other Git hosts are supported through `GIT_CONFIG_COUNT`/`KEY`/`VALUE` env-var secrets. GitHub Enterprise Server is not supported.
- **Commit identity** options: Amp, You + Amp, or You. Workspace policies can enforce one. Identities must be verified by email.
- **Signed commits**: Amp generates an SSH signing key that stays on its servers, and Git in the orb calls Amp to sign. You upload the public key to GitHub to get Verified commits.
- A PR description that contains a thread URL links the PR status into the thread's title bar.

Sources: https://ampcode.com/docs/github

---

## 22. MCP servers and plugins in orbs

- Remote MCP servers configured on ampcode.com (Settings > MCP servers, with OAuth handled by ampcode.com) work in orbs, the TUI, runners, and Puck.
- Repo-level MCP servers (`.amp/settings.json` `amp.mcpServers`, or a skill's `mcp.json`) need approval inside the orb: Allow Once, Always Allow for Me, or Always Allow for Workspace.
- Browser-based OAuth does not work inside orbs. Use headers with secrets, `${amp:id-token}`, or remote definitions instead.
- Plugins (TypeScript) load in orbs from `.amp/plugins/`. Personal and workspace plugin and skill repos are global. `amp.system.executor.kind` and `keepAlive()` are available to plugins.

Sources: https://ampcode.com/docs/customize/mcp, https://ampcode.com/news/mcp-in-orbs, https://ampcode.com/docs/plugin-api

---

## 23. Clients: web, macOS, iOS, CLI, and Puck

- The same threads appear everywhere: ampcode.com (desktop and mobile web, or `amp app`), the macOS app (Apple Silicon, macOS 26 or later), the iOS and iPadOS apps (TestFlight), and the CLI/TUI (Ctrl+\ opens the thread sidebar).
- The apps send a **notification when a thread is ready** for your next message. They also offer dictation, Shortcuts actions ("Dictate to Puck", "Call Puck"), screen recording on iOS, opening links in the app, and up to 5 signed-in accounts.
- **Puck** is a meta-assistant that starts, steers, finds, ships, and archives threads, creates projects, and fans out work. It has no orb of its own. It is available on the web (Ctrl+/), in the apps, in Slack, through voice calls, and as an MCP server at `https://ampcode.com/mcp` (tools `puck` and `orbs`).
- **Thread features** that affect orbs:
  - Visibility can be private, workspace, group, or unlisted.
  - Export a thread as Markdown or JSON (append `.md` to the URL).
  - Archive a thread to pause its orb. If the project is later deleted, the thread is permanently archived.
  - Snooze, pin, labels, and Activity search.

Sources: https://ampcode.com/docs/macos-and-ios, https://ampcode.com/news/amp-on-ios-and-macos, https://ampcode.com/docs/puck, https://ampcode.com/docs/threads, https://ampcode.com/news/agents-everywhere

---

## 24. Self-hosted orbs (the subject of the X post)

**What the user can do**
- Run orbs on your own compute while keeping the same Amp UI and features.
- Setup steps:
  1. In workspace Settings > Orbs, click Add Orb Provider and give it a name (for example `our-k8s-orbs`). Copy the `aop_live_...` token, which is shown only once.
  2. Run `AMP_ORB_PROVIDER_TOKEN=... amp orb provider /abs/path/dispatch.sh` under a service manager.
  3. When starting a thread, choose Orb > Self-Hosted > your provider. From the CLI, use `amp -ox "..." --orb-provider our-k8s-orbs`.
- A provider can be the workspace default. Admins can turn self-hosted orbs off.
- Linear routes can choose the provider.

**Dispatch contract** (the provider runs your program once per job, with no arguments, and passes these env vars):
- `ORB_OPERATION`: `spawn`, `pause`, or `delete`
- `ORB_ID`: `amp-<thread id>`. Use it as the machine name.
- `ORB_IMAGE`: your override or Amp's image `us-central1-docker.pkg.dev/amp-prod-0/amp-orb/amp-orb:latest`
- `ORB_SNAPSHOT_ID`: the project snapshot to boot from on spawn, or the ID to save under on pause
- `ORB_TOKEN`: spawn only; a short-lived credential for this orb's connection to its thread
- `AMP_URL`: spawn only; set when the server is not ampcode.com

What each operation must do:
- `spawn`: start the orb if it exists. Otherwise create it from the snapshot (if you have it) or from the image. Then start `amp orb bootstrap` detached, as the image's default user, with `ORB_TOKEN` and `AMP_URL` set.
- `pause`: stop the orb and keep its disk. If `ORB_SNAPSHOT_ID` is set, also save a copy under that ID. If the platform cannot keep disks, delete the orb instead.
- `delete`: remove the orb and its disk.

Every operation must be idempotent and finish within 5 minutes. Output goes to the provider log, and spawn output also appears in the thread's setup log.

When Amp sends each job:
- A new thread sends spawn.
- An idle or archived thread sends pause.
- The next message sends spawn again (a resume).
- A deleted thread sends delete.
- To make a project snapshot, Amp sends pause with `ORB_SNAPSHOT_ID` set, followed by spawn.

**Example dispatchers** (all published in the docs): Docker, E2B, Kubernetes (Helm chart), Apple `container`, Modal, Vercel Sandbox, Daytona, exe.dev, and Boat. A table in the docs compares what each keeps across a pause:

| Infrastructure | Memory | Disk | Project snapshots |
|---|---|---|---|
| Amp-hosted | yes | yes | yes |
| Docker | no | yes | one host only |
| Apple containers | no | yes | one Mac only (container 1.6.0 or later) |
| Kubernetes (Helm chart) | no | yes | yes |
| E2B | yes | yes | not in the example |
| Modal | no | yes | not in the example |
| Vercel | no | yes | not in the example |
| Daytona | no | yes | not in the example |
| exe.dev | yes | yes | not in the example |
| Boat | no guarantee | partial | not in the example |

Without memory snapshots, a waking orb loses its running processes, terminal sessions, and desktop apps. Services start again when someone opens a portal.

**Kubernetes**: a Helm chart (`oci://us-central1-docker.pkg.dev/amp-prod-0/orb-provider/chart`) for GKE, EKS, and AKS.
- One pod with two containers: a "spawner" that runs `amp orb provider`, and a "provider" that talks to **Substrate**, an open-source gVisor sandbox runtime for Kubernetes that the chart installs.
- Paused orb disks are saved to GCS, S3, or Azure Blob, so an orb can resume on any node.
- The token lives in the Secret `amp-orb-spawner`.
- A downloadable bundle (`/docs/orbs/self-hosted/bundle.zip`) has an AGENTS.md, runbooks, Terraform, and `smoke-test.sh`. Users are meant to run `amp` inside the bundle and let the agent do the install.
- Default sizing is 16 vCPU and 32 GiB per orb, with 2 spare workers.

**Bring your own image**: Linux x64 with glibc (no Alpine). It needs:
- bash, coreutils, util-linux, and CA certificates
- Git 2.34 or later
- the `amp` binary at `/usr/local/bin/amp`
- a user named `user` with a writable home and passwordless sudo
- Node 18 or later (for portals and external agents) and tmux 2.9 or later
- curl
- the Wayland desktop stack (for Desktop)
- recommended: ripgrep, gh, ssh

**Bring your own checkout**: an advanced setting turns off cloning and Git credential setup. The image must then contain `/home/user/workspace/repo` with `origin` and `origin/HEAD` set.

**Network (outbound only)**:
- The provider talks to `ampcode.com:443`.
- Orbs talk to `ampcode.com` (HTTPS and WSS), `tunnel.ampcode.com` (WSS, for portals, terminal, and desktop), `static.ampcode.com` (CLI updates), your Git host, and `storage.googleapis.com` (to download ripgrep).
- What leaves your network: file contents the agent reads, command output, diffs, and attachments. The model and the agent loop stay on Amp's side.
- Portals on self-hosted orbs can only be opened by signed-in Amp users who have access to the thread. No public sharing.

**Positioning**: Amp says "you probably shouldn't self-host orbs". The feature is aimed at enterprises with data-residency rules, internal networks, or custom hardware, and Amp supports only its own side of the contract.

**Pricing**: free for every workspace until 29 Oct 2026. After that it stays free on Hobby, Individual, and Teams. Enterprise pays the standard orb rate for the CPU and memory the orb reports, billed per minute while the orb is connected.

Sources: https://ampcode.com/news/self-hosted-orbs, https://ampcode.com/docs/orbs/self-hosted, https://ampcode.com/docs/orbs/self-hosted/kubernetes, X thread above

---

## 25. iOS Simulator and native app testing

I found no orb feature that runs the iOS Simulator. Orbs are Linux. Native iOS testing is done like this:
- **macOS runners**, which can be shared (for example a "macos-builder" runner that builds and signs the app). The runner's Desktop tab lets you "try native apps that Amp builds for you, such as iOS apps".
- **Agent to agent**: an orb thread hands simulator work to a thread on a Mac runner and receives files and videos back. The talk mentions "runs the simulator builds ... native iOS verification" and screenshots from a Buildkite Mac build.
- **services.yaml `platforms: [darwin]`**: the docs' own example is a `simulator` service (`./scripts/serve-ios-simulator`, with `portal: true`) that runs only on macOS executors. This suggests streaming the simulator through a portal on a Mac runner.
- The plugin API docs use `registerSkill({ path: 'skills/simulator' })` as an example.
- Android emulators do run inside the orb Desktop.

Sources: https://ampcode.com/docs/orbs/portals (platforms), https://ampcode.com/news/runner-desktop, https://ampcode.com/news/shared-runners, https://ampcode.com/what-are-orbs (talk at 16:34 and 22:00), https://ampcode.com/docs/orbs/desktop

---

## 26. Terms I could not find

- **"Perma-orbs"**: this term does not appear in the docs, news, notes, Wayback copy, or web search. The closest real features:
  - Orbs can sleep for weeks at no cost and wake with their state. Amp-hosted orbs keep memory.
  - A plugin can hold `keepAlive()` to keep an orb awake.
  - Custom portal hostnames survive archiving and can be moved with `--take-over`.
  - The friendly-URLs post says portals are increasingly "a long-lived application, not just a preview".
  - Webhook URLs and GitHub or Linear spawners are durable.
- **`.agents/Procfile`**: not found anywhere (see section 9). Services have always been declared in `.amp/services.yaml`.
- **Exit nodes**: they appear only as a warning in the Tailscale recipe (section 15). Amp Net's runner-based network routing is the supported way to send an orb's traffic out through your own network.

---

## 27. Timeline (useful for scoping)

| Date (2026) | Change |
|---|---|
| May 6 | "Amp, Rebuilt": a distributed system with a durable agent loop and a plugin API |
| Jun 4 | One UI and sidebar for all threads across web, mobile, and CLI |
| Jun 16 | Diff review in Amp |
| Jun 30 | **Agents in Orbs** launched (`amp -ox`, `amp sync`, Terminal, Files) |
| Jul 3 | Orb sizes selectable per project; storage raised from 20 to 40 GB |
| Jul 8 | Runners (`amp --no-tui`) and remote thread creation |
| Jul 14 | OIDC workload identity |
| Jul 17 | Agent-to-agent |
| Jul 21 | Schedules (automations) |
| Jul 22 | Multiplayer |
| Jul 23 | Event-driven orbs (webhooks) |
| Aug 4 | Attach any file |
| Aug 6 | **Portals** and `services.yaml` |
| Aug 7 | a1 sizes, 5-minute auto-pause, size per thread, `--orb-size` |
| Aug 19 | @-tag teammates into an orb; MCP in orbs |
| Aug 23 | Friendly portal URLs and custom domains |
| Aug 25 | Pre-clone and pre-setup scripts |
| Aug 27 | Multi-repo projects |
| Aug 28 | iOS and macOS apps |
| Aug 31 | Space (voice and video) |
| Sep 1 | Intelligently ordered diffs |
| Sep 4 | **Desktop** |
| Sep 11 | Restack |
| Sep 13 | Free Hobby tier; orbs become the paid product |
| Sep 17 to 24 | Multi-directory runners, worktrees, `--amp-env`, Mac app runner, shared runners |
| Oct 12 | First-class GitHub webhooks and orb spawners |
| Oct 16 | Runner desktop |
| Oct 19 | Linear agent |
| Oct 22 | **Self-hosted orbs** |

---

## 28. Outside reception (short)

- HN, "Orbs" (Orbs Explained, 25 Aug 2026; 116 points, 43 comments): https://news.ycombinator.com/item?id=49437117. Commenters compared orbs to Claude Code on the web, Codex cloud, Cursor background agents, exe.dev, and fly.io Sprites. Some called them "just a VM". Thorsten replied that the value is in what the wrapper makes possible. One builder listed the hard parts of doing this well: refreshing base snapshots with the latest Git delta, and similar chores. A positive user named portals, multiplayer, local syncing, Puck, and cross-thread references as the real value.
- Other ampcode news and notes items reached HN with very few points.
- Thorsten's talk "How Thorsten Uses Amp" (embedded on /what-are-orbs, 34 minutes). Key practices: the team does "no more local dev", asks agents for "irrefutable proof" (screenshots, videos, test matrices), uses fan-out orbs to evaluate AGENTS.md changes, pushes to main without PRs, and builds incident and feature-flag plugins.

---

## Summary table

| Capability | User-facing behaviour | Mechanism | Source |
|---|---|---|---|
| Orb per thread | New thread starts a fresh remote machine with the repo and the agent; close the laptop and continue anywhere | Agent loop on Amp servers; `amp orb bootstrap` in the VM connects out over WSS; E2B microVMs on GCP | /docs/orbs, /what-are-orbs |
| Entry points | Web or app executor picker, `amp -ox`, `amp --executor orb`, TUI `thread: new in orb`, plugin `createThread({executor:'orb'})`, Puck, Slack, Linear, GitHub | CLI flags `--project --orb-size --orb-provider --attach --stream-json`; `amp threads continue -ox` | /docs/cli/spawning-orbs |
| Projects | Repo (GitHub, other Git, or Amp-hosted) plus settings shared by every orb; up to 20 extra repos; No Project mode | `amp projects create/update`, `amp clone`, Git remote aliases, base branch | /docs/projects |
| Setup/resume hooks | Repo is ready to work in every new orb; quick repair after each wake | `.agents/setup` (20 min, snapshotted), `.agents/resume` (10 s blocking), pre-clone and pre-setup scripts in settings, logs in `~/.cache/amp/logs` | /docs/orbs/customizing |
| Project snapshots | Later orbs start fast and skip setup | Snapshot per project and size, reused up to 72 h; `amp projects snapshots list/delete` | /docs/orbs/customizing |
| Sizes and billing | a1.tiny to a1.3xlarge, $0.08 to $2.13/h, per minute; paused costs $0 | Auto-pause at 5 min agent idle AND 20 min user idle; burst of 20 orbs then 1 per 5 min; Orb Saver Mode | /docs/orbs/sizes-and-costs |
| Secrets and env | Workspace, project, and personal values; masked in output; private entry dialog | Injected at start; `amp secrets`; `amp orb restart-processes` | /docs/orbs/handling-secrets |
| OIDC identity | Keyless access to GCP, AWS, Tailscale, MCP | `amp orb id-token --audience --subject-scope`; issuer ampcode.com/api/workload-identity | /docs/orbs/handling-secrets |
| Services | Declared dev servers run supervised and survive pause | `.amp/services.yaml`; `amp orb services ensure`; `amp orb service start/stop/logs/...`; `$PORT`, `$PUBLIC_URL` | /docs/orbs/portals |
| Portals | Open the app in a Portal tab, comment on elements, share a link, public for up to 7 days, custom domain | Auth proxy `*.onamp.dev` through Amp Tunnel; `amp orb portal <port> --hostname`; `X-Amp-*` headers; hairpin inside the orb; wakes the orb | /docs/orbs/portals |
| Changes and review | Diff with intelligent ordering, request changes, stage | Diff computed in the orb; LLM-ranked file order | /docs/threads, /news/diffs |
| Restack and Ship | Clean up commits; one button to commit, rebase, test, and push, or push a branch, or a custom flow | Prompts sent to the agent; project Ship Behavior; saved prompts as buttons | /docs/orbs/shipping |
| Sync | Mirror the orb's changes into a local checkout | `amp sync <thread>` | /docs/orbs |
| Files and attachments | Browse files; drag-drop upload up to 512 MB; attach media and logs | Files pane upload; drop into terminal inserts the path; attachments downloaded on demand | /docs/orbs/files-and-attachments |
| Terminal | Shell in the orb shared with the agent; can be embedded live in a reply | Shared tmux session through Amp Tunnel | /docs/orbs |
| Desktop | Interactive Linux GUI; agent drives Chrome; you take over | Wayland and labwc streamed by Waymote; `install-app`; `.agents/desktop/resume` | /docs/orbs/desktop |
| Amp Net | Orb browses from your IP with your cookies | Runner `--share-network --share-browser`; `amp net route`, `amp sync browser` | /docs/cli/runners |
| Tailscale | Join the tailnet; reach private subnets; no exit node | tailscaled with OIDC client; `--accept-routes` | /docs/orbs/customizing |
| Runners | Use your own machine as an executor; directories, worktrees, sharing, desktop, terminal | `amp --no-tui` with `--dir --discover-dirs --share --amp-env --desktop --remote-control-terminal`; Mac app runner | /docs/cli/runners |
| Multiplayer | Teammates prompt the agent and use the orb; @-tag to invite | Thread visibility plus a multiplayer TTL (7 days default); costs go to the owner | /docs/collaborate/multiplayer |
| Space | Voice, video, and screen share per thread | WebRTC call attached to the thread | /docs/collaborate/space |
| Agent to agent | Side quests, fan-out, file exchange, cross-project, onto runners | `create_thread`, wait, read, message, and file-transfer tools | /docs/orbs/agent-to-agent |
| Automations | "Every morning at 9..." wakes the same thread with context | Per-thread schedule plus saved prompt; `get_schedule` tool; pause or delete UI | /docs/orbs/automations |
| Webhooks | External events wake an orb | Plugin `amp.createWebhook`; durable queue; at-least-once; rate limits | /docs/orbs/event-driven |
| GitHub events | Follow PRs, issues, and CI; orb per new issue or PR; auto-follow PRs Amp opens | GitHub App webhooks managed by Amp; subscriptions table | /docs/github |
| Linear and Slack | Assign an issue to start an orb; @Amp in Slack talks to Puck | Linear Agent Sessions; Puck | /docs/integrations |
| Git auth and signing | Push and open PRs as you; verified signed commits | Credential helper fetching short-lived tokens; server-side SSH signing | /docs/github |
| MCP in orbs | Remote MCP via ampcode.com OAuth; repo MCP with approval | `${amp:id-token}` header; approval dialog | /docs/customize/mcp |
| Clients and Puck | Web, macOS, iOS, CLI; notifications; Puck orchestrates | Same thread URL everywhere; Puck MCP `orbs` tool | /docs/macos-and-ios, /docs/puck |
| Self-hosted orbs | Your compute appears as a "Self-Hosted" option in the picker | `amp orb provider ./dispatch` with an outbound-only connection; spawn, pause, delete env-var contract; `amp orb bootstrap`; Helm chart with Substrate/gVisor | /docs/orbs/self-hosted, X thread |
| iOS simulator | No orb simulator; use Mac runners, their desktop, darwin-only services | `platforms: [darwin]`; runner `--desktop` | /docs/orbs/portals, /news/runner-desktop |
| Perma-orbs / `.agents/Procfile` | Not documented | Nearest equivalents: keepAlive, long sleeps, durable hostnames; `services.yaml` | (not found) |
