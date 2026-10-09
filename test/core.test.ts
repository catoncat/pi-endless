// 为什么测这里：合并顺序和视图持久化出错时没有任何报错，只是缓存悄悄全失效；zoom 寻址容易差一。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cutLine, Memory, NODE, start, end, View, bytes, type Part } from "../src/core";

// ---- Taelin 的 rollback push（gist §3.1），用来对照视图的合并顺序
type States = { keep: number; life: number; state: number; older: States | null } | null;
function push(s: number, states: States): States {
	if (states === null) return { keep: 0, life: 0, state: s, older: null };
	const { keep, life, state, older } = states;
	if (keep === 0) return { keep: 1, life, state, older };
	if (life > 0) return { keep: 0, life: 0, state: s, older: { keep: 0, life: life - 1, state, older } };
	return { keep: 0, life, state: s, older: push(state, older) };
}
function pushView(states: States, T: number): Part[] {
	const starts: number[] = [];
	for (let s = states; s; s = s.older) starts.push(s.state);
	starts.reverse();
	return starts.map((st, k) => {
		const n = (starts[k + 1] ?? T) - st;
		return { l: Math.log2(n), i: st / n };
	});
}

describe("View", () => {
	test("due=(T-last)/2^l 以行数为预算时逐步等于 Taelin 的 push（t=0..3000）", () => {
		const v = new View(Infinity, Infinity, () => 1, () => true);
		let states: States = null;
		for (let t = 0; t <= 3000; t++) {
			states = push(t, states);
			const want = pushView(states, t + 1);
			v.append(t);
			// 把预算设成 push 列表的长度：手动驱动 fit 直到行数相等
			(v as unknown as { shrinking: boolean }).shrinking = true;
			(v as unknown as { lo: number }).lo = want.length;
			(v as unknown as { hi: number }).hi = want.length;
			v.fit(t + 1);
			expect(v.parts).toEqual(want);
		}
	});

	test("锯齿批量合并：两次批量之间视图只在尾部增长；平均每条消息重写 <3 行", () => {
		const sizes = new Map<string, number>();
		let seed = 1;
		const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
		const sizeOf = (p: Part) => { const k = `${p.l}/${p.i}`; if (!sizes.has(k)) sizes.set(k, 150 + Math.floor(rnd() * 362)); return sizes.get(k)!; };
		const v = new View(128_000, 64_000, sizeOf, () => true);
		let prev: Part[] = [], resent = 0, batches = 0;
		const N = 5000;
		for (let t = 0; t < N; t++) {
			v.append(t);
			if (v.fit(t + 1)) batches++;
			let k = 0;
			while (k < prev.length && k < v.parts.length && prev[k].l === v.parts[k].l && prev[k].i === v.parts[k].i) k++;
			resent += v.parts.length - k;
			prev = [...v.parts];
			expect(v.tiles(t + 1)).toBe(true);
			expect(v.bytes).toBeLessThanOrEqual(128_000 + 512);
		}
		expect(batches).toBeGreaterThan(5);
		expect(resent / N).toBeLessThan(3);
	});

	test("父节点没建时不合并，等建好再继续缩", () => {
		const built = new Set<string>();
		const v = new View(10, 4, () => 1, (p) => built.has(`${p.l}/${p.i}`));
		for (let i = 0; i < 12; i++) { v.append(i); v.fit(i + 1); }
		expect(v.parts.length).toBe(12);
		expect(v.shrinking).toBe(true);
		for (let i = 0; i < 6; i++) built.add(`1/${i}`);
		v.fit(12);
		expect(v.parts.length).toBe(6);
		expect(v.tiles(12)).toBe(true);
		for (let i = 0; i < 3; i++) built.add(`2/${i}`);
		v.fit(12);
		expect(v.parts.length).toBe(4);
		expect(v.shrinking).toBe(false);
	});
});

describe("cutLine", () => {
	test("短的原样；去掉 id+n| 头和围栏", () => {
		expect(cutLine("12+4|hello world").line).toBe("hello world");
		expect(cutLine("```\nhello\n```").line).toBe("hello");
	});
	test("超长在最后一个分隔符处截，≤512 字节，中文也安全", () => {
		const items = Array.from({ length: 40 }, (_, i) => `user: 第${i}条决定，路径 /a/b/${i}`);
		const r = cutLine(items.join("; "));
		expect(r.cut).toBe(true);
		expect(bytes(r.line)).toBeLessThanOrEqual(NODE);
		expect(r.line.endsWith("}")).toBe(false);
		expect(r.line).toMatch(/\/a\/b\/\d+$/);
	});
});

