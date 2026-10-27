#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { httpJobSource, runProvider } from "./dispatch.ts";
import { authProtocols, VERSION } from "./protocol.ts";

const USAGE = `moonlet ${VERSION}: open-source orbs on pi-durable

Control plane:
  moonlet server [--port 7400] [--public-url URL] [--dispatch ./dispatch.sh] [--model provider/id]
               [--image IMAGE] [--auth-file auth.json] [--idle-minutes 10] [--data DIR] [--portal-host HOST]
  moonlet provider <dispatch-program> --server URL [--token TOKEN]

Threads (MOONLET_URL and MOONLET_TOKEN, or the local server's config):
  moonlet new [--repo URL] [--title T] "prompt"     start a thread in a new orb
  moonlet send <thread> "message" [--steer]         send a follow-up (or steer a running turn)
  moonlet watch <thread>                            stream the thread's events
  moonlet show <thread>                             print the transcript
  moonlet threads                                   list threads and their orbs
  moonlet portal <thread> <port>                    give a port in the thread's orb a URL
  moonlet term <thread>                             a terminal in the orb's shared tmux session (detach: ctrl-b d)
  moonlet upload <thread> <file> [orb-path]         copy a file into the orb's workspace
  moonlet download <thread> <orb-path> [file]       copy a file out of the orb
  moonlet secrets [list] | set NAME [--plain] | rm NAME   env vars for every orb (set reads the value from stdin)
  moonlet pause <thread> | abort <thread> | rm <thread>

In the orb (started by the dispatch program):
  moonlet bootstrap                                 connect this machine to the control plane
`;

function clientConfig() {
	let url = process.env.MOONLET_URL;
	let token = process.env.MOONLET_TOKEN;
	// A remote server, as the pi extension uses it: ~/.moonlet/client.json { "url", "token" }.
	const client = join(process.env.HOME ?? "", ".moonlet", "client.json");
	if (!url && !token && !process.env.MOONLET_PORT && existsSync(client)) return JSON.parse(readFileSync(client, "utf8")) as { url: string; token: string };
	const dataDir = process.env.MOONLET_DATA ?? join(process.env.HOME ?? "", ".moonlet", "server");
	const file = join(dataDir, "config.json");
	if (!token && existsSync(file)) token = JSON.parse(readFileSync(file, "utf8")).apiToken;
	url ??= `http://localhost:${process.env.MOONLET_PORT ?? 7400}`;
	if (!token) throw new Error("Set MOONLET_TOKEN (the apiToken in the server's config.json)");
	return { url, token };
}

