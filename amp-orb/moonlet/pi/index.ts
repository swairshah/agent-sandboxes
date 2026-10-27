/**
 * moonlet for pi: hand tasks to orbs that run on a moonlet server, independently of this machine.
 *
 * The model gets `orb_dispatch`, `orb_status`, `orb_send` and `orb_stop`. A dispatched task is a durable
 * pi-durable thread on the server with its own orb (a container there); it keeps running when this session
 * ends or the laptop sleeps. The session remembers its tasks, so after `pi -c` the model can check on them.
 *
 * While the session is open it holds a socket to the server. Through it, tasks it started can read files
 * here (`local_read`, `local_ls`, `local_find`, `local_grep`; read-only, inside this directory), and it hears
 * when they finish.
 *
 * Config: MOONLET_URL and MOONLET_TOKEN, or ~/.moonlet/client.json ({ "url", "token" }).
 */

import { execFile, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ClientMessage, HubMessage, LocalTool } from "../src/protocol.ts";

const TASK_ENTRY = "moonlet-task";
const SEEN_ENTRY = "moonlet-seen";
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

interface Task {
	id: string;
	title: string;
	orb: string;
	/** Entries of the thread already reported to the model. */
	seen: number;
	state?: "running" | "idle";
}

interface Step {
	kind: "user" | "assistant" | "tool" | "result" | "setup";
	text: string;
}

interface Status {
	thread: { id: string; title: string; orb_id: string };
	orb?: { status: string; last_error: string | null };
	running: boolean;
	userMachine: boolean;
	/** Web servers in the orb, with URLs only the user can open. */
	portals?: { port: number; url: string }[];
	entries: number;
	steps: Step[];
	lastText?: string;
}

