import { openTerminal } from "@earendil-works/pi-env";
import type { ServerWebSocket } from "bun";
import type { OrbManager, SocketData } from "./orbs.ts";
import type { Store } from "./store.ts";
import type { Threads } from "./threads.ts";

type Socket = ServerWebSocket<SocketData>;
type TerminalData = Extract<SocketData, { kind: "terminal" }>;

/**
 * Attaches to the orb's shared tmux session `moonlet` (the agent can use it too, with `tmux attach -t moonlet` or
 * send-keys), or a login shell where tmux is missing. Leaving tmux (prefix d) ends the terminal; the session lives on.
 */
const ATTACH = "command -v tmux >/dev/null && exec tmux new-session -A -s moonlet; exec bash -l";

/** Users' terminals into orbs: a WebSocket to `/api/threads/<id>/terminal`, bridged to a pi-env pseudo-terminal. */
export class Terminals {
	constructor(private readonly options: { store: Store; orbs: OrbManager; threads: () => Threads; log: (message: string) => void }) {}

	async onOpen(socket: Socket) {
		const data = socket.data as TerminalData;
		const thread = this.options.store.thread(data.threadId);
		if (!thread) return socket.close(4404, "unknown thread");
		const { orbs } = this.options;
		// An attached terminal keeps the orb awake.
		orbs.busy(thread.orb_id, 1);
		data.orbId = thread.orb_id;
		try {
			await orbs.ensureRunning(thread.orb_id);
			const cwd = await this.options.threads().prepare(thread);
			if (socket.readyState !== WebSocket.OPEN) return;
			const terminal = await openTerminal(orbs.connection(thread.orb_id), {
				cwd,
				argv: ["bash", "-lc", ATTACH],
				env: { TERM: "xterm-256color" },
				cols: data.cols,
				rows: data.rows,
				onData: (bytes) => socket.send(bytes),
			});
			data.terminal = terminal;
			for (const chunk of data.pending.splice(0)) terminal.write(chunk);
			void terminal.exited.then(
				() => socket.close(1000, "terminal ended"),
				() => socket.close(1000, "terminal ended"),
			);
		} catch (error) {
			socket.close(4500, String(error instanceof Error ? error.message : error).slice(0, 120));
		}
	}

	onMessage(socket: Socket, message: string | Buffer) {
		const data = socket.data as TerminalData;
		if (data.orbId) this.options.orbs.touch(data.orbId);
		if (typeof message === "string") {
			try {
				const parsed = JSON.parse(message) as { type: string; cols: number; rows: number };
				if (parsed.type === "resize") data.terminal?.resize(parsed.cols, parsed.rows);
			} catch {}
			return;
		}
		if (data.terminal) data.terminal.write(message);
		else data.pending.push(new Uint8Array(message));
	}

	onClose(socket: Socket) {
		const data = socket.data as TerminalData;
		data.terminal?.close();
		if (data.orbId) this.options.orbs.busy(data.orbId, -1);
	}
}