describe("Memory", () => {
	const fakeCompressor = async (req: { user: string; part: Part }) => `summary of ${req.part.l}/${req.part.i} (${req.user.length} chars of input)`;
	const tmp = () => mkdtempSync(join(tmpdir(), "mem-"));

	test("短消息零成本成节点；长消息叫模型；整棵树建完；重启后视图逐字节相同", async () => {
		const dir = tmp();
		const warn = (s: string) => { throw new Error(s); };
		const m = new Memory(dir, fakeCompressor, warn, { jobs: 4 });
		for (let i = 0; i < 20; i++) m.append(i % 3 === 0 ? "user" : "echo", i % 3 === 0 ? `说一句 ${i}` : "x".repeat(700 + i));
		await waitFor(() => m.owed === 0);
		expect(m.pending).toBe(0);
		expect(m.tree.get("0/0")?.text).toBe("user: 说一句 0");
		expect(m.tree.get("0/1")?.text).toMatch(/^summary of 0\/1/);
		expect(bytes(m.tree.get("1/0")!.text)).toBeLessThanOrEqual(NODE);
		const rendered = m.render();
		expect(m.view.tiles(20)).toBe(true);
		await m.close();
		const m2 = new Memory(dir, fakeCompressor, warn);
		expect(m2.render()).toBe(rendered);
		expect(m2.view.bytes).toBe(m.view.bytes);
		await m2.close();
		rmSync(dir, { recursive: true });
	});

	test("zoom 寻址与 search", async () => {
		const dir = tmp();
		const m = new Memory(dir, fakeCompressor, () => {}, { jobs: 2 });
		for (let i = 0; i < 8; i++) m.append("user", `msg ${i} ${"y".repeat(600)}`);
		await waitFor(() => m.owed === 0);
		expect(m.zoom(0, 8).split("\n").map((l) => l.split("|")[0])).toEqual(["0+4", "4+4"]);
		expect(m.zoom(4, 2).split("\n").map((l) => l.split("|")[0])).toEqual(["4+1", "5+1"]);
		expect(m.zoom(5, 1)).toMatch(/^5\+1\|user: msg 5/);
		expect(() => m.zoom(3, 2)).toThrow();
		expect(() => m.zoom(0, 3)).toThrow();
		expect(m.search("msg 6").map((e) => e.i)).toEqual([6]);
		expect(m.search("MSG").length).toBe(8);
		await m.close();
		rmSync(dir, { recursive: true });
	});

	test("压缩失败会重试，期间视图保留占位行", async () => {
		const dir = tmp();
		let fails = 2;
		const flaky = async (req: { part: Part }) => { if (fails-- > 0) throw new Error("boom"); return `ok ${req.part.l}/${req.part.i}`; };
		const m = new Memory(dir, flaky, () => {}, { jobs: 1, retryMs: 20 });
		m.append("echo", "z".repeat(800));
		expect(m.render()).toContain("(not summarized yet: zoom it)");
		await waitFor(() => m.owed === 0, 3000);
		expect(m.render()).toContain("0+1|ok 0/0");
		expect(m.lastError).toBeUndefined();
		await m.close();
		rmSync(dir, { recursive: true });
	});

	test("settle 超时返回 false，建完返回 true", async () => {
		const dir = tmp();
		let release: () => void = () => {};
		const slow = () => new Promise<string>((r) => { release = () => r("done"); });
		const m = new Memory(dir, slow, () => {}, { jobs: 1 });
		m.append("echo", "w".repeat(600));
		expect(await m.settle(30)).toBe(false);
		const p = m.settle(2000);
		release();
		expect(await p).toBe(true);
		await m.close();
		rmSync(dir, { recursive: true });
	});
});

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > ms) throw new Error("timeout");
		await new Promise((r) => setTimeout(r, 5));
	}
}

// 用到的导出保持引用，避免 unused 告警
void start; void end;
