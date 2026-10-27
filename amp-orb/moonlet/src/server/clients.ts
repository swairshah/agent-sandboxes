import { randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import type { ClientMessage, HubMessage, LocalTool } from "../protocol.ts";
import type { SocketData } from "./orbs.ts";

type Socket = ServerWebSocket<SocketData>;

/** How long one tool request may take once a client has it. */
const REQUEST_TIMEOUT_MS = 2 * 60_000;

interface Pending {
	socket: Socket;
	resolve: (result: LocalResult | "disconnected") => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface LocalResult {
	ok: boolean;
	text: string;
}

/**
 * The clients of users' machines: pi sessions that started threads. A thread's `local_*` tool calls go to a client
 * that attached the thread; with none attached, a call waits for one up to `waitMs`, then fails so the agent can
 * carry on. Requests are not durable: a call cut off by a restart reruns (the tools are replay-safe).
 */
export class ClientHub {
	readonly #clients = new Set<Socket>();
	readonly #pending = new Map<string, Pending>();
	readonly #attachWaiters = new Map<string, Set<() => void>>();

	constructor(
		private readonly waitMs: number,
		private readonly log: (message: string) => void,
	) {}

	onOpen(socket: Socket) {
		this.#clients.add(socket);
	}

	onMessage(socket: Socket, message: string | Buffer) {
		const data = socket.data;
		if (data.kind !== "client" || typeof message !== "string") return;
		let parsed: ClientMessage;
		try {
			parsed = JSON.parse(message);
		} catch {
			return;
		}
		if (parsed.type === "attach") {
			data.threads = new Set(parsed.threads);
			data.host = parsed.host;
			this.log(`client ${parsed.host} attached ${parsed.threads.length} thread(s)`);
			for (const thread of parsed.threads) for (const wake of this.#attachWaiters.get(thread) ?? []) wake();
		} else if (parsed.type === "tool-result") {
			const pending = this.#pending.get(parsed.id);
			if (pending?.socket !== socket) return;
			this.#pending.delete(parsed.id);
			clearTimeout(pending.timer);
			pending.resolve({ ok: parsed.ok, text: parsed.text });
		} else if (parsed.type === "ping") {
			socket.send(JSON.stringify({ type: "ping" } satisfies HubMessage));
		}
	}

	onClose(socket: Socket) {
		this.#clients.delete(socket);
		for (const [id, pending] of this.#pending) {
			if (pending.socket !== socket) continue;
			this.#pending.delete(id);
			clearTimeout(pending.timer);
			pending.resolve("disconnected");
		}
	}

	isAttached(thread: string) {
		return this.#clientFor(thread) !== undefined;
	}

	/** Run a local tool on a client of `thread`, waiting for one to attach if none is. */
	async call(thread: string, tool: LocalTool, args: Record<string, unknown>): Promise<LocalResult> {
		const deadline = Date.now() + this.waitMs;
		for (;;) {
			const socket = this.#clientFor(thread);
			if (socket === undefined) {
				if (await this.#waitForClient(thread, deadline - Date.now())) continue;
				return {
					ok: false,
					text: `The user's machine is offline: no pi session for this thread connected within ${Math.round(this.waitMs / 60_000)} min. Carry on without it, and say what you could not read.`,
				};
			}
			const result = await this.#request(socket, thread, tool, args);
			if (result !== "disconnected") return result;
		}
	}

	/** Tell the clients of `thread` about a run starting or ending. */
	notify(thread: string, update: Omit<Extract<HubMessage, { type: "thread-update" }>, "type" | "thread">) {
		const message = JSON.stringify({ type: "thread-update", thread, ...update } satisfies HubMessage);
		for (const socket of this.#clients) {
			if (socket.data.kind === "client" && socket.data.threads.has(thread)) socket.send(message);
		}
	}

	#clientFor(thread: string): Socket | undefined {
		let found: Socket | undefined;
		// The most recent client wins: a reopened session replaces one that has not noticed it is gone.
		for (const socket of this.#clients) if (socket.data.kind === "client" && socket.data.threads.has(thread)) found = socket;
		return found;
	}

	#request(socket: Socket, thread: string, tool: LocalTool, args: Record<string, unknown>) {
		const id = randomUUID();
		return new Promise<LocalResult | "disconnected">((resolve) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				resolve({ ok: false, text: `${tool} timed out on the user's machine` });
			}, REQUEST_TIMEOUT_MS);
			this.#pending.set(id, { socket, resolve, timer });
			socket.send(JSON.stringify({ type: "tool-request", id, thread, tool, args } satisfies HubMessage));
		});
	}

	#waitForClient(thread: string, timeoutMs: number): Promise<boolean> {
		if (timeoutMs <= 0) return Promise.resolve(false);
		return new Promise((resolve) => {
			let waiters = this.#attachWaiters.get(thread);
			if (!waiters) this.#attachWaiters.set(thread, (waiters = new Set()));
			const done = (attached: boolean) => {
				clearTimeout(timer);
				waiters.delete(wake);
				if (waiters.size === 0) this.#attachWaiters.delete(thread);
				resolve(attached);
			};
			const wake = () => done(true);
			const timer = setTimeout(() => done(false), timeoutMs);
			waiters.add(wake);
		});
	}
}
