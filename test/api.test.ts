// 为什么测这里：对外接口是合同。两条一旦坏了不会报错：工具输出（文件内容、命令输出，密钥常在这里）默认不能漏出去；
// 读的一方绝不能写盘（另一个窗口可能正在写）。MCP 的握手和调用形状是外部客户端依赖的边界。
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Memory } from "../src/core";
import { Conversation, listConversations, search } from "../src/api";

const seed = async () => {
	const home = mkdtempSync(join(tmpdir(), "mem-api-"));
	const m = new Memory(join(home, "proj"), async () => "summary", () => {});
	m.append("user", "what port does the db use?");
	m.append("tool", 'bash {"command":"cat .env"}');
	m.append("echo", "bash: DB_PORT=5433 API_KEY=sk-secret-123");
	m.append("pi", "The database listens on 5433.");
	await m.close();
	writeFileSync(join(home, "old"), JSON.stringify({ renamedTo: "proj" }));
	return home;
};
const snapshot = (dir: string): string => readdirSync(dir, { recursive: true, withFileTypes: false }).map((f) => `${f}:${statSync(join(dir, String(f))).size}:${statSync(join(dir, String(f))).mtimeMs}`).sort().join(",");

test("工具输出默认不出现在任何读法里；显式要才给；读不写盘；改名指针跟得上", async () => {
	const home = await seed();
	const before = snapshot(home);
	const c = Conversation.open("old", home);
	expect(c.name).toBe("proj");
	const leak = (x: unknown) => JSON.stringify(x).includes("sk-secret-123");
	expect(leak(search("5433", { home }))).toBe(false);
	expect(search("5433", { home }).map((h) => h.kind)).toEqual(["pi"]);
	expect(leak(c.message(2))).toBe(false);
	expect(leak(c.since(0))).toBe(false);
	expect(leak(c.zoom(2, 1))).toBe(false);
	expect(leak(search("5433", { home, includeTools: true }))).toBe(true);
	expect(leak(c.message(2, { includeTools: true }))).toBe(true);
	expect(listConversations(home).map((i) => [i.name, i.messages])).toEqual([["proj", 4]]);
	expect(snapshot(home)).toBe(before);
	rmSync(home, { recursive: true });
});

test("MCP：initialize → tools/list → tools/call 的形状", async () => {
	const home = await seed();
	const p = spawn("bun", [join(import.meta.dir, "../src/cli.ts"), "mcp"], { env: { ...process.env, MEM_HOME: home } });
	const replies: any[] = [];
	let buf = "";
	p.stdout.on("data", (d) => { buf += d; const ls = buf.split("\n"); buf = ls.pop()!; for (const l of ls) if (l.trim()) replies.push(JSON.parse(l)); });
	const send = (o: object) => p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...o })}\n`);
	send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
	send({ method: "notifications/initialized" });
	send({ id: 2, method: "tools/list" });
	send({ id: 3, method: "tools/call", params: { name: "search", arguments: { text: "5433" } } });
	send({ id: 4, method: "tools/call", params: { name: "message", arguments: { conversation: "nope", id: 0 } } });
	for (let k = 0; replies.length < 4 && k < 200; k++) await new Promise((r) => setTimeout(r, 10));
	p.kill();
	const by = (id: number) => replies.find((r) => r.id === id);
	expect(by(1).result.serverInfo.name).toBe("pi-mem");
	expect(by(1).result.capabilities.tools).toBeDefined();
	expect(by(2).result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["list", "message", "search", "since", "view", "zoom"]);
	expect(by(3).result.content[0].text).toContain("The database listens on 5433");
	expect(by(4).result.isError).toBe(true);
	rmSync(home, { recursive: true });
});
