import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { DispatchEnv, JobResult } from "../protocol.ts";

/**
 * The control plane's own bookkeeping: threads, orbs and dispatch jobs. Conversations
 * themselves live in pi-durable's storage; a thread points at its conversation.
 */

export type OrbStatus = "none" | "spawning" | "running" | "pausing" | "paused" | "deleting" | "deleted" | "error";

export interface ThreadRow {
	id: string;
	/** pi-durable conversation id. */
	conversation_id: number;
	orb_id: string;
	title: string;
	repo: string | null;
	/** Directory on the user's machine that the thread's `local_*` tools read, for threads started from pi. */
	local_cwd: string | null;
	created_at: number;
}

export interface OrbRow {
	id: string;
	status: OrbStatus;
	generation: number;
	image: string;
	setup_done: number;
	/** Working directory in the orb, known once setup ran. */
	workspace: string | null;
	/** Commit the workspace started from: its changes are relative to this. */
	base: string | null;
	/** small | medium | large | xlarge; null is the default. */
	size: string | null;
	/** Project snapshot the orb was created from, if any. */
	snapshot_id: string | null;
	paused_at: number | null;
	/** How deeply a paused orb is paused: `freeze` or `stop`. */
	pause_depth: string | null;
	last_error: string | null;
	updated_at: number;
}

export interface JobRow {
	id: string;
	orb_id: string;
	operation: DispatchEnv["ORB_OPERATION"];
	env: string;
	status: "queued" | "claimed" | "done" | "failed";
	output: string | null;
	created_at: number;
	claimed_at: number | null;
	finished_at: number | null;
}

export interface PortalRow {
	orb_id: string;
	/** Port on the orb's loopback. */
	port: number;
	/** Port on the control plane's machine that forwards to it. */
	public_port: number;
	created_at: number;
}

/** A supervised process in an orb: declared in `.amp/services.yaml` (or `.moonlet/services.yaml`), or ad hoc. */
export interface ServiceRow {
	orb_id: string;
	name: string;
	command: string;
	cwd: string | null;
	/** The port it listens on (`$PORT`), if it is a server. */
	port: number | null;
	/** JSON object of extra environment variables. */
	env: string | null;
	/** HTTP path that answers 2xx/3xx once it is ready. */
	health: string | null;
	/** Whether it gets a portal. */
	portal: number;
	/** 1 when it comes from services.yaml: removed from the file, it is stopped and dropped. */
	declared: number;
	created_at: number;
}

export interface SecretRow {
	name: string;
	value: string;
	/** 1: masked in tool output and never returned by the API. */
	secret: number;
	updated_at: number;
}

/** A message sent to a thread at `next_at`, and again every `every_ms` if set. */
export interface ScheduleRow {
	id: string;
	thread_id: string;
	next_at: number;
	every_ms: number | null;
	message: string;
	created_at: number;
}

export class Store {
	readonly db: Database;

