/**
 * `moonlet relay`: the program pi-env's `Connection` spawns on the control plane instead of `ssh`.
 *
 * pi-env talks to its daemon over a child process's stdin and stdout. This process copies
 * those bytes to and from the control plane's internal relay socket, which splices them to
 * the orb's pipe. pi-env appends `serve --token <hex>`; those arguments travel to the orb,
 * where the bootstrap passes them to the real daemon.
 */
export async function runRelay(orbId: string, daemonArgs: string[]) {
	const base = process.env.MOONLET_RELAY_URL;
	const key = process.env.MOONLET_RELAY_KEY;
	if (!base || !key) throw new Error("MOONLET_RELAY_URL and MOONLET_RELAY_KEY must be set");
	const url = new URL(`/internal/relay/${encodeURIComponent(orbId)}`, base);
	url.searchParams.set("args", JSON.stringify(daemonArgs));

	const socket = new WebSocket(url.toString(), { headers: { authorization: `Bearer ${key}` } } as never);
	socket.binaryType = "arraybuffer";
	const pending: Uint8Array[] = [];
	const done = Promise.withResolvers<void>();

	socket.addEventListener("open", () => {
		for (const chunk of pending.splice(0)) socket.send(chunk);
	});
	socket.addEventListener("message", (event) => {
		if (event.data instanceof ArrayBuffer) process.stdout.write(new Uint8Array(event.data));
	});
	socket.addEventListener("close", (event) => {
		if (event.code !== 1000 && event.reason) process.stderr.write(`moonlet relay: ${event.reason}\n`);
		done.resolve();
	});
	socket.addEventListener("error", () => done.resolve());

	process.stdin.on("data", (chunk: Buffer) => {
		if (socket.readyState === WebSocket.OPEN) socket.send(chunk);
		else pending.push(chunk);
	});
	process.stdin.on("end", () => socket.close(1000));

	await done.promise;
	process.exit(0);
}
