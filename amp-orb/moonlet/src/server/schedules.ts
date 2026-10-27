import type { ScheduleRow, Store } from "./store.ts";
import type { Threads } from "./threads.ts";

export interface ScheduleInput {
	/** Minutes from now; or `at`, an ISO time. */
	inMinutes?: number;
	at?: string;
	/** Repeat every so many minutes (at least 5). */
	everyMinutes?: number;
	message: string;
}

/**
 * Schedules: messages that wake a thread later, once or repeatedly, with its whole context, like Amp's automations.
 * Checked every 15 s; a repeating schedule that was missed (the server was down) runs once and moves on.
 */
export class Schedules {
	readonly #timer: ReturnType<typeof setInterval>;

	constructor(private readonly options: { store: Store; threads: () => Threads; log: (message: string) => void }) {
		this.#timer = setInterval(() => void this.#tick(), 15_000);
	}

	add(threadId: string, input: ScheduleInput): ScheduleRow {
		const now = Date.now();
		const nextAt = input.at ? Date.parse(input.at) : now + (input.inMinutes ?? input.everyMinutes ?? 0) * 60_000;
		if (!Number.isFinite(nextAt)) throw new Error(`invalid time ${input.at}`);
		if (input.everyMinutes !== undefined && input.everyMinutes < 5) throw new Error("everyMinutes must be at least 5");
		const row = this.options.store.addSchedule({
			thread_id: threadId,
			next_at: Math.max(nextAt, now),
			every_ms: input.everyMinutes ? input.everyMinutes * 60_000 : null,
			message: input.message,
		});
		this.options.log(`thread ${threadId}: schedule ${row.id} at ${new Date(row.next_at).toISOString()}${row.every_ms ? ` every ${row.every_ms / 60_000} min` : ""}`);
		return row;
	}

	list(threadId: string) {
		return this.options.store.schedules(threadId);
	}

	remove(threadId: string, id: string) {
		if (!this.options.store.schedules(threadId).some((row) => row.id === id)) throw new Error(`no schedule ${id}`);
		this.options.store.deleteSchedule(id);
	}

	close() {
		clearInterval(this.#timer);
	}

	async #tick() {
		const now = Date.now();
		for (const row of this.options.store.schedules()) {
			if (row.next_at > now) continue;
			if (row.every_ms) {
				let next = row.next_at + row.every_ms;
				while (next <= now) next += row.every_ms;
				this.options.store.moveSchedule(row.id, next);
			} else {
				this.options.store.deleteSchedule(row.id);
			}
			this.options.log(`thread ${row.thread_id}: schedule ${row.id} fired`);
			await this.options.threads().send(row.thread_id, `[scheduled ${row.id}] ${row.message}`).catch((error) => this.options.log(`schedule ${row.id}: ${error}`));
		}
	}
}
