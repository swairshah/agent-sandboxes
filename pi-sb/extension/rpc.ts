/**
 * Client for sbx's line-delimited JSON protocol. Works over any transport that
 * can send a line and deliver lines back: a local child process or a remote
 * sandbox's exec stream.
 */

import { appendFileSync } from "node:fs";

export interface Transport {
	send(line: string): void | Promise<void>;
	/** Called once with a line handler before the first send. */
	onLine(handler: (line: string) => void): void;
	onClose(handler: (reason: string) => void): void;
}

type Pending = {
	resolve: (v: any) => void;
	reject: (e: Error) => void;
	onData?: (chunk: Buffer) => void;
};

export class SbxError extends Error {}

// PI_SB_DEBUG=<file> logs every request and reply.
const debugFile = process.env.PI_SB_DEBUG;
export function debug(dir: string, line: string) {
	if (debugFile) appendFileSync(debugFile, `${new Date().toISOString()} ${dir} ${line.slice(0, 300).trimEnd()}\n`);
}

export class Client {
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private closed: string | undefined;
	private eventHandlers: Array<(msg: any) => void> = [];
	private sendChain: Promise<void> = Promise.resolve();

	private transport: Transport;

	constructor(transport: Transport) {
		this.transport = transport;
		transport.onLine((line) => this.dispatch(line));
		transport.onClose((reason) => {
			this.closed = reason || "sandbox connection closed";
			for (const p of this.pending.values()) p.reject(new SbxError(this.closed));
			this.pending.clear();
		});
	}

	/** Messages without an id (for example the host's "box" announcement). */
	onEvent(handler: (msg: any) => void): void {
		this.eventHandlers.push(handler);
	}

	get isClosed(): boolean {
		return this.closed !== undefined;
	}

	private dispatch(line: string) {
		if (!line.trim()) return;
		debug("<", line);
		let msg: any;
		try {
			msg = JSON.parse(line);
		} catch {
			return; // stray output on the channel
		}
		if (typeof msg.id !== "number") {
			for (const h of this.eventHandlers) h(msg);
			return;
		}
		const p = this.pending.get(msg.id);
		if (!p) return;
		if (msg.ev === "data") {
			p.onData?.(Buffer.from(msg.d ?? "", "base64"));
			return;
		}
		this.pending.delete(msg.id);
		if (msg.error !== undefined) p.reject(new SbxError(msg.error));
		else p.resolve(msg);
	}

	/** Starts a request and returns its id with a promise for the reply. */
	start(op: string, params: Record<string, unknown> = {}, onData?: (chunk: Buffer) => void) {
		if (this.closed) return { id: -1, done: Promise.reject(new SbxError(this.closed)) };
		const id = this.nextId++;
		const done = new Promise<any>((resolve, reject) => {
			this.pending.set(id, { resolve, reject, onData });
		});
		const line = `${JSON.stringify({ ...params, id, op })}\n`;
		debug(">", line);
		// Keep writes ordered even when the transport's send is async.
		this.sendChain = this.sendChain
			.then(() => this.transport.send(line))
			.catch((err) => {
				const p = this.pending.get(id);
				this.pending.delete(id);
				p?.reject(new SbxError(`send failed: ${err?.message ?? err}`));
			});
		return { id, done };
	}

	call(op: string, params: Record<string, unknown> = {}): Promise<any> {
		return this.start(op, params).done;
	}
}
