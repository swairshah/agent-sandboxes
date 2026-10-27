/**
 * Remote backends: pi stays on this machine; tools run in a Modal or E2B
 * sandbox where the workspace is copied to the same absolute path. sbx serve
 * runs there with its own checkpoint engine, and `pull` brings changes back.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { constants as fsConstants } from "node:fs";
import { expandHome, type SbConfig } from "./config.ts";
import { type Backend, sbxBinary } from "./local.ts";
import { Client, type Transport } from "./rpc.ts";

const REMOTE_BIN = "/usr/local/bin/sbx";
const REMOTE_STORE = "/var/lib/sbx";

type Progress = (msg: string) => void;

/** Packs the workspace into a tar.gz. Returns its path and file count. */
function packWorkspace(cwd: string, config: SbConfig): { path: string; files: number } {
	const out = join(tmpdir(), `pi-sb-upload-${process.pid}-${Date.now()}.tgz`);
	const env = { ...process.env, COPYFILE_DISABLE: "1" };
	const tarFlags = ["--no-xattrs", "--no-mac-metadata", "-czf", out];
	const isGit = config.remote.upload === "git" && existsSync(join(cwd, ".git"));
	if (isGit) {
		const ls = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
			cwd,
			maxBuffer: 1 << 28,
		});
		if (ls.status !== 0) throw new Error(`git ls-files failed: ${ls.stderr}`);
		const files = ls.stdout
			.toString("utf8")
			.split("\0")
			.filter((f) => f && existsSync(join(cwd, f)));
		const list = `${files.join("\0")}\0.git\0`;
		const r = spawnSync("tar", [...tarFlags, "--null", "-T", "-"], { cwd, input: list, env, maxBuffer: 1 << 26 });
		if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
		return { path: out, files: files.length };
	}
	const excludes = config.remote.exclude.flatMap((e) => ["--exclude", e]);
	const r = spawnSync("tar", [...tarFlags, ...excludes, "."], { cwd, env, maxBuffer: 1 << 26 });
	if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
	return { path: out, files: -1 };
}

function lineSplitter(onLine: (l: string) => void) {
	let buf = "";
	return (chunk: string) => {
		buf += chunk;
		let i = buf.indexOf("\n");
		while (i >= 0) {
			onLine(buf.slice(0, i));
			buf = buf.slice(i + 1);
			i = buf.indexOf("\n");
		}
	};
}

function serveArgs(cwd: string, config: SbConfig): string[] {
	const args = [REMOTE_BIN, "serve", "--store", REMOTE_STORE, "--root", cwd, "--keep-last", String(config.checkpoint.keepLast)];
	for (const e of config.checkpoint.excludeCwd) args.push("--exclude", e);
	return args;
}

function setupScript(cwd: string): string {
	const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
	return [
		"set -e",
		`chmod +x ${REMOTE_BIN}`,
		`mkdir -p ${q(cwd)} ${REMOTE_STORE}`,
		`tar -xzf /tmp/pi-sb-ws.tgz -C ${q(cwd)} 2>/dev/null || tar -xzf /tmp/pi-sb-ws.tgz -C ${q(cwd)}`,
		"rm -f /tmp/pi-sb-ws.tgz",
	].join("\n");
}

export async function startModal(cwd: string, config: SbConfig, progress: Progress): Promise<Backend> {
	const { ModalClient } = await import("modal");
	const mc = config.remote.modal;
	const modal = new ModalClient(mc.tokenId && mc.tokenSecret ? { tokenId: mc.tokenId, tokenSecret: mc.tokenSecret } : undefined);
	progress("modal: creating sandbox");
	const app = await modal.apps.fromName(mc.app, { createIfMissing: true });
	const image = modal.images.fromRegistry(mc.image);
	const sb = await modal.sandboxes.create(app, image, {
		timeoutMs: mc.timeoutMinutes * 60_000,
		cpu: mc.cpu,
		memoryMiB: mc.memoryMiB,
	});
	try {
		progress("modal: uploading workspace");
		const ws = packWorkspace(cwd, config);
		await Promise.all([
			sb.filesystem.copyFromLocal(sbxBinary(config, "linux", "amd64"), REMOTE_BIN),
			sb.filesystem.copyFromLocal(ws.path, "/tmp/pi-sb-ws.tgz"),
		]);
		rmSync(ws.path, { force: true });
		const setup = await sb.exec(["sh", "-c", setupScript(cwd)], { stdout: "pipe", stderr: "pipe" });
		const code = await setup.wait();
		if (code !== 0) throw new Error(`workspace setup failed: ${await setup.stderr.readText()}`);
		progress("modal: starting agent");
		const proc = await sb.exec(serveArgs(cwd, config), { mode: "text", workdir: cwd });
		let onLine: (l: string) => void = () => {};
		let onClose: (r: string) => void = () => {};
		const split = lineSplitter((l) => onLine(l));
		(async () => {
			const reader = proc.stdout.getReader();
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					split(value);
				}
				onClose("remote agent exited");
			} catch (e) {
				onClose(`remote agent stream failed: ${(e as Error).message}`);
			}
		})();
		const transport: Transport = {
			send: (line) => proc.stdin.writeText(line),
			onLine: (h) => {
				onLine = h;
			},
			onClose: (h) => {
				onClose = h;
			},
		};
		const client = new Client(transport);
		const hello = await client.call("hello");
		return {
			kind: "modal",
			client,
			label: `modal ${sb.sandboxId.slice(0, 10)}`,
			home: hello.home,
			async dispose() {
				// Terminating the sandbox ends the agent too; closing stdin first
				// waits on the output stream for seconds.
				await sb.terminate().catch(() => {});
				modal.close();
			},
		};
	} catch (e) {
		await sb.terminate().catch(() => {});
		modal.close();
		throw e;
	}
}

