import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { RemoteExecutionEnv } from "@earendil-works/pi-env";
import type { OrbManager } from "./orbs.ts";
import type { Store } from "./store.ts";

/**
 * An orb's changes: everything in its workspace that differs from the commit it started from, committed or not,
 * new files included (ignored ones excepted). Computed with a throwaway index, so the orb's own index is untouched.
 */
export async function orbChanges(orbs: OrbManager, store: Store, orbId: string, mode: "stat" | "patch"): Promise<{ base: string; text: string }> {
	await orbs.ensureRunning(orbId);
	const orb = store.orb(orbId);
	if (!orb?.workspace) throw new Error("the orb has no workspace yet");
	const env = new RemoteExecutionEnv({ connection: orbs.connection(orbId), id: `moonlet:${orbId}`, cwd: orb.workspace });
	let text = "";
	let error = "";
	const result = await env.exec(
		CHANGES_SCRIPT,
		{
			cwd: orb.workspace,
			env: { BASE: orb.base ?? "", MODE: mode },
			timeout: 120,
			onOutput: (chunk, _context, info) => void (info.stream === "stderr" ? (error += chunk) : (text += chunk)),
		},
		BACKGROUND_CONTEXT,
	);
	if (!result.ok) throw new Error(result.error.message);
	if (result.value.exitCode !== 0) throw new Error(`git diff failed: ${error.trim().slice(-500)}`);
	const [first, ...rest] = text.split("\n");
	return { base: first?.replace(/^base /, "") ?? "", text: rest.join("\n") };
}

const CHANGES_SCRIPT = `set -e
base="$BASE"
[ -n "$base" ] && git cat-file -e "$base^{commit}" 2>/dev/null || base=$(git rev-list --max-parents=0 HEAD | tail -n 1)
echo "base $base"
index=$(mktemp)
trap 'rm -f "$index"' EXIT
cp "$(git rev-parse --git-dir)/index" "$index" 2>/dev/null || true
export GIT_INDEX_FILE="$index"
git add -A
if [ "$MODE" = patch ]; then git diff --cached --binary "$base"; else git diff --cached --stat=200 --stat-graph-width=20 "$base"; fi
`;
