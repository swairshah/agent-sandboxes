import type { Socket, TCPSocketListener } from "bun";
import type { OrbManager } from "./orbs.ts";
import type { PortalRow, Store } from "./store.ts";

export interface PortalsOptions {
	store: Store;
	orbs: OrbManager;
	/** Ports of this machine that portals may take, inclusive. */
	range: [number, number];
	/** Ports in the range that are taken otherwise, such as the server's own. */
	reserved: number[];
	/**
	 * Hostname that reaches this machine's ports over HTTPS, such as an exe.dev VM's `<vm>.exe.xyz`, whose proxy
	 * forwards ports 3000-9999 to users with access to the VM. Without one, URLs are http://localhost:<port>.
	 */
	host?: string;
	log: (message: string) => void;
}

interface Connection {
	stream?: { send(data: Uint8Array): void; close(): void };
	/** Bytes from the orb that the client has not taken yet. */
	out: Uint8Array[];
	ending: boolean;
}

/**
 * Portals: a port on this machine per (orb, port) that forwards each TCP connection, byte for byte, to that port on
 * the orb's loopback through a pipe the orb's bootstrap opens. HTTP, WebSockets and hot reload all pass through, and
 * a connection to a paused orb starts it.
 */
export class Portals {
	readonly #listeners = new Map<number, TCPSocketListener<Connection>>();

	constructor(private readonly options: PortalsOptions) {}

	/** Listen for the portals recorded before a restart. */
	start() {
		for (const row of this.options.store.portals()) {
			try {
				this.#listen(row);
			} catch (error) {
				this.options.log(`portal ${row.orb_id}:${row.port} could not listen on ${row.public_port}: ${error}`);
			}
		}
	}

	url(row: PortalRow) {
		return this.options.host ? `https://${this.options.host}:${row.public_port}/` : `http://localhost:${row.public_port}/`;
	}

	list(orbId: string) {
		return this.options.store.portals(orbId).map((row) => ({ port: row.port, url: this.url(row) }));
	}

	/** The portal of `port` on the orb, made on first use; the same port keeps its URL. */
	create(orbId: string, port: number): { port: number; url: string } {
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port ${port}`);
		const existing = this.options.store.portals(orbId).find((row) => row.port === port);
		if (existing) return { port, url: this.url(existing) };
		const taken = new Set([...this.options.store.portals().map((row) => row.public_port), ...this.options.reserved]);
		for (let candidate = this.options.range[0]; candidate <= this.options.range[1]; candidate++) {
			if (taken.has(candidate)) continue;
			const row = { orb_id: orbId, port, public_port: candidate, created_at: Date.now() };
			try {
				this.#listen(row);
			} catch {
				continue; // Something else has this port.
			}
			this.options.store.addPortal(row);
			this.options.log(`orb ${orbId}: portal for port ${port} at ${this.url(row)}`);
			return { port, url: this.url(row) };
		}
		throw new Error("no free portal ports");
	}

	removeOrb(orbId: string) {
		for (const row of this.options.store.portals(orbId)) {
			this.#listeners.get(row.public_port)?.stop(true);
			this.#listeners.delete(row.public_port);
		}
		this.options.store.deletePortals(orbId);
	}

	close() {
		for (const listener of this.#listeners.values()) listener.stop(true);
	}

	#listen(row: PortalRow) {
		const { orbs } = this.options;
		const write = (socket: Socket<Connection>, bytes: Uint8Array) => {
			if (socket.data.out.length > 0) return void socket.data.out.push(bytes.slice());
			const written = socket.write(bytes);
			if (written < bytes.byteLength) socket.data.out.push(bytes.slice(Math.max(0, written)));
		};
		const listener = Bun.listen<Connection>({
			hostname: "0.0.0.0",
			port: row.public_port,
			socket: {
				open(socket) {
					socket.data = { out: [], ending: false };
					socket.data.stream = orbs.openPort(row.orb_id, row.port, {
						send: (bytes) => write(socket, bytes),
						close: () => {
							socket.data.ending = true;
							if (socket.data.out.length === 0) socket.end();
						},
					});
				},
				data(socket, bytes) {
					socket.data.stream?.send(bytes);
				},
				drain(socket) {
					const { out } = socket.data;
					while (out.length > 0) {
						const next = out[0]!;
						const written = socket.write(next);
						if (written < next.byteLength) {
							out[0] = next.slice(Math.max(0, written));
							return;
						}
						out.shift();
					}
					if (socket.data.ending) socket.end();
				},
				close(socket) {
					socket.data.stream?.close();
				},
				error(socket) {
					socket.data.stream?.close();
				},
			},
		});
		this.#listeners.set(row.public_port, listener);
	}
}
