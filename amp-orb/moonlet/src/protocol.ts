/**
 * Wire protocol between the control plane and an orb.
 *
 * The orb only ever dials out. `moonlet bootstrap` keeps one control WebSocket open to
 * `/orb/connect`. When the control plane needs the orb's environment, it asks for a pipe:
 * the bootstrap starts `pi-env <args>` and dials `/orb/pipe/<pipeId>`, then copies the
 * daemon's stdio to and from that socket as binary messages. On the control plane, the
 * pipe is spliced to a `moonlet relay` process that pi-env's `Connection` spawned, so
 * pi-env's own framed protocol runs end to end and moonlet never parses it.
 *
 * WebSockets authenticate with a subprotocol, because the WebSocket constructor in
 * browsers and Node cannot set headers: the client offers `[PROTOCOL, AUTH_PREFIX + token]`
 * and the server answers with `PROTOCOL`.
 */

export const PROTOCOL = "moonlet.v1";
export const AUTH_PREFIX = "moonlet.auth.";
export const VERSION = "0.1.0";

/** Orb → control plane, on the control socket. */
export type OrbMessage =
	| {
			type: "hello";
			orbId: string;
			version: string;
			hostname: string;
			user: string;
			home: string;
			piEnv: string;
	  }
	| { type: "pipe-failed"; pipeId: string; error: string }
	| { type: "ping" };

/** Control plane → orb, on the control socket. */
export type ServerMessage =
	| { type: "welcome"; orbId: string; generation: number }
	/** Start pi-env with `args` and pipe its stdio; `env` (secrets and env vars) is added to its environment. */
	| { type: "open-pipe"; pipeId: string; args: string[]; env?: Record<string, string> }
	/** Connect a pipe to this TCP port on the orb's loopback, for a portal. */
	| { type: "open-port"; pipeId: string; port: number }
	| { type: "shutdown"; reason: string }
	| { type: "ping" };

export function authProtocols(token: string): string[] {
	return [PROTOCOL, AUTH_PREFIX + token];
}

/** The token offered in a `Sec-WebSocket-Protocol` header, if any. */
export function tokenFromProtocols(header: string | null): string | undefined {
	if (header === null) return undefined;
	for (const value of header.split(",")) {
		const trimmed = value.trim();
		if (trimmed.startsWith(AUTH_PREFIX)) return trimmed.slice(AUTH_PREFIX.length);
	}
	return undefined;
}

/**
 * A user's client (the pi extension) holds one socket to `/api/client` while its session is open. Threads it
 * started can then read files on the user's machine through it (`local_*` tools), and it hears when they finish.
 */
export type LocalTool = "local_read" | "local_ls" | "local_find" | "local_grep";

/** Client → control plane. */
export type ClientMessage =
	| { type: "attach"; threads: string[]; host: string; cwd: string }
	| { type: "tool-result"; id: string; ok: boolean; text: string }
	| { type: "ping" };

/** Control plane → client. */
export type HubMessage =
	| { type: "tool-request"; id: string; thread: string; tool: LocalTool; args: Record<string, unknown> }
	| { type: "thread-update"; thread: string; state: "running" | "idle"; text?: string }
	| { type: "ping" };

/** Environment variables of a dispatch job. The names match Amp's self-hosted orb contract. */
export interface DispatchEnv {
	/** `snapshot` (moonlet) saves the orb's disk as ORB_SNAPSHOT_ID without stopping it; programs may not support it. */
	ORB_OPERATION: "spawn" | "pause" | "delete" | "snapshot";
	ORB_ID: string;
	ORB_IMAGE: string;
	ORB_SNAPSHOT_ID?: string;
	ORB_TOKEN?: string;
	/** The control plane's public URL. Amp's equivalent is AMP_URL. */
	ORB_SERVER_URL?: string;
	/** What to run inside the orb, as the image's default user, detached. Amp's equivalent is `amp orb bootstrap`. */
	ORB_BOOTSTRAP?: string;
	/** Resources (moonlet): CPUs and memory such as `4G`. */
	ORB_CPUS?: string;
	ORB_MEMORY?: string;
	/** Pause depth (moonlet): `freeze` keeps processes and memory, `stop` keeps only the disk. */
	ORB_PAUSE?: "freeze" | "stop";
}

export interface ProviderJob {
	id: string;
	env: DispatchEnv;
}

export interface JobResult {
	ok: boolean;
	exitCode: number | null;
	output: string;
}
