#!/usr/bin/env bun
// Replay a real pi session into a throwaway conversation with a real compactor: the long-run path (batch merges,
// multi-level summaries, cost) in minutes instead of weeks. Talks to an OpenAI-compatible provider from ~/.pi/agent/models.json.
//   bun scripts/replay-session.ts <session.jsonl> <provider/model> [--max 700] [--home DIR] [--keep]
// Prints merges, levels, calls, tokens and sample lines; the conversation lands in --home (default: a temp dir, removed unless --keep).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Memory, cap, end, start, type Kind } from "../src/core";

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const [file, target] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!file || !target) { console.error("usage: bun scripts/replay-session.ts <session.jsonl> <provider/model> [--max 700] [--home DIR] [--keep]"); process.exit(2); }
const max = Number(opt("--max") ?? 700);
const slash = target.indexOf("/"), providerName = target.slice(0, slash), modelId = target.slice(slash + 1);
const provider = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "models.json"), "utf8")).providers?.[providerName];
if (!provider?.baseUrl || provider.api !== "openai-completions") { console.error(`${providerName}: needs an openai-completions provider with baseUrl in models.json`); process.exit(2); }
const key = /^[A-Z_][A-Z0-9_]*$/.test(provider.apiKey ?? "") && process.env[provider.apiKey] ? process.env[provider.apiKey] : provider.apiKey;

const usage = { calls: 0, failed: 0, prompt: 0, cached: 0, completion: 0, ms: 0 };
const compress = async (req: { system: string; user: string }, signal: AbortSignal): Promise<string> => {
	const t0 = Date.now();
	const res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
		method: "POST", signal,
		headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
		body: JSON.stringify({ model: modelId, max_tokens: 170, temperature: 0.2, messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }] }),
	});
	usage.calls++; usage.ms += Date.now() - t0;
	if (!res.ok) { usage.failed++; throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`); }
	const j = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; prompt_cache_hit_tokens?: number } };
	usage.prompt += j.usage?.prompt_tokens ?? 0; usage.completion += j.usage?.completion_tokens ?? 0;
	usage.cached += j.usage?.prompt_tokens_details?.cached_tokens ?? j.usage?.prompt_cache_hit_tokens ?? 0;
	return j.choices?.[0]?.message?.content ?? "";
};

// the same mapping as src/index.ts logMessage
type Block = { type: string; text?: string; name?: string; arguments?: unknown };
const textOf = (c: unknown) => typeof c === "string" ? c : Array.isArray(c) ? (c as Block[]).map((b) => (b.type === "text" ? b.text ?? "" : b.type === "image" ? "[image]" : "")).filter(Boolean).join("\n") : "";
const records: Array<{ kind: Kind; text: string; date: string }> = [];
for (const line of readFileSync(file, "utf8").split("\n")) {
	if (records.length >= max) break;
	let e: { type?: string; timestamp?: string; message?: { role: string; content: unknown; toolName?: string } };
	try { e = JSON.parse(line); } catch { continue; }
	if (e.type !== "message" || !e.message) continue;
	const m = e.message, date = new Date(e.timestamp ?? Date.now()).toISOString();
	const add = (kind: Kind, text: string) => { if (text.trim() && records.length < max) records.push({ kind, text, date }); };
	if (m.role === "user") add("user", textOf(m.content));
	else if (m.role === "assistant" && Array.isArray(m.content)) for (const b of m.content as Block[]) { if (b.type === "text") add("pi", b.text ?? ""); else if (b.type === "toolCall") add("tool", `${b.name} ${JSON.stringify(b.arguments)}`); }
	else if (m.role === "toolResult") add("echo", `${m.toolName}: ${cap(textOf(m.content))}`);
	else if (m.role === "custom") add("work", textOf(m.content));
}

const home = opt("--home") ?? mkdtempSync(join(tmpdir(), "mem-replay-"));
const m = new Memory(join(home, "replay"), compress, (s) => { if (!/compaction .* failed/.test(s)) console.error(s); });
const t0 = Date.now();
let merges = 0, prevLines = 0, peak = 0;
const progress = setInterval(() => console.error(`  ${((Date.now() - t0) / 1000).toFixed(0)}s · logged ${m.T}/${records.length} · owed ${m.owed} · calls ${usage.calls} (${usage.failed} failed) · view ${m.view.parts.length} lines ${(m.view.bytes / 1000).toFixed(0)} KB`), 15_000);
for (const r of records) {
	while (m.pending > 16) await new Promise((res) => setTimeout(res, 50)); // like a real chat: summaries keep up with the talk
	m.append(r.kind, r.text, r.date);
	peak = Math.max(peak, m.view.bytes);
	if (m.view.parts.length < prevLines) merges++;
	prevLines = m.view.parts.length;
}
while (m.owed > 0) { await new Promise((res) => setTimeout(res, 200)); if (m.view.parts.length < prevLines) merges++; prevLines = m.view.parts.length; }
clearInterval(progress);
m.render();
const levels = new Map<number, number>();
for (const p of m.view.parts) levels.set(p.l, (levels.get(p.l) ?? 0) + 1);
const said = m.log.reduce((s, e) => s + e.size, 0);
console.log(`replayed ${m.T} messages (${(said / 1000).toFixed(0)} KB said) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.log(`view ${m.view.parts.length} lines, ${(m.view.bytes / 1000).toFixed(0)} KB (peak ${(peak / 1000).toFixed(0)} KB); batch merges ${merges}; lines by level ${[...levels].sort((a, b) => a[0] - b[0]).map(([l, n]) => `${2 ** l}:${n}`).join(" ")}`);
console.log(`compactor ${target}: ${usage.calls} calls (${usage.failed} failed), ${usage.prompt} prompt tokens (${usage.cached} cached), ${usage.completion} completion, ${(usage.ms / Math.max(1, usage.calls) / 1000).toFixed(1)} s avg`);
for (const l of [...levels.keys()].sort((a, b) => b - a).slice(0, 3)) {
	const p = m.view.parts.find((q) => q.l === l)!;
	console.log(`\n[${start(p)}+${end(p) - start(p)}] ${m.text(p)}`);
}
await m.close();
if (!opt("--home") && !args.includes("--keep")) rmSync(home, { recursive: true, force: true });
else console.log(`\nkept: MEM_HOME=${home}`);
