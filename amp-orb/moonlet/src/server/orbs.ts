import { randomUUID } from "node:crypto";
import { Connection, type RemoteTerminal } from "@earendil-works/pi-env";
import type { ServerWebSocket } from "bun";
import type { DispatchEnv, JobResult, OrbMessage, ServerMessage } from "../protocol.ts";
import { issueOrbToken, verifyOrbToken } from "../tokens.ts";
import type { JobRow, OrbRow, Store } from "./store.ts";

export type SocketData =
	| { kind: "control"; orbId: string; generation: number; hello: boolean }
	| { kind: "pipe"; orbId: string; pipeId: string }
	| { kind: "relay"; orbId: string; pipeId: string; args: string[] }
	| { kind: "client"; threads: Set<string>; host: string }
	| { kind: "terminal"; threadId: string; orbId?: string; cols: number; rows: number; terminal?: RemoteTerminal; pending: Uint8Array[] };

type Socket = ServerWebSocket<SocketData>;

export interface OrbManagerOptions {
	store: Store;
	secret: string;
	/** URL orbs dial, e.g. https://moonlet.example.com. */
	publicUrl: string;
	image: string;
	/** Shell command the dispatch program runs inside the orb. */
	bootstrap: string;
	/** How long an idle orb stays running before it is paused. */
	idleMs: number;
	/** How long a spawn may take before the waiting call fails. */
	spawnTimeoutMs: number;
	/** argv that starts `moonlet relay` (pi-env appends `serve --token <hex>`). */
	relayCommand: (orbId: string) => string[];
	/** Environment for the orb's pi-env daemons: secrets and env vars. */
	pipeEnv: (orbId: string) => Record<string, string>;
	log: (message: string) => void;
}

/** The control plane's end of a pipe: a `moonlet relay` socket, or a portal's TCP connection. */
export interface PipePeer {
	send(data: Uint8Array): void;
	close(code?: number, reason?: string): void;
}

interface Pipe {
	orbId: string;
	peer: PipePeer;
	orb?: Socket;
	buffered: Uint8Array[];
	timer: ReturnType<typeof setTimeout>;
	/** Count pi-env's pings as idle; a portal's traffic is always activity. */
	pings: boolean;
}

const SPAWN_BACKOFF_MS = 15_000;

/** Orb sizes: CPUs and memory a dispatch program gives the machine. */
export const ORB_SIZES: Record<string, { cpus: string; memory: string }> = {
	small: { cpus: "1", memory: "2G" },
	medium: { cpus: "2", memory: "4G" },
	large: { cpus: "4", memory: "8G" },
	xlarge: { cpus: "4", memory: "14G" },
};

/** A frozen orb keeps its memory; after this long it is stopped, keeping only its disk. */
const DEEP_PAUSE_MS = Number(process.env.MOONLET_DEEP_PAUSE_MINUTES ?? 120) * 60_000;

/** Frames of pi-env pings are 15 bytes; anything larger is real work and keeps the orb awake. */
const PING_FRAME_BYTES = 15;

/**
 * Lifecycle of orbs: spawn, pause and delete through dispatch jobs; the control sockets
 * of connected orbs; pipes between pi-env connections and orbs; and idle pausing.
 */
export class OrbManager {
	readonly #options: OrbManagerOptions;
	readonly #store: Store;
	readonly #control = new Map<string, Socket>();
	readonly #connectWaiters = new Map<string, Set<PromiseWithResolvers<void>>>();
	readonly #spawning = new Map<string, Promise<void>>();
	/** The last failed spawn per orb; calls within SPAWN_BACKOFF_MS get its error instead of another attempt. */
	readonly #failed = new Map<string, { at: number; error: Error }>();
	readonly #jobWaiters = new Map<string, PromiseWithResolvers<JobRow>>();
	readonly #claimWaiters = new Set<() => void>();
	readonly #pipes = new Map<string, Pipe>();
	readonly #connections = new Map<string, Connection>();
	readonly #busy = new Map<string, number>();
	readonly #lastActive = new Map<string, number>();
	readonly #idleTimer: ReturnType<typeof setInterval>;
	readonly #connectListeners = new Set<(orbId: string) => void>();

