/**
 * pi-endless — one chat that never ends, for pi. Taelin's OptChat/UniiChat recipe (gist v2), see docs/.
 *
 * Opt-in: nothing changes until you open a conversation (`pi --mem main` or `/mem open main`).
 * In an open conversation each turn the model sees [view][previous exchange][turn state][new message]
 * and gets zoom/date/search; everything is logged verbatim and compressed into a summary tree in the background.
 * One pi writes a conversation at a time (lock.json); a second pi may open it read-only or take it over.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Memory, PROMPT, CAP, atomicWrite, bytes, cap, flat, start, type Compressor, type Kind } from "./core";
import { t } from "./i18n";

const HOME = process.env.MEM_HOME ?? join(homedir(), ".pi", "memory");
const BINDING = "mem";
const BANNER = "mem-banner";
const TOOLS = ["zoom", "date", "search"];
const SEARCH_PAGE = 20;
const SETTLE_MS = 8000; // wait at most this long for pending summaries at the start of a turn, then go on with placeholders
const PREV_BYTES = 16_000; // the previous exchange is carried verbatim up to this size
const KNOWN_OVERLAPS = ["pi-blackhole", "pi-vcc", "pi-observational-memory", "pi-optchat"];

interface Compactor { provider: string; model: string; thinking?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; maxTokens?: number }
interface Config { compactor: Compactor }
interface Usage { calls: number; input: number; output: number; cacheRead: number; cost: number }
interface Active { name: string; dir: string; memory: Memory; config: Config; token: string; readOnly: boolean; usage: Usage }
interface Banner { name: string; readOnly: boolean; messages: number; compactor: string; last?: { user: string; reply: string }; tail: string[]; overlaps: string[] }

const lockFile = (dir: string) => join(dir, "lock.json");
const readLock = (dir: string): { pid: number; token: string; cwd?: string; at?: string } | undefined => {
	try { return JSON.parse(readFileSync(lockFile(dir), "utf8")); } catch { return undefined; }
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const fmtCompactor = (c: Compactor) => `${c.provider}/${c.model}${c.thinking ? ` (${c.thinking})` : ""}`;

export default function endless(pi: ExtensionAPI) {
	let active: Active | undefined;
	let run: AgentMessage[] = [];
	let logged = 0;
	let view: string | undefined;
	let prevExchange = "";
	let runStarted = false;
	let reviews = 0; // mid-turn context rebuilds in this run
	let fault: string | undefined;
	let flagConsumed = false; // --mem applies to the first session only; a session opened later by /mem close must not reopen it

	pi.registerFlag("mem", { type: "string", description: t("Open this endless conversation (~/.pi/memory/<name>); also /mem open <name> inside pi", "打开这个长期对话（~/.pi/memory/<name>）；会话里也可 /mem open <name>") });

	// ------------------------------------------------------------ status

	const status = (ctx: ExtensionContext) => {
		if (!active) { ctx.ui.setStatus("mem", undefined); return; }
		const m = active.memory;
		const parts = [`mem ${active.name}`, `${m.T} msgs`];
		if (m.pending) parts.push(t(`${m.pending} pending`, `${m.pending} 待摘要`));
		if (m.active) parts.push(t(`${m.active} running`, `${m.active} 压缩中`));
		if (active.readOnly) parts.push(t("read-only", "只读"));
		if (m.lastError) parts.push(t(`compactor failing: ${clip(flat(m.lastError), 50)}`, `压缩失败: ${clip(flat(m.lastError), 50)}`));
		ctx.ui.setStatus("mem", parts.join(" · "));
	};

	// ------------------------------------------------------------ config & compactor

	/** A cheap model the user is logged in to: cheapest by catalog price among haiku/flash/mini/lite-ish ids, else the current model. */
	const pickCompactor = (ctx: ExtensionContext): Compactor => {
		const cheapish = /haiku|flash|mini|lite|nano|small|fast|turbo/i;
		const candidates = ctx.modelRegistry.getAvailable().filter((m) => cheapish.test(m.id) && !/vision|embed|image|audio|tts|whisper/i.test(m.id));
		candidates.sort((a, b) => (a.cost?.input ?? 99) + (a.cost?.output ?? 99) - ((b.cost?.input ?? 99) + (b.cost?.output ?? 99)));
		const same = ctx.model ? candidates.find((m) => m.provider === ctx.model!.provider) : undefined;
		const pick = candidates[0] && (candidates[0].cost?.input ?? 99) === 0 ? candidates[0] : same ?? candidates[0];
		if (pick) return { provider: pick.provider, model: pick.id };
		if (ctx.model) return { provider: ctx.model.provider, model: ctx.model.id };
		throw new Error(t("No model available for the compactor: log in to a provider, then /mem model", "没有可用的压缩模型：先登录一个 provider，再 /mem model"));
	};
	const readJson = <T,>(file: string): T | undefined => { try { return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined; } catch { return undefined; } };
	const loadConfig = (dir: string, ctx: ExtensionContext): Config => {
		const own = readJson<Config>(join(dir, "config.json"));
		if (own?.compactor?.provider && own.compactor.model) return own;
		const global = readJson<Config>(join(HOME, "config.json"));
		const config: Config = { compactor: global?.compactor?.provider && global.compactor.model ? global.compactor : pickCompactor(ctx) };
		atomicWrite(join(dir, "config.json"), JSON.stringify(config, null, 2));
		return config;
	};
	const saveConfig = (a: Active) => {
		atomicWrite(join(a.dir, "config.json"), JSON.stringify(a.config, null, 2));
		atomicWrite(join(HOME, "config.json"), JSON.stringify({ compactor: a.config.compactor }, null, 2)); // new conversations start from the last choice
	};

	const compressor = (ctx: ExtensionContext, get: () => Active): Compressor => async (req, signal) => {
		const a = get(), c = a.config.compactor;
		const model = ctx.modelRegistry.find(c.provider, c.model);
		if (!model) throw new Error(t(`compactor model ${c.provider}/${c.model} unavailable (/mem model)`, `压缩模型 ${c.provider}/${c.model} 不可用（/mem model）`));
		const stream = ctx.modelRegistry.streamSimple(
			model,
			{ systemPrompt: req.system, messages: [{ role: "user", content: req.user, timestamp: Date.now() }] },
			{
				maxTokens: (c.maxTokens ?? 170) + (c.thinking ? 8000 : 0),
				temperature: c.thinking ? undefined : 0.2,
				reasoning: c.thinking,
				samplingParams: c.thinking ? undefined : { reasoning_effort: "none", enable_thinking: false },
				signal,
				sessionId: "mem-compactor",
				cacheRetention: "short",
				transport: "sse",
			},
		);
		const reply = await stream.result();
		const u = reply.usage;
		if (u) { a.usage.calls++; a.usage.input += u.input ?? 0; a.usage.output += u.output ?? 0; a.usage.cacheRead += u.cacheRead ?? 0; a.usage.cost += u.cost?.total ?? 0; }
		if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? `compactor ${reply.stopReason}`);
		const text = reply.content.filter((b) => b.type === "text").map((b) => b.text).join("");
		if (!text.trim()) throw new Error("compactor returned no text");
		return text;
	};

	// ------------------------------------------------------------ open / close

	const overlaps = (): string[] => {
		try {
			const settings = pi.getSettings() as { packages?: unknown[] };
			return (settings.packages ?? []).map((p) => (typeof p === "string" ? p : ((p as { source?: string }).source ?? ""))).filter((s) => KNOWN_OVERLAPS.some((c) => s.includes(c)));
		} catch { return []; }
	};
	const listConversations = () => (existsSync(HOME) ? readdirSync(HOME, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : []);
	/** After a rename the old name holds a pointer file {renamedTo}, so old session bindings and habits follow. */
	const resolveName = (name: string): string => {
		for (let hop = 0; hop < 5; hop++) {
			const p = join(HOME, name);
			if (!existsSync(p) || statSync(p).isDirectory()) return name;
			try { name = JSON.parse(readFileSync(p, "utf8")).renamedTo; } catch { throw new Error(t(`${name} is a file, not a conversation`, `${name} 处是个文件，不是对话目录`)); }
		}
		throw new Error("rename pointers loop");
	};
	const lastExchange = (m: Memory): { user: string; reply: string } | undefined => {
		const log = m.log;
		let r = -1;
		for (let i = log.length - 1; i >= 0; i--) if (log[i].kind === "pi") { r = i; break; }
		if (r < 0) return undefined;
		for (let i = r - 1; i >= 0; i--) if (log[i].kind === "user") return { user: log[i].text, reply: log[r].text };
		return undefined;
	};

	const open = async (rawName: string, ctx: ExtensionContext, create = true): Promise<void> => {
		if (active) await close();
		if (!/^[\w.-]+$/.test(rawName)) throw new Error(t(`Conversation names are letters, digits, . _ -: ${rawName}`, `对话名只能是字母数字 ._-：${rawName}`));
		const name = resolveName(rawName);
		const dir = join(HOME, name);
		if (!existsSync(dir)) {
			if (!create) throw new Error(t(`Conversation ${name} does not exist (${dir})`, `对话 ${name} 不存在（${dir}）`));
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
		let readOnly = false;
		const token = randomUUID();
		const lock = readLock(dir);
		if (lock && lock.pid !== process.pid && alive(lock.pid)) {
			const where = t(`${name} is open in another pi (pid ${lock.pid}${lock.cwd ? ` · ${lock.cwd}` : ""}${lock.at ? ` · since ${lock.at.slice(0, 16)}` : ""})`,
				`${name} 正在被另一个 pi 用着（pid ${lock.pid}${lock.cwd ? ` · ${lock.cwd}` : ""}${lock.at ? ` · 自 ${lock.at.slice(0, 16)}` : ""}）`);
			if (!ctx.hasUI) throw new Error(where);
			const RO = t("Open read-only (search and zoom, nothing logged)", "只读打开（能查不写）"), TAKE = t("Take over (the other pi becomes read-only)", "接管（那边降为只读）"), NO = t("Cancel", "取消");
			const choice = await ctx.ui.select(where, [RO, TAKE, NO]);
			if (choice === undefined || choice === NO) throw new Error(t(`${name} not opened`, `没有打开 ${name}`));
			if (choice === RO) readOnly = true;
		}
		if (!readOnly) atomicWrite(lockFile(dir), JSON.stringify({ pid: process.pid, token, session: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, at: new Date().toISOString() }));
		const config = loadConfig(dir, ctx);
		const a: Active = { name, dir, config, token, readOnly, memory: undefined as unknown as Memory, usage: { calls: 0, input: 0, output: 0, cacheRead: 0, cost: 0 } };
		a.memory = new Memory(dir, compressor(ctx, () => a), (s) => ctx.ui.notify(s, "warning"));
		active = a;
		fault = undefined;
		a.memory.onChange(() => status(ctx));
		pi.setActiveTools([...new Set([...pi.getActiveTools(), ...TOOLS])]);
		pi.setSessionName(`mem ${name}`);
		status(ctx);
		const banner: Banner = {
			name, readOnly, messages: a.memory.T, compactor: fmtCompactor(config.compactor), last: lastExchange(a.memory),
			tail: a.memory.view.parts.slice(-12).map((p) => a.memory.renderLine(p)), overlaps: overlaps(),
		};
		pi.appendEntry(BANNER, banner);
		if (ctx.mode !== "tui") ctx.ui.notify(`mem ${name}${readOnly ? " (read-only)" : ""} · ${a.memory.T} messages · ${banner.compactor}`, "info");
	};

	const close = async () => {
		const a = active;
		if (!a) return;
		active = undefined;
		try { flush(a); } catch { /* closing anyway */ }
		await a.memory.close();
		if (!a.readOnly && readLock(a.dir)?.token === a.token) rmSync(lockFile(a.dir), { force: true });
		pi.setActiveTools(pi.getActiveTools().filter((x) => !TOOLS.includes(x)));
		run = []; logged = 0; view = undefined; runStarted = false; prevExchange = ""; reviews = 0;
	};

	// ------------------------------------------------------------ logging

	const textOf = (content: unknown): string => {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.map((c: { type?: string; text?: string }) => (c?.type === "text" ? (c.text ?? "") : c?.type === "image" ? "[image]" : ""))
			.filter(Boolean)
			.join("\n");
	};

	const logMessage = (a: Active, m: AgentMessage) => {
		const date = new Date(typeof m.timestamp === "number" ? m.timestamp : Date.now()).toISOString();
		const add = (kind: Kind, text: string) => { if (text.trim()) a.memory.append(kind, text, date); };
		if (m.role === "user") add("user", textOf(m.content));
		else if (m.role === "assistant") {
			for (const b of m.content) {
				if (b.type === "text") add("pi", b.text);
				else if (b.type === "toolCall") add("tool", `${b.name} ${JSON.stringify(b.arguments)}`);
			}
			if (m.stopReason === "error" || m.stopReason === "aborted") add("echo", `Agent ${m.stopReason}: ${m.errorMessage ?? "no details"}`);
		} else if (m.role === "toolResult") add("echo", `${m.toolName}: ${cap(textOf(m.content))}`);
		else if (m.role === "custom") add("work", textOf((m as { content: unknown }).content));
	};

	/** Log this run's messages that are not in the log yet. Losing the lock demotes the session to read-only. */
	const flush = (a: Active) => {
		if (a.readOnly) { logged = run.length; return; }
		while (logged < run.length) {
			if (readLock(a.dir)?.token !== a.token) {
				a.readOnly = true;
				fault = t(`${a.name} was taken over by another pi; this session is now read-only`, `${a.name} 被另一个 pi 接管了，本会话降为只读`);
				logged = run.length;
				throw new Error(fault);
			}
			logMessage(a, run[logged]);
			logged++;
		}
	};

	const previousExchange = (a: Active): string => {
		const last = lastExchange(a.memory);
		if (!last || bytes(last.user) + bytes(last.reply) > PREV_BYTES) return "";
		return `<previous_exchange>\nuser: ${last.user}\n\npi: ${last.reply}\n</previous_exchange>`;
	};

	const startRun = (a: Active) => {
		try { flush(a); } catch { /* demoted to read-only; carry on */ }
		run = []; logged = 0; view = undefined; runStarted = true; reviews = 0;
		prevExchange = previousExchange(a);
	};

	const turnState = (a: Active, ctx: ExtensionContext, note = "") =>
		`<turn>\nnow: ${new Date().toString().slice(0, 33)} · cwd: ${ctx.cwd}${a.readOnly ? " · memory is read-only in this session (nothing said here is logged)" : ""}${note ? `\n${note}` : ""}\n</turn>`;

	/** Messages for the model: the first one carries [view][previous exchange][turn state], the rest of the run follows as is. */
	const buildContext = (a: Active, ctx: ExtensionContext): AgentMessage[] => {
		const blocks = [view!, ...(prevExchange ? [prevExchange] : []), turnState(a, ctx)].map((text) => ({ type: "text" as const, text }));
		const first = run[0];
		if (first && first.role === "user") {
			const content = typeof first.content === "string" ? [{ type: "text" as const, text: first.content }] : first.content;
			return [{ ...first, content: [...blocks, ...content] }, ...run.slice(1)];
		}
		return [{ role: "user", content: blocks, timestamp: Date.now() }, ...run];
	};

	/** A very long turn would overflow the model: rebuild the context from memory instead of compacting. The turn's own steps are in the view now (zoomable). */
	const runBytes = () => run.reduce((s, m) => { const c = (m as { content?: unknown }).content; return s + bytes(typeof c === "string" ? c : JSON.stringify(c ?? "")); }, 0);
	const reviewIfLong = (a: Active, ctx: ExtensionContext): boolean => {
		const budget = Math.max(150_000, (ctx.model?.contextWindow ?? 128_000) * 2); // ~ bytes; mixed text runs 2-4 bytes per token
		if (runBytes() < budget) return false;
		flush(a);
		const task = run.find((m) => m.role === "user");
		const taskText = task ? textOf(task.content) : "";
		view = a.memory.render();
		prevExchange = "";
		reviews++;
		run = [{
			role: "user",
			timestamp: Date.now(),
			content: [{
				type: "text",
				text: turnState(a, ctx, `This turn ran long, so its context was rebuilt from memory (rebuild #${reviews}): everything you did so far in this turn is in the last lines of the view above; zoom them for exact details. Continue the task without repeating finished steps.${taskText && bytes(taskText) <= 4000 ? `\nThe task of this turn, verbatim: ${taskText}` : ""}`),
			}],
		}];
		logged = 0;
		ctx.ui.notify(t("mem: this turn ran long; context rebuilt from memory", "mem：本轮太长，已从记忆重建上下文继续"), "info");
		return true;
	};

	// ------------------------------------------------------------ pi events

	pi.on("session_start", async (_e, ctx) => {
		const flag = flagConsumed ? undefined : pi.getFlag("mem");
		flagConsumed = true;
		const bound = ctx.sessionManager.getEntries().findLast((e) => e.type === "custom" && e.customType === BINDING);
		const boundName = bound?.type === "custom" && bound.data && typeof (bound.data as { name?: unknown }).name === "string" ? (bound.data as { name: string }).name : undefined;
		const name = boundName ?? (typeof flag === "string" && flag ? flag : undefined);
		if (!name) { status(ctx); return; }
		if (boundName && typeof flag === "string" && flag && flag !== boundName) ctx.ui.notify(t(`This session is bound to ${boundName}; ignoring --mem ${flag}`, `这个会话绑定的是 ${boundName}，忽略 --mem ${flag}`), "warning");
		try {
			await open(name, ctx, name !== boundName);
			if (active && active.name !== boundName) pi.appendEntry(BINDING, { name: active.name });
		} catch (e) {
			fault = errorText(e);
			ctx.ui.notify(fault, "error");
			status(ctx);
		}
	});
	pi.on("session_shutdown", close);

	const DEFAULT_PREAMBLE = "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
	let warnedForced = false;
	pi.on("before_agent_start", (event, ctx) => {
		if (!active) return;
		event.systemPromptOptions.customPrompt = PROMPT;
		startRun(active);
		// An earlier extension returned `systemPrompt` (forcing the whole prompt), which would hide ours: swap its default preamble for ours.
		const forced = event.systemPromptOptions.forceSystemPrompt;
		if (forced !== undefined && !forced.includes(PROMPT.slice(0, 40))) {
			if (!warnedForced) { warnedForced = true; ctx.ui.notify(t("mem: another extension forces the system prompt via before_agent_start; patched its preamble. It should use systemPromptOptions.sections instead.", "mem：有扩展在 before_agent_start 返回 systemPrompt 钉死了提示词，已替换其默认开头；它应改用 systemPromptOptions.sections。"), "warning"); }
			return { systemPrompt: forced.includes(DEFAULT_PREAMBLE) ? forced.replace(DEFAULT_PREAMBLE, PROMPT) : `${PROMPT}\n\n${forced}` };
		}
	});
	pi.on("agent_start", () => { if (active && !runStarted) startRun(active); });

	pi.on("message_end", (event, ctx) => {
		if (!active || !runStarted) return;
		let message = event.message;
		// Tool output is capped at CAP characters (head and tail) both in the log and in this turn's context.
		if (message.role === "toolResult") {
			const text = message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
			if (text.length > CAP) message = { ...message, content: [{ type: "text", text: cap(text) }, ...message.content.filter((c) => c.type === "image")] };
		}
		run.push(message);
		if (view !== undefined) {
			try { flush(active); } catch (e) { ctx.ui.notify(errorText(e), "warning"); }
		}
		if (message !== event.message) return { message };
	});

	pi.on("context", async (_event, ctx) => {
		const a = active;
		if (!a) return;
		if (view === undefined) {
			const m = a.memory;
			if (!m.ready) {
				const show = () => ctx.ui.setWorkingMessage(t(`mem: waiting for ${m.pending} summaries${m.lastError ? ` (failing: ${clip(flat(m.lastError), 80)})` : ""}…`, `mem：等摘要，${m.pending} 条未建${m.lastError ? `（失败：${clip(flat(m.lastError), 80)}）` : ""}…`));
				show();
				const off = m.onChange(show);
				try { await m.settle(SETTLE_MS, ctx.signal); } finally { off(); ctx.ui.setWorkingMessage(); }
			}
			view = m.render(); // the view covers everything before this turn's new message, which is logged right after
			try { flush(a); } catch (e) { ctx.ui.notify(errorText(e), "warning"); }
			status(ctx);
		} else {
			try { reviewIfLong(a, ctx); } catch (e) { ctx.ui.notify(errorText(e), "warning"); }
		}
		if (!run.length) return; // nothing captured for this run (should not happen): leave pi's context alone rather than send an empty one
		return { messages: buildContext(a, ctx) };
	});

	pi.on("agent_settled", (_e, ctx) => {
		if (!active) return;
		try { flush(active); } catch (e) { ctx.ui.notify(errorText(e), "warning"); }
		runStarted = false;
		status(ctx);
	});

	pi.on("session_before_compact", (_e, ctx) => {
		if (!active) return;
		ctx.ui.notify(t("mem owns the history: pi compaction cancelled.", "mem 接管了历史：pi 的 compaction 已取消。"), "info");
		return { cancel: true };
	});
	pi.on("cache_warming_decision", () => (active ? { action: "stop" } : undefined));

	// Anthropic: the view goes in 4-line blocks with one cache mark on the last whole block; pi's own message marks are removed (4-mark limit).
	pi.on("before_provider_request", (event, ctx) => {
		if (active && process.env.MEM_DEBUG) atomicWrite(process.env.MEM_DEBUG, JSON.stringify(event.payload, null, 1));
		if (!active || ctx.model?.api !== "anthropic-messages") return event.payload;
		const payload = event.payload as { messages?: Array<{ role: string; content: unknown; cache_control?: unknown }> };
		if (!Array.isArray(payload?.messages)) return event.payload;
		for (const msg of payload.messages) {
			if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
			const at = (msg.content as Array<{ type: string; text?: string }>).findIndex((b) => b.type === "text" && typeof b.text === "string" && b.text.startsWith("<chat>\n"));
			if (at < 0) continue;
			const lines = (msg.content[at] as { text: string }).text.split("\n");
			const blocks: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> = [];
			for (let i = 0; i < lines.length; i += 4) blocks.push({ type: "text", text: lines.slice(i, i + 4).join("\n") + (i + 4 < lines.length ? "\n" : "") });
			if (blocks.length > 1) blocks[blocks.length - 2].cache_control = { type: "ephemeral" };
			(msg.content as unknown[]).splice(at, 1, ...blocks);
			for (const m of payload.messages) {
				delete m.cache_control;
				if (Array.isArray(m.content)) for (const b of m.content as Array<{ cache_control?: unknown }>) if (!blocks.includes(b as never)) delete b.cache_control;
			}
			(payload as { cache_control?: unknown }).cache_control = { type: "ephemeral" };
			break;
		}
		return payload;
	});

	// ------------------------------------------------------------ tools

	const need = () => { if (!active) throw new Error(t("No conversation open: /mem open <name>", "没有打开的对话：/mem open <name>")); return active; };
	const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: undefined });

	pi.registerTool({
		name: "zoom", label: "Zoom memory", exposure: "codemode",
		description: "Open the line id+n of the memory view into the two lines of n/2 under it; n = 1 gives message id whole. n is a power of 2 and id a multiple of n.",
		parameters: Type.Object({ id: Type.Integer({ minimum: 0 }), n: Type.Integer({ minimum: 1 }) }),
		async execute(_id, args) { return text(need().memory.zoom(args.id, args.n)); },
	});
	pi.registerTool({
		name: "date", label: "Memory date", exposure: "codemode",
		description: "The date and time of memory message id.",
		parameters: Type.Object({ id: Type.Integer({ minimum: 0 }) }),
		async execute(_id, args) { return text(need().memory.date(args.id)); },
	});
	pi.registerTool({
		name: "search", label: "Search memory", exposure: "codemode",
		description: `Find the original memory messages that contain text (plain text, any case), newest first, ${SEARCH_PAGE} at a time; before: id continues with older ones. zoom(id, 1) gives a hit whole.`,
		parameters: Type.Object({ text: Type.String({ minLength: 1 }), before: Type.Optional(Type.Integer({ minimum: 0 })) }),
		async execute(_id, args) { return text(searchPage(need().memory, args.text, args.before)); },
	});

	const searchPage = (m: Memory, q: string, before?: number): string => {
		const hits = m.search(q, before);
		if (!hits.length) return `No ${before === undefined ? "" : "older "}messages contain "${q}".`;
		const page = hits.slice(0, SEARCH_PAGE), needle = q.toLowerCase();
		const lines = page.map((e) => {
			const at = Math.max(0, e.text.toLowerCase().indexOf(needle) - 50);
			const snippet = flat(e.text.slice(at, at + 200));
			const line = m.view.covering(e.i);
			return `${e.i}${line && line.l ? ` (in ${start(line)}+${2 ** line.l})` : ""} · ${new Date(e.date).toString().slice(0, 21)} · ${e.kind}: ${at ? "…" : ""}${snippet}${at + 200 < e.text.length ? "…" : ""}`;
		});
		const more = hits.length > page.length ? `\nOlder matches: search again with before: ${page[page.length - 1].i}.` : "";
		return `${hits.length} ${hits.length === 1 ? "message contains" : "messages contain"} "${q}", newest first:\n${lines.join("\n")}${more}`;
	};

	// ------------------------------------------------------------ banner (scrollback entry, never sent to the model)

	pi.registerEntryRenderer<Banner>(BANNER, (entry, { expanded }, theme) => {
		const b = entry.data;
		if (!b) return undefined;
		const box = new Box(1, 0, (s) => theme.bg("customMessageBg", s));
		const head = `${theme.fg("accent", `📒 ${b.name}`)}${b.readOnly ? theme.fg("warning", t(" read-only", " 只读")) : ""} · ${b.messages} ${t("messages", "条消息")} · ${theme.fg("dim", b.compactor)}`;
		box.addChild(new Text(head, 0, 0));
		if (b.last) {
			box.addChild(new Text(theme.fg("dim", t("last time:", "上次：")), 0, 0));
			box.addChild(new Text(`${theme.fg("accent", "you")}  ${clip(flat(b.last.user), 300)}`, 0, 0));
			box.addChild(new Text(`${theme.fg("accent", "pi")}   ${clip(flat(b.last.reply), 600)}`, 0, 0));
		} else if (!b.messages) box.addChild(new Text(theme.fg("dim", t("new conversation — nothing remembered yet. Say something; everything is kept.", "新对话，还没有记忆。说点什么吧，什么都不会丢。")), 0, 0));
		if (b.tail.length) {
			if (expanded) { box.addChild(new Text(theme.fg("dim", t("the newest lines of the view (what the model sees):", "视图最新几行（模型看到的）：")), 0, 0)); for (const l of b.tail) box.addChild(new Text(theme.fg("dim", clip(l, 400)), 0, 0)); }
			else box.addChild(new Text(theme.fg("dim", t("/mem for status · /mem view for the whole view · ctrl+o shows the newest lines", "/mem 看状态 · /mem view 看整个视图 · ctrl+o 展开最新几行")), 0, 0));
		}
		if (b.overlaps.length) box.addChild(new Text(theme.fg("warning", t(`note: ${b.overlaps.join(", ")} will run its workers for nothing here (memory is unaffected)`, `提示：${b.overlaps.join(", ")} 的后台 worker 在这里会白跑（记忆不受影响）`)), 0, 0));
		return box;
	});

	// ------------------------------------------------------------ /mem

	const USAGE = "/mem open <name> | close | rename <new> | status | view | zoom id+n | search <text> | model | list";
	pi.registerCommand("mem", {
		description: t("Endless conversation: open <name> | close | rename | status | view | zoom | search | model | list", "长期对话：open <name> | close | rename | status | view | zoom | search | model | list"),
		getArgumentCompletions: (prefix) => {
			const m = /^(open|rename)\s+(\S*)$/.exec(prefix);
			if (m) return listConversations().filter((n) => n.startsWith(m[2])).map((n) => ({ value: `${m[1]} ${n}`, label: n }));
			return ["open", "close", "rename", "status", "view", "zoom", "search", "model", "list"].filter((s) => s.startsWith(prefix)).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const [cmd0, ...rest] = args.trim().split(/\s+/);
			const cmd = cmd0 || (active ? "status" : "open");
			const arg = rest.join(" ");
			try {
				if (cmd === "open") {
					let name = arg;
					const NEW = t("+ new conversation", "+ 新建对话");
					if (!name && ctx.hasUI) name = (await ctx.ui.select(t("Open which conversation?", "打开哪个对话？"), [...listConversations(), NEW])) ?? "";
					if (name === NEW) name = (await ctx.ui.input(t("Name", "对话名"), "main"))?.trim() ?? "";
					if (!name) return;
					if (!ctx.isIdle()) throw new Error(t("Wait for the agent to finish first", "等 agent 停下来再换对话"));
					if (active?.name === name) { ctx.ui.notify(t(`${name} is already open`, `${name} 已经打开`), "info"); return; }
					// A fresh session bound to the conversation (this one stays, /resume brings it back); session_start opens it.
					await ctx.newSession({ setup: async (sm) => { sm.appendCustomEntry(BINDING, { name }); } });
					return;
				}
				if (cmd === "close") {
					if (!active) { ctx.ui.notify(t("No conversation open", "没有打开的对话"), "info"); return; }
					if (!ctx.isIdle()) throw new Error(t("Wait for the agent to finish first", "等 agent 停下来再关"));
					await close();
					await ctx.newSession();
					return;
				}
				if (cmd === "list") { ctx.ui.notify(listConversations().join("\n") || t("No conversations yet: /mem open <name> creates one", "还没有对话：/mem open <name> 新建"), "info"); return; }
				const a = need();
				if (cmd === "rename") {
					const to = arg.trim();
					if (!/^[\w.-]+$/.test(to)) throw new Error(t("Usage: /mem rename <new-name>", "用法：/mem rename <新名字>"));
					if (!ctx.isIdle()) throw new Error(t("Wait for the agent to finish first", "等 agent 停下来再改名"));
					if (a.readOnly) throw new Error(t("A read-only conversation cannot be renamed here", "只读打开的对话不能改名"));
					if (existsSync(join(HOME, to))) throw new Error(t(`${to} already exists`, `${to} 已经存在`));
					const from = a.name;
					await close();
					renameSync(join(HOME, from), join(HOME, to));
					atomicWrite(join(HOME, from), JSON.stringify({ renamedTo: to }));
					await open(to, ctx, false);
					pi.appendEntry(BINDING, { name: to });
					ctx.ui.notify(t(`${from} → ${to}. The old name keeps a pointer, so old sessions and --mem ${from} still work.`, `${from} → ${to}。旧名字处留了指针，旧会话和 --mem ${from} 都会跟过来。`), "info");
					return;
				}
				if (cmd === "status") {
					const m = a.memory, u = a.usage;
					ctx.ui.notify([
						`mem ${a.name}${a.readOnly ? t(" (read-only)", "（只读）") : ""} · ${a.dir}`,
						t(`messages ${m.T} · tree nodes ${m.tree.size} · owed ${m.owed} (leaves ${m.pending}) · running ${m.active}`, `消息 ${m.T} · 树节点 ${m.tree.size} · 欠 ${m.owed}（叶子 ${m.pending}）· 压缩中 ${m.active}`),
						t(`view ${m.view.parts.length} lines, ${m.view.bytes} B (compaction view ${m.cview.parts.length} lines, ${m.cview.bytes} B)`, `视图 ${m.view.parts.length} 行 ${m.view.bytes} B（压缩视图 ${m.cview.parts.length} 行 ${m.cview.bytes} B）`),
						t(`compactor ${fmtCompactor(a.config.compactor)} · this session: ${u.calls} calls, ${u.input + u.cacheRead} in (${u.cacheRead} cached), ${u.output} out, $${u.cost.toFixed(4)}`, `压缩器 ${fmtCompactor(a.config.compactor)} · 本会话 ${u.calls} 次，输入 ${u.input + u.cacheRead}（缓存 ${u.cacheRead}），输出 ${u.output}，$${u.cost.toFixed(4)}`),
						...(m.lastError ? [t(`last error: ${m.lastError}`, `最近错误：${m.lastError}`)] : []),
						...(fault ? [fault] : []),
					].join("\n"), "info");
					return;
				}
				if (cmd === "view") { await ctx.ui.editor(t(`view of ${a.name} (read-only; esc to close)`, `${a.name} 的视图（只看；esc 关闭）`), a.memory.render()); return; }
				if (cmd === "zoom") {
					const mm = /^(\d+)\+(\d+)$/.exec(arg) ?? /^(\d+)\s+(\d+)$/.exec(arg);
					if (!mm) throw new Error(t("Usage: /mem zoom 1024+256", "用法：/mem zoom 1024+256"));
					await ctx.ui.editor(`zoom ${mm[1]}+${mm[2]}`, a.memory.zoom(Number(mm[1]), Number(mm[2])));
					return;
				}
				if (cmd === "search") { if (!arg) throw new Error(t("Usage: /mem search <text>", "用法：/mem search 词")); await ctx.ui.editor(`search ${arg}`, searchPage(a.memory, arg)); return; }
				if (cmd === "model") {
					const models = ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`).sort();
					const current = `${a.config.compactor.provider}/${a.config.compactor.model}`;
					const pick = await ctx.ui.select(t(`Compactor model (now ${current})`, `压缩模型（现在 ${current}）`), [current, ...models.filter((m) => m !== current)]);
					if (!pick) return;
					const slash = pick.indexOf("/");
					const OFF = t("thinking off (recommended: fast and cheap; size is enforced by the cut)", "不思考（推荐：快、便宜；尺寸由截断保证）"), MED = t("thinking medium (models that obey size limits, e.g. Haiku)", "思考 medium（听得懂尺寸限制的模型，如 Haiku）");
					const thinking = await ctx.ui.select(t("Thinking", "思考"), [OFF, MED]);
					a.config.compactor = { provider: pick.slice(0, slash), model: pick.slice(slash + 1), ...(thinking === MED ? { thinking: "medium" as const } : {}) };
					saveConfig(a);
					ctx.ui.notify(t(`Compactor → ${fmtCompactor(a.config.compactor)} from the next summary on; new conversations start with it too.`, `压缩器 → ${fmtCompactor(a.config.compactor)}，下一次压缩起生效；新对话也默认用它。`), "info");
					return;
				}
				throw new Error(`${t("Usage", "用法")}: ${USAGE}`);
			} catch (e) {
				ctx.ui.notify(errorText(e), "error");
			}
		},
	});
}
