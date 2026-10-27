import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { RemoteExecutionEnv } from "@earendil-works/pi-env";
import type { OrbManager } from "./orbs.ts";
import type { Portals } from "./portals.ts";
import type { ServiceRow, Store } from "./store.ts";

const context = BACKGROUND_CONTEXT;

/** Files that declare an orb's services, in the workspace; the first that exists wins. Amp's format is accepted as is. */
const SERVICE_FILES = [".moonlet/services.yaml", ".amp/services.yaml"];

/** Ports given to servers that declare none, stable per orb. */
const FIRST_AUTO_PORT = 5100;

export interface ServiceSpec {
	name: string;
	command: string;
	cwd?: string;
	port?: number;
	env?: Record<string, string>;
	health?: string;
	/** Default: true when it has a port. */
	portal?: boolean;
}

export interface ServiceStatus {
	name: string;
	command: string;
	port: number | null;
	url?: string;
	state: "running" | "stopped" | "unknown";
	declared: boolean;
	note?: string;
}

/**
 * Services: long-running processes in orbs (dev servers, watchers), each run by a small supervisor in the orb that
 * restarts it when it exits. moonlet starts them again whenever an orb connects (after a resume, the processes are
 * gone), waits for them to listen, and gives servers a portal. `$PORT` and `$PUBLIC_URL` tell a server where it is.
 */
export class Services {
	constructor(
		private readonly options: { store: Store; orbs: OrbManager; portals: Portals; portalHost?: string; log: (message: string) => void },
	) {}

	start() {
		this.options.orbs.onConnect((orbId) => {
			// Before setup the workspace may not exist yet; setup calls ensure itself.
			if (!this.options.store.orb(orbId)?.setup_done) return;
			this.resume(orbId)
				.then(() => this.ensure(orbId))
				.catch((error) => this.#log(orbId, `resume: ${error instanceof Error ? error.message : error}`));
		});
	}

	/**
	 * Run the workspace's `.agents/resume` hook, as Amp does after every wake: for quick work such as logins, tunnels or
	 * mounts. It may take 10 s before services start; after that it carries on in the background.
	 */
	async resume(orbId: string) {
		const workspace = this.options.store.orb(orbId)?.workspace;
		if (!workspace) return;
		const env = new RemoteExecutionEnv({ connection: this.options.orbs.connection(orbId), id: `moonlet:${orbId}`, cwd: workspace });
		let output = "";
		await env.exec(RESUME_SCRIPT, { cwd: workspace, timeout: 20, onOutput: (text) => void (output += text) }, context);
		if (output.trim()) this.#log(orbId, output.trim());
	}

	list(orbId: string): ServiceStatus[] {
		return this.options.store.services(orbId).map((row) => this.#status(row, "unknown"));
	}

	/**
	 * Read the services file, then start every service that is not running: declared ones and ad hoc ones. Declared
	 * services that left the file are stopped and dropped.
	 */
	async ensure(orbId: string): Promise<ServiceStatus[]> {
		const declared = await this.#readDeclared(orbId);
		const rows = this.options.store.services(orbId);
		if (declared) {
			const names = new Set(declared.map((spec) => spec.name));
			for (const row of rows) {
				if (row.declared && !names.has(row.name)) {
					await this.#run(row, "stop");
					this.options.store.deleteService(orbId, row.name);
				}
			}
			for (const spec of declared) this.#put(orbId, spec, true);
		}
		const results: ServiceStatus[] = [];
		for (const row of this.options.store.services(orbId)) results.push(await this.#start(row));
		return results;
	}

	/** Add or replace an ad hoc service and start it. */
	async add(orbId: string, spec: ServiceSpec): Promise<ServiceStatus> {
		const existing = this.options.store.services(orbId).find((row) => row.name === spec.name);
		if (existing) await this.#run(existing, "stop");
		return this.#start(this.#put(orbId, spec, false));
	}

	async stop(orbId: string, name: string, forget = false) {
		const row = this.#row(orbId, name);
		const output = await this.#run(row, "stop");
		if (forget && !row.declared) this.options.store.deleteService(orbId, name);
		return output;
	}

	async restart(orbId: string, name: string): Promise<ServiceStatus> {
		const row = this.#row(orbId, name);
		await this.#run(row, "stop");
		return this.#start(row);
	}

	logs(orbId: string, name: string, lines = 80) {
		return this.#run(this.#row(orbId, name), "logs", { LINES: String(lines) });
	}

	#row(orbId: string, name: string) {
		const row = this.options.store.services(orbId).find((candidate) => candidate.name === name);
		if (!row) throw new Error(`no service ${name}; known: ${this.options.store.services(orbId).map((r) => r.name).join(", ") || "none"}`);
		return row;
	}

	#put(orbId: string, spec: ServiceSpec, declared: boolean): ServiceRow {
		const rows = this.options.store.services(orbId);
		const existing = rows.find((row) => row.name === spec.name);
		let port = spec.port ?? existing?.port ?? null;
		// A server without a port gets a stable one, so its URL survives restarts.
		if (port === null && spec.portal !== false && /\$\{?PORT\b/.test(spec.command)) {
			const used = new Set(rows.map((row) => row.port));
			port = FIRST_AUTO_PORT;
			while (used.has(port)) port++;
		}
		const row = {
			orb_id: orbId,
			name: spec.name,
			command: spec.command,
			cwd: spec.cwd ?? null,
			port,
			env: spec.env ? JSON.stringify(spec.env) : null,
			health: spec.health ?? null,
			portal: spec.portal === false || port === null ? 0 : 1,
			declared: declared ? 1 : 0,
		};
		this.options.store.putService(row);
		return { ...row, created_at: existing?.created_at ?? Date.now() };
	}

	async #start(row: ServiceRow): Promise<ServiceStatus> {
		const url = row.portal && row.port ? this.options.portals.create(row.orb_id, row.port).url : undefined;
		const env = this.#env(row, url);
		const output = (await this.#run(row, "start", env)).trim();
		const state: ServiceStatus["state"] = output.includes("not ready") ? "unknown" : "running";
		this.#log(row.orb_id, `service ${row.name}: ${output.split("\n").pop()}`);
		return this.#status(row, state, output.split("\n").pop());
	}

	#status(row: ServiceRow, state: ServiceStatus["state"], note?: string): ServiceStatus {
		const url = row.portal && row.port ? this.options.portals.list(row.orb_id).find((portal) => portal.port === row.port)?.url : undefined;
		return { name: row.name, command: row.command, port: row.port, url, state, declared: row.declared === 1, note };
	}

	#env(row: ServiceRow, url: string | undefined): Record<string, string> {
		const env: Record<string, string> = {};
		if (row.port) env.PORT = String(row.port);
		if (url) env.PUBLIC_URL = url;
		// Vite refuses requests for hosts it does not know.
		if (this.options.portalHost) env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = this.options.portalHost;
		const extra = row.env ? (JSON.parse(row.env) as Record<string, string>) : {};
		const others = this.options.store.services(row.orb_id);
		for (const [key, value] of Object.entries(extra)) {
			// `${services.<name>.publicURL}` refers to another service's portal.
			env[key] = String(value).replace(/\$\{services\.([\w-]+)\.publicURL\}/g, (_, name: string) => {
				const other = others.find((candidate) => candidate.name === name);
				return (other?.port && this.options.portals.list(row.orb_id).find((portal) => portal.port === other.port)?.url) || "";
			});
		}
		return env;
	}

