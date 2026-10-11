// 为什么测这里：缓存失效不报错，只是悄悄变贵。core 证明视图本身稳定，这里证明整条请求稳定——
// 2026-10 的回归就在这一层：每次调用都重写带秒的 <turn>，视图之后的整轮内容每步都 cache miss。
// 用假的 pi 驱动真实 hook（before_agent_start → message_end → context），步与步之间拨钟。
import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Handler = (event: any, ctx: any) => any;
const home = mkdtempSync(join(tmpdir(), "mem-index-"));
const handlers = new Map<string, Handler[]>();
const tools: any[] = [];
let activeTools: string[] = ["read"];
let clock = Date.parse("2026-10-11T10:00:00Z");

const ctx = (api = "openai-completions") => ({
	cwd: "/tmp/project", hasUI: false, mode: "print", signal: undefined, isIdle: () => true,
	model: { provider: "fake", id: "chat", api, contextWindow: 128_000 },
	ui: { setStatus() {}, notify() {}, setWorkingMessage() {} },
	sessionManager: { getEntries: () => [], getSessionId: () => "s1" },
	modelRegistry: {
		getAvailable: () => [{ provider: "fake", id: "mini", cost: { input: 0, output: 0 } }],
		find: (provider: string, id: string) => ({ provider, id }),
		streamSimple: () => ({ result: async () => ({ content: [{ type: "text", text: "summary" }], stopReason: "stop", usage: {} }) }),
	},
});
const emit = async (name: string, event: any = {}, c: any = ctx()) => {
	let out;
	for (const h of handlers.get(name) ?? []) out = (await h(event, c)) ?? out;
	return out;
};
const tick = (s: number) => { clock += s * 1000; setSystemTime(new Date(clock)); };

const user = (text: string) => ({ role: "user", content: text, timestamp: clock });
const call = (n: number) => ({ role: "assistant", content: [{ type: "toolCall", id: `c${n}`, name: "read", arguments: { path: `f${n}.txt` } }], stopReason: "toolUse", timestamp: clock });
const result = (n: number) => ({ role: "toolResult", toolCallId: `c${n}`, toolName: "read", content: [{ type: "text", text: `contents of f${n}` }], isError: false, timestamp: clock });
const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: clock });

/** One agent run with `steps` tool calls; returns the system prompt options and every context sent to the model. */
const turn = async (text: string, steps: number, c: any = ctx()) => {
	const options: any = {};
	await emit("before_agent_start", { systemPromptOptions: options }, c);
	await emit("agent_start", {}, c);
	await emit("message_end", { message: user(text) }, c);
	const sent: any[][] = [];
	for (let s = 0; s <= steps; s++) {
		tick(7);
		sent.push((await emit("context", { messages: [] }, c)).messages);
		if (s < steps) { await emit("message_end", { message: call(s) }, c); await emit("message_end", { message: result(s) }, c); }
	}
	await emit("message_end", { message: reply(`done: ${text}`) }, c);
	await emit("agent_settled", {}, c);
	return { options, sent };
};
const viewOf = (messages: any[]) => messages[0].content[0].text as string;

beforeAll(async () => {
	process.env.MEM_HOME = home;
	setSystemTime(new Date(clock));
	const { default: endless } = await import("../src/index");
	endless({
		registerFlag() {}, getFlag: () => "t", getSettings: () => ({}),
		on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
		registerTool: (t: any) => tools.push(t), registerEntryRenderer() {}, registerCommand() {},
		getActiveTools: () => activeTools, setActiveTools: (t: string[]) => { activeTools = t; },
		setSessionName() {}, appendEntry() {},
	} as any);
	await emit("session_start");
});
afterAll(async () => {
	await emit("session_shutdown");
	setSystemTime();
	rmSync(home, { recursive: true, force: true });
});

test("一轮里每次调用模型，上一次发出的消息是这一次的前缀（时间流逝也不变）", async () => {
	await turn("warm up", 1);
	const { sent } = await turn("read three files", 3);
	for (let s = 1; s < sent.length; s++) expect(sent[s].slice(0, sent[s - 1].length)).toEqual(sent[s - 1]);
});

test("跨轮：系统提示词与工具声明逐字节不变，视图只在末尾增长", async () => {
	const tools0 = JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters })));
	const a = await turn("first", 1);
	tick(3600);
	const b = await turn("second", 2);
	expect(a.options.customPrompt).toBeString();
	expect(b.options.customPrompt).toBe(a.options.customPrompt);
	expect(activeTools).toEqual(["read", "zoom", "date", "search"]);
	expect(JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters })))).toBe(tools0);
	const before = viewOf(a.sent[0]), after = viewOf(b.sent[0]);
	expect(after.startsWith(before.slice(0, -"</chat>".length))).toBe(true);
	expect(after.length).toBeGreaterThan(before.length);
});

test("Anthropic：视图按 4 行切块，标记在倒数第二块，下一轮同位置的块不变；总标记 ≤ 4", async () => {
	const c = ctx("anthropic-messages");
	const payloadOf = (messages: any[]) => ({
		system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
		messages: messages.map((m) => ({
			role: m.role === "toolResult" ? "user" : m.role,
			content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content.map((b: any) => ({ type: "text", text: b.text ?? JSON.stringify(b) })),
		})).map((m, i, all) => (i === all.length - 1 ? { ...m, content: m.content.map((b: any) => ({ ...b, cache_control: { type: "ephemeral" } })) } : m)),
	});
	const marked = async (messages: any[]) => {
		const p: any = await emit("before_provider_request", { payload: payloadOf(messages) }, c);
		const blocks = p.messages[0].content as any[];
		const marks = JSON.stringify(p).split("cache_control").length - 1;
		return { blocks, marks, at: blocks.findIndex((b) => b.cache_control) };
	};
	const one = await marked((await turn("third", 1, c)).sent[0]);
	const two = await marked((await turn("fourth", 1, c)).sent[0]);
	for (const r of [one, two]) {
		expect(r.marks).toBeLessThanOrEqual(4);
		expect(r.at).toBeGreaterThan(0);
		expect(r.blocks[r.at + 1].text.endsWith("</chat>")).toBe(true);
	}
	const texts = (bs: any[]) => bs.slice(0, one.at + 1).map((x) => x.text);
	expect(texts(two.blocks)).toEqual(texts(one.blocks)); // the marked prefix of the last turn is read back from cache
});
