/**
 * Configuration lives only in ~/.pi/agent/sb.json. A project-local file would
 * sit inside the sandbox's writable directory, letting the agent widen its own
 * permissions for the next session. Per-project overrides go under "projects".
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface CheckpointConfig {
	keepLast: number;
	keepDays: number;
	excludeCwd: string[];
	excludeHome: string[];
}

export interface RemoteConfig {
	provider?: "modal" | "e2b";
	/** "git": tracked + untracked-but-not-ignored files and .git; "all": everything not excluded. */
	upload: "git" | "all";
	exclude: string[];
	/** What to do with the agent's changes when the session ends. */
	pullOnExit: "ask" | "always" | "never";
	modal: {
		tokenId?: string;
		tokenSecret?: string;
		app: string;
		image: string;
		cpu?: number;
		memoryMiB?: number;
		timeoutMinutes: number;
	};
	e2b: {
		apiKey?: string;
		template: string;
		timeoutMinutes: number;
	};
}

export interface SbConfig {
	read: string[];
	write: string[];
	deny: string[];
	protect: string[];
	network: "on" | "local";
	env: Record<string, string>;
	seed: string[];
	shell: string;
	root: string;
	/** Extra (non-sandboxed) tools to keep active in --sb mode. */
	allowHostTools: string[];
	checkpoint: CheckpointConfig;
	remote: RemoteConfig;
	/** Path to the sbx binary directory, if not next to the extension. */
	binDir?: string;
}

// Toolchains commonly installed under $HOME. Reading them lets node, cargo,
// uv-managed pythons and friends run inside the box. Credential files under
// them are denied below.
const TOOLCHAIN_READS = [
	"~/.nvm",
	"~/.cargo/bin",
	"~/.rustup",
	"~/.local/bin",
	"~/.local/share/uv/python",
	"~/.local/share/uv/tools",
	"~/.bun/bin",
	"~/.deno/bin",
	"~/.volta",
	"~/.pyenv",
	"~/go",
	"~/.sdkman/candidates",
];

export const DEFAULTS: SbConfig = {
	read: [],
	write: [],
	deny: [],
	protect: [".pi", ".envrc"],
	network: "on",
	env: {},
	seed: ["~/.gitconfig"],
	shell: "/bin/bash",
	root: "~/.pi/sb",
	allowHostTools: [],
	checkpoint: {
		keepLast: 500,
		keepDays: 14,
		excludeCwd: [],
		excludeHome: [".cache", ".npm/_cacache", ".npm/_logs", ".cargo/registry", ".cargo/git", "Library/Caches", "go/pkg/mod"],
	},
	remote: {
		upload: "git",
		exclude: ["node_modules", ".venv", "venv", "__pycache__", "target", ".next", "dist", "build"],
		pullOnExit: "ask",
		modal: { app: "pi-sb", image: "node:22-bookworm", timeoutMinutes: 120 },
		e2b: { template: "base", timeoutMinutes: 60 },
	},
};

export function configPath(): string {
	return join(homedir(), ".pi", "agent", "sb.json");
}

function isObject(v: unknown): v is Record<string, any> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function merge<T>(base: T, over: unknown): T {
	if (!isObject(over)) return base;
	const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
	for (const [k, v] of Object.entries(over)) {
		out[k] = isObject(v) && isObject(out[k]) ? merge(out[k], v) : v;
	}
	return out;
}

export function loadConfig(cwd: string): { config: SbConfig; warnings: string[] } {
	const warnings: string[] = [];
	let file: any = {};
	const p = configPath();
	if (existsSync(p)) {
		try {
			file = JSON.parse(readFileSync(p, "utf8"));
		} catch (e) {
			warnings.push(`could not parse ${p}: ${(e as Error).message}`);
		}
	}
	const { projects, ...rest } = isObject(file) ? file : ({} as any);
	let config = merge(DEFAULTS, rest);
	if (isObject(projects)) {
		const here = resolve(cwd);
		// The most specific matching project wins.
		const keys = Object.keys(projects)
			.filter((k) => {
				const kp = resolve(expandHome(k));
				return here === kp || here.startsWith(`${kp}/`);
			})
			.sort((a, b) => a.length - b.length);
		for (const k of keys) config = merge(config, projects[k]);
	}
	// Arrays in the file replace defaults, except reads: the toolchain list is
	// always added so a short "read" list does not break node or cargo.
	config.read = [...new Set([...TOOLCHAIN_READS, ...config.read])];
	config.deny = [...new Set(["~/.cargo/credentials", "~/.cargo/credentials.toml", ...config.deny])];
	return { config, warnings };
}

export function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

/** Credentials for a remote provider, from sb.json, the environment, or the provider's own config. */
export function remoteCredentials(config: SbConfig): { provider: "modal" | "e2b"; reason: string } | { error: string } {
	const modal =
		(config.remote.modal.tokenId && config.remote.modal.tokenSecret) ||
		(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET) ||
		existsSync(join(homedir(), ".modal.toml"));
	const e2b = config.remote.e2b.apiKey || process.env.E2B_API_KEY;
	const want = config.remote.provider;
	if (want === "modal") return modal ? { provider: "modal", reason: "remote.provider" } : { error: "remote.provider is modal but no Modal credentials were found (sb.json remote.modal.tokenId/tokenSecret, MODAL_TOKEN_ID/SECRET, or ~/.modal.toml)" };
	if (want === "e2b") return e2b ? { provider: "e2b", reason: "remote.provider" } : { error: "remote.provider is e2b but no E2B key was found (sb.json remote.e2b.apiKey or E2B_API_KEY)" };
	if (modal) return { provider: "modal", reason: "Modal credentials found" };
	if (e2b) return { provider: "e2b", reason: "E2B key found" };
	return { error: "--remote needs Modal or E2B credentials: set remote.modal.tokenId/tokenSecret or remote.e2b.apiKey in ~/.pi/agent/sb.json (or MODAL_TOKEN_ID/MODAL_TOKEN_SECRET, ~/.modal.toml, E2B_API_KEY)" };
}