function loadConfig(): { url: string; token: string } | undefined {
	if (process.env.MOONLET_URL && process.env.MOONLET_TOKEN) return { url: process.env.MOONLET_URL, token: process.env.MOONLET_TOKEN };
	try {
		const config = JSON.parse(readFileSync(join(homedir(), ".moonlet", "client.json"), "utf8"));
		if (typeof config.url === "string" && typeof config.token === "string") return config;
	} catch {}
	return undefined;
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	const tasks = new Map<string, Task>();
	let root = process.cwd();
	let ui: ExtensionContext["ui"] | undefined;
	let socket: WebSocket | undefined;
	let open = false;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let attempt = 0;

	async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
		if (!config) throw new Error("moonlet is not configured: set MOONLET_URL and MOONLET_TOKEN, or write ~/.moonlet/client.json");
		const response = await fetch(new URL(path, config.url), {
			method,
			headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const raw = await response.text();
		if (!response.ok) throw new Error(`moonlet ${method} ${path}: HTTP ${response.status} ${raw.slice(0, 300)}`);
		return (raw ? JSON.parse(raw) : undefined) as T;
	}

	function showStatus() {
		if (!ui) return;
		if (tasks.size === 0) return ui.setStatus("moonlet", undefined);
		const running = [...tasks.values()].filter((task) => task.state === "running").length;
		const link = open ? "" : " (offline)";
		ui.setStatus("moonlet", ui.theme.fg(running ? "accent" : "dim", `orbs: ${running} running, ${tasks.size - running} idle${link}`));
	}

	// The socket ---------------------------------------------------------------------------------

	function send(message: ClientMessage) {
		if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
	}

	function attach() {
		send({ type: "attach", threads: [...tasks.keys()], host: hostname(), cwd: root });
	}

	function connect() {
		if (!config || socket || tasks.size === 0) return;
		const url = new URL("/api/client", config.url);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(url, ["moonlet.v1", `moonlet.auth.${config.token}`]);
		socket = ws;
		ws.addEventListener("open", () => {
			open = true;
			attempt = 0;
			attach();
			heartbeat = setInterval(() => send({ type: "ping" }), 30_000);
			showStatus();
		});
		ws.addEventListener("message", (event) => void onMessage(String(event.data)));
		ws.addEventListener("close", () => {
			clearInterval(heartbeat);
			if (socket !== ws) return;
			socket = undefined;
			open = false;
			showStatus();
			attempt++;
			retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));
		});
		ws.addEventListener("error", () => {});
	}

	function disconnect() {
		clearTimeout(retry);
		clearInterval(heartbeat);
		const ws = socket;
		socket = undefined;
		open = false;
		ws?.close();
	}

	async function onMessage(raw: string) {
		let message: HubMessage;
		try {
			message = JSON.parse(raw);
		} catch {
			return;
		}
		if (message.type === "tool-request") {
			let result: { ok: boolean; text: string };
			try {
				result = { ok: true, text: await runLocal(message.tool, message.args) };
			} catch (error) {
				result = { ok: false, text: error instanceof Error ? error.message : String(error) };
			}
			send({ type: "tool-result", id: message.id, ...result });
		} else if (message.type === "thread-update") {
			const task = tasks.get(message.thread);
			if (!task) return;
			const finished = task.state === "running" && message.state === "idle";
			task.state = message.state;
			showStatus();
			if (finished) {
				ui?.notify(`Orb task ${task.id} finished: ${task.title}`, "info");
				pi.sendMessage(
					{
						customType: "moonlet",
						content: `Orb task ${task.id} (${task.title}) finished. Its last message:\n\n${message.text ?? "(none)"}\n\nUse orb_status for the full report.`,
						display: true,
					},
					{ deliverAs: "followUp" },
				);
			}
		}
	}

	// Local tools, for tasks ---------------------------------------------------------------------

	/** Resolve `path` inside this session's directory, following links, or refuse it. */
	async function inside(path: unknown): Promise<string> {
		const base = await realpath(root);
		const target = await realpath(resolve(base, typeof path === "string" && path ? path : "."));
		if (target !== base && !target.startsWith(base + sep)) throw new Error(`${String(path)} is outside ${root}`);
		return target;
	}

	function run(command: string, args: string[]): Promise<string> {
		return new Promise((done, fail) => {
			execFile(command, args, { cwd: root, maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }, (error, stdout, stderr) => {
				// ripgrep exits 1 when nothing matches.
				if (error && (error as { code?: unknown }).code !== 1) fail(new Error(stderr.trim() || error.message));
				else done(stdout);
			});
		});
	}

	function cap(output: string, what: string) {
		const lines = output.split("\n");
		let kept = lines.slice(0, MAX_LINES).join("\n");
		if (kept.length > MAX_BYTES) kept = kept.slice(0, MAX_BYTES);
		return kept.length < output.length ? `${kept}\n… (${what} truncated)` : output;
	}

	async function runLocal(tool: LocalTool, args: Record<string, unknown>): Promise<string> {
		switch (tool) {
			case "local_read": {
				const file = await inside(args.path);
				const info = await stat(file);
				if (info.isDirectory()) throw new Error(`${String(args.path)} is a directory`);
				if (info.size > 20 * 1024 * 1024) throw new Error(`${String(args.path)} is ${info.size} bytes, too large to read`);
				const content = await readFile(file, "utf8");
				if (content.includes("\u0000")) throw new Error(`${String(args.path)} is a binary file`);
				const lines = content.split("\n");
				const start = Math.max(1, Number(args.offset) || 1);
				const count = Math.max(1, Number(args.limit) || MAX_LINES);
				const slice = lines.slice(start - 1, start - 1 + count).join("\n");
				const out = cap(slice, "file");
				const end = start - 1 + out.split("\n").length;
				return end < lines.length ? `${out}\n… (lines ${start}-${end} of ${lines.length}; use offset to read on)` : out;
			}
			case "local_ls": {
				const dir = await inside(args.path);
				const entries = await readdir(dir, { withFileTypes: true });
				const names = entries.map((entry) => entry.name + (entry.isDirectory() ? "/" : "")).sort();
				return cap(names.join("\n") || "(empty)", "listing");
			}
			case "local_find": {
				const dir = await inside(args.path);
				const out = await run("rg", ["--files", "--glob", String(args.pattern ?? "*"), dir]);
				return cap(out.split(root + sep).join("").trim() || "(no files)", "results");
			}
			case "local_grep": {
				const target = await inside(args.path);
				const flags = ["-n", "--no-heading", "--color", "never", "--max-columns", "300"];
				if (args.ignoreCase) flags.push("-i");
				if (typeof args.glob === "string") flags.push("--glob", args.glob);
				const out = await run("rg", [...flags, "-e", String(args.pattern ?? ""), target]);
				return cap(out.split(root + sep).join("").trim() || "(no matches)", "results");
			}
		}
	}

	// Session ------------------------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		ui = ctx.hasUI ? ctx.ui : undefined;
		root = ctx.cwd;
		tasks.clear();
		for (const entry of ctx.sessionManager.getBranch() as { type: string; customType?: string; data?: any }[]) {
			if (entry.type !== "custom") continue;
			if (entry.customType === TASK_ENTRY) tasks.set(entry.data.id, { ...entry.data, seen: 0 });
			if (entry.customType === SEEN_ENTRY && tasks.has(entry.data.id)) tasks.get(entry.data.id)!.seen = entry.data.seen;
		}
		disconnect();
		connect();
		// Learn which tasks still run, for the footer.
		await Promise.all(
			[...tasks.values()].map(async (task) => {
				const status = await api<Status>("GET", `/api/threads/${task.id}/status?after=${Number.MAX_SAFE_INTEGER}`).catch(() => undefined);
				if (status) task.state = status.running ? "running" : "idle";
			}),
		);
		showStatus();
	});

	pi.on("session_shutdown", async () => {
		disconnect();
	});

	// Tools for the model ------------------------------------------------------------------------

	pi.registerTool({
		name: "orb_dispatch",
		label: "Orb dispatch",
		description:
			"Start a task in an orb: a separate agent with its own Linux machine on the user's moonlet server. It runs on its own, " +
			"even after this session ends, and can read files in the current directory (read-only) while this session is open. " +
			"Give it a complete, self-contained task. Returns the task id at once; check on it with orb_status.",
		parameters: Type.Object({
			task: Type.String({ description: "What the orb agent should do, with all the context it needs" }),
			title: Type.Optional(Type.String({ description: "Short title" })),
			repo: Type.Optional(Type.String({ description: "Git URL the orb clones into its workspace before starting" })),
			size: Type.Optional(Type.String({ description: "small, medium (default), large or xlarge; only for heavy work" })),
			files: Type.Optional(Type.Array(Type.String(), { description: "Local files (in this directory) to copy into the orb's workspace first" })),
		}),
		async execute(_id, params) {
			const files = params.files ?? [];
			const thread = await api<{ id: string; orb_id: string; title: string }>("POST", "/api/threads", {
				// With files, the task starts once they are in place.
				prompt: files.length ? undefined : params.task,
				title: params.title ?? params.task.slice(0, 60),
				repo: params.repo,
				size: params.size,
				localCwd: root,
			});
			const copied: string[] = [];
			for (const file of files) copied.push(await upload(thread.id, file));
			if (files.length) await api("POST", `/api/threads/${thread.id}/messages`, { content: params.task, whenBusy: "followUp" });
			const task: Task = { id: thread.id, title: thread.title, orb: thread.orb_id, seen: 0, state: "running" };
			tasks.set(task.id, task);
			pi.appendEntry(TASK_ENTRY, { id: task.id, title: task.title, orb: task.orb });
			if (socket) attach();
			else connect();
			showStatus();
			const note = copied.length ? ` Copied into the orb: ${copied.join(", ")}.` : "";
			return text(`Started orb task ${task.id} (orb ${task.orb}): ${task.title}. It runs on the moonlet server; check on it with orb_status.${note}`);
		},
	});

	pi.registerTool({
		name: "orb_status",
		label: "Orb status",
		description:
			"Check on orb tasks. Without an id: list this session's tasks. With an id: whether it is still running and what it did " +
			"since the last check, ending with its latest message. `wait` waits up to that many seconds for it to finish first.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Task id, e.g. t-1a2b3c4d" })),
			wait: Type.Optional(Type.Number({ description: "Seconds to wait for the task to finish (max 600)" })),
		}),
		async execute(_id, params, signal) {
			if (!params.id) {
				if (tasks.size === 0) return text("This session has no orb tasks.");
				const lines = await Promise.all(
					[...tasks.values()].map(async (task) => {
						const status = await api<Status>("GET", `/api/threads/${task.id}/status?after=${Number.MAX_SAFE_INTEGER}`).catch(
							(error: Error) => error,
						);
						if (status instanceof Error) return `${task.id}  ${task.title}: ${status.message}`;
						task.state = status.running ? "running" : "idle";
						const last = status.lastText ? ` Last: ${status.lastText.replace(/\s+/g, " ").slice(0, 200)}` : "";
						const portals = status.portals?.length ? ` Portals: ${status.portals.map((portal) => portal.url).join(", ")}.` : "";
						return `${task.id}  ${status.running ? "running" : "idle"}  orb ${status.orb?.status ?? "?"}  ${task.title}.${portals}${last}`;
					}),
				);
				showStatus();
				return text(lines.join("\n"));
			}
			const id = params.id;
			const known = tasks.get(id);
			const deadline = Date.now() + Math.min(600, Math.max(0, params.wait ?? 0)) * 1000;
			let status = await api<Status>("GET", `/api/threads/${id}/status?after=${known?.seen ?? 0}`);
			while (status.running && Date.now() < deadline && !signal?.aborted) {
				await new Promise((done) => setTimeout(done, 5000));
				status = await api<Status>("GET", `/api/threads/${id}/status?after=${known?.seen ?? 0}`);
			}
			if (known) {
				known.seen = status.entries;
				known.state = status.running ? "running" : "idle";
				pi.appendEntry(SEEN_ENTRY, { id, seen: status.entries });
				showStatus();
			}
			const header = [
				`${id}: ${status.thread.title}`,
				`state: ${status.running ? "running" : "idle"}; orb ${status.orb?.status ?? "?"}${status.orb?.last_error ? ` (${status.orb.last_error.slice(0, 200)})` : ""}`,
			];
			for (const portal of status.portals ?? []) header.push(`portal: port ${portal.port} → ${portal.url} (opens for the user only; a visit wakes a paused orb)`);
			const labels: Record<Step["kind"], string> = { user: "user", assistant: "agent", tool: "→", result: "  ←", setup: "setup" };
			let steps = status.steps.map((step) => `${labels[step.kind]} ${step.text}`).join("\n");
			if (steps.length > 20_000) steps = `… (earlier steps omitted)\n${steps.slice(-20_000)}`;
			return text(`${header.join("\n")}\n\n${steps || "(nothing new since the last check)"}`);
		},
	});

	pi.registerTool({
		name: "orb_send",
		label: "Orb send",
		description: "Send a follow-up message to an orb task. With steer, it reaches the agent during its current run.",
		parameters: Type.Object({
			id: Type.String({ description: "Task id" }),
			message: Type.String(),
			steer: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params) {
			await api("POST", `/api/threads/${params.id}/messages`, { content: params.message, whenBusy: params.steer ? "steer" : "followUp" });
			const task = tasks.get(params.id);
			if (task) task.state = "running";
			showStatus();
			return text(`Sent to ${params.id}.`);
		},
	});

	pi.registerTool({
		name: "orb_stop",
		label: "Orb stop",
		description: "Stop the current run of an orb task. Its orb and files stay; send a message to continue it.",
		parameters: Type.Object({ id: Type.String({ description: "Task id" }) }),
		async execute(_id, params) {
			await api("POST", `/api/threads/${params.id}/abort`);
			const task = tasks.get(params.id);
			if (task) task.state = "idle";
			showStatus();
			return text(`Stopped ${params.id}.`);
		},
	});

	/** Copy a local file (inside this directory) into the orb's workspace at the same relative path. */
	async function upload(id: string, file: string, target?: string): Promise<string> {
		if (!config) throw new Error("moonlet is not configured");
		const source = await inside(file);
		const path = target ?? (relative(await realpath(root), source) || basename(source));
		// Files from here are part of what the orb starts from, not its changes.
		const response = await fetch(new URL(`/api/threads/${id}/files?baseline=1&path=${encodeURIComponent(path)}`, config.url), {
			method: "PUT",
			headers: { authorization: `Bearer ${config.token}` },
			body: await readFile(source),
		});
		if (!response.ok) throw new Error(`upload ${file}: HTTP ${response.status} ${await response.text()}`);
		return ((await response.json()) as { path: string }).path;
	}

	pi.registerTool({
		name: "orb_upload",
		label: "Orb upload",
		description: "Copy files from this directory into an orb task's workspace (same relative paths unless `to` is given for one file).",
		parameters: Type.Object({
			id: Type.String({ description: "Task id" }),
			files: Type.Array(Type.String()),
			to: Type.Optional(Type.String({ description: "Destination path in the orb, for a single file" })),
		}),
		async execute(_id, params) {
			const copied: string[] = [];
			for (const file of params.files) copied.push(await upload(params.id, file, params.files.length === 1 ? params.to : undefined));
			return text(`Copied into ${params.id}: ${copied.join(", ")}`);
		},
	});

	pi.registerTool({
		name: "orb_download",
		label: "Orb download",
		description:
			"Copy a file from an orb task (a path relative to its workspace, or absolute) into this directory, e.g. a " +
			"screenshot under .moonlet/artifacts/. Saved under `to` (default: the same relative path, or its name).",
		parameters: Type.Object({
			id: Type.String({ description: "Task id" }),
			path: Type.String({ description: "Path in the orb" }),
			to: Type.Optional(Type.String({ description: "Local path, inside this directory" })),
		}),
		async execute(_id, params) {
			if (!config) throw new Error("moonlet is not configured");
			const response = await fetch(new URL(`/api/threads/${params.id}/files?path=${encodeURIComponent(params.path)}`, config.url), {
				headers: { authorization: `Bearer ${config.token}` },
			});
			if (!response.ok) throw new Error(`download ${params.path}: HTTP ${response.status} ${await response.text()}`);
			const target = resolve(root, params.to ?? (params.path.startsWith("/") ? basename(params.path) : params.path));
			const base = await realpath(root);
			if (target !== base && !target.startsWith(base + sep) && !target.startsWith(root + sep)) throw new Error(`${target} is outside ${root}`);
			const bytes = new Uint8Array(await response.arrayBuffer());
			const { mkdir } = await import("node:fs/promises");
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, bytes);
			return text(`Saved ${params.path} from ${params.id} to ${relative(root, target)} (${bytes.byteLength} bytes).`);
		},
	});

	/** Run git in this session's directory; resolves with its output, or rejects with stderr. */
	function git(args: string[]): Promise<string> {
		return new Promise((done, fail) => {
			execFile("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
				if (error) fail(new Error((stderr || stdout).trim() || error.message));
				else done(stdout);
			});
		});
	}

	pi.registerTool({
		name: "orb_changes",
		label: "Orb changes",
		description:
			"Show what an orb task changed in its workspace since it started: committed and uncommitted edits and new files. " +
			"By default a summary of files and line counts; with patch, the full diff (long diffs are cut).",
		parameters: Type.Object({
			id: Type.String({ description: "Task id" }),
			patch: Type.Optional(Type.Boolean({ description: "Include the full diff" })),
		}),
		async execute(_id, params) {
			const changes = await api<{ base: string; text: string }>("GET", `/api/threads/${params.id}/changes?mode=${params.patch ? "patch" : "stat"}`);
			if (!changes.text.trim()) return text(`${params.id} has no changes since ${changes.base.slice(0, 10)}.`);
			let body = changes.text;
			if (body.length > 40_000) body = `${body.slice(0, 40_000)}\n… (diff cut at 40 KB; use orb_sync to apply all of it)`;
			return text(`Changes in ${params.id} since ${changes.base.slice(0, 10)}:\n${body}`);
		},
	});

	pi.registerTool({
		name: "orb_sync",
		label: "Orb sync",
		description:
			"Copy an orb task's changes into this directory on the user's machine: fetches its diff and applies it with git " +
			"apply (three-way in a git repository, so conflicts show as conflict markers). Use only when the user wants the " +
			"changes here. The directory should match what the orb started from (the same repository and commit, or empty " +
			"for a task without a repository).",
		parameters: Type.Object({ id: Type.String({ description: "Task id" }) }),
		async execute(_id, params) {
			const changes = await api<{ base: string; text: string }>("GET", `/api/threads/${params.id}/changes?mode=patch`);
			if (!changes.text.trim()) return text(`${params.id} has no changes to sync.`);
			const dir = await mkdtemp(join(tmpdir(), "moonlet-sync-"));
			const file = join(dir, `${params.id}.patch`);
			try {
				await writeFile(file, changes.text.endsWith("\n") ? changes.text : `${changes.text}\n`);
				const files = (await git(["apply", "--numstat", file])).trim();
				const inRepo = await git(["rev-parse", "--git-dir"]).then(() => true, () => false);
				try {
					await git(["apply", "--whitespace=nowarn", file]);
				} catch (error) {
					if (!inRepo) throw error;
					// Fall back to a three-way merge, which leaves conflict markers where both sides changed.
					await git(["apply", "--3way", "--whitespace=nowarn", file]);
				}
				return text(`Applied ${params.id}'s changes (base ${changes.base.slice(0, 10)}) to ${root}:\n${files}`);
			} catch (error) {
				return { ...text(`Could not apply ${params.id}'s changes: ${error instanceof Error ? error.message : error}`), isError: true };
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	});

	const SHIP: Record<string, string> = {
		trunk:
			"Ship your changes: commit everything with a clear message, fetch origin, rebase onto the default branch " +
			"(origin/HEAD), run the project's tests, and push to the default branch. Retry if the push races another one. " +
			"If the rebase has conflicts that need judgment, stop and explain them instead of guessing.",
		branch:
			"Ship your changes on a branch: create a descriptively named branch, commit everything with a clear message, " +
			"push it to origin, and open a pull request (gh pr create) if gh can. Reply with the branch and the PR URL.",
		commit: "Commit all your changes locally with a clear message. Do not push.",
	};

	pi.registerTool({
		name: "orb_ship",
		label: "Orb ship",
		description:
			"Ask an orb task to ship its changes. trunk: commit, rebase onto the default branch, test, push. branch: push a " +
			"branch and open a PR. commit: commit locally only. Extra instructions are appended. Pushing needs git credentials " +
			"in the orb (a GITHUB_TOKEN secret on the moonlet server).",
		parameters: Type.Object({
			id: Type.String({ description: "Task id" }),
			mode: Type.Optional(Type.Union([Type.Literal("trunk"), Type.Literal("branch"), Type.Literal("commit")])),
			instructions: Type.Optional(Type.String({ description: "Extra instructions, e.g. the branch name" })),
		}),
		async execute(_id, params) {
			const prompt = `${SHIP[params.mode ?? "branch"]}${params.instructions ? `\n\n${params.instructions}` : ""}`;
			await api("POST", `/api/threads/${params.id}/messages`, { content: prompt, whenBusy: "followUp" });
			const task = tasks.get(params.id);
			if (task) task.state = "running";
			showStatus();
			return text(`Asked ${params.id} to ship (${params.mode ?? "branch"}). Check with orb_status.`);
		},
	});

	pi.registerTool({
		name: "orb_schedule",
		label: "Orb schedule",
		description:
			"Wake an orb task later with a message, once or repeatedly (every_minutes, at least 5), e.g. a nightly dependency " +
			"update or a CI check in 20 minutes. `list` and `remove` manage them.",
		parameters: Type.Object({
			id: Type.String({ description: "Task id" }),
			action: Type.Union([Type.Literal("add"), Type.Literal("list"), Type.Literal("remove")]),
			message: Type.Optional(Type.String()),
			in_minutes: Type.Optional(Type.Number()),
			at: Type.Optional(Type.String({ description: "ISO time" })),
			every_minutes: Type.Optional(Type.Number()),
			schedule: Type.Optional(Type.String({ description: "remove: schedule id" })),
		}),
		async execute(_id, params) {
			const path = `/api/threads/${params.id}/schedules`;
			if (params.action === "remove") {
				await api("DELETE", `${path}?id=${encodeURIComponent(params.schedule ?? "")}`);
				return text(`Removed ${params.schedule}.`);
			}
			if (params.action === "add") {
				const row = await api<{ id: string; next_at: number; every_ms: number | null }>("POST", path, {
					message: params.message,
					inMinutes: params.in_minutes,
					at: params.at,
					everyMinutes: params.every_minutes,
				});
				return text(`Scheduled ${row.id} for ${new Date(row.next_at).toLocaleString()}${row.every_ms ? `, then every ${row.every_ms / 60_000} min` : ""}.`);
			}
			const rows = await api<{ id: string; next_at: number; every_ms: number | null; message: string }[]>("GET", path);
			return text(rows.length ? rows.map((row) => `${row.id}  ${new Date(row.next_at).toLocaleString()}${row.every_ms ? ` every ${row.every_ms / 60_000} min` : ""}  ${row.message}`).join("\n") : "No schedules.");
		},
	});

	pi.registerCommand("orb-open", {
		description: "Open an orb task's portals (web servers, desktop) in the browser",
		handler: async (args, ctx) => {
			const id = args.trim() || [...tasks.keys()].pop();
			if (!id) return ctx.ui.notify("No orb task: /orb-open <task id>", "warning");
			const status = await api<Status>("GET", `/api/threads/${id}/status?after=${Number.MAX_SAFE_INTEGER}`);
			const services = (status as Status & { services?: { name: string; url?: string }[] }).services ?? [];
			const urls = services.filter((service) => service.url).map((service) =>
				service.name === "desktop-vnc" ? `${service.url}vnc.html?autoconnect=true&resize=scale&path=websockify` : service.url!,
			);
			for (const portal of status.portals ?? []) if (!urls.some((url) => url.startsWith(portal.url))) urls.push(portal.url);
			if (urls.length === 0) return ctx.ui.notify(`${id} has no portals.`, "info");
			for (const url of urls) spawnSync(process.platform === "darwin" ? "open" : "xdg-open", [url]);
			ctx.ui.notify(`Opened ${urls.join(", ")}`, "info");
		},
	});

	pi.registerCommand("orb-term", {
		description: "Open a terminal in an orb task's shared tmux session (detach with ctrl-b d to come back)",
		handler: async (args, ctx) => {
			const id = args.trim() || [...tasks.values()].reverse().find((task) => task.state === "running")?.id || [...tasks.keys()].pop();
			if (!id) return ctx.ui.notify("No orb task: /orb-term <task id>", "warning");
			const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
			await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
				tui.stop();
				process.stdout.write("\x1b[2J\x1b[H");
				spawnSync("bun", [cli, "term", id], { stdio: "inherit", env: { ...process.env, ...(config ? { MOONLET_URL: config.url, MOONLET_TOKEN: config.token } : {}) } });
				tui.start();
				tui.requestRender(true);
				done();
				return { render: () => [], invalidate: () => {} };
			});
		},
	});

	pi.registerCommand("orbs", {
		description: "List this session's orb tasks",
		handler: async (_args, ctx) => {
			if (tasks.size === 0) return ctx.ui.notify("No orb tasks in this session.", "info");
			const lines = [...tasks.values()].map((task) => `${task.id}  ${task.state ?? "?"}  ${task.title}`);
			ctx.ui.notify(`${lines.join("\n")}\n${config?.url ?? ""}`, "info");
		},
	});
}
