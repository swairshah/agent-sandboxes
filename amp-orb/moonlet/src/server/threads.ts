import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type Conversation,
	createRegistry,
	defineExtension,
	defineTool,
	type EntryRecord,
	Harness,
	type HarnessSettings,
	section,
	watchEvents,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { RemoteExecutionEnv } from "@earendil-works/pi-env";
import { Type } from "typebox";
import type { LocalTool } from "../protocol.ts";
import type { ClientHub, LocalResult } from "./clients.ts";
import { ORB_SIZES, type OrbManager } from "./orbs.ts";
import type { Portals } from "./portals.ts";
import { maskTool, masker } from "./secrets.ts";
import type { Schedules } from "./schedules.ts";
import type { Services, ServiceStatus } from "./services.ts";
import { openBunSqliteStorage } from "./bun-sqlite.ts";
import type { ModelChoice } from "./models.ts";
import type { Store, ThreadRow } from "./store.ts";

const context = BACKGROUND_CONTEXT;

/** What the orb tools need from the server, per conversation. */
export interface OrbHost {
	portal(conversationId: number, port: number): { port: number; url: string };
	services(conversationId: number): { orbId: string; services: Services };
	/** The thread store, for agents that start and follow other threads. */
	threads(): Threads;
	schedules(): Schedules;
	threadOf(conversationId: number): string;
}

