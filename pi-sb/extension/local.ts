/** Local backend: `sbx host` runs the checkpoint engine and a Seatbelt-confined agent. */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SbConfig } from "./config.ts";
import { Client } from "./rpc.ts";

export interface BoxInfo {
	id: string;
	dir: string;
	home: string;
	tmp: string;
	store: string;
	cwd: string;
}

export interface Backend {
	kind: "local" | "modal" | "e2b";
	client: Client;
	/** Short description for the status line. */
	label: string;
	/** The sandbox's $HOME, as the agent sees it. */
	home: string;
	box?: BoxInfo;
	dispose(): Promise<void>;
}

export function binDir(config: SbConfig): string {
	if (config.binDir) return config.binDir;
	const here = dirname(fileURLToPath(import.meta.url));
	for (const d of [join(here, "bin"), join(here, "..", "bin")]) {
		if (existsSync(d)) return d;
	}
	return join(here, "bin");
}

export function sbxBinary(config: SbConfig, os: string, arch: string): string {
	const a = arch === "x64" || arch === "x86_64" || arch === "amd64" ? "amd64" : "arm64";
	const p = join(binDir(config), `sbx-${os}-${a}`);
	if (!existsSync(p)) throw new Error(`sbx binary not found at ${p}; run make in the pi-sb repo`);
	return p;
}

export async function startLocal(cwd: string, config: SbConfig): Promise<Backend> {
	if (process.platform !== "darwin") {
		throw new Error("local --sb uses macOS Seatbelt; on Linux use --sb --remote for now");
	}
	const bin = sbxBinary(config, "darwin", process.arch);
	const hostConfig = {
		cwd,
		root: config.root,
		read: config.read,
		write: config.write,
		deny: config.deny,
		protect: config.protect,
		network: config.network,
		env: config.env,
		seed: config.seed,
		shell: config.shell,
		checkpoint: config.checkpoint,
	};
	const child = spawn(bin, ["host", "--config-b64", Buffer.from(JSON.stringify(hostConfig)).toString("base64")], {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (d) => {
		stderr = (stderr + d.toString()).slice(-4000);
	});
	let buf = "";
	let lineHandler: (l: string) => void = () => {};
	let closeHandler: (r: string) => void = () => {};
	child.stdout.on("data", (d: Buffer) => {
		buf += d.toString("utf8");
		let i = buf.indexOf("\n");
		while (i >= 0) {
			lineHandler(buf.slice(0, i));
			buf = buf.slice(i + 1);
			i = buf.indexOf("\n");
		}
	});
	child.on("exit", (code) => closeHandler(`sbx host exited (${code})${stderr ? `: ${stderr.trim()}` : ""}`));
	child.on("error", (err) => closeHandler(`sbx host failed: ${err.message}`));
	const client = new Client({
		send: (line) => {
			child.stdin.write(line);
		},
		onLine: (h) => {
			lineHandler = h;
		},
		onClose: (h) => {
			closeHandler = h;
		},
	});
	const box = await new Promise<BoxInfo>((resolve, reject) => {
		client.onEvent((msg) => {
			if (msg.ev === "box") resolve({ ...msg, id: msg.box } as BoxInfo);
		});
		child.on("exit", (code) => reject(new Error(`sbx host exited (${code}): ${stderr.trim()}`)));
	});
	return {
		kind: "local",
		client,
		label: "local",
		home: box.home,
		box,
		async dispose() {
			child.stdin.end();
			await new Promise<void>((r) => {
				if (child.exitCode !== null) return r();
				const t = setTimeout(() => {
					child.kill("SIGKILL");
					r();
				}, 4000);
				child.on("exit", () => {
					clearTimeout(t);
					r();
				});
			});
		},
	};
}
