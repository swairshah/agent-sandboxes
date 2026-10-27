import { expect, test } from "bun:test";
import { Store } from "./store.ts";

test("jobs of one orb are claimed one at a time, in order", () => {
	const store = new Store(":memory:");
	store.upsertOrb("a", "image");
	store.upsertOrb("b", "image");
	const first = store.enqueueJob("a", { ORB_OPERATION: "spawn", ORB_ID: "a", ORB_IMAGE: "image", ORB_TOKEN: "secret" });
	const second = store.enqueueJob("a", { ORB_OPERATION: "pause", ORB_ID: "a", ORB_IMAGE: "image" });
	const other = store.enqueueJob("b", { ORB_OPERATION: "spawn", ORB_ID: "b", ORB_IMAGE: "image" });

	expect(store.claimJob()?.id).toBe(first.id);
	// a's pause waits for a's spawn; b is independent.
	expect(store.claimJob()?.id).toBe(other.id);
	expect(store.claimJob()).toBeUndefined();

	store.finishJob(first.id, { ok: true, exitCode: 0, output: "" });
	expect(store.claimJob()?.id).toBe(second.id);
});

test("finished jobs drop their orb token", () => {
	const store = new Store(":memory:");
	const job = store.enqueueJob("a", { ORB_OPERATION: "spawn", ORB_ID: "a", ORB_IMAGE: "image", ORB_TOKEN: "secret" });
	store.claimJob();
	store.finishJob(job.id, { ok: true, exitCode: 0, output: "" });
	expect(JSON.parse(store.job(job.id)!.env).ORB_TOKEN).toBeUndefined();
});