/** Tells the model where it runs, and gives it services and portals: how it shows the user what it built. */
function orbExtension(host: OrbHost) {
	const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });
	const describe = (status: ServiceStatus) =>
		`${status.name}: ${status.state}${status.port ? ` on port ${status.port}` : ""}${status.url ? `, ${status.url}` : ""}${status.declared ? " (declared)" : ""}${status.note ? `\n  ${status.note}` : ""}`;
	return defineExtension({
		name: "moonlet",
		tools: [
			defineTool({
				name: "service",
				description:
					"Run long-lived processes (dev servers, watchers) as supervised services: restarted when they exit and started " +
					"again whenever the orb resumes. `ensure` starts every service in .amp/services.yaml (or .moonlet/services.yaml) " +
					"and prints their URLs. `start` adds an ad hoc service: a foreground `command`, and for a server its `port` " +
					"(it gets $PORT and $PUBLIC_URL; give it a portal unless portal is false). `logs`, `restart`, `stop`, `list` " +
					"manage them. Never keep servers alive with nohup, setsid, & or tmux.",
				parameters: Type.Object({
					action: Type.Union(["ensure", "start", "stop", "restart", "logs", "list"].map((value) => Type.Literal(value))),
					name: Type.Optional(Type.String({ description: "Service name (start, stop, restart, logs)" })),
					command: Type.Optional(Type.String({ description: "start: shell command that runs in the foreground" })),
					port: Type.Optional(Type.Integer({ description: "start: port the server listens on" })),
					cwd: Type.Optional(Type.String({ description: "start: directory, relative to the workspace (default: workspace)" })),
					health: Type.Optional(Type.String({ description: "start: HTTP path that answers once it is ready, e.g. /" })),
					portal: Type.Optional(Type.Boolean({ description: "start: give it a portal URL (default true when it has a port)" })),
					env: Type.Optional(Type.Record(Type.String(), Type.String())),
					lines: Type.Optional(Type.Integer({ description: "logs: number of lines (default 80)" })),
				}),
				async execute(args, api) {
					const { orbId, services } = host.services(Number(api.conversationId));
					const name = () => {
						if (!args.name) throw new Error(`${args.action} needs a name`);
						return args.name;
					};
					switch (args.action) {
						case "ensure": {
							const all = await services.ensure(orbId);
							return text(all.length ? all.map(describe).join("\n") : "No services: add .amp/services.yaml, or use start.");
						}
						case "start": {
							if (!args.command) throw new Error("start needs a command");
							return text(describe(await services.add(orbId, { name: name(), command: args.command, port: args.port, cwd: args.cwd, health: args.health, portal: args.portal, env: args.env })));
						}
						case "stop":
							return text(await services.stop(orbId, name(), true));
						case "restart":
							return text(describe(await services.restart(orbId, name())));
						case "logs":
							return text(await services.logs(orbId, name(), args.lines));
						case "list": {
							const all = services.list(orbId);
							return text(all.length ? all.map(describe).join("\n") : "No services.");
						}
					}
					throw new Error(`unknown action ${args.action}`);
				},
			}),
			defineTool({
				name: "desktop",
				description:
					"A Linux desktop in this orb with Google Chrome, which the user can watch and take over in their browser. " +
					"`ensure` starts it (display :1) and returns the user's URL and the Chrome DevTools endpoint " +
					"(http://127.0.0.1:9222) for driving Chrome with CDP, Playwright or Puppeteer. To open another program for " +
					"the user, run it with DISPLAY=:1. `stop` ends it.",
				parameters: Type.Object({ action: Type.Union([Type.Literal("ensure"), Type.Literal("stop")]) }),
				async execute(args, api) {
					const { orbId, services } = host.services(Number(api.conversationId));
					if (args.action === "stop") {
						for (const name of ["desktop-chrome", "desktop-vnc", "desktop"]) await services.stop(orbId, name, true).catch(() => {});
						return text("Desktop stopped.");
					}
					const display = { DISPLAY: ":1" };
					await services.add(orbId, {
						name: "desktop",
						command:
							"Xvfb :1 -screen 0 1600x1000x24 -nolisten tcp & sleep 1; DISPLAY=:1 fluxbox >/dev/null 2>&1 & " +
							"exec x11vnc -display :1 -forever -shared -nopw -localhost -rfbport 5900 -quiet",
						port: 5900,
						portal: false,
					});
					const vnc = await services.add(orbId, { name: "desktop-vnc", command: "exec websockify --web /usr/share/novnc 6080 localhost:5900", port: 6080 });
					await services.add(orbId, {
						name: "desktop-chrome",
						command:
							"exec google-chrome --no-sandbox --no-first-run --no-default-browser-check --disable-dev-shm-usage " +
							"--remote-debugging-port=9222 --user-data-dir=$HOME/.moonlet/chrome --window-position=0,0 --window-size=1600,1000 about:blank",
						port: 9222,
						portal: false,
						env: display,
					});
					const url = vnc.url ? `${vnc.url}vnc.html?autoconnect=true&resize=scale&path=websockify` : "(no portal)";
					return text(`Desktop running. The user can watch and take over at ${url}\nChrome DevTools: http://127.0.0.1:9222 (DISPLAY=:1)`);
				},
			}),
			defineTool({
				name: "schedule",
				description:
					"Wake this thread later with a message, once or repeatedly (e.g. check CI in 20 minutes, or a daily report). " +
					"The orb resumes and you get the message with all of this thread's context.",
				parameters: Type.Object({
					action: Type.Union([Type.Literal("add"), Type.Literal("list"), Type.Literal("remove")]),
					message: Type.Optional(Type.String({ description: "add: what to do when it fires" })),
					in_minutes: Type.Optional(Type.Number({ description: "add: minutes from now" })),
					at: Type.Optional(Type.String({ description: "add: ISO time, instead of in_minutes" })),
					every_minutes: Type.Optional(Type.Number({ description: "add: repeat every so many minutes (at least 5)" })),
					id: Type.Optional(Type.String({ description: "remove: schedule id" })),
				}),
				async execute(args, api) {
					const schedules = host.schedules();
					const threadId = host.threadOf(Number(api.conversationId));
					if (args.action === "remove") {
						if (!args.id) throw new Error("remove needs an id");
						schedules.remove(threadId, args.id);
						return text(`Removed ${args.id}.`);
					}
					if (args.action === "add") {
						if (!args.message) throw new Error("add needs a message");
						const row = schedules.add(threadId, { message: args.message, inMinutes: args.in_minutes, at: args.at, everyMinutes: args.every_minutes });
						return text(`Scheduled ${row.id} for ${new Date(row.next_at).toISOString()}${row.every_ms ? `, then every ${row.every_ms / 60_000} min` : ""}.`);
					}
					const rows = schedules.list(threadId);
					return text(rows.length ? rows.map((row) => `${row.id}  ${new Date(row.next_at).toISOString()}${row.every_ms ? ` every ${row.every_ms / 60_000} min` : ""}  ${row.message}`).join("\n") : "No schedules.");
				},
			}),
			defineTool({
				name: "thread_create",
				description:
					"Start another agent in its own orb, for work that can run in parallel or apart from yours. Give it a complete, " +
					"self-contained task. Returns its thread id at once; follow it with thread_status.",
				parameters: Type.Object({
					task: Type.String(),
					title: Type.Optional(Type.String()),
					repo: Type.Optional(Type.String({ description: "Git URL it clones before starting" })),
					size: Type.Optional(Type.String({ description: "small, medium (default), large or xlarge" })),
				}),
				async execute(args) {
					const thread = await host.threads().create({ prompt: args.task, title: args.title ?? args.task.slice(0, 60), repo: args.repo, size: args.size });
					return text(`Started ${thread.id} (orb ${thread.orb_id}).`);
				},
			}),
			defineTool({
				name: "thread_send",
				description: "Send a follow-up message to a thread you started.",
				parameters: Type.Object({ id: Type.String(), message: Type.String() }),
				async execute(args) {
					await host.threads().send(args.id, args.message);
					return text(`Sent to ${args.id}.`);
				},
			}),
			defineTool({
				name: "thread_status",
				description:
					"Check on a thread: whether it is still running, and its latest message. `wait` waits up to that many seconds " +
					"(max 900) for it to finish first.",
				parameters: Type.Object({ id: Type.String(), wait: Type.Optional(Type.Number()) }),
				async execute(args) {
					const threads = host.threads();
					const deadline = Date.now() + Math.min(900, Math.max(0, args.wait ?? 0)) * 1000;
					let status = await threads.status(args.id, Number.MAX_SAFE_INTEGER);
					while (status.running && Date.now() < deadline) {
						await Bun.sleep(5000);
						status = await threads.status(args.id, Number.MAX_SAFE_INTEGER);
					}
					const portals = status.portals.map((portal) => `\nportal: port ${portal.port} → ${portal.url}`).join("");
					return text(`${args.id}: ${status.running ? "running" : "idle"}${portals}\n\n${status.lastText ?? "(no reply yet)"}`);
				},
			}),
			defineTool({
				name: "portal",
				description:
					"Give the user a URL for something already listening on a port in this orb (127.0.0.1 is fine). Only the user " +
					"can open it; the same port keeps the same URL, and a visit wakes a paused orb. For a server that must keep " +
					"running, use service start instead, which also gives it a portal.",
				parameters: Type.Object({ port: Type.Integer({ description: "TCP port in the orb" }) }),
				replay: "safe",
				async execute(args, api) {
					const portal = host.portal(Number(api.conversationId), args.port);
					return text(`Port ${portal.port} is at ${portal.url}`);
				},
			}),
		],
		sections: [
			section(
				"orb",
				(input) =>
					[
						"You are running inside an orb: a remote Linux machine (a container) dedicated to this thread, not the user's computer. Refer to it as an orb.",
						"Your tools (read, write, edit, bash) act on the orb.",
						`The working directory is ${input.env?.cwd ?? "the workspace"}.`,
						"The orb pauses when the thread is idle: files persist; running processes stop unless they are services, which moonlet starts again on resume.",
						"The user cannot open localhost URLs in the orb. To show a web app, run it with the service tool (or portal for something already listening) and share the URL it returns, as a Markdown link. Never use public tunnels such as cloudflared or ngrok.",
						"Treat environment variables, git credentials, and secret files as sensitive; do not print full secret values.",
						"Save files the user should look at (screenshots, recordings, exports) under .moonlet/artifacts/ in the workspace.",
						"Preinstalled: git, gh, Node.js with npm and pnpm, Bun, Python 3 with uv, rg, jq, ffmpeg, ImageMagick, tmux, and Google Chrome. For a browser the user can see, use the desktop tool.",
						"The user's terminal is the tmux session `moonlet`; to show them a command, run it there (tmux send-keys -t moonlet).",
						"Prove your changes work by running them before you report back.",
					].join("\n"),
				{ tag: true },
			),
		],
	});
}

