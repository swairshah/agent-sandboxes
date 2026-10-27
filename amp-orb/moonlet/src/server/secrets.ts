import { type ToolRegistration, wrapTool } from "@earendil-works/pi-durable";
import type { Store } from "./store.ts";

/** Values shorter than this are not masked: they would match ordinary text. */
const MIN_MASKED_LENGTH = 6;

/**
 * Secrets and env vars, set on the control plane (`moonlet secrets set`) and given to every process in every orb
 * through the environment of its pi-env daemon, so they never land on an orb's disk.
 */
export function orbEnv(store: Store): Record<string, string> {
	const env: Record<string, string> = {};
	const names: string[] = [];
	for (const row of store.secrets()) {
		env[row.name] = row.value;
		if (row.secret) names.push(row.name);
	}
	env.MOONLET_SECRET_NAMES = names.join(",");
	// A GitHub token also authenticates git (clone, push) and gh, through git's environment config.
	const github = env.GITHUB_TOKEN ?? env.GH_TOKEN;
	if (github) {
		env.GH_TOKEN ??= github;
		env.GIT_CONFIG_COUNT = "1";
		env.GIT_CONFIG_KEY_0 = "credential.https://github.com.helper";
		env.GIT_CONFIG_VALUE_0 = '!f() { test "$1" = get && echo username=x-access-token && echo "password=${GITHUB_TOKEN:-$GH_TOKEN}"; }; f';
	}
	return env;
}

/** Replace every secret value in `text` with `[secret NAME]`. */
export function masker(store: Store): (text: string) => string {
	return (text) => {
		for (const row of store.secrets()) {
			if (row.secret && row.value.length >= MIN_MASKED_LENGTH && text.includes(row.value)) text = text.split(row.value).join(`[secret ${row.name}]`);
		}
		return text;
	};
}

/** Wrap `tool` so its output, live and final, never shows a secret value to the model or the transcript. */
export function maskTool<Tool extends ToolRegistration>(tool: Tool, mask: (text: string) => string) {
	return wrapTool(tool, (inner) => ({
		...inner,
		async execute(args: never, api: never, context: never) {
			const base = api as Parameters<ToolRegistration["execute"]>[1];
			const masked = {
				...base,
				output: (chunk: string | Uint8Array) => base.output(mask(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))),
				// Masked text cannot take the environment's skipped-output windowing.
				outputWindow: undefined,
			};
			const result = await inner.execute(args, masked as never, context);
			if (!result.output) return result;
			return { ...result, output: result.output.map((item) => (item.type === "text" ? { ...item, text: mask(item.text) } : item)) as typeof result.output };
		},
	}) as Tool);
}

