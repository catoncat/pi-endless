#!/usr/bin/env node
// Does the provider actually serve this extension's requests from its prompt cache? Two real turns in a throwaway
// conversation (separate pi processes, like two days of chat): turn 1 reads 4 files one call at a time, turn 2 reads 2 more.
// Pass = cacheRead grows at every step after the first of a turn (the run's own messages are cached), and turn 2's first
// call reads the cache at all (system prompt + tools + the view written by turn 1). Costs a few cents of the chosen model.
//   node scripts/cache-check.mjs [provider/model]      (or CACHE_MODEL=provider/model; default: pi's default model)
// exit 0 = cached as designed, 1 = cache misses (or the provider reports no cache usage), 2 = pi failed
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const model = process.argv[2] ?? process.env.CACHE_MODEL;
const root = mkdtempSync(join(tmpdir(), "pi-endless-cache-"));
const [home, cwd, sessions] = ["mem", "cwd", "sessions"].map((d) => { const p = join(root, d); spawnSync("mkdir", ["-p", p]); return p; });
for (let i = 1; i <= 6; i++) writeFileSync(join(cwd, `f${i}.txt`), randomBytes(2400).toString("base64")); // incompressible, ~1k tokens each

const pi = (prompt) => {
	const r = spawnSync("pi", [...(model ? ["--model", model] : []), "--session-dir", sessions, "--mem", "cachecheck", "-p", prompt], {
		cwd, env: { ...process.env, MEM_HOME: home }, encoding: "utf8", timeout: 300_000,
	});
	if (r.status !== 0) { console.error(`pi failed (${r.status}): ${(r.stderr || r.stdout).slice(-800)}`); rmSync(root, { recursive: true, force: true }); process.exit(2); }
};
const usage = () => readdirSync(sessions).sort().map((f) => readFileSync(join(sessions, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
	.filter((e) => e.type === "message" && e.message.role === "assistant").map((e) => ({ input: e.message.usage?.input ?? 0, cacheRead: e.message.usage?.cacheRead ?? 0, model: `${e.message.provider}/${e.message.model}` })));

const ask = (files) => `Read ${files.map((f) => `f${f}.txt`).join(", ")} one at a time: exactly one read tool call per step, never in parallel. Then reply with just "done".`;
pi(ask([1, 2, 3, 4]));
pi(ask([5, 6]));
const turns = usage();
rmSync(root, { recursive: true, force: true });

const problems = [];
if (turns.length !== 2) problems.push(`expected 2 sessions, found ${turns.length}`);
console.log(`model: ${turns[0]?.[0]?.model ?? model ?? "?"}`);
turns.forEach((steps, t) => {
	console.log(`turn ${t + 1}`);
	steps.forEach((s, k) => {
		const grew = k === 0 || s.cacheRead > steps[k - 1].cacheRead;
		console.log(`  step ${k + 1}: input ${String(s.input).padStart(6)}  cacheRead ${String(s.cacheRead).padStart(6)}${grew ? "" : "  <- cache did not grow"}`);
		if (!grew) problems.push(`turn ${t + 1} step ${k + 1}: cacheRead ${s.cacheRead} did not grow (step ${k}: ${steps[k - 1].cacheRead})`);
	});
	if (steps.length < 3) problems.push(`turn ${t + 1}: only ${steps.length} model calls; the model batched the reads, nothing to compare`);
});
if (turns.flat().every((s) => s.cacheRead === 0)) problems.push("the provider reported no cacheRead at all: either it has no prompt cache or pi does not get the numbers; cannot judge");
else if (turns[1] && turns[1][0]?.cacheRead === 0) problems.push("turn 2's first call read nothing from the cache: the prefix (system prompt, tools, view) changed between turns");
console.log(problems.length ? `\nCACHE PROBLEMS:\n- ${problems.join("\n- ")}` : "\ncached as designed");
process.exit(problems.length ? 1 : 0);