/**
 * Read-only tools on the user's machine, for threads started from a pi session (`local_cwd`). The pi session runs
 * them in its working directory; they reach it through the client hub.
 */
function localExtension(call: (conversationId: number, tool: LocalTool, args: Record<string, unknown>) => Promise<LocalResult>, cwdOf: (conversationId: number) => string | undefined) {
	const local = <T extends Parameters<typeof defineTool>[0]["parameters"]>(name: LocalTool, description: string, parameters: T) =>
		defineTool({
			name,
			description,
			parameters,
			replay: "safe",
			async execute(args, api) {
				const result = await call(Number(api.conversationId), name, args as Record<string, unknown>);
				return { output: [{ type: "text", text: result.text }], isError: !result.ok };
			},
		});
	const path = (what: string) => Type.Optional(Type.String({ description: `${what}, relative to the user's directory (default ".")` }));
	return defineExtension({
		name: "moonlet-local",
		tools: [
			local("local_read", "Read a text file on the user's machine. Output is capped at 2000 lines or 50 KB; use offset/limit for more.", Type.Object({
				path: Type.String({ description: "File path, relative to the user's directory" }),
				offset: Type.Optional(Type.Number({ description: "Line to start at (1-indexed)" })),
				limit: Type.Optional(Type.Number({ description: "Number of lines" })),
			})),
			local("local_ls", "List a directory on the user's machine.", Type.Object({ path: path("Directory") })),
			local("local_find", "Find files on the user's machine by glob, respecting .gitignore.", Type.Object({
				pattern: Type.String({ description: "Glob, e.g. **/*.ts" }),
				path: path("Directory to search"),
			})),
			local("local_grep", "Search file contents on the user's machine (ripgrep regex), respecting .gitignore.", Type.Object({
				pattern: Type.String({ description: "Regular expression" }),
				path: path("File or directory to search"),
				glob: Type.Optional(Type.String({ description: "Only files matching this glob" })),
				ignoreCase: Type.Optional(Type.Boolean()),
			})),
		],
		sections: [
			section("user-machine", (input) => {
				const cwd = cwdOf(Number(input.conversationId));
				if (!cwd) return undefined;
				return [
					`The user started this task from a pi session in ${cwd} on their own machine.`,
					"The local_read, local_ls, local_find and local_grep tools read files there, read-only, through that session.",
					"Copy what you need into the orb with write. If the user's machine is offline, those tools fail after a wait; carry on without them.",
				].join("\n");
			}),
		],
	});
}

