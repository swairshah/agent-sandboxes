/**
 * `moonlet bootstrap`: the process that runs inside an orb.
 *
 * It holds one outbound control socket to the control plane and, on request, starts the
 * pi-env daemon and pipes its stdio over a second outbound socket. It runs no agent code:
 * the agent loop, its storage and its model credentials stay on the control plane.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { authProtocols, type OrbMessage, type ServerMessage, VERSION } from "./protocol.ts";

/** Close codes after which reconnecting cannot help. */
const FATAL_CLOSE = new Set([4401, 4409]);

function log(message: string) {
	console.log(`${new Date().toISOString()} ${message}`);
}

function wsUrl(server: string, path: string) {
	const url = new URL(path, server);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}

function findPiEnv(): string {
	const candidates = [process.env.MOONLET_PI_ENV, join(homedir(), ".moonlet", "bin", "pi-env"), "/usr/local/bin/pi-env"];
	for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
	throw new Error("pi-env daemon not found; set MOONLET_PI_ENV or install it to ~/.moonlet/bin/pi-env");
}

function openPipe(server: string, token: string, piEnv: string, pipeId: string, args: string[], env: Record<string, string>, report: (m: OrbMessage) => void) {
	// Everything the agent runs inherits this environment; the values are never written to disk.
	const child = spawn(piEnv, args, { cwd: homedir(), stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
	const socket = new WebSocket(wsUrl(server, `/orb/pipe/${pipeId}`), authProtocols(token));
	socket.binaryType = "arraybuffer";
	const pending: Buffer[] = [];
	let closed = false;

	const close = (reason: string) => {
		if (closed) return;
		closed = true;
		log(`pipe ${pipeId} closed: ${reason}`);
		child.stdin.end();
		// pi-env exits when stdin ends; make sure of it.
		setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
		if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
	};

	child.stdout.on("data", (chunk: Buffer) => {
		if (socket.readyState === WebSocket.OPEN) socket.send(chunk);
		else pending.push(chunk);
	});
	child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
	child.on("error", (error) => {
		report({ type: "pipe-failed", pipeId, error: error.message });
		close(`spawn failed: ${error.message}`);
	});
	child.on("exit", (code) => close(`pi-env exited with ${code}`));
	child.stdin.on("error", () => {});

	socket.addEventListener("open", () => {
		for (const chunk of pending.splice(0)) socket.send(chunk);
	});
	socket.addEventListener("message", (event) => {
		const data = event.data;
		if (data instanceof ArrayBuffer) child.stdin.write(Buffer.from(data));
		else if (typeof data === "string") child.stdin.write(data);
	});
	socket.addEventListener("close", () => close("socket closed"));
	socket.addEventListener("error", () => close("socket error"));
}

/**
 * A portal connection: a TCP connection to `port` on this machine's loopback (IPv4, then IPv6), piped over a
 * socket to `/orb/pipe/<pipeId>`. The service only needs to listen on 127.0.0.1.
 */
function openPort(server: string, token: string, pipeId: string, port: number, report: (m: OrbMessage) => void) {
	const socket = new WebSocket(wsUrl(server, `/orb/pipe/${pipeId}`), authProtocols(token));
	socket.binaryType = "arraybuffer";
	const toSocket: Buffer[] = [];
	const toPort: Buffer[] = [];
	let tcp: Socket | undefined;
	let connected = false;
	let closed = false;
	// A server that moonlet just (re)started may take a moment to listen.
	const deadline = Date.now() + 20_000;

	const close = (reason: string) => {
		if (closed) return;
		closed = true;
		log(`portal pipe ${pipeId} (port ${port}) closed: ${reason}`);
		tcp?.destroy();
		if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
	};

	const dial = (host: string) => {
		const conn = connect({ host, port });
		tcp = conn;
		conn.on("connect", () => {
			connected = true;
			for (const chunk of toPort.splice(0)) conn.write(chunk);
		});
		conn.on("data", (chunk: Buffer) => {
			if (socket.readyState === WebSocket.OPEN) socket.send(chunk);
			else toSocket.push(chunk);
		});
		conn.on("error", (error: NodeJS.ErrnoException) => {
			if (!connected && !closed && error.code === "ECONNREFUSED") {
				if (host === "127.0.0.1") return dial("::1");
				if (Date.now() < deadline) return void setTimeout(() => dial("127.0.0.1"), 500);
			}
			if (!connected) report({ type: "pipe-failed", pipeId, error: `nothing listens on port ${port} (${error.code ?? error.message})` });
			close(error.message);
		});
		conn.on("close", () => {
			if (connected) close("connection ended");
		});
	};
	dial("127.0.0.1");

	socket.addEventListener("open", () => {
		for (const chunk of toSocket.splice(0)) socket.send(chunk);
	});
	socket.addEventListener("message", (event) => {
		const data = event.data instanceof ArrayBuffer ? Buffer.from(event.data) : Buffer.from(String(event.data));
		if (connected) tcp?.write(data);
		else toPort.push(data);
	});
	socket.addEventListener("close", () => close("socket closed"));
	socket.addEventListener("error", () => close("socket error"));
}

export async function runBootstrap() {
	const server = process.env.ORB_SERVER_URL;
	const token = process.env.ORB_TOKEN;
	if (!server || !token) throw new Error("ORB_SERVER_URL and ORB_TOKEN must be set");
	const piEnv = findPiEnv();
	log(`moonlet bootstrap ${VERSION} → ${server} (pi-env: ${piEnv})`);

	let attempt = 0;
	for (;;) {
		const code = await new Promise<number>((resolve) => {
			const socket = new WebSocket(wsUrl(server, "/orb/connect"), authProtocols(token));
			const send = (message: OrbMessage) => {
				if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
			};
			let heartbeat: ReturnType<typeof setInterval> | undefined;
			socket.addEventListener("open", () => {
				attempt = 0;
				const user = userInfo();
				send({ type: "hello", orbId: process.env.ORB_ID ?? "", version: VERSION, hostname: hostname(), user: user.username, home: homedir(), piEnv });
				heartbeat = setInterval(() => send({ type: "ping" }), 15_000);
			});
			socket.addEventListener("message", (event) => {
				let message: ServerMessage;
				try {
					message = JSON.parse(String(event.data));
				} catch {
					return;
				}
				if (message.type === "welcome") log(`connected as ${message.orbId} (generation ${message.generation})`);
				else if (message.type === "open-pipe") openPipe(server, token, piEnv, message.pipeId, message.args, message.env ?? {}, send);
				else if (message.type === "open-port") openPort(server, token, message.pipeId, message.port, send);
				else if (message.type === "shutdown") {
					log(`shutdown: ${message.reason}`);
					socket.close(4409, "shutdown");
				}
			});
			socket.addEventListener("close", (event) => {
				clearInterval(heartbeat);
				resolve(event.code);
			});
			socket.addEventListener("error", () => {});
		});
		if (FATAL_CLOSE.has(code)) {
			log(`control socket closed with ${code}; exiting`);
			process.exit(0);
		}
		attempt++;
		const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
		log(`control socket closed with ${code}; reconnecting in ${delay} ms`);
		await Bun.sleep(delay);
	}
}