	constructor(path: string) {
		this.db = new Database(path, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS threads (
				id TEXT PRIMARY KEY,
				conversation_id INTEGER NOT NULL,
				orb_id TEXT NOT NULL,
				title TEXT NOT NULL,
				repo TEXT,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS orbs (
				id TEXT PRIMARY KEY,
				status TEXT NOT NULL,
				generation INTEGER NOT NULL DEFAULT 0,
				image TEXT NOT NULL,
				setup_done INTEGER NOT NULL DEFAULT 0,
				workspace TEXT,
				last_error TEXT,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS jobs (
				id TEXT PRIMARY KEY,
				orb_id TEXT NOT NULL,
				operation TEXT NOT NULL,
				env TEXT NOT NULL,
				status TEXT NOT NULL,
				output TEXT,
				created_at INTEGER NOT NULL,
				claimed_at INTEGER,
				finished_at INTEGER
			);
			CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, created_at);
			CREATE TABLE IF NOT EXISTS snapshots (
				repo TEXT PRIMARY KEY,
				id TEXT NOT NULL,
				workspace TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS schedules (
				id TEXT PRIMARY KEY,
				thread_id TEXT NOT NULL,
				next_at INTEGER NOT NULL,
				every_ms INTEGER,
				message TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS secrets (
				name TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				secret INTEGER NOT NULL DEFAULT 1,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS services (
				orb_id TEXT NOT NULL,
				name TEXT NOT NULL,
				command TEXT NOT NULL,
				cwd TEXT,
				port INTEGER,
				env TEXT,
				health TEXT,
				portal INTEGER NOT NULL DEFAULT 1,
				declared INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				PRIMARY KEY (orb_id, name)
			);
			CREATE TABLE IF NOT EXISTS portals (
				orb_id TEXT NOT NULL,
				port INTEGER NOT NULL,
				public_port INTEGER NOT NULL UNIQUE,
				created_at INTEGER NOT NULL,
				PRIMARY KEY (orb_id, port)
			);
		`);
		const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(threads)").all();
		if (!columns.some((column) => column.name === "local_cwd")) this.db.exec("ALTER TABLE threads ADD COLUMN local_cwd TEXT");
		const orbColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(orbs)").all();
		for (const [column, type] of [["base", "TEXT"], ["size", "TEXT"], ["snapshot_id", "TEXT"], ["paused_at", "INTEGER"], ["pause_depth", "TEXT"]]) {
			if (!orbColumns.some((existing) => existing.name === column)) this.db.exec(`ALTER TABLE orbs ADD COLUMN ${column} ${type}`);
		}

	}

	createThread(row: Omit<ThreadRow, "created_at">) {
		this.db
			.query("INSERT INTO threads (id, conversation_id, orb_id, title, repo, local_cwd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
			.run(row.id, row.conversation_id, row.orb_id, row.title, row.repo, row.local_cwd, Date.now());
	}

	thread(id: string): ThreadRow | undefined {
		return this.db.query<ThreadRow, [string]>("SELECT * FROM threads WHERE id = ?").get(id) ?? undefined;
	}

	threadByConversation(conversationId: number): ThreadRow | undefined {
		return this.db.query<ThreadRow, [number]>("SELECT * FROM threads WHERE conversation_id = ?").get(conversationId) ?? undefined;
	}

	threads(): ThreadRow[] {
		return this.db.query<ThreadRow, []>("SELECT * FROM threads ORDER BY created_at DESC").all();
	}

	deleteThread(id: string) {
		this.db.query("DELETE FROM threads WHERE id = ?").run(id);
		this.db.query("DELETE FROM schedules WHERE thread_id = ?").run(id);
	}

	upsertOrb(id: string, image: string): OrbRow {
		this.db
			.query("INSERT OR IGNORE INTO orbs (id, status, generation, image, updated_at) VALUES (?, 'none', 0, ?, ?)")
			.run(id, image, Date.now());
		return this.orb(id)!;
	}

	orb(id: string): OrbRow | undefined {
		return this.db.query<OrbRow, [string]>("SELECT * FROM orbs WHERE id = ?").get(id) ?? undefined;
	}

	orbs(): OrbRow[] {
		return this.db.query<OrbRow, []>("SELECT * FROM orbs ORDER BY updated_at DESC").all();
	}

	updateOrb(
		id: string,
		change: Partial<Pick<OrbRow, "status" | "generation" | "setup_done" | "workspace" | "base" | "size" | "snapshot_id" | "paused_at" | "pause_depth" | "last_error">>,
	) {
		const fields = Object.keys(change);
		if (fields.length === 0) return;
		const sets = fields.map((field) => `${field} = ?`).join(", ");
		const values = fields.map((field) => change[field as keyof typeof change] ?? null);
		this.db.query(`UPDATE orbs SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, Date.now(), id);
	}

	enqueueJob(orbId: string, env: DispatchEnv): JobRow {
		const id = randomUUID();
		this.db
			.query("INSERT INTO jobs (id, orb_id, operation, env, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)")
			.run(id, orbId, env.ORB_OPERATION, JSON.stringify(env), Date.now());
		return this.job(id)!;
	}

	job(id: string): JobRow | undefined {
		return this.db.query<JobRow, [string]>("SELECT * FROM jobs WHERE id = ?").get(id) ?? undefined;
	}

	/** Claim the oldest queued job whose orb has no job in flight, so one orb's jobs run in order. */
	claimJob(): JobRow | undefined {
		return this.db.transaction(() => {
			const job = this.db
				.query<JobRow, []>(
					`SELECT * FROM jobs j WHERE status = 'queued'
					 AND NOT EXISTS (SELECT 1 FROM jobs c WHERE c.orb_id = j.orb_id AND c.status = 'claimed')
					 ORDER BY created_at LIMIT 1`,
				)
				.get();
			if (!job) return undefined;
			this.db.query("UPDATE jobs SET status = 'claimed', claimed_at = ? WHERE id = ?").run(Date.now(), job.id);
			return { ...job, status: "claimed" as const };
		})();
	}

	finishJob(id: string, result: JobResult) {
		this.db
			// The orb token is only needed by the dispatch program; do not keep it around.
			.query("UPDATE jobs SET status = ?, output = ?, finished_at = ?, env = json_remove(env, '$.ORB_TOKEN') WHERE id = ?")
			.run(result.ok ? "done" : "failed", result.output.slice(-64_000), Date.now(), id);
	}

	/** Requeue jobs claimed by a provider that went away; dispatch programs are idempotent. */
	requeueStale(olderThanMs: number) {
		this.db
			.query("UPDATE jobs SET status = 'queued', claimed_at = NULL WHERE status = 'claimed' AND claimed_at < ?")
			.run(Date.now() - olderThanMs);
	}

	portals(orbId?: string): PortalRow[] {
		if (orbId === undefined) return this.db.query<PortalRow, []>("SELECT * FROM portals ORDER BY created_at").all();
		return this.db.query<PortalRow, [string]>("SELECT * FROM portals WHERE orb_id = ? ORDER BY created_at").all(orbId);
	}

	addPortal(row: Omit<PortalRow, "created_at">) {
		this.db.query("INSERT INTO portals (orb_id, port, public_port, created_at) VALUES (?, ?, ?, ?)").run(row.orb_id, row.port, row.public_port, Date.now());
	}

	/** The newest project snapshot of `repo`, if younger than `maxAgeMs`. */
	snapshot(repo: string, maxAgeMs: number): { id: string; workspace: string } | undefined {
		return (
			this.db
				.query<{ id: string; workspace: string }, [string, number]>("SELECT id, workspace FROM snapshots WHERE repo = ? AND created_at > ?")
				.get(repo, Date.now() - maxAgeMs) ?? undefined
		);
	}

	putSnapshot(repo: string, id: string, workspace: string) {
		this.db
			.query("INSERT INTO snapshots (repo, id, workspace, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (repo) DO UPDATE SET id = excluded.id, workspace = excluded.workspace, created_at = excluded.created_at")
			.run(repo, id, workspace, Date.now());
	}

	schedules(threadId?: string): ScheduleRow[] {
		if (threadId === undefined) return this.db.query<ScheduleRow, []>("SELECT * FROM schedules ORDER BY next_at").all();
		return this.db.query<ScheduleRow, [string]>("SELECT * FROM schedules WHERE thread_id = ? ORDER BY next_at").all(threadId);
	}

	addSchedule(row: Omit<ScheduleRow, "id" | "created_at">): ScheduleRow {
		const created = { ...row, id: `s-${randomUUID().slice(0, 8)}`, created_at: Date.now() };
		this.db
			.query("INSERT INTO schedules (id, thread_id, next_at, every_ms, message, created_at) VALUES (?, ?, ?, ?, ?, ?)")
			.run(created.id, created.thread_id, created.next_at, created.every_ms, created.message, created.created_at);
		return created;
	}

	moveSchedule(id: string, nextAt: number) {
		this.db.query("UPDATE schedules SET next_at = ? WHERE id = ?").run(nextAt, id);
	}

	deleteSchedule(id: string) {
		this.db.query("DELETE FROM schedules WHERE id = ?").run(id);
	}

	secrets(): SecretRow[] {
		return this.db.query<SecretRow, []>("SELECT * FROM secrets ORDER BY name").all();
	}

	setSecret(name: string, value: string, secret: boolean) {
		this.db
			.query("INSERT INTO secrets (name, value, secret, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value, secret = excluded.secret, updated_at = excluded.updated_at")
			.run(name, value, secret ? 1 : 0, Date.now());
	}

	deleteSecret(name: string) {
		this.db.query("DELETE FROM secrets WHERE name = ?").run(name);
	}

	services(orbId: string): ServiceRow[] {
		return this.db.query<ServiceRow, [string]>("SELECT * FROM services WHERE orb_id = ? ORDER BY created_at").all(orbId);
	}

	putService(row: Omit<ServiceRow, "created_at">) {
		this.db
			.query(
				`INSERT INTO services (orb_id, name, command, cwd, port, env, health, portal, declared, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT (orb_id, name) DO UPDATE SET command = excluded.command, cwd = excluded.cwd, port = excluded.port,
				 env = excluded.env, health = excluded.health, portal = excluded.portal, declared = excluded.declared`,
			)
			.run(row.orb_id, row.name, row.command, row.cwd, row.port, row.env, row.health, row.portal, row.declared, Date.now());
	}

	deleteService(orbId: string, name: string) {
		this.db.query("DELETE FROM services WHERE orb_id = ? AND name = ?").run(orbId, name);
	}

	deletePortals(orbId: string) {
		this.db.query("DELETE FROM portals WHERE orb_id = ?").run(orbId);
		this.db.query("DELETE FROM services WHERE orb_id = ?").run(orbId);
	}

	recentJobs(orbId: string, limit = 20): JobRow[] {
		return this.db
			.query<JobRow, [string, number]>("SELECT * FROM jobs WHERE orb_id = ? ORDER BY created_at DESC LIMIT ?")
			.all(orbId, limit);
	}
}