export interface ThreadsOptions {
	store: Store;
	orbs: OrbManager;
	durablePath: string;
	models: Parameters<typeof Harness.open>[1]["models"];
	model: ModelChoice;
	/** Token that lets setup clone private GitHub repositories. */
	gitToken?: string;
	clients: ClientHub;
	portals: Portals;
	services: Services;
	schedules: () => Schedules;
	log: (message: string) => void;
}

export interface ThreadView {
	thread: ThreadRow;
	orb: ReturnType<Store["orb"]>;
	entries: readonly EntryRecord[];
}

/**
 * Threads: one durable pi-durable conversation plus one orb each. The agent loop and its
 * storage run here; every tool call reaches the thread's orb through pi-env.
 */
export class Threads {
	private constructor(
		readonly harness: Harness,
		private readonly options: ThreadsOptions,
		private readonly local: ReturnType<typeof localExtension>,
	) {}

	static async open(options: ThreadsOptions): Promise<Threads> {
		const { store, orbs } = options;
		const registry = createRegistry();
		const Local = localExtension(
			(conversationId, tool, args) => {
				const thread = store.threadByConversation(conversationId);
				if (!thread) return Promise.resolve({ ok: false, text: "unknown thread" });
				return options.clients.call(thread.id, tool, args);
			},
			(conversationId) => store.threadByConversation(conversationId)?.local_cwd ?? undefined,
		);
		const orbOf = (conversationId: number) => {
			const thread = store.threadByConversation(conversationId);
			if (!thread) throw new Error("unknown thread");
			return thread.orb_id;
		};
		const Orb = orbExtension({
			portal: (conversationId, port) => options.portals.create(orbOf(conversationId), port),
			services: (conversationId) => ({ orbId: orbOf(conversationId), services: options.services }),
			threads: () => {
				if (!threads) throw new Error("threads are not open yet");
				return threads;
			},
			schedules: () => options.schedules(),
			threadOf: (conversationId) => {
				const thread = store.threadByConversation(conversationId);
				if (!thread) throw new Error("unknown thread");
				return thread.id;
			},
		});
		// Secret values never reach the model through tool output.
		const mask = masker(store);
		const outputs = [...(CodingTools.tools ?? []), ...(Orb.tools ?? []), ...(Local.tools ?? [])];
		const Redact = defineExtension({ name: "moonlet-redact", wraps: outputs.map((tool) => maskTool(tool, mask)) });
		registry.install(CodingTools);
		registry.install(Orb);
		registry.install(Local);
		registry.install(Redact);
		// Only threads started from a pi session select the local tools.
		const settings: HarnessSettings = { toolExecution: "parallel", extensions: [CodingTools, Orb, Redact] };
		const storage = await openBunSqliteStorage(options.durablePath);
		let threads: Threads | undefined;
		const harness = await Harness.open(
			storage,
			{
				models: options.models,
				registry,
				settings,
				// The first use of a thread's environment starts its orb and sets up the workspace.
				env: async ({ conversationId, cwd }) => {
					const thread = store.threadByConversation(Number(conversationId));
					if (!thread || !threads) return undefined;
					const workspace = await threads.prepare(thread);
					return new RemoteExecutionEnv({
						connection: orbs.connection(thread.orb_id),
						id: `moonlet:${thread.orb_id}`,
						cwd: cwd ?? workspace,
					});
				},
				onReport: (error, info) => options.log(`durable ${info.type}: ${error instanceof Error ? error.message : String(error)}`),
			},
			context,
		);
		threads = new Threads(harness, options, Local);
		harness.resume();
		return threads;
	}

