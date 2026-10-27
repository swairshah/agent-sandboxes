import { spawn } from "node:child_process";
import type { DispatchEnv, JobResult } from "./protocol.ts";

/** Amp's contract: every operation finishes within five minutes. */
const JOB_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT = 256 * 1024;

/**
 * Run a dispatch program once for one job, with the job in its environment and no arguments,
 * exactly as `amp orb provider` does, so the same program serves Amp and moonlet.
 */
export function runDispatch(script: string, env: DispatchEnv, onOutput?: (text: string) => void): Promise<JobResult> {
	return new Promise((resolve) => {
		const jobEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(env)) if (value !== undefined) jobEnv[key] = value;
		const child = spawn(script, [], { env: { ...process.env, ...jobEnv }, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		const collect = (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			onOutput?.(text);
			output = (output + text).slice(-MAX_OUTPUT);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		const timer = setTimeout(() => {
			output += `\ndispatch timed out after ${JOB_TIMEOUT_MS / 1000} s`;
			child.kill("SIGKILL");
		}, JOB_TIMEOUT_MS);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ ok: false, exitCode: null, output: `${output}\n${error.message}` });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ ok: code === 0, exitCode: code, output });
		});
	});
}

export interface JobSource {
	claim(): Promise<{ id: string; env: DispatchEnv } | undefined>;
	complete(id: string, result: JobResult): Promise<void>;
}

/** Pull jobs and run them, several orbs at once; the control plane keeps each orb's jobs in order. */
export async function runProvider(script: string, source: JobSource, log: (line: string) => void, concurrency = 8) {
	const running = new Set<Promise<void>>();
	for (;;) {
		while (running.size >= concurrency) await Promise.race(running);
		let job: Awaited<ReturnType<JobSource["claim"]>>;
		try {
			job = await source.claim();
		} catch (error) {
			log(`claim failed: ${error instanceof Error ? error.message : error}; retrying in 5 s`);
			await Bun.sleep(5_000);
			continue;
		}
		if (!job) continue;
		const { id, env } = job;
		log(`${env.ORB_OPERATION} ${env.ORB_ID} claimed`);
		const started = Date.now();
		const task = runDispatch(script, env, (text) => {
			for (const line of text.split("\n")) if (line.trim()) log(`  ${env.ORB_ID} › ${line}`);
		})
			.then(async (result) => {
				log(`${env.ORB_OPERATION} ${env.ORB_ID} ${result.ok ? "done" : `failed (exit ${result.exitCode})`} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
				for (let attempt = 0; ; attempt++) {
					try {
						await source.complete(id, result);
						return;
					} catch (error) {
						if (attempt >= 5) throw error;
						await Bun.sleep(1_000 * 2 ** attempt);
					}
				}
			})
			.catch((error) => log(`job ${id} failed to report: ${error}`))
			.finally(() => running.delete(task));
		running.add(task);
	}
}

/** Jobs from a remote control plane over HTTPS, for `moonlet provider`. */
export function httpJobSource(server: string, token: string): JobSource {
	const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
	return {
		async claim() {
			const response = await fetch(new URL("/api/provider/claim", server), { method: "POST", headers });
			if (response.status === 204) return undefined;
			if (!response.ok) throw new Error(`claim: HTTP ${response.status} ${await response.text()}`);
			return (await response.json()) as { id: string; env: DispatchEnv };
		},
		async complete(id, result) {
			const response = await fetch(new URL(`/api/provider/jobs/${id}`, server), { method: "POST", headers, body: JSON.stringify(result) });
			if (!response.ok) throw new Error(`complete: HTTP ${response.status}`);
		},
	};
}