	constructor(options: OrbManagerOptions) {
		this.#options = options;
		this.#store = options.store;
		this.#idleTimer = setInterval(() => void this.#pauseIdle(), 15_000);
		// Orbs that were connected before a restart reconnect on their own; others resume on demand.
		setInterval(() => this.#store.requeueStale(10 * 60_000), 60_000).unref();
	}

	close() {
		clearInterval(this.#idleTimer);
		for (const connection of this.#connections.values()) void connection.close();
	}

	/** Call `listener` each time an orb's bootstrap says hello: after a spawn, a resume, or a reconnect. */
	onConnect(listener: (orbId: string) => void) {
		this.#connectListeners.add(listener);
	}

	ensureOrb(orbId: string): OrbRow {
		return this.#store.upsertOrb(orbId, this.#options.image);
	}

	isConnected(orbId: string) {
		const socket = this.#control.get(orbId);
		return socket !== undefined && socket.data.kind === "control" && socket.data.hello;
	}

	/** pi-env connection to the orb. It starts the orb on its first request after a pause. */
	connection(orbId: string): Connection {
		let connection = this.#connections.get(orbId);
		if (connection === undefined) {
			connection = new Connection({
				command: async () => {
					await this.ensureRunning(orbId);
					return this.#options.relayCommand(orbId);
				},
				onLog: (text) => this.#options.log(`[pi-env ${orbId}] ${text.trim()}`),
			});
			this.#connections.set(orbId, connection);
		}
		return connection;
	}

	/**
	 * Drop the pi-env connections of orbs with no work in progress, so their next tool call starts a daemon with the
	 * current secrets. Busy orbs pick them up after their run.
	 */
	refreshEnv() {
		for (const [orbId, connection] of this.#connections) {
			if ((this.#busy.get(orbId) ?? 0) > 0) continue;
			this.#connections.delete(orbId);
			void Promise.resolve(connection.close()).catch(() => {});
		}
	}

	/** Mark work in progress on the orb's thread; an orb is never paused while busy. */
	busy(orbId: string, delta: 1 | -1) {
		this.#busy.set(orbId, Math.max(0, (this.#busy.get(orbId) ?? 0) + delta));
		this.#lastActive.set(orbId, Date.now());
	}

	touch(orbId: string) {
		this.#lastActive.set(orbId, Date.now());
	}

	/** Resolve once the orb's bootstrap is connected, spawning or resuming it if needed. */
	async ensureRunning(orbId: string): Promise<void> {
		this.touch(orbId);
		if (this.isConnected(orbId)) return;
		const row = this.ensureOrb(orbId);
		if (row.status === "deleted" || row.status === "deleting") throw new Error(`Orb ${orbId} is deleted`);
		const failed = this.#failed.get(orbId);
		if (failed && Date.now() - failed.at < SPAWN_BACKOFF_MS) throw failed.error;
		let spawning = this.#spawning.get(orbId);
		if (spawning === undefined) {
			spawning = this.#spawn(orbId, row)
				.then(
					() => void this.#failed.delete(orbId),
					(error: Error) => {
						this.#failed.set(orbId, { at: Date.now(), error });
						throw error;
					},
				)
				.finally(() => this.#spawning.delete(orbId));
			this.#spawning.set(orbId, spawning);
		}
		await spawning;
	}

	async #spawn(orbId: string, row: OrbRow) {
		// A running orb whose socket dropped is probably reconnecting; give it a moment first.
		if (row.status === "running" && (await this.#waitConnected(orbId, 20_000).then(() => true, () => false))) return;
		// A pause in flight must finish before the orb can resume.
		await this.#waitForOrbJobs(orbId);
		const generation = row.generation + 1;
		const token = issueOrbToken(this.#options.secret, { orb: orbId, gen: generation, exp: Date.now() + 24 * 3600_000 });
		this.#store.updateOrb(orbId, { status: "spawning", generation, last_error: null });
		this.#log(orbId, `spawning (generation ${generation})`);
		const connected = this.#waitConnected(orbId, this.#options.spawnTimeoutMs);
		const job = this.#enqueue(orbId, {
			ORB_OPERATION: "spawn",
			ORB_ID: orbId,
			ORB_IMAGE: row.image,
			ORB_TOKEN: token,
			ORB_SERVER_URL: this.#options.publicUrl,
			ORB_BOOTSTRAP: this.#options.bootstrap,
			...this.#resources(row),
			...(row.snapshot_id ? { ORB_SNAPSHOT_ID: row.snapshot_id } : {}),
		});
		const failed = this.waitForJob(job.id).then((done) => {
			if (done.status === "failed") throw new Error(`spawn failed: ${(done.output ?? "").trim().slice(-2000)}`);
			// A successful spawn still has to connect; keep waiting for that.
			return connected;
		});
		try {
			await Promise.race([connected, failed]);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#store.updateOrb(orbId, { status: "error", last_error: message });
			throw error;
		}
	}

	#resources(row: OrbRow): Partial<DispatchEnv> {
		const size = ORB_SIZES[row.size ?? ""];
		return size ? { ORB_CPUS: size.cpus, ORB_MEMORY: size.memory } : {};
	}

	/**
	 * Pause an orb. It is first frozen (processes and memory kept, so dev servers and terminals carry on after a
	 * resume); `#pauseIdle` stops frozen orbs after DEEP_PAUSE_MS. Dispatch programs without freezing just pause.
	 */
	async pause(orbId: string, reason: string, depth: "freeze" | "stop" = "freeze") {
		const row = this.#store.orb(orbId);
		if (!row || !["running", "spawning", "error"].includes(row.status)) return;
		this.#log(orbId, `pausing (${reason}, ${depth})`);
		this.#store.updateOrb(orbId, { status: "pausing" });
		await this.#disconnect(orbId, "pausing");
		const job = this.#enqueue(orbId, { ORB_OPERATION: "pause", ORB_ID: orbId, ORB_IMAGE: row.image, ORB_PAUSE: depth });
		const done = await this.waitForJob(job.id);
		this.#store.updateOrb(
			orbId,
			done.status === "done" ? { status: "paused", paused_at: Date.now(), pause_depth: depth } : { status: "error", last_error: done.output },
		);
	}

	/** Stop an orb that has been frozen too long; it stays paused. */
	async #deepen(orbId: string) {
		const row = this.#store.orb(orbId);
		if (!row || row.status !== "paused" || row.pause_depth !== "freeze") return;
		this.#store.updateOrb(orbId, { pause_depth: "stop" });
		this.#log(orbId, "frozen too long; stopping it");
		const job = this.#enqueue(orbId, { ORB_OPERATION: "pause", ORB_ID: orbId, ORB_IMAGE: row.image, ORB_PAUSE: "stop" });
		const done = await this.waitForJob(job.id);
		if (done.status !== "done") this.#store.updateOrb(orbId, { pause_depth: "freeze" });
	}

	/** Save the orb's disk as a snapshot that new orbs can start from. Resolves to whether it worked. */
	async snapshot(orbId: string, snapshotId: string): Promise<boolean> {
		const row = this.#store.orb(orbId);
		if (!row) return false;
		const job = this.#enqueue(orbId, { ORB_OPERATION: "snapshot", ORB_ID: orbId, ORB_IMAGE: row.image, ORB_SNAPSHOT_ID: snapshotId });
		const done = await this.waitForJob(job.id);
		this.#log(orbId, `snapshot ${snapshotId}: ${done.status}`);
		return done.status === "done";
	}

	async delete(orbId: string) {
		const row = this.#store.orb(orbId);
		if (!row || row.status === "deleted") return;
		this.#log(orbId, "deleting");
		this.#store.updateOrb(orbId, { status: "deleting" });
		await this.#disconnect(orbId, "deleting");
		const job = this.#enqueue(orbId, { ORB_OPERATION: "delete", ORB_ID: orbId, ORB_IMAGE: row.image });
		const done = await this.waitForJob(job.id);
		this.#store.updateOrb(orbId, done.status === "done" ? { status: "deleted" } : { status: "error", last_error: done.output });
	}

	async #disconnect(orbId: string, reason: string) {
		const connection = this.#connections.get(orbId);
		this.#connections.delete(orbId);
		await Promise.resolve(connection?.close()).catch(() => {});
		const socket = this.#control.get(orbId);
		if (socket) {
			this.#control.delete(orbId);
			socket.send(JSON.stringify({ type: "shutdown", reason } satisfies ServerMessage));
			socket.close(4409, reason);
		}
	}

	async #pauseIdle() {
		const now = Date.now();
		for (const row of this.#store.orbs()) {
			if (row.status === "paused" && row.pause_depth === "freeze" && now - (row.paused_at ?? now) > DEEP_PAUSE_MS) {
				await this.#deepen(row.id).catch((error) => this.#log(row.id, `stop failed: ${error}`));
			}
		}
		for (const orbId of this.#control.keys()) {
			if ((this.#busy.get(orbId) ?? 0) > 0) continue;
			if (this.#spawning.has(orbId)) continue;
			const last = this.#lastActive.get(orbId) ?? 0;
			if (now - last < this.#options.idleMs) continue;
			await this.pause(orbId, `idle for ${Math.round((now - last) / 1000)} s`).catch((error) =>
				this.#log(orbId, `pause failed: ${error}`),
			);
		}
	}

	#waitConnected(orbId: string, timeoutMs: number): Promise<void> {
		if (this.isConnected(orbId)) return Promise.resolve();
		const waiter = Promise.withResolvers<void>();
		let waiters = this.#connectWaiters.get(orbId);
		if (!waiters) this.#connectWaiters.set(orbId, (waiters = new Set()));
		waiters.add(waiter);
		const timer = setTimeout(() => waiter.reject(new Error(`orb ${orbId} did not connect within ${timeoutMs / 1000} s`)), timeoutMs);
		return waiter.promise.finally(() => {
			clearTimeout(timer);
			waiters.delete(waiter);
		});
	}

	async #waitForOrbJobs(orbId: string) {
		for (const job of this.#store.recentJobs(orbId, 5)) {
			if (job.status === "queued" || job.status === "claimed") await this.waitForJob(job.id);
		}
	}

	// Jobs ----------------------------------------------------------------------------------

	#enqueue(orbId: string, env: DispatchEnv): JobRow {
		const job = this.#store.enqueueJob(orbId, env);
		for (const wake of this.#claimWaiters) wake();
		return job;
	}

	waitForJob(jobId: string): Promise<JobRow> {
		const job = this.#store.job(jobId);
		if (job && (job.status === "done" || job.status === "failed")) return Promise.resolve(job);
		let waiter = this.#jobWaiters.get(jobId);
		if (!waiter) this.#jobWaiters.set(jobId, (waiter = Promise.withResolvers<JobRow>()));
		return waiter.promise;
	}

	/** Long-poll for the next job, for providers. */
	async claim(timeoutMs: number): Promise<JobRow | undefined> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const job = this.#store.claimJob();
			if (job) return job;
			const remaining = deadline - Date.now();
			if (remaining <= 0) return undefined;
			await new Promise<void>((resolve) => {
				const wake = () => {
					clearTimeout(timer);
					this.#claimWaiters.delete(wake);
					resolve();
				};
				const timer = setTimeout(wake, remaining);
				this.#claimWaiters.add(wake);
			});
		}
	}

	complete(jobId: string, result: JobResult) {
		const job = this.#store.job(jobId);
		if (!job || job.status !== "claimed") return;
		this.#store.finishJob(jobId, result);
		const finished = this.#store.job(jobId)!;
		this.#log(job.orb_id, `${job.operation} ${result.ok ? "done" : "failed"}${result.exitCode === null ? "" : ` (exit ${result.exitCode})`}`);
		this.#jobWaiters.get(jobId)?.resolve(finished);
		this.#jobWaiters.delete(jobId);
		// The next job of this orb may now be claimable.
		for (const wake of this.#claimWaiters) wake();
	}

	// Sockets -------------------------------------------------------------------------------

	/** Verify an orb's token for an upgrade; the generation must be the current one. */
	authorizeOrb(token: string | undefined): { orbId: string; generation: number } | undefined {
		if (!token) return undefined;
		const claims = verifyOrbToken(this.#options.secret, token);
		if (!claims) return undefined;
		const row = this.#store.orb(claims.orb);
		if (!row || row.generation !== claims.gen || row.status === "deleted" || row.status === "deleting") return undefined;
		return { orbId: claims.orb, generation: claims.gen };
	}

	hasPipe(pipeId: string, orbId: string) {
		return this.#pipes.get(pipeId)?.orbId === orbId;
	}

	onOpen(socket: Socket) {
		const data = socket.data;
		if (data.kind === "control") {
			const previous = this.#control.get(data.orbId);
			if (previous && previous !== socket) previous.close(4409, "replaced");
			this.#control.set(data.orbId, socket);
		} else if (data.kind === "relay") {
			void this.#openPipe(socket, data);
		} else if (data.kind === "pipe") {
			const pipe = this.#pipes.get(data.pipeId);
			if (!pipe || pipe.orb) {
				socket.close(4404, "unknown pipe");
				return;
			}
			pipe.orb = socket;
			clearTimeout(pipe.timer);
			for (const chunk of pipe.buffered.splice(0)) socket.send(chunk);
		}
	}

	onMessage(socket: Socket, message: string | Buffer) {
		const data = socket.data;
		if (data.kind === "control") {
			if (typeof message !== "string") return;
			let parsed: OrbMessage;
			try {
				parsed = JSON.parse(message);
			} catch {
				return;
			}
			if (parsed.type === "hello") {
				data.hello = true;
				this.#store.updateOrb(data.orbId, { status: "running", last_error: null });
				this.touch(data.orbId);
				this.#log(data.orbId, `connected: ${parsed.user}@${parsed.hostname} (bootstrap ${parsed.version})`);
				socket.send(JSON.stringify({ type: "welcome", orbId: data.orbId, generation: data.generation } satisfies ServerMessage));
				for (const waiter of this.#connectWaiters.get(data.orbId) ?? []) waiter.resolve();
				for (const listener of this.#connectListeners) listener(data.orbId);
			} else if (parsed.type === "pipe-failed") {
				this.#pipes.get(parsed.pipeId)?.peer.close(4500, `orb could not open the pipe: ${parsed.error}`.slice(0, 120));
			}
		} else if (data.kind === "relay") {
			const pipe = this.#pipes.get(data.pipeId);
			if (pipe && typeof message !== "string") this.#toOrb(pipe, message);
		} else if (data.kind === "pipe") {
			const pipe = this.#pipes.get(data.pipeId);
			if (pipe && typeof message !== "string") pipe.peer.send(message);
		}
	}

	onClose(socket: Socket, code: number, reason: string) {
		const data = socket.data;
		if (data.kind === "control") {
			if (this.#control.get(data.orbId) === socket) {
				this.#control.delete(data.orbId);
				this.#log(data.orbId, `control socket closed (${code}${reason ? ` ${reason}` : ""})`);
			}
		} else if (data.kind === "relay") {
			this.#closePipe(data.pipeId, "peer");
		} else if (data.kind === "pipe") {
			this.#closePipe(data.pipeId, "orb");
		}
	}

	/** Close a pipe from one end: the other end closes too. */
	#closePipe(pipeId: string, from: "peer" | "orb") {
		const pipe = this.#pipes.get(pipeId);
		if (!pipe) return;
		this.#pipes.delete(pipeId);
		clearTimeout(pipe.timer);
		if (from === "orb") pipe.peer.close(1000);
		else pipe.orb?.close(1000);
	}

	#toOrb(pipe: Pipe, data: Uint8Array) {
		if (!pipe.pings || data.byteLength > PING_FRAME_BYTES) this.touch(pipe.orbId);
		if (pipe.orb) pipe.orb.send(data);
		else pipe.buffered.push(new Uint8Array(data));
	}

	/**
	 * Ask the orb for a pipe: it dials `/orb/pipe/<pipeId>` back and connects it to `request` (pi-env, or a port on
	 * its loopback). Starts the orb first if needed. Failures close `pipe.peer`.
	 */
	async #requestPipe(pipeId: string, pipe: Pipe, request: Extract<ServerMessage, { type: "open-pipe" | "open-port" }>) {
		this.#pipes.set(pipeId, pipe);
		try {
			await this.ensureRunning(pipe.orbId);
		} catch (error) {
			this.#pipes.delete(pipeId);
			clearTimeout(pipe.timer);
			pipe.peer.close(4503, String(error instanceof Error ? error.message : error).slice(0, 120));
			return;
		}
		const control = this.#control.get(pipe.orbId);
		if (!control) {
			this.#pipes.delete(pipeId);
			clearTimeout(pipe.timer);
			pipe.peer.close(4503, "orb is not connected");
			return;
		}
		control.send(JSON.stringify(request satisfies ServerMessage));
	}

	#newPipe(orbId: string, peer: PipePeer, pings: boolean): Pipe {
		return { orbId, peer, buffered: [], pings, timer: setTimeout(() => peer.close(4504, "orb did not open the pipe"), 30_000) };
	}

	async #openPipe(relay: Socket, data: Extract<SocketData, { kind: "relay" }>) {
		const peer: PipePeer = { send: (bytes) => relay.send(bytes), close: (code, reason) => relay.close(code, reason) };
		await this.#requestPipe(data.pipeId, this.#newPipe(data.orbId, peer, true), {
			type: "open-pipe",
			pipeId: data.pipeId,
			args: data.args,
			env: this.#options.pipeEnv(data.orbId),
		});
	}

	/**
	 * A byte stream to `port` on the orb's loopback, for portals. Bytes from the orb go to `peer`; the returned
	 * handle sends bytes to the orb (buffered until the orb connects) and closes the stream.
	 */
	openPort(orbId: string, port: number, peer: PipePeer): { send(data: Uint8Array): void; close(): void } {
		const pipeId = randomUUID();
		const pipe = this.#newPipe(orbId, peer, false);
		void this.#requestPipe(pipeId, pipe, { type: "open-port", pipeId, port });
		return { send: (data) => this.#toOrb(pipe, data), close: () => this.#closePipe(pipeId, "peer") };
	}

	newPipeId() {
		return randomUUID();
	}

	#log(orbId: string, message: string) {
		this.#options.log(`orb ${orbId}: ${message}`);
	}
}
