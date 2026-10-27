/** A small single-page UI: thread list, composer, and a live transcript over SSE. */
export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>moonlet</title>
<style>
:root { --bg:#fbfaf7; --fg:#1d1b18; --muted:#6f6a62; --line:#e4e0d8; --accent:#3b5bdb; --code:#f2efe8; }
@media (prefers-color-scheme: dark) { :root { --bg:#151412; --fg:#ece8e1; --muted:#9a948a; --line:#2c2a26; --accent:#8ea2ff; --code:#1f1d1a; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 ui-sans-serif, system-ui, sans-serif; }
header { display:flex; gap:12px; align-items:center; padding:12px 16px; border-bottom:1px solid var(--line); }
header h1 { font-size:16px; margin:0; }
header input { flex:1; max-width:340px; }
main { display:grid; grid-template-columns: 280px 1fr; min-height: calc(100vh - 53px); }
@media (max-width: 760px) { main { grid-template-columns: 1fr; } nav { border-right:0; border-bottom:1px solid var(--line); } }
nav { border-right:1px solid var(--line); padding:12px; display:flex; flex-direction:column; gap:8px; }
nav button.thread { text-align:left; background:none; border:1px solid transparent; border-radius:8px; padding:8px; color:inherit; cursor:pointer; }
nav button.thread[aria-current] { border-color:var(--line); background:var(--code); }
.status { font-size:12px; color:var(--muted); }
section { padding:16px; display:flex; flex-direction:column; gap:12px; min-width:0; }
#log { flex:1; overflow:auto; display:flex; flex-direction:column; gap:10px; }
.user { font-weight:600; }
.tool { font:12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; background:var(--code); border-radius:8px; padding:8px 10px; white-space:pre-wrap; color:var(--muted); max-height:260px; overflow:auto; }
.text { white-space:pre-wrap; }
form { display:flex; gap:8px; flex-wrap:wrap; }
input, textarea { font:inherit; color:inherit; background:transparent; border:1px solid var(--line); border-radius:8px; padding:8px 10px; }
textarea { flex:1; min-width:220px; min-height:44px; }
button.primary { font:inherit; background:var(--accent); color:white; border:0; border-radius:8px; padding:8px 14px; cursor:pointer; }
</style>
</head>
<body>
<header><h1>moonlet</h1><input id="token" type="password" placeholder="API token" autocomplete="off"></header>
<main>
<nav>
	<form id="create"><textarea id="prompt" placeholder="New thread: what should the agent do?"></textarea><input id="repo" placeholder="git repo URL (optional)" style="flex:1"><button class="primary">Start</button></form>
	<div id="threads"></div>
</nav>
<section>
	<div class="status" id="meta">Pick or start a thread.</div>
	<div id="log"></div>
	<form id="send"><textarea id="message" placeholder="Message"></textarea><button class="primary">Send</button></form>
</section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const store = { get(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
$("token").value = store.get("moonlet.token");
$("token").onchange = () => { store.set("moonlet.token", $("token").value); refresh(); };
const token = () => $("token").value;
const api = async (method, path, body) => {
	const r = await fetch(path, { method, headers: { authorization: "Bearer " + token(), "content-type": "application/json" }, body: body && JSON.stringify(body) });
	if (!r.ok) throw new Error(await r.text());
	return r.status === 204 ? null : r.json();
};
let current = null, source = null, live = null;
async function refresh() {
	if (!token()) return;
	const threads = await api("GET", "/api/threads");
	$("threads").replaceChildren(...threads.map((t) => {
		const b = document.createElement("button");
		b.className = "thread"; if (t.id === current) b.setAttribute("aria-current", "true");
		b.innerHTML = "<div></div><div class=status></div>";
		b.firstChild.textContent = t.title; b.lastChild.textContent = t.id + " · orb " + (t.orb ? t.orb.status : "?");
		b.onclick = () => open(t.id);
		return b;
	}));
}
const add = (cls, text) => { const d = document.createElement("div"); d.className = cls; d.textContent = text; $("log").append(d); d.scrollIntoView({ block: "end" }); return d; };
function entry(e) {
	const m = e.model && e.model[0];
	if (e.kind === "pi.user") add("user", typeof m.content === "string" ? m.content : m.content.map((b) => b.text || "").join(""));
	else if (e.kind === "pi.assistant") for (const b of m.content) {
		if (b.type === "text") add("text", b.text);
		else if (b.type === "toolCall") add("tool", "→ " + b.name + " " + JSON.stringify(b.arguments));
	}
	else if (e.kind === "pi.tool-result") add("tool", m.content.map((b) => b.text || "").join("").trim());
	else if (e.kind === "moonlet.setup") add("tool", "setup (exit " + e.data.exitCode + ")\\n" + e.data.output);
}
function open(id) {
	current = id; refresh();
	if (source) source.close();
	$("log").replaceChildren(); live = null;
	source = new EventSource("/api/threads/" + id + "/events?token=" + encodeURIComponent(token()));
	source.onmessage = (msg) => {
		const ev = JSON.parse(msg.data);
		if (ev.type === "snapshot") { $("log").replaceChildren(); ev.entries.forEach(entry); }
		else if (ev.type === "message_start") live = add("text", "");
		else if (ev.type === "message_update") for (const c of ev.changes || []) { if (c.type === "text_delta" && live) live.textContent += c.delta; }
		else if (ev.type === "message_end") { if (live) live.remove(); live = null; entry(ev.entry); }
		else if (ev.type === "tool_execution_start") live = add("tool", "");
		else if (ev.type === "tool_execution_update" && ev.output && live) { if (ev.output.set !== undefined) live.textContent = ev.output.set; else live.textContent += ev.output.append || ""; }
		else if (ev.type === "tool_execution_end") { if (live) live.remove(); live = null; if (ev.entry) entry(ev.entry); }
		else if (ev.type === "entry_appended" && ev.entry.kind === "moonlet.setup") entry(ev.entry);
		else if (ev.type === "run_end") refresh();
	};
	api("GET", "/api/threads/" + id).then((v) => { $("meta").textContent = v.thread.title + " · orb " + v.orb.id + " (" + v.orb.status + ")"; });
}
$("create").onsubmit = async (e) => { e.preventDefault(); const t = await api("POST", "/api/threads", { prompt: $("prompt").value || undefined, repo: $("repo").value || undefined }); $("prompt").value = ""; open(t.id); };
$("send").onsubmit = async (e) => { e.preventDefault(); if (!current) return; await api("POST", "/api/threads/" + current + "/messages", { content: $("message").value }); $("message").value = ""; };
refresh(); setInterval(refresh, 10000);
</script>
</body>
</html>`;