	async create(input: { title?: string; repo?: string; prompt?: string; localCwd?: string; size?: string }): Promise<ThreadRow> {
		if (input.size && !ORB_SIZES[input.size]) throw new Error(`unknown size ${input.size}; sizes: ${Object.keys(ORB_SIZES).join(", ")}`);
		const id = `t-${randomUUID().slice(0, 8)}`;
		const orbId = `moonlet-${id.slice(2)}`;
		const conversation = await this.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model: this.options.model, ...(input.localCwd ? { extensions: { add: [this.local] } } : {}) },
			},
			context,
		);
		this.options.orbs.ensureOrb(orbId);
		// A repository set up recently starts from its snapshot and skips setup.
		const snapshot = input.repo ? this.options.store.snapshot(input.repo, SNAPSHOT_MAX_AGE_MS) : undefined;
		this.options.store.updateOrb(orbId, { size: input.size ?? null, snapshot_id: snapshot?.id ?? null });
		this.options.store.createThread({
			id,
			conversation_id: Number(conversation.id),
			orb_id: orbId,
			title: input.title ?? input.prompt?.slice(0, 60) ?? "Untitled",
			repo: input.repo ?? null,
			local_cwd: input.localCwd ?? null,
		});
		const thread = this.options.store.thread(id)!;
		if (input.prompt) await this.send(id, input.prompt);
		return thread;
	}

	async send(threadId: string, content: string, whenBusy: "steer" | "followUp" = "followUp") {
		const { thread, conversation } = await this.#open(threadId);
		const { orbs, clients } = this.options;
		orbs.busy(thread.orb_id, 1);
		try {
			const submission = await conversation.submit({ type: "input", content, whenBusy, requestId: randomUUID() }, context);
			clients.notify(thread.id, { state: "running" });
			void submission
				.wait(context)
				.catch(() => undefined)
				.finally(async () => {
					orbs.busy(thread.orb_id, -1);
					const status = await this.status(thread.id).catch(() => undefined);
					if (status && !status.running) clients.notify(thread.id, { state: "idle", text: status.lastText });
				});
			return { submissionId: submission.id };
		} catch (error) {
			orbs.busy(thread.orb_id, -1);
			throw error;
		}
	}

	/**
	 * Write a file into the thread's orb: a path relative to its workspace, or absolute. Parents are created. With
	 * `baseline`, a file from the user's machine joins the commit the orb's changes are measured from (while the orb
	 * has no commits of its own), so syncing the changes back does not recreate it.
	 */
	async writeFile(threadId: string, path: string, content: Uint8Array, baseline = false) {
		const { env, target, orbId } = await this.#file(threadId, path);
		const dir = target.slice(0, target.lastIndexOf("/")) || "/";
		const made = await env.exec(["mkdir", "-p", dir], { cwd: "/", timeout: 30 }, context);
		if (!made.ok) throw new Error(made.error.message);
		const written = await env.writeFile(target, content, context);
		if (!written.ok) throw new Error(written.error.message);
		const orb = this.options.store.orb(orbId);
		if (baseline && orb?.workspace && orb.base && target.startsWith(`${orb.workspace}/`)) {
			let output = "";
			const result = await env.exec(
				BASELINE_SCRIPT,
				{ cwd: orb.workspace, env: { BASE: orb.base, FILE: target.slice(orb.workspace.length + 1) }, timeout: 60, onOutput: (text) => void (output += text) },
				context,
			);
			const base = output.match(/^MOONLET_BASE=([0-9a-f]{40})$/m)?.[1];
			if (result.ok && base) this.options.store.updateOrb(orbId, { base });
		}
		return target;
	}

	async readFile(threadId: string, path: string): Promise<Uint8Array> {
		const { env, target } = await this.#file(threadId, path);
		const read = await env.readBinaryFile(target, context);
		if (!read.ok) throw new NotFound(`${path}: ${read.error.message}`);
		return read.value;
	}

	async #file(threadId: string, path: string) {
		const { thread } = await this.#open(threadId);
		const workspace = await this.prepare(thread);
		const target = path.startsWith("/") ? path : `${workspace}/${path}`.replace(/\/\.\//g, "/");
		if (target.split("/").includes("..")) throw new Error("path must not contain ..");
		const env = new RemoteExecutionEnv({ connection: this.options.orbs.connection(thread.orb_id), id: `moonlet:${thread.orb_id}`, cwd: workspace });
		return { env, target, orbId: thread.orb_id };
	}

	async view(threadId: string): Promise<ThreadView> {
		const { thread, conversation } = await this.#open(threadId);
		const view = await conversation.viewState(context);
		try {
			return { thread, orb: this.options.store.orb(thread.orb_id), entries: view.value.entries };
		} finally {
			view.dispose();
		}
	}

	/**
	 * Where a thread is, for clients that check on it: whether a run is in progress, and the steps after the first
	 * `after` entries, condensed to text.
	 */
	async status(threadId: string, after = 0) {
		const { thread } = await this.#open(threadId);
		const stream = await watchEvents(this.harness, thread.conversation_id as never, context);
		try {
			const { entries, run } = stream.snapshot;
			const steps = entries.slice(Math.max(0, after)).flatMap(condense);
			const lastText = [...entries].reverse().flatMap(condense).find((step) => step.kind === "assistant")?.text;
			return {
				thread,
				orb: this.options.store.orb(thread.orb_id),
				running: run !== undefined,
				userMachine: this.options.clients.isAttached(thread.id),
				portals: this.options.portals.list(thread.orb_id),
				services: this.options.services.list(thread.orb_id),
				entries: entries.length,
				steps,
				lastText,
			};
		} finally {
			await stream.stop();
		}
	}

	async events(threadId: string) {
		const { thread } = await this.#open(threadId);
		return watchEvents(this.harness, thread.conversation_id as never, context);
	}

	async abort(threadId: string) {
		const { conversation } = await this.#open(threadId);
		await conversation.abort(context);
	}

	async pause(threadId: string) {
		const { thread } = await this.#open(threadId);
		await this.options.orbs.pause(thread.orb_id, "requested");
	}

	async delete(threadId: string) {
		const { thread, conversation } = await this.#open(threadId);
		await conversation.abort(context).catch(() => {});
		await this.options.orbs.delete(thread.orb_id);
		this.options.portals.removeOrb(thread.orb_id);
		this.options.store.deleteThread(threadId);
	}

	async close() {
		await this.harness.close(context);
	}

	async #open(threadId: string): Promise<{ thread: ThreadRow; conversation: Conversation }> {
		const thread = this.options.store.thread(threadId);
		if (!thread) throw new NotFound(`No thread ${threadId}`);
		const conversation = await this.harness.conversation(thread.conversation_id as never, context);
		if (!conversation) throw new NotFound(`Thread ${threadId} has no conversation`);
		return { thread, conversation };
	}

	readonly #preparing = new Map<string, Promise<string>>();

	/**
	 * First use of an orb: clone the repository, run `.agents/setup`, and point the agent at the
	 * checkout. Resolves to the working directory. Later calls resolve at once.
	 */
	prepare(thread: ThreadRow): Promise<string> {
		const done = this.options.store.orb(thread.orb_id);
		if (done?.setup_done && done.workspace) return Promise.resolve(done.workspace);
		let running = this.#preparing.get(thread.id);
		if (!running) {
			running = this.#open(thread.id)
				.then(({ conversation }) => this.#setup(thread, conversation))
				.finally(() => this.#preparing.delete(thread.id));
			this.#preparing.set(thread.id, running);
		}
		return running;
	}

	async #setup(thread: ThreadRow, conversation: Conversation): Promise<string> {
		const { orbs, store, log } = this.options;
		const started = Date.now();
		await orbs.ensureRunning(thread.orb_id);
		const connection = orbs.connection(thread.orb_id);
		const info = await connection.info();
		const workspace = `${info.home}/workspace`;
		const cwd = thread.repo ? `${workspace}/repo` : workspace;
		const env = new RemoteExecutionEnv({ connection, id: `moonlet:${thread.orb_id}`, cwd: info.home });
		const shellEnv: Record<string, string> = { MOONLET_WORKSPACE: workspace };
		if (thread.repo) shellEnv.MOONLET_REPO = thread.repo;
		if (this.options.gitToken) {
			shellEnv.MOONLET_GIT_AUTH = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${this.options.gitToken}`).toString("base64")}`;
		}
		let output = "";
		const snapshot = store.orb(thread.orb_id)?.snapshot_id;
		const script = snapshot ? REFRESH_SCRIPT : SETUP_SCRIPT;
		if (snapshot) output += `started from snapshot ${snapshot}; skipping setup\n`;
		const result = await env.exec(script, { cwd: info.home, env: shellEnv, timeout: 20 * 60, onOutput: (text) => void (output += text) }, context);
		const exitCode = result.ok ? result.value.exitCode : -1;
		if (!result.ok) output += `\n${result.error.message}`;
		log(`thread ${thread.id}: setup exited ${exitCode} in ${Math.round((Date.now() - started) / 1000)} s`);
		await conversation.configure({ cwd }, context);
		await conversation.submit(
			{ type: "write", entry: { kind: "moonlet.setup", data: { exitCode, output: output.slice(-16_000), cwd } } },
			context,
		);
		// A failed setup is reported but does not block the thread, like Amp's uncached setup.
		const base = output.match(/^MOONLET_BASE=([0-9a-f]{40})$/m)?.[1] ?? null;
		store.updateOrb(thread.orb_id, { setup_done: 1, workspace: cwd, base });
		this.options.services.ensure(thread.orb_id).catch((error) => log(`thread ${thread.id}: services: ${error instanceof Error ? error.message : error}`));
		// After a successful setup, save the orb as the repository's snapshot, in the background.
		if (thread.repo && !snapshot && exitCode === 0) {
			const id = `${thread.orb_id.replace(/^moonlet-/, "")}-${Date.now().toString(36)}`;
			const repo = thread.repo;
			void orbs.snapshot(thread.orb_id, id).then((ok) => ok && store.putSnapshot(repo, id, cwd));
		}
		return cwd;
	}
}

