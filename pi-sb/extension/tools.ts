/**
 * pi's built-in tools, rewired so every file and process operation happens in
 * the sandbox. Paths are identical inside and outside, so no translation is
 * needed. Mutating tools checkpoint first.
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	DEFAULT_MAX_BYTES,
	type EditOperations,
	type FindOperations,
	formatSize,
	type LsOperations,
	type ReadOperations,
	truncateHead,
	truncateLine,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { Client } from "./rpc.ts";

export const SANDBOX_TOOLS = ["read", "write", "edit", "bash", "ls", "find", "grep"];

const IMAGE_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

function errnoError(e: unknown): Error {
	// pi checks for Node-style codes in a few places.
	const err = e instanceof Error ? e : new Error(String(e));
	const msg = err.message;
	const code = /no such file/.test(msg) ? "ENOENT" : /permission|not permitted/.test(msg) ? "EACCES" : undefined;
	if (code) Object.assign(err, { code });
	return err;
}

export function readOps(c: () => Client): ReadOperations {
	return {
		readFile: async (p) => {
			try {
				const r = await c().call("read", { path: p });
				return Buffer.from(r.data ?? "", "base64");
			} catch (e) {
				throw errnoError(e);
			}
		},
		access: async (p) => {
			try {
				await c().call("access", { path: p });
			} catch (e) {
				throw errnoError(e);
			}
		},
		detectImageMimeType: async (p) => IMAGE_TYPES[path.extname(p).toLowerCase()] ?? null,
	};
}

export function writeOps(c: () => Client): WriteOperations {
	return {
		writeFile: async (p, content) => {
			try {
				await c().call("write", { path: p, data: Buffer.from(content, "utf8").toString("base64") });
			} catch (e) {
				throw errnoError(e);
			}
		},
		mkdir: async (dir) => {
			try {
				await c().call("mkdir", { path: dir });
			} catch (e) {
				throw errnoError(e);
			}
		},
	};
}

export function editOps(c: () => Client): EditOperations {
	const r = readOps(c);
	const w = writeOps(c);
	return {
		readFile: r.readFile,
		writeFile: w.writeFile,
		access: async (p) => {
			try {
				await c().call("access", { path: p, write: true });
			} catch (e) {
				throw errnoError(e);
			}
		},
	};
}

export function bashOps(c: () => Client): BashOperations {
	return {
		exec: (command, cwd, { onData, signal, timeout }) =>
			new Promise((resolve, reject) => {
				if (signal?.aborted) return reject(new Error("aborted"));
				const client = c();
				const { id, done } = client.start("exec", { cmd: command, cwd, timeout: timeout ?? 0 }, onData);
				const onAbort = () => client.call("cancel", { target: id }).catch(() => {});
				signal?.addEventListener("abort", onAbort, { once: true });
				done.then(
					(r) => {
						signal?.removeEventListener("abort", onAbort);
						if (r.aborted || signal?.aborted) reject(new Error("aborted"));
						else if (r.timedOut) reject(new Error(`timeout:${timeout}`));
						else resolve({ exitCode: r.exit ?? null });
					},
					(e) => {
						signal?.removeEventListener("abort", onAbort);
						reject(e);
					},
				);
			}),
	};
}

function lsOps(c: () => Client): LsOperations {
	// pi stats every entry after listing; answer those from the listing.
	const kinds = new Map<string, boolean>();
	return {
		exists: async (p) => {
			const r = await c().call("stat", { path: p });
			if (r.exists) kinds.set(p, r.dir);
			return !!r.exists;
		},
		stat: async (p) => {
			let dir = kinds.get(p);
			if (dir === undefined) {
				const r = await c().call("stat", { path: p });
				if (!r.exists) throw errnoError(new Error(`no such file or directory: ${p}`));
				dir = !!r.dir;
			}
			const isDir = dir;
			return { isDirectory: () => isDir };
		},
		readdir: async (p) => {
			const r = await c().call("lsdir", { path: p });
			const names: string[] = [];
			for (const e of r.entries ?? []) {
				kinds.set(path.join(p, e.n), !!e.d);
				names.push(e.n);
			}
			return names;
		},
	};
}

function findOps(c: () => Client): FindOperations {
	return {
		exists: async (p) => !!(await c().call("stat", { path: p })).exists,
		glob: async (pattern, cwd, options) => {
			const r = await c().call("glob", { pattern, path: cwd, limit: options.limit, ignore: options.ignore });
			return r.paths ?? [];
		},
	};
}

/** grep has no pluggable search, so format sbx's results the way pi does. */
async function sandboxGrep(c: Client, cwd: string, params: any) {
	const p = params.path ? (path.isAbsolute(params.path) ? params.path : path.resolve(cwd, params.path)) : cwd;
	const limit = Math.max(1, params.limit ?? 100);
	const r = await c.call("grep", {
		pattern: params.pattern,
		path: p,
		glob: params.glob,
		ignoreCase: !!params.ignoreCase,
		literal: !!params.literal,
		context: params.context ?? 0,
		limit,
	});
	if (!r.matches) return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
	let linesTruncated = false;
	const out: string[] = [];
	for (const l of r.lines as Array<{ p: string; n: number; s: string; t: string }>) {
		const { text, wasTruncated } = truncateLine(l.t.replace(/\r/g, ""));
		if (wasTruncated) linesTruncated = true;
		out.push(`${l.p}${l.s}${l.n}${l.s} ${text}`);
	}
	const truncation = truncateHead(out.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
	const details: Record<string, unknown> = {};
	const notices: string[] = [];
	if (r.limitReached) {
		details.matchLimitReached = limit;
		notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
	}
	if (linesTruncated) {
		details.linesTruncated = true;
		notices.push("Some lines truncated. Use read tool to see full lines");
	}
	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	let text = truncation.content;
	if (notices.length) text += `\n\n[${notices.join(". ")}]`;
	return { content: [{ type: "text" as const, text }], details: Object.keys(details).length ? details : undefined };
}

export interface ToolHooks {
	client: () => Client;
	/** Awaited before a tool may change files. */
	beforeMutation: (label: string, toolCallId: string, ctx: ExtensionContext) => Promise<void>;
}

function rel(cwd: string, p: string): string {
	const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
	const r = path.relative(cwd, abs);
	return r && !r.startsWith("..") ? r : abs;
}

function oneLine(s: string, n = 70): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * Registers the sandboxed tools. `rename` maps a built-in name to the name to
 * register under, for when another extension already owns the built-in name;
 * `only` limits which tools are registered.
 */
export function registerSandboxTools(
	pi: ExtensionAPI,
	cwd: string,
	hooks: ToolHooks,
	rename: (name: string) => string = (n) => n,
	only: string[] = SANDBOX_TOOLS,
) {
	const c = hooks.client;
	const read = createReadToolDefinition(cwd, { operations: readOps(c) });
	const write = createWriteToolDefinition(cwd, { operations: writeOps(c) });
	const edit = createEditToolDefinition(cwd, { operations: editOps(c) });
	const bash = createBashToolDefinition(cwd, { operations: bashOps(c) });
	const ls = createLsToolDefinition(cwd, { operations: lsOps(c) });
	const find = createFindToolDefinition(cwd, { operations: findOps(c) });
	const grep = createGrepToolDefinition(cwd);

	const grepDef: typeof grep = {
		...grep,
		async execute(_id, params) {
			return sandboxGrep(c(), cwd, params);
		},
	};
	const writeDef: typeof write = {
		...write,
		async execute(id, params, signal, onUpdate, ctx) {
			await hooks.beforeMutation(`write ${rel(cwd, params.path)}`, id, ctx);
			return write.execute(id, params, signal, onUpdate, ctx);
		},
	};
	const editDef: typeof edit = {
		...edit,
		async execute(id, params, signal, onUpdate, ctx) {
			await hooks.beforeMutation(`edit ${rel(cwd, params.path)}`, id, ctx);
			return edit.execute(id, params, signal, onUpdate, ctx);
		},
	};
	const bashDef: typeof bash = {
		...bash,
		async execute(id, params, signal, onUpdate, ctx) {
			await hooks.beforeMutation(`bash: ${oneLine(params.command)}`, id, ctx);
			return bash.execute(id, params, signal, onUpdate, ctx);
		},
	};
	for (const def of [read, ls, find, grepDef, writeDef, editDef, bashDef] as Array<{ name: string; label: string }>) {
		if (!only.includes(def.name)) continue;
		const name = rename(def.name);
		pi.registerTool((name === def.name ? def : { ...def, name, label: `${def.label} (sandbox)` }) as any);
	}
}
