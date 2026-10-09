#!/usr/bin/env node
// End-to-end smoke test over `pi --mode rpc`: open / chat / status / rename / close / reopen by old name / recall /
// lock takeover from a second pi / delete to trash / mistyped name pruned. Needs a logged-in pi and a model.
//   node scripts/smoke.mjs            (SMOKE_MODEL=provider/id to pick the chat model; MEM_LANG is forced to en)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MEM_HOME = mkdtempSync(join(tmpdir(), "pi-endless-smoke-"));
const cwd = mkdtempSync(join(tmpdir(), "pi-endless-cwd-"));
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

class Pi {
	constructor(label, args = []) {
		this.label = label;
		this.notices = [];
		this.status = new Map();
		this.pendingUi = [];
		this.waiters = [];
		this.seq = 0;
		this.buf = "";
		this.answer = () => undefined; // (uiRequest) => response fields
		const model = process.env.SMOKE_MODEL ? ["--model", process.env.SMOKE_MODEL] : [];
		this.proc = spawn("pi", ["--mode", "rpc", ...model, ...args], { cwd, env: { ...process.env, MEM_HOME, MEM_LANG: "en" }, stdio: ["pipe", "pipe", "pipe"] });
		this.proc.stdout.on("data", (d) => this.feed(d.toString()));
		this.proc.stderr.on("data", (d) => { if (process.env.SMOKE_VERBOSE) process.stderr.write(`[${label} stderr] ${d}`); });
	}
	feed(chunk) {
		this.buf += chunk;
		const lines = this.buf.split("\n"); this.buf = lines.pop();
		for (const line of lines) {
			if (!line.trim()) continue;
			let ev; try { ev = JSON.parse(line); } catch { continue; }
			if (process.env.SMOKE_VERBOSE) console.log(`[${this.label}] ${line.slice(0, 200)}`);
			if (ev.type === "extension_ui_request") {
				if (ev.method === "notify") this.notices.push(ev.message);
				else if (ev.method === "setStatus") this.status.set(ev.statusKey, ev.statusText);
				else if (["select", "confirm", "input", "editor"].includes(ev.method)) {
					const fields = this.answer(ev) ?? { cancelled: true };
					this.send({ type: "extension_ui_response", id: ev.id, ...fields });
				}
			}
			for (const w of [...this.waiters]) if (w.test(ev)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(ev); }
		}
	}
	send(obj) { this.proc.stdin.write(`${JSON.stringify(obj)}\n`); }
	wait(test, ms = 120_000) {
		return new Promise((resolve, reject) => {
			const w = { test, resolve };
			this.waiters.push(w);
			setTimeout(() => { if (this.waiters.includes(w)) { this.waiters.splice(this.waiters.indexOf(w), 1); reject(new Error(`${this.label}: timeout waiting`)); } }, ms);
		});
	}
	async cmd(obj) {
		const id = `${this.label}-${++this.seq}`;
		const done = this.wait((ev) => ev.type === "response" && ev.id === id);
		this.send({ id, ...obj });
		return done;
	}
	/** Send a prompt or /command; waits for agent_settled when a run starts. Returns the notices produced meanwhile. */
	async say(message) {
		const from = this.notices.length;
		const settled = this.wait((ev) => ev.type === "agent_settled");
		const res = await this.cmd({ type: "prompt", message });
		if (!res.success) throw new Error(`${this.label}: prompt failed: ${res.error}`);
		if (res.data?.disposition === "started" || res.data?.disposition === "queued") await settled;
		else { this.waiters = this.waiters.filter((w) => w.resolve !== settled.resolve); await new Promise((r) => setTimeout(r, 300)); }
		return this.notices.slice(from).join("\n");
	}
	async lastText() { return (await this.cmd({ type: "get_last_assistant_text" })).data?.text ?? ""; }
	async stop() { this.proc.stdin.end(); await new Promise((r) => { this.proc.on("exit", r); setTimeout(r, 20_000); }); }
}

const logCount = (name) => { const d = join(MEM_HOME, name, "main"); return existsSync(d) ? readdirSync(d).reduce((n, f) => n + readFileSync(join(d, f), "utf8").split("\n").filter(Boolean).length, 0) : -1; };

const a = new Pi("A");
try {
	await a.wait((ev) => ev.type === "response" || ev.type === "extension_ui_request" || ev.type === "agent_settled" || ev.type === "session_start", 5000).catch(() => {});
	let n = await a.say("/mem open smoke");
	check("open new conversation", /mem smoke/.test(n) && existsSync(join(MEM_HOME, "smoke", "config.json")), n.split("\n")[0]);

	n = await a.say("Remember this: the project code name is bluewhale and the database port is 5433. Reply with just: ok");
	check("chat is logged", logCount("smoke") >= 2, `${logCount("smoke")} log entries`);

	n = await a.say("/mem status");
	check("status", /messages \d+/.test(n) && /compactor/.test(n), n.split("\n")[1]);

	n = await a.say("/mem rename smoke2");
	check("rename", existsSync(join(MEM_HOME, "smoke2", "config.json")) && JSON.parse(readFileSync(join(MEM_HOME, "smoke"), "utf8")).renamedTo === "smoke2", n.split("\n")[0]);

	n = await a.say("/mem close");
	await new Promise((r) => setTimeout(r, 500));
	n = await a.say("/mem status");
	check("close", /No conversation open/.test(n), n);

	n = await a.say("/mem open smoke");
	check("reopen by old name follows the pointer", /mem smoke2/.test(n), n.split("\n")[0]);

	await a.say("What is the database port of the project? Answer with the number only.");
	const answer = await a.lastText();
	check("recall across sessions", /5433/.test(answer), answer.trim().slice(0, 60));

	// second pi takes over
	const b = new Pi("B");
	b.answer = (req) => (req.method === "select" ? { value: req.options.find((o) => /Take over/.test(o)) } : undefined);
	await new Promise((r) => setTimeout(r, 1500));
	n = await b.say("/mem open smoke2");
	check("takeover from a second pi", /mem smoke2/.test(n) && !/read-only/.test(n), n.split("\n")[0]);
	n = await a.say("Reply with just: ok");
	check("first pi demoted to read-only", /taken over/.test(n) || /read-only/.test(a.status.get("mem") ?? ""), `${n.split("\n")[0]} | status: ${a.status.get("mem")}`);

	n = await b.say("/mem delete smoke2");
	check("delete refuses while open", /close first/.test(n), n);
	await b.say("/mem close");
	b.answer = (req) => (req.method === "confirm" ? { confirmed: true } : undefined);
	n = await b.say("/mem delete smoke2");
	const trashed = existsSync(join(MEM_HOME, ".trash")) ? readdirSync(join(MEM_HOME, ".trash")) : [];
	check("delete moves to .trash", trashed.some((d) => d.startsWith("smoke2-")) && !existsSync(join(MEM_HOME, "smoke2")), trashed.join(","));

	await b.say("/mem open typo");
	await b.say("/mem close");
	await new Promise((r) => setTimeout(r, 500));
	check("mistyped empty conversation is pruned on close", !existsSync(join(MEM_HOME, "typo")));
	await b.stop();
} catch (e) {
	check("run", false, e.message);
} finally {
	await a.stop();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed · MEM_HOME ${MEM_HOME}`);
if (!failed) { rmSync(MEM_HOME, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