export class NotFound extends Error {}

/** Snapshots older than this are not reused: the repository and its dependencies have moved on. */
const SNAPSHOT_MAX_AGE_MS = 72 * 3600_000;

export interface Step {
	kind: "user" | "assistant" | "tool" | "result" | "setup";
	text: string;
}

type Block = { type: string; text?: string; name?: string; arguments?: unknown };

/** An entry as short text steps; entries that are not part of the dialogue give none. */
function condense(entry: EntryRecord): Step[] {
	const record = entry as unknown as { kind: string; model?: { content?: string | Block[]; isError?: boolean }[]; data?: { exitCode?: number; output?: string } };
	const content = record.model?.[0]?.content;
	const blocks: Block[] = typeof content === "string" ? [{ type: "text", text: content }] : (content ?? []);
	const text = (limit: number) => clip(blocks.map((block) => block.text ?? "").join("").trim(), limit);
	switch (record.kind) {
		case "pi.user":
			return [{ kind: "user", text: text(2000) }];
		case "pi.assistant":
			return blocks.flatMap((block): Step[] => {
				if (block.type === "text" && block.text?.trim()) return [{ kind: "assistant", text: clip(block.text.trim(), 8000) }];
				if (block.type === "toolCall") return [{ kind: "tool", text: `${block.name} ${clip(JSON.stringify(block.arguments), 300)}` }];
				return [];
			});
		case "pi.tool-result":
			return [{ kind: "result", text: `${record.model?.[0]?.isError ? "error: " : ""}${text(600)}` }];
		case "moonlet.setup":
			return [{ kind: "setup", text: `setup exited ${record.data?.exitCode}: ${clip(String(record.data?.output ?? "").trim(), 600)}` }];
		default:
			return [];
	}
}

