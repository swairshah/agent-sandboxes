# How an Amp orb works on the inside

These notes come from a live self-hosted orb on exe.dev
(`amp-01a162f8-ffe2-74fd-80db-6b066adbdb10`, thread `T-01a162f8-…`, Amp CLI
`0.0.1792659929-ga55f8f`) and from the Amp CLI binary. The binary is a Bun
standalone executable whose main bundle is compiled to **Bun bytecode**, so it
contains no readable JS source. The npm package `@sourcegraph/amp` only wraps
`@ampcode/cli`, which is the same binary. The evidence below therefore comes from
four sources:

* the processes, files, environment variables and logs inside the orb
  (`~/.cache/amp/logs/{cli,headless,setup,resume,plugin-runtime}.log`, with
  `headless.log` logging every websocket message);
* the binary's string table (`strings -n 4`), which has RPC names, log messages
  and embedded shell scripts;
* **live protocol probes**: `amp orb provider` and `amp orb bootstrap` were
  pointed (`--amp-url` / `AMP_URL`) at local fake servers. The servers logged
  each request, and their deliberately wrong replies made the CLI print its zod
  validation errors, which list the field names it expects;
* the public docs at `ampcode.com/docs/orbs/self-hosted`.

All secrets are redacted. Field names marked *(inferred)* were not observed
directly.

---

## 0. Big picture

```
 ampcode.com (control plane)                       your infra
 ┌───────────────────────────────┐   HTTPS poll   ┌──────────────────────────────┐
 │ thread actor (Rivet actor,    │◄───────────────│ amp orb provider (spawner)   │
 │  key = thread id)             │  /api/internal │   runs ./dispatch.sh per job │
 │  - agent loop + inference     │  orbSpawner*   └──────────────┬───────────────┘
 │  - tool scheduling (leases)   │                               │ spawn/pause/delete
 │  - orb setup script driver    │                               ▼
 │  - job queue per provider     │   WSS (Rivet gateway)  ┌──────────── orb VM ───────────────┐
 │                               │◄──────────────────────►│ amp orb bootstrap   (guest agent) │
 │                               │  /actors/gateway/      │   ↳ amp-headless supervisor (sh)  │
 │                               │  threadActor/websocket │      ↳ amp --headless=T-… (exec.) │
 │                               │◄──────────────────────►│         ↳ plugin runtime (stdio)  │
 └───────────────────────────────┘                        │ tunnel.ampcode.com ⇄ term/desktop │
                                                          └───────────────────────────────────┘
```

**The agent loop runs on Amp's servers, in a per-thread "thread actor".** The orb
is a remote *executor*. It registers a set of tools, accepts tool **leases** from
the actor, runs them locally, and sends results back. Model inference never runs
in the orb. The orb holds no model keys and no Amp API key: it authenticates
with a short-lived, per-thread **ORB_TOKEN** and, after that, with thread or
workload identity credentials that the actor writes into `~/.env`.

---

## 1. `amp orb bootstrap`

### 1.1 Discovery
```
GET {AMP_URL}/api/orbs/bootstrap
Authorization: Bearer <ORB_TOKEN>
→ 200 { threadId: string, sandboxId: string, rivetEndpoint: string, expiresAt: number(ms),
        rivetPublicEndpoint?: string, ampVersion?: string }   // last two (inferred) from strings
```
The required fields come from the zod errors returned when the fake server
replied `{}`: `threadId`, `sandboxId`, `rivetEndpoint`, `expiresAt`. A non-2xx
response gives the error `Orb bootstrap discovery at … failed with HTTP …`. A
rejected token gives *"ORB_TOKEN was rejected by Amp. It is minted for one spawn
job and expires after N minutes; start amp orb bootstrap with the token of the
current spawn job."*

`sandboxId` has the form `orb-provider:<providerConfigId>:<ORB_ID>`. The real
value was `orb-provider:1afdc718-…:amp-01a162f8-…`. It is also written to
`~/.cache/amp/logs/setup.log.sandbox-id`.