export async function startE2B(cwd: string, config: SbConfig, progress: Progress): Promise<Backend> {
	const { Sandbox } = await import("e2b");
	const ec = config.remote.e2b;
	progress("e2b: creating sandbox");
	const sb = await Sandbox.create(ec.template, {
		apiKey: ec.apiKey ?? process.env.E2B_API_KEY,
		timeoutMs: ec.timeoutMinutes * 60_000,
	});
	try {
		progress("e2b: uploading workspace");
		const ws = packWorkspace(cwd, config);
		const toAB = (p: string) => {
			const b = readFileSync(p);
			return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
		};
		await sb.files.write("/tmp/pi-sb-sbx", toAB(sbxBinary(config, "linux", "amd64")), { user: "root" } as any);
		await sb.files.write("/tmp/pi-sb-ws.tgz", toAB(ws.path), { user: "root" } as any);
		rmSync(ws.path, { force: true });
		await sb.commands.run(`mv /tmp/pi-sb-sbx ${REMOTE_BIN} && ${setupScript(cwd).replace(/\n/g, " && ").replace("set -e && ", "")}`, {
			user: "root",
			timeoutMs: 120_000,
		});
		progress("e2b: starting agent");
		let onLine: (l: string) => void = () => {};
		let onClose: (r: string) => void = () => {};
		const split = lineSplitter((l) => onLine(l));
		const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
		const handle = await sb.commands.run(serveArgs(cwd, config).map(q).join(" "), {
			background: true,
			stdin: true,
			user: "root",
			cwd,
			timeoutMs: 0,
			onStdout: (d: string) => split(d),
		});
		handle.wait().then(
			() => onClose("remote agent exited"),
			(e: Error) => onClose(`remote agent failed: ${e.message}`),
		);
		const input = sb.commands.streamInput(handle.pid);
		const client = new Client({
			send: (line) => input.send(line),
			onLine: (h) => {
				onLine = h;
			},
			onClose: (h) => {
				onClose = h;
			},
		});
		const hello = await client.call("hello");
		return {
			kind: "e2b",
			client,
			label: `e2b ${sb.sandboxId.slice(0, 10)}`,
			home: hello.home,
			async dispose() {
				await input.close().catch(() => {});
				await sb.kill().catch(() => {});
			},
		};
	} catch (e) {
		await sb.kill().catch(() => {});
		throw e;
	}
}

export interface PullResult {
	files: number;
	deleted: number;
	backup?: string;
}

/**
 * Copies the remote workspace's changes into the local cwd. Local files that
 * get overwritten or deleted are cloned to a backup directory first.
 */
export async function pull(client: Client, cwd: string, config: SbConfig): Promise<PullResult> {
	const res = await client.call("sync.export");
	const tar = Buffer.from(res.tar ?? "", "base64");
	const deleted: string[] = res.deleted ?? [];
	const tarPath = join(tmpdir(), `pi-sb-pull-${process.pid}-${Date.now()}.tgz`);
	writeFileSync(tarPath, tar);
	const list = spawnSync("tar", ["-tzf", tarPath], { maxBuffer: 1 << 28 });
	const entries = list.stdout
		.toString("utf8")
		.split("\n")
		.map((l) => l.replace(/\/$/, ""))
		.filter(Boolean);
	const safe = (rel: string) => {
		const n = normalize(rel);
		return n && !isAbsolute(n) && !n.startsWith("..") ? n : undefined;
	};
	const touched = [...entries, ...deleted].map(safe).filter((x): x is string => !!x);
	const backup = join(expandHome(config.root), "pulls", `${new Date().toISOString().replace(/[:.]/g, "-")}`);
	let backedUp = 0;
	for (const rel of touched) {
		const src = join(cwd, rel);
		if (!existsSync(src) || statSync(src).isDirectory()) continue;
		const dst = join(backup, rel);
		mkdirSync(dirname(dst), { recursive: true });
		cpSync(src, dst, { mode: fsConstants.COPYFILE_FICLONE });
		backedUp++;
	}
	if (entries.length) {
		const r = spawnSync("tar", ["-xzf", tarPath, "-C", cwd]);
		if (r.status !== 0) throw new Error(`extract failed: ${r.stderr}`);
	}
	rmSync(tarPath, { force: true });
	for (const rel of deleted) {
		const s = safe(rel);
		if (s) rmSync(join(cwd, s), { recursive: true, force: true });
	}
	return { files: res.files ?? 0, deleted: deleted.length, backup: backedUp ? backup : undefined };
}