function clip(text: string, limit: number) {
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Add an uploaded file to the base commit, if the orb has not committed anything since it. */
const BASELINE_SCRIPT = `[ "$(git rev-parse HEAD)" = "$BASE" ] || exit 0
index=$(mktemp); trap 'rm -f "$index"' EXIT
GIT_INDEX_FILE="$index" git read-tree "$BASE"
GIT_INDEX_FILE="$index" git add -f -- "$FILE"
commit=$(git commit-tree "$(GIT_INDEX_FILE="$index" git write-tree)" -p "$BASE" -m "moonlet: files from the user's machine")
git update-ref HEAD "$commit" && git reset -q && echo "MOONLET_BASE=$commit"
`;

/** For an orb started from a snapshot: bring the checkout up to date instead of setting up again. */
const REFRESH_SCRIPT = `cd "$MOONLET_WORKSPACE" && [ -d repo ] && cd repo
git fetch -q origin 2>&1 && git merge -q --ff-only "@{upstream}" 2>&1 || echo "could not fast-forward; using the snapshot's checkout"
echo "MOONLET_BASE=$(git rev-parse HEAD)"
`;

const SETUP_SCRIPT = `set -u
mkdir -p "$MOONLET_WORKSPACE"
cd "$MOONLET_WORKSPACE"
if [ -n "\${MOONLET_REPO:-}" ] && [ ! -d repo/.git ]; then
	echo "cloning $MOONLET_REPO"
	if [ -n "\${MOONLET_GIT_AUTH:-}" ]; then
		git -c "http.https://github.com/.extraheader=$MOONLET_GIT_AUTH" clone "$MOONLET_REPO" repo || exit 1
	else
		git clone "$MOONLET_REPO" repo || exit 1
	fi
fi
[ -d repo ] && cd repo
# Every workspace is a git repository, so the orb's changes can be shown and synced.
git config --global user.name >/dev/null || git config --global user.name "moonlet"
git config --global user.email >/dev/null || git config --global user.email "moonlet@localhost"
if ! git rev-parse --git-dir >/dev/null 2>&1; then
	git init -q && git commit -q --allow-empty -m "moonlet: start"
fi
echo "MOONLET_BASE=$(git rev-parse HEAD)"
if [ -x .agents/setup ]; then
	echo "running .agents/setup"
	./.agents/setup
elif [ -f .agents/setup ]; then
	echo "running .agents/setup"
	bash .agents/setup
fi
`;