	/** Run the supervisor script in the orb for one action. */
	async #run(row: ServiceRow, action: "start" | "stop" | "logs", extra: Record<string, string> = {}): Promise<string> {
		const orb = this.options.store.orb(row.orb_id);
		const cwd = row.cwd ? (row.cwd.startsWith("/") ? row.cwd : `${orb?.workspace ?? "~"}/${row.cwd}`) : (orb?.workspace ?? "");
		const env = new RemoteExecutionEnv({ connection: this.options.orbs.connection(row.orb_id), id: `moonlet:${row.orb_id}`, cwd: "/" });
		let output = "";
		const result = await env.exec(
			SUPERVISOR,
			{
				env: {
					...extra,
					ACTION: action,
					NAME: row.name,
					SERVICE_COMMAND: row.command,
					SERVICE_CWD: cwd,
					SERVICE_PORT: row.port ? String(row.port) : "",
					SERVICE_HEALTH: row.health ?? "",
				},
				timeout: 90,
				onOutput: (text) => void (output += text),
			},
			context,
		);
		if (!result.ok) throw new Error(`${action} ${row.name}: ${result.error.message}`);
		return output;
	}

	async #readDeclared(orbId: string): Promise<ServiceSpec[] | undefined> {
		const workspace = this.options.store.orb(orbId)?.workspace;
		if (!workspace) return undefined;
		const env = new RemoteExecutionEnv({ connection: this.options.orbs.connection(orbId), id: `moonlet:${orbId}`, cwd: workspace });
		let text = "";
		const files = SERVICE_FILES.map((file) => `"${file}"`).join(" ");
		const result = await env.exec(`for f in ${files}; do [ -f "$f" ] && { cat "$f"; exit 0; }; done; exit 3`, { cwd: workspace, timeout: 15, onOutput: (chunk) => void (text += chunk) }, context);
		if (!result.ok || result.value.exitCode === 3) return undefined;
		return parseServices(text);
	}

	#log(orbId: string, message: string) {
		this.options.log(`orb ${orbId}: ${message}`);
	}
}

