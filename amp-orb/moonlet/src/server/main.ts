import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runProvider } from "../dispatch.ts";
import { type JobResult, tokenFromProtocols } from "../protocol.ts";
import { randomSecret, safeEqual } from "../tokens.ts";
import { orbChanges } from "./changes.ts";
import { ClientHub } from "./clients.ts";
import { Schedules } from "./schedules.ts";
import { orbEnv } from "./secrets.ts";
import { Terminals } from "./terminals.ts";
import { openModels, parseModel } from "./models.ts";
import { OrbManager, type SocketData } from "./orbs.ts";
import { Portals } from "./portals.ts";
import { Services } from "./services.ts";
import { Store } from "./store.ts";
import { NotFound, Threads } from "./threads.ts";
import { INDEX_HTML } from "./ui.ts";

export interface ServerOptions {
	port: number;
	host: string;
	dataDir: string;
	publicUrl?: string;
	/** Run jobs in this process with this dispatch program instead of waiting for `moonlet provider`. */
	dispatch?: string;
	image: string;
	model: string;
	authFile?: string;
	idleMinutes: number;
	/** Hostname whose HTTPS ports reach this machine's portal ports, e.g. `moonlet.exe.xyz`. */
	portalHost?: string;
}

export interface ServerConfig {
	secret: string;
	apiToken: string;
	providerToken: string;
}

const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

export function defaultDataDir() {
	return process.env.MOONLET_DATA ?? join(homedir(), ".moonlet", "server");
}

/** Secrets are created once and kept in the data directory (mode 600). */
export async function loadConfig(dataDir: string): Promise<ServerConfig> {
	const file = join(dataDir, "config.json");
	if (existsSync(file)) return JSON.parse(await readFile(file, "utf8"));
	await mkdir(dataDir, { recursive: true, mode: 0o700 });
	const config: ServerConfig = { secret: randomSecret(), apiToken: randomSecret("pio_api_"), providerToken: randomSecret("pio_prov_") };
	await writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 });
	await chmod(file, 0o600);
	return config;
}

/** Linux binaries an orb downloads: the bootstrap and the pi-env daemon. */
async function orbArtifacts(root: string) {
	const artifacts = new Map<string, { path: string; sha256: string; gzip?: Uint8Array }>();
	const candidates: Record<string, Record<string, string>> = {
		x86_64: {
			moonlet: join(root, "dist", "moonlet-linux-x64"),
			"pi-env": join(root, "node_modules", "@earendil-works", "pi-env", "bin", "pi-env-linux-x64", "pi-env"),
		},
		aarch64: {
			moonlet: join(root, "dist", "moonlet-linux-arm64"),
			"pi-env": join(root, "node_modules", "@earendil-works", "pi-env", "bin", "pi-env-linux-arm64", "pi-env"),
		},
	};
	for (const [arch, files] of Object.entries(candidates)) {
		for (const [name, path] of Object.entries(files)) {
			if (!existsSync(path)) continue;
			const bytes = await readFile(path);
			artifacts.set(`${arch}/${name}`, { path, sha256: createHash("sha256").update(bytes).digest("hex") });
		}
	}
	return artifacts;
}

const INSTALL_SCRIPT = `#!/usr/bin/env bash
# Installs and starts the moonlet bootstrap. Run by a dispatch program inside the orb, as the
# image's default user, with ORB_TOKEN, ORB_SERVER_URL and ORB_ID set.
set -euo pipefail
: "\${ORB_SERVER_URL:?}" "\${ORB_TOKEN:?}"
dir="$HOME/.moonlet"
mkdir -p "$dir/bin"
arch=$(uname -m)
manifest=$(curl -fsSL "$ORB_SERVER_URL/download/manifest?arch=$arch")
while read -r name sha; do
	[ -n "$name" ] || continue
	have=""
	[ -f "$dir/bin/$name" ] && have=$(sha256sum "$dir/bin/$name" | cut -d' ' -f1)
	if [ "$have" != "$sha" ]; then
		echo "downloading $name"
		curl -fsSL --compressed "$ORB_SERVER_URL/download/$arch/$name" -o "$dir/bin/$name.tmp"
		echo "$sha  $dir/bin/$name.tmp" | sha256sum -c --quiet
		chmod +x "$dir/bin/$name.tmp"
		mv "$dir/bin/$name.tmp" "$dir/bin/$name"
	fi
done <<<"$manifest"
pkill -f "$dir/bin/moonlet bootstrap" 2>/dev/null || true
cd "$HOME"
MOONLET_PI_ENV="$dir/bin/pi-env" setsid -f "$dir/bin/moonlet" bootstrap >>"$dir/bootstrap.log" 2>&1 </dev/null
echo "moonlet bootstrap started"
`;