async function call(method: string, path: string, body?: unknown) {
	const { url, token } = clientConfig();
	const response = await fetch(new URL(path, url), {
		method,
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${text}`);
	return text ? JSON.parse(text) : undefined;
}

type Block = { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown };

/** Render agent events as plain text. Partial message updates are streamed as deltas. */
function printer() {
	return (event: any) => {
		switch (event.type) {
			case "snapshot":
				for (const entry of event.entries) printEntry(entry);
				if (event.run) console.log("… (a run is in progress)");
				break;
			case "message_update":
				for (const change of event.changes ?? []) {
					if (change.type === "text_delta") process.stdout.write(change.delta);
					else if (change.type === "text_start" && change.block?.text) process.stdout.write(change.block.text);
				}
				break;
			case "message_end":
				process.stdout.write("\n");
				for (const block of (event.entry?.model?.[0]?.content ?? []) as Block[]) {
					if (block.type === "toolCall") console.log(`\x1b[2m→ ${block.name} ${JSON.stringify(block.arguments).slice(0, 200)}\x1b[0m`);
				}
				break;
			case "tool_execution_update":
				if (event.output?.append) process.stdout.write(`\x1b[2m${event.output.append}\x1b[0m`);
				break;
			case "tool_execution_end":
				process.stdout.write("\n");
				break;
			case "entry_appended":
				if (event.entry?.kind === "moonlet.setup") printEntry(event.entry);
				break;
			case "run_end":
				console.log("\x1b[2m── run finished ──\x1b[0m");
				break;
			case "auto_retry_start":
				console.log(`\x1b[33mretrying (${event.attempt}): ${event.errorMessage}\x1b[0m`);
				break;
		}
	};
}

function printEntry(entry: any) {
	const kind = entry.kind as string;
	if (kind === "pi.user") {
		const content = entry.model?.[0]?.content;
		const text = typeof content === "string" ? content : (content ?? []).map((b: Block) => b.text ?? "").join("");
		console.log(`\n\x1b[1m> ${text}\x1b[0m`);
	} else if (kind === "pi.assistant") {
		for (const block of (entry.model?.[0]?.content ?? []) as Block[]) {
			if (block.type === "text") console.log(block.text);
			else if (block.type === "toolCall") console.log(`\x1b[2m→ ${block.name} ${JSON.stringify(block.arguments).slice(0, 200)}\x1b[0m`);
		}
	} else if (kind === "pi.tool-result") {
		const content = entry.model?.[0]?.content ?? [];
		const text = content.map((b: Block) => b.text ?? "").join("").trim();
		console.log(`\x1b[2m${text.split("\n").slice(0, 12).join("\n")}${text.split("\n").length > 12 ? "\n…" : ""}\x1b[0m`);
	} else if (kind === "moonlet.setup") {
		console.log(`\x1b[2m[setup exit ${entry.data?.exitCode} in ${entry.data?.cwd}]\n${String(entry.data?.output ?? "").trim().split("\n").slice(-8).join("\n")}\x1b[0m`);
	}
}

async function watch(threadId: string, untilIdle: boolean) {
	const { url, token } = clientConfig();
	const controller = new AbortController();
	const response = await fetch(new URL(`/api/threads/${threadId}/events`, url), {
		headers: { authorization: `Bearer ${token}` },
		signal: controller.signal,
	});
	if (!response.ok || !response.body) throw new Error(`watch: HTTP ${response.status}`);
	const print = printer();
	const decoder = new TextDecoder();
	let buffer = "";
	let finished = false;
	// Leaving the loop cancels the stream; aborting the fetch first would surface as an error.
	for await (const chunk of response.body) {
		buffer += decoder.decode(chunk, { stream: true });
		let index: number;
		while (!finished && (index = buffer.indexOf("\n\n")) !== -1) {
			const frame = buffer.slice(0, index);
			buffer = buffer.slice(index + 2);
			if (!frame.startsWith("data: ")) continue;
			const event = JSON.parse(frame.slice(6));
			print(event);
			finished = untilIdle && (event.type === "run_end" || (event.type === "snapshot" && !event.run && event.entries.at(-1)?.kind === "pi.assistant"));
		}
		if (finished) break;
	}
	controller.abort();
}

/** A terminal in the orb: raw stdin to the socket, the socket to stdout, window sizes as resize messages. */
async function terminal(threadId: string) {
	const { url, token } = clientConfig();
	const target = new URL(`/api/threads/${threadId}/terminal`, url);
	target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
	target.searchParams.set("cols", String(process.stdout.columns ?? 120));
	target.searchParams.set("rows", String(process.stdout.rows ?? 40));
	const socket = new WebSocket(target, authProtocols(token));
	socket.binaryType = "arraybuffer";
	const done = Promise.withResolvers<void>();
	const restore = () => {
		if (process.stdin.isTTY) process.stdin.setRawMode(false);
		process.stdin.pause();
	};
	socket.addEventListener("open", () => {
		if (process.stdin.isTTY) process.stdin.setRawMode(true);
		process.stdin.on("data", (chunk: Buffer) => socket.send(chunk));
		process.stdout.on("resize", () => socket.send(JSON.stringify({ type: "resize", cols: process.stdout.columns, rows: process.stdout.rows })));
	});
	socket.addEventListener("message", (event) => {
		if (event.data instanceof ArrayBuffer) process.stdout.write(new Uint8Array(event.data));
	});
	socket.addEventListener("close", (event) => {
		restore();
		if (event.code !== 1000 && event.reason) console.error(`\nterminal closed: ${event.reason}`);
		done.resolve();
	});
	socket.addEventListener("error", () => {});
	await done.promise;
	process.exit(0);
}

async function main() {
	const [command, ...rest] = process.argv.slice(2);
	switch (command) {
		case "server": {
			const { values } = parseArgs({
				args: rest,
				options: {
					port: { type: "string", default: process.env.MOONLET_PORT ?? "7400" },
					host: { type: "string", default: "127.0.0.1" },
					"public-url": { type: "string", default: process.env.MOONLET_PUBLIC_URL },
					dispatch: { type: "string", default: process.env.MOONLET_DISPATCH },
					image: { type: "string", default: process.env.ORB_IMAGE ?? "boldsoftware/exeuntu" },
					model: { type: "string", default: process.env.MOONLET_MODEL ?? "openai/gpt-6-sol" },
					"auth-file": { type: "string", default: process.env.MOONLET_AUTH_FILE },
					"idle-minutes": { type: "string", default: "10" },
					"portal-host": { type: "string", default: process.env.MOONLET_PORTAL_HOST },
					data: { type: "string" },
				},
			});
			const { startServer, defaultDataDir } = await import("./server/main.ts");
			await startServer({
				port: Number(values.port),
				host: values.host!,
				dataDir: values.data ?? defaultDataDir(),
				publicUrl: values["public-url"],
				dispatch: values.dispatch,
				image: values.image!,
				model: values.model!,
				authFile: values["auth-file"],
				idleMinutes: Number(values["idle-minutes"]),
				portalHost: values["portal-host"],
			});
			return;
		}
		case "provider": {
			const { values, positionals } = parseArgs({
				args: rest,
				allowPositionals: true,
				options: { server: { type: "string", default: process.env.MOONLET_URL }, token: { type: "string", default: process.env.MOONLET_PROVIDER_TOKEN } },
			});
			const script = positionals[0];
			if (!script || !values.server || !values.token) throw new Error("usage: moonlet provider <dispatch> --server URL --token TOKEN");
			const { resolve } = await import("node:path");
			console.log(`moonlet provider → ${values.server} with ${resolve(script)}`);
			await runProvider(resolve(script), httpJobSource(values.server, values.token), (line) =>
				console.log(`${new Date().toISOString().slice(11, 19)} ${line}`),
			);
			return;
		}
		case "bootstrap": {
			const { runBootstrap } = await import("./bootstrap.ts");
			await runBootstrap();
			return;
		}
		case "relay": {
			const [orbId, ...daemonArgs] = rest;
			if (!orbId) throw new Error("usage: moonlet relay <orb> serve --token <hex>");
			const { runRelay } = await import("./relay.ts");
			await runRelay(orbId, daemonArgs);
			return;
		}
		case "new": {
			const { values, positionals } = parseArgs({
				args: rest,
				allowPositionals: true,
				options: { repo: { type: "string" }, title: { type: "string" }, detach: { type: "boolean", short: "d" } },
			});
			const prompt = positionals.join(" ");
			const thread = await call("POST", "/api/threads", { prompt: prompt || undefined, repo: values.repo, title: values.title });
			console.log(`thread ${thread.id} (orb ${thread.orb_id})`);
			if (prompt && !values.detach) await watch(thread.id, true);
			return;
		}
		case "send": {
			const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { steer: { type: "boolean" }, detach: { type: "boolean", short: "d" } } });
			const [threadId, ...words] = positionals;
			if (!threadId || words.length === 0) throw new Error('usage: moonlet send <thread> "message"');
			await call("POST", `/api/threads/${threadId}/messages`, { content: words.join(" "), whenBusy: values.steer ? "steer" : "followUp" });
			if (!values.detach) await watch(threadId, true);
			return;
		}
		case "watch":
			if (!rest[0]) throw new Error("usage: moonlet watch <thread>");
			await watch(rest[0], false);
			return;
		case "show": {
			if (!rest[0]) throw new Error("usage: moonlet show <thread>");
			const view = await call("GET", `/api/threads/${rest[0]}`);
			console.log(`${view.thread.title}  [orb ${view.orb?.id}: ${view.orb?.status}]`);
			for (const entry of view.entries) printEntry(entry);
			return;
		}
		case "threads": {
			for (const thread of await call("GET", "/api/threads")) {
				console.log(`${thread.id}  ${(thread.orb?.status ?? "?").padEnd(8)}  ${thread.title}`);
			}
			return;
		}
		case "term": {
			if (!rest[0]) throw new Error("usage: moonlet term <thread>");
			await terminal(rest[0]);
			return;
		}
		case "upload": {
			const [threadId, file, target] = rest;
			if (!threadId || !file) throw new Error("usage: moonlet upload <thread> <file> [orb-path]");
			const { url, token } = clientConfig();
			const path = target ?? file.split("/").pop()!;
			const response = await fetch(new URL(`/api/threads/${threadId}/files?path=${encodeURIComponent(path)}`, url), {
				method: "PUT",
				headers: { authorization: `Bearer ${token}` },
				body: Bun.file(file),
			});
			if (!response.ok) throw new Error(`upload: HTTP ${response.status} ${await response.text()}`);
			console.log(`uploaded to ${((await response.json()) as { path: string }).path}`);
			return;
		}
		case "download": {
			const [threadId, path, file] = rest;
			if (!threadId || !path) throw new Error("usage: moonlet download <thread> <orb-path> [file]");
			const { url, token } = clientConfig();
			const response = await fetch(new URL(`/api/threads/${threadId}/files?path=${encodeURIComponent(path)}`, url), { headers: { authorization: `Bearer ${token}` } });
			if (!response.ok) throw new Error(`download: HTTP ${response.status} ${await response.text()}`);
			const out = file ?? path.split("/").pop()!;
			await Bun.write(out, response);
			console.log(`saved ${out}`);
			return;
		}
		case "secrets": {
			const [action = "list", name] = rest;
			if (action === "list") {
				for (const row of await call("GET", "/api/secrets")) console.log(`${row.name}${row.secret ? "  (secret)" : `=${row.value}`}`);
			} else if (action === "set" && name) {
				// From stdin, so the value stays out of shell history and process lists.
				const value = (await new Response(Bun.stdin.stream()).text()).replace(/\r?\n$/, "");
				await call("PUT", `/api/secrets/${name}`, { value, secret: !rest.includes("--plain") });
				console.log(`set ${name}`);
			} else if (action === "rm" && name) {
				await call("DELETE", `/api/secrets/${name}`);
				console.log(`removed ${name}`);
			} else {
				throw new Error("usage: moonlet secrets [list] | set NAME [--plain] < value | rm NAME");
			}
			return;
		}
		case "portal": {
			const [threadId, port] = rest;
			if (!threadId || !port) throw new Error("usage: moonlet portal <thread> <port>");
			const portal = await call("POST", `/api/threads/${threadId}/portals`, { port: Number(port) });
			console.log(portal.url);
			return;
		}
		case "pause":
		case "abort":
			if (!rest[0]) throw new Error(`usage: moonlet ${command} <thread>`);
			await call("POST", `/api/threads/${rest[0]}/${command}`);
			console.log(`${command === "pause" ? "paused" : "aborted"} ${rest[0]}`);
			return;
		case "rm":
			if (!rest[0]) throw new Error("usage: moonlet rm <thread>");
			await call("DELETE", `/api/threads/${rest[0]}`);
			console.log(`deleted ${rest[0]}`);
			return;
		case "version":
		case "--version":
			console.log(VERSION);
			return;
		default:
			console.log(USAGE);
			if (command && command !== "help" && command !== "--help") process.exit(1);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
