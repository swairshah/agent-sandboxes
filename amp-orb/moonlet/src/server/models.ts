import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

export interface ModelChoice {
	provider: string;
	modelId: string;
}

/** `provider/model`, e.g. `openai/gpt-6-sol` or `anthropic/claude-opus-5-5`. */
export function parseModel(spec: string): ModelChoice {
	const slash = spec.indexOf("/");
	if (slash <= 0) throw new Error(`Model must be provider/model, got ${spec}`);
	return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

/**
 * Credentials in one JSON file (provider → credential), compatible with the pi-durable examples'
 * `auth.json`. OAuth refreshes are written back; a lock directory keeps two writers apart.
 */
function fileCredentials(file: string): CredentialStore {
	const read = async (): Promise<Record<string, Credential>> => {
		try {
			return JSON.parse(await readFile(file, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error;
		}
	};
	let tail = Promise.resolve();
	const mutate = <T>(change: (values: Record<string, Credential>) => Promise<T>) => {
		const result = tail.then(async () => {
			const lock = `${file}.lock`;
			await mkdir(dirname(file), { recursive: true });
			await mkdir(lock, { mode: 0o700 });
			const temporary = `${file}.${crypto.randomUUID()}.tmp`;
			try {
				const values = await read();
				const value = await change(values);
				await writeFile(temporary, JSON.stringify(values, null, 2), { mode: 0o600, flag: "wx" });
				await rename(temporary, file);
				return value;
			} finally {
				await rm(temporary, { force: true });
				await rm(lock, { recursive: true, force: true });
			}
		});
		tail = result.then(
			() => {},
			() => {},
		);
		return result;
	};
	return {
		async read(providerId) {
			return (await read())[providerId];
		},
		async list() {
			return Object.entries(await read()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
		},
		modify(providerId, change) {
			return mutate(async (values) => {
				const updated = await change(values[providerId]);
				if (updated !== undefined) values[providerId] = updated;
				return values[providerId];
			});
		},
		delete(providerId) {
			return mutate(async (values) => {
				delete values[providerId];
			});
		},
	};
}

/**
 * Models with OpenAI and Anthropic. Credentials come from `authFile` when given (for example a
 * ChatGPT subscription login), and otherwise from OPENAI_API_KEY / ANTHROPIC_API_KEY.
 */
export function openModels(authFile: string | undefined, model: ModelChoice) {
	const models = createModels(authFile ? { credentials: fileCredentials(authFile) } : {});
	models.setProvider(openaiProvider());
	models.setProvider(anthropicProvider());
	if (models.getModel(model.provider, model.modelId) === undefined) {
		throw new Error(`Unknown model ${model.provider}/${model.modelId}`);
	}
	return models;
}