### 1.2 Transport: a Rivet actor WebSocket
The bootstrap then opens a WebSocket to the thread actor through the Rivet
gateway:
```
GET {rivetEndpoint}/gateway/threadActor/websocket/?rvt-namespace=default
        &rvt-method=get&rvt-key=<threadId>&rvt-skip-ready-wait=true
Upgrade: websocket
Sec-WebSocket-Protocol: rivet, rivet_encoding.bare, rivet_skip_ready_wait,
                        rivet_conn_params.<urlencoded JSON>
  conn params = {"orbToken":"<ORB_TOKEN>","transport":"json-rpc"}
```
* `rivet_encoding.bare` is Rivet's own framing, a BARE binary envelope. Inside
  that envelope the app protocol is **JSON-RPC**, as the logs show
  (`[thread-client] JSON-RPC request sent`, `rpcRequestId`, `frameMessageCount`
  when several messages are batched into one frame).
* In production `rivetEndpoint` is `https://…@ampcode.com/actors`, which
  includes a publishable Rivet key (`pk_…`, redacted here).
* Connection states seen in the logs: `disconnected → connecting →
  waiting_for_actor → connected`. On failure the bootstrap logs `Initial connect
  failed; retrying with backoff`.

### 1.3 Guest-agent role
Once connected, the bootstrap logs `Connected to thread actor; announcing
sandbox` with `{sandboxId, sessionId, guestId}`. From then on it serves
**bootstrap requests** from the actor. This is a small remote-exec and file API:

| operation | notes |
|---|---|
| `run` | Runs a shell script. The actor writes it to `/tmp/amp-<uuid>.sh` and passes env. Most requests are this type. |
| `write_files` | Writes one or more files, using `mkdir -p -- "$(dirname -- "$1")" && cat >"$1"` |
| `read_file` | Has a size limit (`… bytes; read_file supports up to …`) |
| `file_exists`, `remove_file`, `append_file`, `make_directory`, `truncate` | Errors are typed, for example `code: "file_not_found"` |

Each request has a `requestId` such as `bootstrap-1`, `bootstrap-2`, and so on.
In the observed session the actor issued 30 requests in about 5 s (09:43:00 to
09:43:05), and then the headless executor started.

A PID file at `~/.cache/amp/pids/headless-bootstrap.pid` keeps a single
bootstrap per guest. A second one exits with *"Headless bootstrap already
running in this guest; exiting"*. This matters on resume: the dispatcher must
kill the old bootstrap (or the old one must die when its token is rejected), or
the new token is never used.

---

## 2. Process tree and IPC

```
exe-init (PID 1, exe.dev)  ── no systemd in self-hosted guests
├─ amp orb bootstrap                     (user, setsid'd by dispatch.sh; env: ORB_TOKEN, AMP_URL)
└─ /bin/bash ~/.amp/http-headless-supervisor.sh      (written+started by the actor via bootstrap `run`)
   └─ ~/.amp/bin/amp --dangerously-allow-all --headless=T-<thread> --log-file=…/headless.log
      └─ ~/.amp/bin/amp run /tmp/amp-plugin-runtime-XXXX/plugin-runtime.ts \
             ~/.cache/amp/global-plugins/ampcode.com/workspace/official-modes@<hash>/index.ts
```

* **Supervisor** (`http-headless-supervisor.sh`, the full text is in the
  appendix). It runs a loop forever: source `~/.env`, run
  `amp-headless-update-binary`, `cd $AMP_WORKING_DIRECTORY`, start
  `amp --headless=$AMP_THREAD_ID`, wait for it, sleep 10, and repeat. It writes
  PID files to `~/.amp/http-headless{,-supervisor}.pid`. Images that have
  systemd use `amp-headless.service` together with `amp-headless-apply-env`.
* **`~/.env`** is written by the actor ("Generated by Amp sandbox manager"). It
  holds the runtime variables plus the user, project and workspace secrets.
  Keys: `AMP_THREAD_ID, AMP_PROJECT_ID, AMP_WORKSPACE_ID, AMP_USER_ID,
  AMP_USER_EMAIL, AMP_URL, AMP_WORKING_DIRECTORY=/home/user/workspace/repo,
  AMP_EXECUTOR=sandbox, AMP_ORB=1, AMP_ORB_PROVIDER, AMP_THREAD_IDENTITY_AUTH=1,
  AMP_WORKLOAD_IDENTITY_REQUEST_TOKEN (secret), AMP_SECRET_ENV_NAMES,
  AMP_PORTAL_DOMAIN=onamp.dev, AMP_DIRECT_{TERMINAL,DESKTOP}{,_HOST}=…127.0.0.1,
  AMP_DIRECT_NET_HOST, GH_HOST, PATH`. `ORB_TOKEN` is **not** in `~/.env`: the
  headless executor authenticates with thread identity instead.