export async function startServer(options: ServerOptions) {
	const root = resolve(dirname(Bun.main), "..");
	await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
	const config = await loadConfig(options.dataDir);
	const publicUrl = options.publicUrl ?? `http://localhost:${options.port}`;
	const store = new Store(join(options.dataDir, "moonlet.sqlite"));
	const artifacts = await orbArtifacts(root);
	if (![...artifacts.keys()].some((key) => key.endsWith("/moonlet"))) {
		log("warning: no dist/moonlet-linux-* binary; run `bun run build:orb` so orbs can download the bootstrap");
	}

	// pi-env spawns `moonlet relay` for each daemon connection; it reaches back over loopback.
	const relayKey = randomSecret();
	process.env.MOONLET_RELAY_URL = `http://127.0.0.1:${options.port}`;
	process.env.MOONLET_RELAY_KEY = relayKey;
	const self = Bun.main.endsWith(".ts") ? [process.execPath, Bun.main] : [process.execPath];

	const orbs = new OrbManager({
		store,
		secret: config.secret,
		publicUrl,
		image: options.image,
		bootstrap: `curl -fsSL "$ORB_SERVER_URL/orb/install.sh" | bash`,
		idleMs: options.idleMinutes * 60_000,
		spawnTimeoutMs: 6 * 60_000,
		relayCommand: (orbId) => [...self, "relay", orbId],
		pipeEnv: () => orbEnv(store),
		log,
	});
	const [low, high] = (process.env.MOONLET_PORTAL_PORTS ?? "4000-7999").split("-").map(Number) as [number, number];
	const portals = new Portals({ store, orbs, range: [low, high], reserved: [options.port], host: options.portalHost, log });
	portals.start();
	const services = new Services({ store, orbs, portals, portalHost: options.portalHost, log });
	services.start();
	const model = parseModel(options.model);
	// How long a thread's call to the user's machine waits for its pi session to come back.
	const clients = new ClientHub(Number(process.env.MOONLET_LOCAL_WAIT_MINUTES ?? 15) * 60_000, log);
	let schedules: Schedules | undefined;
	const threads = await Threads.open({
		store,
		orbs,
		durablePath: join(options.dataDir, "durable.sqlite"),
		models: openModels(options.authFile, model),
		model,
		gitToken: process.env.MOONLET_GIT_TOKEN,
		clients,
		portals,
		services,
		schedules: () => schedules!,
		log,
	});
	schedules = new Schedules({ store, threads: () => threads, log });

	const terminals = new Terminals({ store, orbs, threads: () => threads, log });
	const json = (value: unknown, status = 200) => Response.json(value, { status });
	const bearer = (request: Request) => request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
	const api = (request: Request) => safeEqual(bearer(request), config.apiToken);

	const server = Bun.serve<SocketData, never>({
		port: options.port,
		hostname: options.host,
		idleTimeout: 60,
		async fetch(request, server) {
			const url = new URL(request.url);
			const path = url.pathname;
			try {
				// Orb sockets.
				if (path === "/orb/connect" || path.startsWith("/orb/pipe/")) {
					const auth = orbs.authorizeOrb(tokenFromProtocols(request.headers.get("sec-websocket-protocol")));
					if (!auth) return new Response("unauthorized orb", { status: 401 });
					// Bun answers with the first offered subprotocol (PROTOCOL) on its own; setting the header too breaks the handshake.
					if (path === "/orb/connect") {
						if (server.upgrade(request, { data: { kind: "control", orbId: auth.orbId, generation: auth.generation, hello: false } })) return;
					} else {
						const pipeId = path.slice("/orb/pipe/".length);
						if (!orbs.hasPipe(pipeId, auth.orbId)) return new Response("unknown pipe", { status: 404 });
						if (server.upgrade(request, { data: { kind: "pipe", orbId: auth.orbId, pipeId } })) return;
					}
					return new Response("upgrade failed", { status: 400 });
				}
				// Users' clients (the pi extension); authenticated with the API token like the orbs' sockets.
				if (path === "/api/client") {
					if (!safeEqual(tokenFromProtocols(request.headers.get("sec-websocket-protocol")) ?? "", config.apiToken)) {
						return new Response("unauthorized", { status: 401 });
					}
					if (server.upgrade(request, { data: { kind: "client", threads: new Set<string>(), host: "" } })) return;
					return new Response("upgrade failed", { status: 400 });
				}
				const terminalMatch = path.match(/^\/api\/threads\/([\w-]+)\/terminal$/);
				if (terminalMatch) {
					if (!safeEqual(tokenFromProtocols(request.headers.get("sec-websocket-protocol")) ?? "", config.apiToken)) {
						return new Response("unauthorized", { status: 401 });
					}
					const size = (name: string, fallback: number) => Math.min(500, Math.max(10, Number(url.searchParams.get(name)) || fallback));
					const data = { kind: "terminal" as const, threadId: terminalMatch[1]!, cols: size("cols", 120), rows: size("rows", 40), pending: [] };
					if (server.upgrade(request, { data })) return;
					return new Response("upgrade failed", { status: 400 });
				}
				if (path.startsWith("/internal/relay/")) {
					const address = server.requestIP(request)?.address ?? "";
					// A tunnel or reverse proxy on this host also connects from loopback; its forwarding headers give it away.
					const proxied = request.headers.has("x-forwarded-for") || request.headers.has("cf-connecting-ip");
					const loopback = !proxied && (address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1");
					if (!loopback || !safeEqual(bearer(request), relayKey)) return new Response("forbidden", { status: 403 });
					const orbId = decodeURIComponent(path.slice("/internal/relay/".length));
					const args = JSON.parse(url.searchParams.get("args") ?? "[]") as string[];
					if (server.upgrade(request, { data: { kind: "relay", orbId, pipeId: orbs.newPipeId(), args } })) return;
					return new Response("upgrade failed", { status: 400 });
				}

				// What orbs download. These are open-source binaries, so they need no auth.
				if (path === "/orb/install.sh") return new Response(INSTALL_SCRIPT, { headers: { "content-type": "text/x-shellscript" } });
				if (path === "/download/manifest") {
					const arch = url.searchParams.get("arch") ?? "x86_64";
					const lines = [...artifacts].filter(([key]) => key.startsWith(`${arch}/`)).map(([key, a]) => `${key.split("/")[1]} ${a.sha256}`);
					if (lines.length === 0) return new Response(`no binaries for ${arch}`, { status: 404 });
					return new Response(`${lines.join("\n")}\n`);
				}
				if (path.startsWith("/download/")) {
					const artifact = artifacts.get(path.slice("/download/".length));
					if (!artifact) return new Response("not found", { status: 404 });
					artifact.gzip ??= Bun.gzipSync(new Uint8Array(await readFile(artifact.path)));
					const gzip = request.headers.get("accept-encoding")?.includes("gzip");
					return gzip
						? new Response(artifact.gzip, { headers: { "content-encoding": "gzip", "content-type": "application/octet-stream" } })
						: new Response(Bun.file(artifact.path));
				}

				// Providers.
				if (path === "/api/provider/claim" && request.method === "POST") {
					if (!safeEqual(bearer(request), config.providerToken)) return json({ error: "unauthorized" }, 401);
					const job = await orbs.claim(25_000);
					return job ? json({ id: job.id, env: JSON.parse(job.env) }) : new Response(null, { status: 204 });
				}
				const jobMatch = path.match(/^\/api\/provider\/jobs\/([\w-]+)$/);
				if (jobMatch && request.method === "POST") {
					if (!safeEqual(bearer(request), config.providerToken)) return json({ error: "unauthorized" }, 401);
					orbs.complete(jobMatch[1]!, (await request.json()) as JobResult);
					return json({ ok: true });
				}

				// The UI page is public; everything it does goes through the API token.
				if (path === "/" && request.method === "GET") return new Response(INDEX_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
				if (!path.startsWith("/api/")) return new Response("not found", { status: 404 });
				if (!api(request) && !safeEqual(url.searchParams.get("token") ?? "", config.apiToken)) return json({ error: "unauthorized" }, 401);

				if (path === "/api/threads" && request.method === "GET") {
					return json(store.threads().map((thread) => ({ ...thread, orb: store.orb(thread.orb_id) })));
				}
				if (path === "/api/threads" && request.method === "POST") {
					const body = (await request.json()) as { prompt?: string; repo?: string; title?: string; localCwd?: string; size?: string };
					return json(await threads.create(body), 201);
				}
				if (path === "/api/orbs" && request.method === "GET") return json(store.orbs());
				// Secrets and env vars for every orb. Secret values are never returned.
				if (path === "/api/secrets" && request.method === "GET") {
					return json(store.secrets().map(({ name, value, secret, updated_at }) => ({ name, secret: secret === 1, value: secret ? undefined : value, updated_at })));
				}
				const secretMatch = path.match(/^\/api\/secrets\/([A-Za-z_][A-Za-z0-9_]*)$/);
				if (secretMatch) {
					if (request.method === "PUT") {
						const body = (await request.json()) as { value: string; secret?: boolean };
						if (typeof body.value !== "string") return json({ error: "value must be a string" }, 400);
						store.setSecret(secretMatch[1]!, body.value, body.secret !== false);
					} else if (request.method === "DELETE") {
						store.deleteSecret(secretMatch[1]!);
					} else {
						return json({ error: "method not allowed" }, 405);
					}
					// Idle orbs pick the change up on their next tool call.
					orbs.refreshEnv();
					return json({ ok: true });
				}

				const match = path.match(/^\/api\/threads\/([\w-]+)(\/[a-z]+)?$/);
				if (match) {
					const [, id, action] = match as unknown as [string, string, string | undefined];
					if (!action && request.method === "GET") return json(await threads.view(id));
					if (!action && request.method === "DELETE") {
						await threads.delete(id);
						return json({ ok: true });
					}
					if (action === "/messages" && request.method === "POST") {
						const body = (await request.json()) as { content: string; whenBusy?: "steer" | "followUp" };
						return json(await threads.send(id, body.content, body.whenBusy), 202);
					}
					if (action === "/portals") {
						const thread = store.thread(id);
						if (!thread) throw new NotFound(`No thread ${id}`);
						if (request.method === "POST") return json(portals.create(thread.orb_id, Number(((await request.json()) as { port: number }).port)), 201);
						return json(portals.list(thread.orb_id));
					}
					if (action === "/schedules") {
						if (!store.thread(id)) throw new NotFound(`No thread ${id}`);
						if (request.method === "POST") {
							const body = (await request.json()) as { message: string; inMinutes?: number; at?: string; everyMinutes?: number };
							return json(schedules.add(id, body), 201);
						}
						if (request.method === "DELETE") {
							schedules.remove(id, url.searchParams.get("id") ?? "");
							return json({ ok: true });
						}
						return json(schedules.list(id));
					}
					if (action === "/files") {
						const path = url.searchParams.get("path");
						if (!path) return json({ error: "path is required" }, 400);
						if (request.method === "PUT") {
							const baseline = url.searchParams.get("baseline") === "1";
							return json({ path: await threads.writeFile(id, path, new Uint8Array(await request.arrayBuffer()), baseline) }, 201);
						}
						if (request.method === "GET") return new Response(await threads.readFile(id, path), { headers: { "content-type": "application/octet-stream" } });
					}
					if (action === "/changes" && request.method === "GET") {
						const thread = store.thread(id);
						if (!thread) throw new NotFound(`No thread ${id}`);
						const mode = url.searchParams.get("mode") === "patch" ? "patch" : "stat";
						return json(await orbChanges(orbs, store, thread.orb_id, mode));
					}
					if (action === "/services") {
						const thread = store.thread(id);
						if (!thread) throw new NotFound(`No thread ${id}`);
						if (request.method === "POST") return json(await services.ensure(thread.orb_id));
						return json(services.list(thread.orb_id));
					}
					if (action === "/status" && request.method === "GET") {
						return json(await threads.status(id, Number(url.searchParams.get("after") ?? 0)));
					}
					if (action === "/abort" && request.method === "POST") {
						await threads.abort(id);
						return json({ ok: true });
					}
					if (action === "/pause" && request.method === "POST") {
						await threads.pause(id);
						return json({ ok: true });
					}
					if (action === "/jobs" && request.method === "GET") {
						const thread = store.thread(id);
						if (!thread) throw new NotFound(id);
						return json(store.recentJobs(thread.orb_id).map(({ env: _env, ...job }) => job));
					}
					if (action === "/events" && request.method === "GET") return sse(await threads.events(id), request.signal);
				}
				return json({ error: "not found" }, 404);
			} catch (error) {
				if (error instanceof NotFound) return json({ error: error.message }, 404);
				log(`error ${request.method} ${path}: ${error instanceof Error ? error.stack : error}`);
				return json({ error: error instanceof Error ? error.message : String(error) }, 500);
			}
		},
		websocket: {
			idleTimeout: 120,
			maxPayloadLength: 32 * 1024 * 1024,
			open: (socket) => {
				if (socket.data.kind === "client") clients.onOpen(socket);
				else if (socket.data.kind === "terminal") void terminals.onOpen(socket);
				else orbs.onOpen(socket);
			},
			message: (socket, message) => {
				if (socket.data.kind === "client") clients.onMessage(socket, message);
				else if (socket.data.kind === "terminal") terminals.onMessage(socket, message);
				else orbs.onMessage(socket, message);
			},
			close: (socket, code, reason) => {
				if (socket.data.kind === "client") clients.onClose(socket);
				else if (socket.data.kind === "terminal") terminals.onClose(socket);
				else orbs.onClose(socket, code, reason);
			},
		},
	});

	log(`moonlet server on http://${options.host}:${server.port} (public ${publicUrl})`);
	log(`data: ${options.dataDir}; model: ${options.model}; image: ${options.image}; idle pause after ${options.idleMinutes} min`);
	if (options.dispatch) {
		const script = resolve(options.dispatch);
		log(`running jobs in-process with ${script}`);
		void runProvider(
			script,
			{
				claim: async () => {
					const job = await orbs.claim(25_000);
					return job ? { id: job.id, env: JSON.parse(job.env) } : undefined;
				},
				complete: async (id, result) => orbs.complete(id, result),
			},
			(line) => log(`[dispatch] ${line}`),
		);
	} else {
		log("waiting for providers: moonlet provider <dispatch> --server <url> (token in config.json)");
	}

	const shutdown = async () => {
		log("shutting down");
		orbs.close();
		portals.close();
		schedules?.close();
		await threads.close().catch(() => {});
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	return { server, threads, orbs, store };
}

function sse(stream: Awaited<ReturnType<Threads["events"]>>, signal: AbortSignal) {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (data: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
			send(stream.snapshot);
			stream.start(async (events) => {
				for (const event of events) send(event);
			});
			const keepalive = setInterval(() => controller.enqueue(encoder.encode(": keepalive\n\n")), 15_000);
			signal.addEventListener("abort", () => {
				clearInterval(keepalive);
				void stream.stop();
				controller.close();
			});
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
