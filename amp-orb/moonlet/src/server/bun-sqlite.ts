import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import {
	SqliteStorage,
	type SqliteDatabase,
	type SqliteExecutor,
	type SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";

class SerialQueue {
	private tail: Promise<void> = Promise.resolve();

	run<T>(operation: () => T | Promise<T>): Promise<T> {
		const result = this.tail.then(operation);
		this.tail = result.then(() => undefined, () => undefined);
		return result;
	}
}

class BunSqliteTransaction implements SqliteExecutor {
	private active = true;

	constructor(private readonly database: Database) {}

	finish() {
		this.active = false;
	}

	async exec(sql: string) {
		this.assertActive();
		this.database.exec(sql);
	}

	async run(sql: string, ...params: SqliteValue[]) {
		this.assertActive();
		const statement = this.database.prepare(sql);
		try {
			statement.run(...params);
		} finally {
			statement.finalize();
		}
	}

	async get<T extends object>(sql: string, ...params: SqliteValue[]) {
		this.assertActive();
		const statement = this.database.prepare(sql);
		try {
			return (statement.get(...params) ?? undefined) as T | undefined;
		} finally {
			statement.finalize();
		}
	}

	async all<T extends object>(sql: string, ...params: SqliteValue[]) {
		this.assertActive();
		const statement = this.database.prepare(sql);
		try {
			return statement.all(...params) as T[];
		} finally {
			statement.finalize();
		}
	}

	private assertActive() {
		if (!this.active) throw new Error("SQLite transaction handle is no longer active");
	}
}

class BunSqliteDatabase implements SqliteDatabase {
	private readonly queue = new SerialQueue();
	private closed = false;

	constructor(private readonly database: Database) {}

	exec(sql: string) {
		return this.queue.run(() => {
			this.assertOpen();
			this.database.exec(sql);
		});
	}

	run(sql: string, ...params: SqliteValue[]) {
		return this.queue.run(() => {
			this.assertOpen();
			const statement = this.database.prepare(sql);
			try {
				statement.run(...params);
			} finally {
				statement.finalize();
			}
		});
	}

	get<T extends object>(sql: string, ...params: SqliteValue[]) {
		return this.queue.run(() => {
			this.assertOpen();
			const statement = this.database.prepare(sql);
			try {
				return (statement.get(...params) ?? undefined) as T | undefined;
			} finally {
				statement.finalize();
			}
		});
	}

	all<T extends object>(sql: string, ...params: SqliteValue[]) {
		return this.queue.run(() => {
			this.assertOpen();
			const statement = this.database.prepare(sql);
			try {
				return statement.all(...params) as T[];
			} finally {
				statement.finalize();
			}
		});
	}

	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>) {
		return this.queue.run(async () => {
			this.assertOpen();
			this.database.exec("BEGIN IMMEDIATE");
			const transaction = new BunSqliteTransaction(this.database);
			try {
				const result = await callback(transaction);
				transaction.finish();
				this.database.exec("COMMIT");
				return result;
			} catch (error) {
				transaction.finish();
				try {
					this.database.exec("ROLLBACK");
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], "SQLite transaction failed and rollback failed");
				}
				throw error;
			}
		});
	}

	close() {
		return this.queue.run(() => {
			if (this.closed) return;
			this.closed = true;
			try {
				this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			} finally {
				this.database.close(true);
			}
		});
	}

	private assertOpen() {
		if (this.closed) throw new Error("SQLite database is closed");
	}
}

export async function openBunSqliteStorage(path: string) {
	if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
	const database = new BunSqliteDatabase(new Database(path, { create: true }));
	try {
		await database.exec("PRAGMA journal_mode = WAL");
		await database.exec("PRAGMA synchronous = NORMAL");
		await database.exec("PRAGMA busy_timeout = 5000");
		return await SqliteStorage.open(database);
	} catch (error) {
		await database.close().catch(() => undefined);
		throw error;
	}
}