* **Headless executor** (`amp --headless`). It is a second Rivet client to the
  same thread actor, with client id `cli-headless-<uuid>`. Inside the orb it
  listens on loopback only:
  * direct terminal server `127.0.0.1:58321`, which serves the shared tmux
    terminal;
  * direct desktop server `:58322`;
  * Amp Net server `127.0.0.1:58323`, with a proxy on `:58324` for exit-node
    routing.

  All of these are reached from outside through **Amp Tunnel**. The actor sends
  `tunnel_credentials`, and the executor logs `tunnel connected {gatewayURL:
  https://tunnel.ampcode.com, tunnelID, expiresAt(+24h)}`. Nothing listens on
  a public interface.
* **Plugin runtime**. This is a Bun child process speaking **stdio JSON-RPC**
  with methods `command.list, tool.list, skill.list, events.list,
  agent-mode.list, link-pattern.list`, plus hooks such as `session.start` and
  `changes.prompt`. Plugins add tools, skills and agent modes; the "official
  modes" plugin supplies `ultra` and the others.
* **Other files**: `~/.amp/bin/amp` is the user-owned binary, which
  self-updates from `static.ampcode.com/cli/cli-version.txt`. Also present:
  `~/.amp/bin/gh` (a wrapper that gets a token from `git credential fill`),
  `/usr/local/bin/amp-sign-commit`, `~/.config/git/hooks/prepare-commit-msg`,
  and `~/.config/amp/AGENTS.md` (the system guidance file; it still says "E2B
  sandbox").
* **Workload cgroups**: `amp-run-workload` wraps commands in
  `systemd-run --scope --slice=amp-workload.slice`. Services run as
  `amp-svc-<name>.service`. Guests without systemd fall back to user-level
  supervisors (`/opt/amp-desktop/supervise`, and the bash supervisor above).

---

## 3. Tool execution protocol (executor ⇄ thread actor)

Handshake, as seen in `headless.log`:

1. **Client to actor** `executor_connect`
   ```json
   {"type":"executor_connect","handshakeSeq":1,"executorType":"sandbox",
    "capabilities":{"workspaceId":"/home/user/workspace/repo","workingDirectory":"/home/user/workspace/repo",
      "pid":553,"environment":{"os":"linux"},"pluginReadyTimeoutMs":30000,
      "tags":["executor-relay-v2","executor-relay-v1","filesystem-file2-uris-v1","filesystem-v2-paths-v1",
              "filesystem-write-overwrite-v1","git-blob-chunks-v1","resumable-asset-upload-v1",
              "temporary-file-upload-v1","tunnel-v1","direct-terminal-v1","external-agent-prompt-v1",
              "executor-process-v1","claude-agent-v1","claude-agent-resume-at-v1"]}}
   ```
2. **Actor to client** `executor_connected` `{executorId, registeredToolCount,
   guidanceInventory, rejectedToolCount, resumeBootstrap}`. The handshake times
   out after 60 s.
3. **Client to actor** `executor_environment_snapshot`: `{trees:[{displayName,
   uri:"file:///home/user/workspace/repo", repository:{type:"git",url,ref,sha}}],
   workingDirectory, platform:{os,osVersion,cpuArchitecture,client,clientVersion,
   clientType,installationID,deviceFingerprint}, workspaceRoot,
   rootDirectoryListing, hostname, username, git:{branch}, hasPortals}`.
4. **Client to actor** `executor_guidance_snapshot` (AGENTS.md files, with
   content), `executor_skill_snapshot` (skills), and
   `executor_tools_register` `{tools:[…22 names…]}`, followed by
   `executor_tools_bootstrap_complete {ok:true}`.
5. **Actor to client** `tunnel_credentials`, `executor_status
   {subtype:"running", spawnId}`, `executor_health`, `thread_settings`, and so
   on. The executor is also an **observer** of the thread and receives
   `message_added`, `agent_state` (`working`/`streaming`), `delta`,
   `thread_title`, `queued_messages` and `tool_progress`.

Tools registered by the orb executor:
`apply_patch, async_shell_command, create_file, download_thread_changes,
download_thread_file, edit_file, find_thread, glob, Grep, load_plugin, Read,
read_mcp_resource, read_web_page, reload_mcp, reload_plugins, reload_skills,
shell_command, shell_command_kill, shell_command_status, skill,
upload_thread_file, web_search`. Per turn, the actor sends
`inference_tools {toolCount:31}`: the full set it shows the model, which also
includes server-side and plugin tools.

Running one tool call:
```
actor → orb   tool_lease            {messageId, toolCallId:"TU-…", toolName:"async_shell_command", …args}
orb   → actor executor_tool_lease_ack {toolCallId, threadId}
orb   → actor tool_progress …        (streaming snapshots)
orb   → actor executor_tool_result  {toolCallId, threadId,
                                     run:{status:"done", result:{output:"…", exitCode:0}},
                                     workspaceChanged:false,
                                     timings:{leaseToToolStartMs, toolDurationMs, workspaceSnapshotMs,
                                              resultPreparationMs, totalMs}}
actor → orb   executor_tool_result_ack {toolCallId}
```
The actor also drives git directly: `executor_git_command {requestId,
args:["status","--porcelain=v1","--untracked-files=all","-z"],
maxOutputBytes:20971520}` → `executor_git_command_result`, and
`executor_git_diff_snapshot` → `…_result`. These feed the Changes tab. A lease
is a claim with a deadline: if the executor goes away, the actor can re-lease
the call after a reconnect (`client_resume`, `resumeBootstrap`).

---

## 4. Setup flow (driven by the actor through bootstrap `run` and `write_files`)

Observed order (bootstrap-1 to bootstrap-30, plus the headless log):

1. **Git identity and credentials** (script text captured from `ps`). It clears
   old helpers and sets `credential.helper` to an inline function that serves
   `AMP_GITHUB_BOOTSTRAP_TOKEN` for `AMP_GITHUB_BOOTSTRAP_REPOSITORY_PATH`
   during the clone, then adds `!~/.amp/bin/amp git-credential-helper`, which
   gets short-lived GitHub tokens from Amp. It also sets `useHttpPath`, rewrites
   `git@github.com:` and `ssh://` URLs to `https://github.com/`, symlinks
   `/opt/git/bin/git`, and configures SSH commit signing through
   `amp-sign-commit` (`gpg.format ssh`, an allowed-signers file, applied via
   `includeIf.gitdir:/home/user/workspace/`). Commits are authored as
   `Amp <amp@ampcode.com>`, with a `prepare-commit-msg` co-author hook. It
   installs the `gh` wrapper and creates `~/workspace`.
2. **Clone** into `/home/user/workspace/repo`. The provider's "Disable
   repository cloning" setting skips this step, along with the credential
   rewiring. Global guidance files go into `~/workspace` (PROJECTS.md,
   PLUGINS.md and SKILLS.md are removed first).
3. **Write `~/.env`** and the headless supervisor, start the supervisor, wait
   for `executor_connected`.
4. **Lifecycle hook script** (`/tmp/amp-<uuid>.sh`, full text in the appendix),
   with `AMP_SANDBOX_LIFECYCLE_HOOK=setup|resume`:
   * `setup` runs `$AMP_PROJECT_PRE_SETUP_SCRIPT` and then `.agents/setup`. It
     requires the executable bit, logs to `~/.cache/amp/logs/setup.log`, and
     pipes output through `amp orb redact-output`. Exit codes: 125 means the
     pre-setup script failed, 126 means `.agents/setup` is not executable.
   * `resume` sources `~/.env` and runs `.agents/resume` in the background,
     waiting at most `AMP_SANDBOX_LIFECYCLE_HOOK_WAIT_SECONDS` (default 10 s).
   * **Bug seen on exe.dev:** `exec > >(redact_output)` fails with
     `/dev/fd/63: No such file or directory`, because the exe.dev guest has no
     `/dev/fd`. So the hook dies, and the thread says "Orb setup was not cached
     because the setup script (.agents/setup) failed". The fix is
     `ln -s /proc/self/fd /dev/fd` in the dispatcher.
   * The result is recorded with `recordOrbSetupRun`. A successful setup is what
     makes a project snapshot possible.
5. **Services**: `.amp/services.yaml` or `.agents/Procfile` is reconciled by
   `amp orb service ensure`. Each service runs as a supervised process (on
   systemd, `amp-svc-<name>.service` in `amp-workload.slice`), has a portal URL
   on `*.onamp.dev` (`AMP_PORTAL_DOMAIN`) exposed through Amp Tunnel, and is
   restarted after resume and after CLI updates. AGENTS.md tells the agent not to
   use `nohup`, `setsid` or tmux for servers, because everything started from
   the CLI shares its cgroup.
6. **Terminal**: a shared tmux session (`dev`) behind the direct terminal
   server (`direct-terminal-v1`). `tmux-sync-env` copies `.env` and the client's
   environment into tmux.
7. **Desktop** (optional): labwc/Wayland and Chrome under `/opt/amp-desktop`,
   started by systemd or `/opt/amp-desktop/supervise`. `amp orb desktop ensure`
   prints a CDP endpoint for `agent-browser`.

---

## 5. Lifecycle, the provider job API, and snapshots

### 5.1 `amp orb provider` (the "spawner")
This is plain HTTPS JSON-RPC to `POST {AMP_URL}/api/internal?<method>` with
`Authorization: Bearer aop_live_…` and body `{"method":<name>,"params":{…}}`.
Responses look like `{"ok":true,"result":…}`. Each provider process generates a
random `spawnerID` (UUID).

| method | params | result |
|---|---|---|
| `orbSpawnerClaimJob` | `{spawnerID, spawnerVersion}` | `{claim: null}` when idle (a long poll), or `{claim:{id, attempt, timeoutMs, claimDeadlineAt(ms), job}}` |
| `orbSpawnerHeartbeatJob` | `{jobID, spawnerID}` *(inferred)* | extends the claim while the script runs |
| `orbSpawnerCompleteJob` | `{jobID, spawnerID}` (+ error/exit info on failure, *inferred*) | void |
| `orbSpawnerReleaseClaim` | `{spawnerID}` | void; sent on shutdown |
| `orbSpawnerWaitLogRead` | `{jobID, spawnerID, holdMs:20000}` | `{read: null \| {offset, limit, holdMs}, closed: boolean}` (Amp asks for log ranges while a thread is watching the setup log) |
| `orbSpawnerSendLogChunk` | `{jobID, spawnerID, chunk:{offset, content, nextOffset, atEnd, reset}}` | void |

Methods on the server side (in strings, used by the actor and web app):
`orbSpawnerEnqueueJob`, `orbSpawnerWaitJob`, `orbSpawnerReportSandboxState`,
`orbSpawnerReportGuestVersion`, `getThreadOrbProviderConfig`,
`admitSandboxSpawn`, `canConsumeSandboxCredits`, `publishThreadSandboxAccess`,
`getTunnelCredentials`, `recordOrbSetupRun`.

Job object, a zod discriminated union on `op`:
```
{ op: "spawn"|"pause"|"delete",
  sandboxId: string,               // orb-provider:<configId>:<orbId>
  token: string,                   // → ORB_TOKEN (spawn)
  snapshotId?: string,             // → ORB_SNAPSHOT_ID
  ampURL?: url,                    // → AMP_URL
  envs?: {NAME: value} }           // exported, names listed in ORB_ENVS (e.g. "ORB_TOKEN AMP_URL")
```
Environment passed to the dispatch program: `ORB_OPERATION, ORB_ID,
ORB_SANDBOX_ID, ORB_IMAGE` (from the provider's own env, defaulting to
`us-central1-docker.pkg.dev/amp-prod-0/amp-orb/amp-orb:latest`),
`ORB_SNAPSHOT_ID, ORB_TOKEN, AMP_URL, ORB_ENVS`. In the probe, `ORB_ID` equaled
the full `sandboxId`. In production it was the short `amp-<thread-uuid>`, so
the real job probably carries `ORB_ID` in `envs` or in a field this probe did
not find. Script stdout and stderr go to
`~/.cache/amp/logs/orb-provider/<id>.log` and are streamed to Amp through the
log-chunk API (they appear in the thread's setup log). The provider handles
several jobs at once (`runningJobs`). After a job finishes it logs `Completed
job`. If it cannot report completion it logs "Giving up completing the job; Amp
will requeue it". If it loses the claim it logs "Claim lost while the job ran;
not completing it". It also **self-updates** and drains jobs before restarting.

**Failure semantics are weak.** A dispatch script that exits non-zero still gets
`✓ done` in the provider UI, and the stderr shows up as the thread's error
line. Amp does not retry the spawn right away; it sent the next spawn about 2.5
to 3 minutes later. If a spawn "succeeds" but no bootstrap ever connects, the
thread waits until Amp gives up and re-issues the spawn. Seen here: spawns at
09:37:31 (script error), 09:39:46 (VM created, bootstrap never started) and
09:42:56 (worked).

### 5.2 Pause and resume
* Amp sends `pause` when the thread goes idle or is archived, and `spawn` again
  on the next message. Each spawn has a **fresh ORB_TOKEN** that expires after N
  minutes. The bootstrap is a per-spawn process: on resume the dispatcher must
  start a new `amp orb bootstrap` with the new token.
* Before a pause, the executor writes `~/.amp/prepared-headless-release`
  (`release <ver> <sha256>`) so that `amp-headless-update-binary` can skip a
  pointless `amp update` on resume.
* On resume the actor runs the `resume` lifecycle hook, the supervisor restarts
  `amp --headless`, and the executor handshakes with `resumeBootstrap:true`. The
  actor then re-leases any unfinished tool calls (`client_resume`).
* Idle detection happens on the server: the actor knows when the agent is done
  and no observers are attached. The docs say an orb pauses "a few minutes after
  the agent finishes", and the thread showed `observerCount`. In this session no
  pause arrived within about 7 minutes while a browser tab was still open on the
  thread.

### 5.3 Snapshots
`ORB_SNAPSHOT_ID` is a **project snapshot**: a prepared orb with the repo
already cloned and `.agents/setup` already run. To save one, Amp sends
`pause{snapshotId}` followed by `spawn` for the same orb; on `pause` the
dispatcher stores a copy of the disk under that ID. Later spawns for new threads
carry `snapshotId`, and the dispatcher boots from that copy if it has it, so
setup is skipped. Snapshots are only taken after a successful setup
(`isFirstProjectSandboxThread` and `recordOrbSetupRun`). Because the setup hook
failed on exe.dev (the `/dev/fd` problem), this session never saw a snapshot
job.

---

## 6. What an open-source replacement must provide

For a pi-durable based "orb", the pieces map like this:

| Amp piece | Role | OSS equivalent |
|---|---|---|
| thread actor (Rivet) | durable agent loop, inference, tool leases, setup driver, job enqueue | pi-durable `Harness` + `Session` (SQLite/JSONL) in a control-plane server; one conversation per thread |
| `/api/internal?orbSpawner*` | lifecycle job queue | small HTTP JSON-RPC: claim (long poll), complete, heartbeat |
| `amp orb provider` + dispatch.sh | pulls jobs, runs the dispatch program | same contract: reuse the `ORB_OPERATION`/`ORB_ID`/`ORB_TOKEN`/`ORB_SNAPSHOT_ID` env vars and keep the dispatch scripts unchanged |
| `/api/orbs/bootstrap` + `amp orb bootstrap` | guest agent: token discovery, remote exec/file ops | orb agent: `GET /bootstrap` with the token, then a WSS connection that serves `run`/`write_files`/`read_file` |
| `amp --headless` executor | registers tools, executes leases, reports results, git snapshots | the same orb agent: a tool host implementing pi-durable tools (bash, read, write, edit, grep, glob) and returning results over WSS |
| plugin runtime | per-thread plugins | pi extensions loaded in the control plane, or on the guest for orb-side tools |
| Amp Tunnel | terminal, portals, desktop | optional: the exe.dev HTTPS proxy, or a reverse WSS tunnel multiplexed on the same connection |

Design notes based on what was observed:
* Keep the **agent loop off the orb**. This is what makes pause and resume
  safe: model state lives in the durable store, and the orb only runs tools. A
  tool call is a lease with a deadline that can be re-leased after a reconnect,
  which fits durable tool tasks.
* Every outbound connection from the orb uses a **short-lived per-spawn token**
  that the control plane can mint and revoke. Later credentials (git, thread
  identity) reach the orb through a root-owned env file written by the control
  plane, and are refreshed on resume.
* Make the bootstrap a **singleton per guest** and make it die when its token is
  rejected. The dispatcher should kill the old one before starting the new one.
* Make "spawn job succeeded" mean **"bootstrap connected within N seconds"**,
  not "dispatch exited 0". The control plane should time out quickly and retry.
* Use idempotent lifecycle hooks (`.agents/setup`, `.agents/resume`) and a
  per-project snapshot ID that the control plane assigns after the first
  successful setup.

---

## Appendix A: `~/.amp/http-headless-supervisor.sh` (verbatim)

```bash
#!/usr/bin/env bash
set -uo pipefail
supervisor_pid_file=/home/user/.amp/http-headless-supervisor.pid
headless_pid_file=/home/user/.amp/http-headless.pid
log_file=/home/user/.cache/amp/logs/headless.log
child_pid=''
write_pid() { printf '%s\n' "$2" >"$1.$$"; mv -f "$1.$$" "$1"; }
shutdown() {
	trap - TERM INT EXIT
	if [ -n "$child_pid" ]; then kill -TERM "$child_pid" 2>/dev/null || true; fi
	rm -f "$supervisor_pid_file" "$headless_pid_file"; exit 0
}
trap shutdown TERM INT
trap 'rm -f "$supervisor_pid_file" "$headless_pid_file"' EXIT
mkdir -p "$(dirname "$supervisor_pid_file")" "$(dirname "$log_file")"
write_pid "$supervisor_pid_file" "$$"
while true; do
	rm -f "$headless_pid_file"
	set -a; . /home/user/.env; set +a
	/usr/local/bin/amp-headless-update-binary >>"$log_file" 2>&1 || true
	if ! cd "$AMP_WORKING_DIRECTORY" 2>>"$log_file"; then
		echo "amp --headless supervisor: cannot enter working directory $AMP_WORKING_DIRECTORY; not starting amp --headless" >>"$log_file"
		exit 1
	fi
	/home/user/.amp/bin/amp --dangerously-allow-all --headless="$AMP_THREAD_ID" --log-file=/home/user/.cache/amp/logs/headless.log >>"$log_file" 2>&1 &
	child_pid=$!
	write_pid "$headless_pid_file" "$child_pid"
	wait "$child_pid" || true
	child_pid=''
	rm -f "$headless_pid_file"
	sleep 10
done
```

## Appendix B: the lifecycle hook runner (`/tmp/amp-<uuid>.sh`, condensed)

```bash
set -eu
hook_name="${AMP_SANDBOX_LIFECYCLE_HOOK:-}"        # setup | resume
log_file=/home/user/.cache/amp/logs/$hook_name.log
[ -d /home/user/workspace/repo ] || exit 0
[ "$hook_name" = setup ] && printf '%s' "$AMP_SANDBOX_SETUP_LOG_SANDBOX_ID" > …/setup.log.sandbox-id
run_hook() ( cd /home/user/workspace/repo
  [ "$hook_name" = resume ] && { set -a; . /home/user/.env; set +a; }
  exec > >(redact_output) 2>&1                       # amp orb redact-output (needs /dev/fd!)
  [ "$hook_name" = setup ] && [ -n "${AMP_PROJECT_PRE_SETUP_SCRIPT:-}" ] && bash "$AMP_PROJECT_PRE_SETUP_SCRIPT" || return 125
  [ -f ".agents/$hook_name" ] || return 0
  [ -x ".agents/$hook_name" ] || return 126
  ".agents/$hook_name" ) > "$log_file" 2>&1
setup:  run_hook; exit $?
resume: run_hook in background; wait ≤ ${AMP_SANDBOX_LIFECYCLE_HOOK_WAIT_SECONDS:-10}s, then disown
```

## Appendix C: how to reproduce the probes

* Provider API: run `amp orb provider --amp-url http://127.0.0.1:PORT ./script`
  against a fake server that answers `orbSpawnerClaimJob` with
  `{"ok":true,"result":{"claim":{…}}}`. Zod errors in the provider's output list
  any missing fields.
* Bootstrap: run `HOME=<scratch> ORB_TOKEN=FAKE AMP_URL=http://127.0.0.1:PORT
  amp orb bootstrap` against a fake `/api/orbs/bootstrap`. Zod errors land in
  `<scratch>/.cache/amp/logs/cli.log`. Return a `rivetEndpoint` that points at a
  raw TCP logger to capture the WebSocket upgrade and its `Sec-WebSocket-Protocol`.
* Executor protocol: read `~/.cache/amp/logs/headless.log` in a live orb. It
  logs every `websocket message` with `direction`, `type` and fields.
