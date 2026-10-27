/**
 * pi-sb: `pi --sb` runs every built-in tool inside a sandbox and checkpoints
 * the sandbox before each change, so any change (including `rm -rf`) can be
 * undone with /sb.
 *
 *   pi --sb            macOS Seatbelt box; cwd read/write at its real path
 *   pi --sb --remote   Modal or E2B sandbox; pi stays local, tools run remotely
 *
 * Config: ~/.pi/agent/sb.json (see README). Checkpoints are also manageable
 * from a terminal with `sbx ckpt ls|diff|restore|rm`.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, remoteCredentials, type SbConfig } from "./config.ts";
import { type Backend, startLocal } from "./local.ts";
import { pull, startE2B, startModal } from "./remote.ts";
import { type Client, debug } from "./rpc.ts";
import { bashOps, registerSandboxTools, SANDBOX_TOOLS } from "./tools.ts";

interface Ckpt {
	id: number;
	epoch: number;
	time: string;
	label: string;
	kind: string;
	meta?: Record<string, string>;
	stats: { paths: number; bytes: number; ms: number };
}

const argv = process.argv.slice(2);
const SB = argv.includes("--sb");

export default function (pi: ExtensionAPI) {
	pi.registerFlag("sb", { description: "Run tools in a sandbox with checkpoints (see /sb)", type: "boolean", default: false });
	pi.registerFlag("remote", { description: "With --sb: run tools in a Modal or E2B sandbox", type: "boolean", default: false });
	// Only take over the built-in tools when asked to; otherwise stay out of
	// the way of other extensions that override them.
	if (!SB) return;

	const cwd = process.cwd();
	let config: SbConfig;
	let backend: Backend | undefined;
	let starting: Promise<Backend> | undefined;
	let startError: Error | undefined;
	let lastCkpt: Ckpt | undefined;
	let ui: ExtensionContext["ui"] | undefined;

	const client = (): Client => {
		if (!backend) throw new Error(startError ? `sandbox failed to start: ${startError.message}` : "sandbox is not running");
		return backend.client;
	};
	const ready = async (): Promise<Backend> => {
		if (backend) return backend;
		if (starting) return starting;
		throw startError ?? new Error("sandbox is not running");
	};

	const status = () => {
		if (!ui) return;
		if (!backend) {
			ui.setStatus("sb", ui.theme.fg(startError ? "error" : "warning", startError ? "sb: failed" : "sb: starting"));
			return;
		}
		const last = lastCkpt ? ` · #${lastCkpt.id} ${lastCkpt.stats.ms.toFixed(0)}ms` : "";
		ui.setStatus("sb", ui.theme.fg("accent", `🔒 sb ${backend.label}${last}`));
	};

	async function checkpoint(label: string, meta: Record<string, string>, kind = "auto"): Promise<Ckpt | undefined> {
		const b = await ready();
		const r = await b.client.call("ckpt.create", { label, kind, meta });
		if (r.ckpt) {
			lastCkpt = r.ckpt;
			status();
		}
		return r.ckpt ?? undefined;
	}

	async function beforeMutation(label: string, toolCallId: string, ctx: ExtensionContext) {
		debug("#", `beforeMutation ${label}`);
		try {
			const entryId = ctx.sessionManager.getLeafEntry()?.id ?? "";
			await checkpoint(`before ${label}`, { toolCallId, entryId });
		} catch (e) {
			// A failed checkpoint must not silently look like a safe one.
			ctx.ui.notify(`sb: checkpoint failed: ${(e as Error).message}`, "error");
			throw new Error(`sandbox checkpoint failed, refusing to run: ${(e as Error).message}`);
		}
	}

	const self = dirname(fileURLToPath(import.meta.url));
	const ownedBySelf = (t: { sourceInfo?: { path: string } }) => !!t.sourceInfo?.path && t.sourceInfo.path.startsWith(self);

	/**
	 * Tools are registered at session start rather than at load, so another
	 * extension that also overrides edit/write (a diff viewer, say) does not
	 * make pi refuse to start. pi keeps the first registration of a name, in
	 * extension load order; if another extension got there first, its tool
	 * would run on the host, so it is deactivated and ours is offered under an
	 * sb_ name instead.
	 */
	function installTools(ctx: ExtensionContext): string[] {
		const hooks = { client, beforeMutation };
		registerSandboxTools(pi, cwd, hooks);
		const owner = new Map(pi.getAllTools().map((t) => [t.name, t]));
		const shadowed = SANDBOX_TOOLS.filter((n) => owner.has(n) && !ownedBySelf(owner.get(n)!));
		debug("#", `tool owners: ${SANDBOX_TOOLS.map((n) => `${n}=${owner.get(n)?.sourceInfo?.path ?? "?"}`).join(" ")}`);
		if (shadowed.length) {
			registerSandboxTools(pi, cwd, hooks, (n) => `sb_${n}`, shadowed);
			const owners = [...new Set(shadowed.map((n) => owner.get(n)!.sourceInfo.path))];
			ctx.ui.notify(
				`sb: ${shadowed.join(", ")} ${shadowed.length === 1 ? "is" : "are"} owned by ${owners.join(", ")}, which loads before pi-sb. ` +
					`Those host tools are disabled; the sandboxed versions are named ${shadowed.map((n) => `sb_${n}`).join(", ")}. ` +
					"Load pi-sb first (list it first in settings.json \"extensions\", or pi -e) to keep the normal names.",
				"warning",
			);
		}
		return SANDBOX_TOOLS.map((n) => (shadowed.includes(n) ? `sb_${n}` : n));
	}

	pi.on("session_start", async (_event, ctx) => {
		debug("#", "session_start");
		ui = ctx.ui;
		const sandboxTools = installTools(ctx);
		const loaded = loadConfig(cwd);
		config = loaded.config;
		for (const w of loaded.warnings) ctx.ui.notify(`sb: ${w}`, "warning");
		if (existsSync(join(cwd, ".git"))) config.protect = [...new Set([...config.protect, ".git/hooks", ".git/config"])];

		// Other extensions' tools run on the host, outside the sandbox.
		const allowed = new Set([...sandboxTools, ...config.allowHostTools]);
		const active = pi.getActiveTools();
		const disabled = active.filter((t) => !allowed.has(t));
		pi.setActiveTools([...new Set([...active.filter((t) => allowed.has(t)), ...sandboxTools])]);
		if (disabled.length) {
			ctx.ui.notify(`sb: disabled host tools that would bypass the sandbox: ${disabled.join(", ")} (allow with allowHostTools)`, "info");
		}

		const remote = pi.getFlag("remote") === true || argv.includes("--remote");
		status();
		starting = (async () => {
			if (!remote) return startLocal(cwd, config);
			const cred = remoteCredentials(config);
			if ("error" in cred) throw new Error(cred.error);
			const progress = (m: string) => ctx.ui.setStatus("sb", ctx.ui.theme.fg("warning", `sb: ${m}`));
			return cred.provider === "modal" ? startModal(cwd, config, progress) : startE2B(cwd, config, progress);
		})();
		try {
			const t = performance.now();
			backend = await starting;
			debug("#", `backend ready: ${backend.label}`);
			const ms = performance.now() - t;
			status();
			if (backend.kind === "local") {
				ctx.ui.notify(`sb: sandbox ready in ${ms.toFixed(0)}ms (box ${backend.box?.id}); /sb to list or restore checkpoints`, "info");
			} else {
				ctx.ui.notify(`sb: ${backend.label} ready in ${(ms / 1000).toFixed(1)}s; /sb pull copies changes back`, "info");
			}
		} catch (e) {
			startError = e as Error;
			status();
			ctx.ui.notify(`sb: ${startError.message}`, "error");
		} finally {
			starting = undefined;
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (!backend) return;
		const lines =
			backend.kind === "local"
				? [
						"Sandbox: your tool calls run in a macOS sandbox.",
						`- You can read and write files under ${cwd}. Other paths are read-only or invisible.`,
						`- $HOME is a private sandbox home (${backend.home}). Install tools there: npm i -g, pip install --user, uv tool, cargo install. Homebrew and other system package managers cannot write.`,
						config.network === "local" ? "- Network: localhost only." : "- Network: available.",
						"- Every change is checkpointed, so the user can undo anything you do.",
					]
				: [
						`Sandbox: your tool calls run in a remote Linux sandbox (${backend.kind}). ${cwd} there is a copy of the user's project.`,
						"- You are root; apt-get and other package managers work.",
						"- Changes stay in the sandbox until the user pulls them back.",
					];
		return { systemPrompt: `${event.systemPrompt}\n\n${lines.join("\n")}` };
	});

	pi.on("user_bash", async (_event, ctx) => {
		await ready();
		await beforeMutation("! command", "", ctx);
		return { operations: bashOps(client) };
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!backend) return;
		try {
			await checkpoint("end of turn", { entryId: ctx.sessionManager.getLeafEntry()?.id ?? "" });
		} catch {}
	});

	// Navigating the session tree offers to bring files back to that point.
	pi.on("session_tree", async (event, ctx) => {
		if (!backend || !ctx.hasUI || !event.newLeafId) return;
		const branch = new Set(ctx.sessionManager.getBranch().map((e: any) => e.id));
		const list = await listCkpts();
		const match = [...list].reverse().find((c) => c.meta?.entryId && branch.has(c.meta.entryId));
		if (!match || match.id === list[list.length - 1]?.id) return;
		const ok = await ctx.ui.confirm("Restore files?", `Restore the sandbox to checkpoint #${match.id} (${match.label}), the last one on this branch?`);
		if (ok) await restore(match.id, ctx);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		const b = backend;
		backend = undefined;
		if (!b) return;
		if (b.kind !== "local" && event.reason === "quit") {
			const mode = config.remote.pullOnExit;
			let doPull = mode === "always";
			if (mode === "ask" && ctx.hasUI) {
				doPull = await ctx.ui.confirm("Pull changes?", "Copy the remote sandbox's changes into your local directory before it is destroyed?");
			}
			if (doPull) {
				try {
					const r = await pull(b.client, cwd, config);
					ctx.ui.notify(`sb: pulled ${r.files} files, ${r.deleted} deletions${r.backup ? `; overwritten files backed up to ${r.backup}` : ""}`, "info");
				} catch (e) {
					ctx.ui.notify(`sb: pull failed: ${(e as Error).message}`, "error");
				}
			}
		}
		await b.dispose();
	});

	async function listCkpts(): Promise<Ckpt[]> {
		const b = await ready();
		const r = await b.client.call("ckpt.list");
		return r.ckpts ?? [];
	}

	function fmt(c: Ckpt, epoch: number): string {
		const t = new Date(c.time);
		const time = t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
		const day = c.epoch === epoch ? "" : `${t.toLocaleDateString([], { month: "short", day: "numeric" })} `;
		const paths = c.stats.paths ? ` (${c.stats.paths} path${c.stats.paths === 1 ? "" : "s"})` : "";
		return `#${c.id}  ${day}${time}  ${c.label}${paths}`;
	}

	async function restore(id: number, ctx: ExtensionContext) {
		const b = await ready();
		const t = performance.now();
		const r = await b.client.call("ckpt.restore", { ckpt: id });
		lastCkpt = r.ckpt ?? lastCkpt;
		status();
		ctx.ui.notify(`sb: restored #${id} in ${(performance.now() - t).toFixed(0)}ms (undo with /sb undo)`, "info");
	}

	async function preview(id: number): Promise<string> {
		const b = await ready();
		const r = await b.client.call("ckpt.changed", { ckpt: id });
		if (r.whole) return "This checkpoint is from an earlier session; the whole directory will be rebuilt.";
		const paths: string[] = r.paths ?? [];
		if (!paths.length) return "Nothing has changed since this checkpoint.";
		const shown = paths.slice(0, 12).map((p) => `  ${p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p}`);
		return `${paths.length} path(s) will change:\n${shown.join("\n")}${paths.length > 12 ? `\n  … and ${paths.length - 12} more` : ""}`;
	}

	async function parseIds(args: string[], list: Ckpt[]): Promise<number[]> {
		const all = list.map((c) => c.id);
		const out: number[] = [];
		for (const a of args.join(",").split(",").filter(Boolean)) {
			if (a === "all") out.push(...all);
			else if (/^#?\d+-#?\d+$/.test(a)) {
				const [lo, hi] = a.replace(/#/g, "").split("-").map(Number);
				out.push(...all.filter((id) => id >= lo && id <= hi));
			} else if (/^#?\d+$/.test(a)) out.push(Number(a.replace("#", "")));
			else throw new Error(`bad checkpoint id "${a}"`);
		}
		return out;
	}

	const HELP = [
		"/sb                 pick a checkpoint to restore, inspect or delete",
		"/sb ls              list checkpoints",
		"/sb restore <id>    restore the sandbox to a checkpoint",
		"/sb undo            undo the last restore",
		"/sb diff <id>       paths changed since a checkpoint",
		"/sb rm <ids>        delete checkpoints: 5  3-9  2,4  all",
		"/sb keep <n>        keep only the newest n checkpoints",
		"/sb save [label]    take a checkpoint now",
		"/sb status          sandbox details",
		"/sb pull            (remote) copy the sandbox's changes to the local directory",
	].join("\n");

	pi.registerCommand("sb", {
		description: "Sandbox checkpoints: list, restore, undo, delete",
		handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
			const [sub = "", ...args] = (rawArgs ?? "").trim().split(/\s+/).filter(Boolean);
			try {
				const b = await ready();
				const list = await listCkpts();
				const epoch = list.length ? list[list.length - 1].epoch : 0;
				switch (sub) {
					case "help":
						ctx.ui.notify(HELP, "info");
						return;
					case "ls":
					case "list": {
						const lines = list.slice(-40).reverse().map((c) => fmt(c, epoch));
						ctx.ui.notify(lines.length ? lines.join("\n") : "no checkpoints yet", "info");
						return;
					}
					case "status": {
						const usage = await b.client.call("ckpt.usage");
						const box = b.box;
						ctx.ui.notify(
							[
								`sandbox: ${b.label}${box ? ` (box ${box.id})` : ""}`,
								`cwd: ${cwd} (read/write)`,
								`home: ${b.home}`,
								b.kind === "local" ? `readable: ${config.read.join(", ")}` : "",
								b.kind === "local" ? `protected: ${config.protect.join(", ")}` : "",
								`checkpoints: ${list.length} (keep last ${config.checkpoint.keepLast}, ${config.checkpoint.keepDays} days)`,
								`store: ${box?.store ?? "remote"}: ${(usage.bytes / 1e6).toFixed(1)} MB logical in ${usage.files} files (APFS clones share blocks with live files)`,
							]
								.filter(Boolean)
								.join("\n"),
							"info",
						);
						return;
					}
					case "save": {
						const c = await checkpoint(args.join(" ") || "manual checkpoint", {}, "manual");
						ctx.ui.notify(c ? `sb: checkpoint #${c.id} (${c.stats.paths} paths, ${c.stats.ms.toFixed(1)}ms)` : "sb: nothing changed since the last checkpoint", "info");
						return;
					}
					case "restore": {
						const [id] = await parseIds(args, list);
						if (!id) throw new Error("usage: /sb restore <id>");
						if (ctx.hasUI && !(await ctx.ui.confirm(`Restore #${id}?`, await preview(id)))) return;
						await restore(id, ctx);
						return;
					}
					case "undo": {
						const last = [...list].reverse().find((c) => c.kind === "restore");
						if (!last) throw new Error("no restore to undo");
						const before = [...list].reverse().find((c) => c.id < last.id && c.label.startsWith("before restore"));
						const target = before ?? list.filter((c) => c.id < last.id).pop();
						if (!target) throw new Error("nothing to go back to");
						await restore(target.id, ctx);
						return;
					}
					case "diff": {
						const [id] = await parseIds(args, list);
						if (!id) throw new Error("usage: /sb diff <id>");
						ctx.ui.notify(await preview(id), "info");
						return;
					}
					case "rm":
					case "delete": {
						const ids = await parseIds(args, list);
						if (!ids.length) throw new Error("usage: /sb rm <ids>");
						const r = await b.client.call("ckpt.delete", { ids });
						ctx.ui.notify(`sb: deleted ${r.deleted} checkpoint(s); later checkpoints still restore exactly`, "info");
						return;
					}
					case "keep": {
						const n = Number(args[0]);
						if (!Number.isInteger(n) || n < 0) throw new Error("usage: /sb keep <n>");
						const ids = list.slice(0, Math.max(0, list.length - n)).map((c) => c.id);
						const r = await b.client.call("ckpt.delete", { ids });
						ctx.ui.notify(`sb: deleted ${r.deleted} checkpoint(s)`, "info");
						return;
					}
					case "pull": {
						if (b.kind === "local") throw new Error("pull is for --remote sandboxes; local changes are already in place");
						const r = await pull(b.client, cwd, config);
						ctx.ui.notify(`sb: pulled ${r.files} files, ${r.deleted} deletions${r.backup ? `; overwritten files backed up to ${r.backup}` : ""}`, "info");
						return;
					}
					case "": {
						if (!ctx.hasUI) {
							ctx.ui.notify(HELP, "info");
							return;
						}
						const recent = list.slice(-60).reverse();
						const choice = await ctx.ui.select("Sandbox checkpoints (newest first)", recent.map((c) => fmt(c, epoch)));
						if (!choice) return;
						const id = Number(choice.match(/^#(\d+)/)?.[1]);
						const action = await ctx.ui.select(`Checkpoint #${id}`, [
							"Restore to this checkpoint",
							"Show what changed since",
							"Delete this checkpoint",
							"Delete this and all older checkpoints",
						]);
						if (!action) return;
						if (action.startsWith("Restore")) {
							if (await ctx.ui.confirm(`Restore #${id}?`, await preview(id))) await restore(id, ctx);
						} else if (action.startsWith("Show")) {
							ctx.ui.notify(await preview(id), "info");
						} else {
							const ids = action.includes("older") ? list.filter((c) => c.id <= id).map((c) => c.id) : [id];
							const r = await b.client.call("ckpt.delete", { ids });
							ctx.ui.notify(`sb: deleted ${r.deleted} checkpoint(s)`, "info");
						}
						return;
					}
					default:
						ctx.ui.notify(HELP, "info");
				}
			} catch (e) {
				ctx.ui.notify(`sb: ${(e as Error).message}`, "error");
			}
		},
	});

}