/** `services.yaml`: `services: { <name>: { command, cwd?, port?, env?, health?, portal? } }`, or the map at the top. */
export function parseServices(text: string): ServiceSpec[] {
	const parsed = (Bun.YAML.parse(text) ?? {}) as Record<string, unknown>;
	const map = (parsed.services ?? parsed) as Record<string, Record<string, unknown>>;
	const specs: ServiceSpec[] = [];
	for (const [name, value] of Object.entries(map ?? {})) {
		if (!value || typeof value !== "object" || typeof value.command !== "string") continue;
		const platforms = value.platforms as string[] | undefined;
		if (platforms && !platforms.includes("linux")) continue;
		specs.push({
			name,
			command: value.command,
			cwd: typeof value.cwd === "string" ? value.cwd : undefined,
			port: typeof value.port === "number" ? value.port : undefined,
			env: value.env && typeof value.env === "object" ? Object.fromEntries(Object.entries(value.env).map(([k, v]) => [k, String(v)])) : undefined,
			health: typeof value.health === "string" ? value.health : undefined,
			portal: value.portal === false ? false : undefined,
		});
	}
	return specs;
}

const RESUME_SCRIPT = `[ -f .agents/resume ] || exit 0
mkdir -p "$HOME/.moonlet"; log="$HOME/.moonlet/resume.log"
echo "--- $(date -u +%FT%TZ)" >>"$log"
if [ -x .agents/resume ]; then run=./.agents/resume; else run="bash .agents/resume"; fi
setsid -f bash -c 'echo $$ >"$HOME/.moonlet/resume.pid"; exec $0' "$run" >>"$log" 2>&1 </dev/null
sleep 0.2
for _ in $(seq 1 20); do kill -0 "$(cat "$HOME/.moonlet/resume.pid" 2>/dev/null)" 2>/dev/null || { echo "ran .agents/resume"; exit 0; }; sleep 0.5; done
echo ".agents/resume still running after 10 s; continuing"
`;

/**
 * Run in the orb for each action. `start` runs the command under a restart loop in its own session (the loop's pid is
 * the process group, so `stop` ends everything it started), then waits up to 60 s for the port or health check.
 */
const SUPERVISOR = `dir="$HOME/.moonlet/services"; mkdir -p "$dir"
pidf="$dir/$NAME.pid"; log="$dir/$NAME.log"
# After a restart the pidfile can name another process; the supervisor's command line names its pidfile.
alive() { [ -f "$pidf" ] && tr '\\0' ' ' <"/proc/$(cat "$pidf")/cmdline" 2>/dev/null | grep -qF "$pidf"; }
case "$ACTION" in
start)
	if ! alive; then
		cd "\${SERVICE_CWD:-$HOME}" || { echo "no directory $SERVICE_CWD"; exit 1; }
		echo "--- $(date -u +%FT%TZ) start: $SERVICE_COMMAND" >>"$log"
		setsid -f bash -c 'echo $$ >"$1"; while :; do bash -lc "$SERVICE_COMMAND"; echo "--- exited $?; restarting in 2 s"; sleep 2; done' _ "$pidf" >>"$log" 2>&1 </dev/null
		sleep 0.3
	fi
	[ -n "$SERVICE_PORT" ] || { echo "running"; exit 0; }
	for _ in $(seq 1 120); do
		if [ -n "$SERVICE_HEALTH" ]; then
			curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$SERVICE_PORT$SERVICE_HEALTH" 2>/dev/null && { echo "ready on port $SERVICE_PORT"; exit 0; }
		elif (exec 3<>"/dev/tcp/127.0.0.1/$SERVICE_PORT") 2>/dev/null; then
			echo "ready on port $SERVICE_PORT"; exit 0
		fi
		sleep 0.5
	done
	echo "started, but not ready on port $SERVICE_PORT after 60 s; last log lines:"; tail -n 15 "$log"
	;;
stop)
	if alive; then kill -- -"$(cat "$pidf")" 2>/dev/null; sleep 0.5; kill -9 -- -"$(cat "$pidf")" 2>/dev/null; fi
	rm -f "$pidf"; echo "stopped"
	;;
logs) tail -n "\${LINES:-80}" "$log" 2>/dev/null || echo "(no log yet)" ;;
esac
`;
