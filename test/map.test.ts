// 为什么测这里：pi 的 TUI 要求每行不超过给定宽度，超了会画坏整屏；地图里有柱、天际线、中文、截断，窄终端最容易出事。
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Memory } from "../src/core";
import { MemoryMap } from "../src/map";

test("任何宽度下每行都不超宽：空对话、长对话、展开到原文", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mem-map-"));
	const m = new Memory(dir, async (r) => `摘要 ${r.part.l}/${r.part.i} 用户和 pi 讨论了很多事情`.repeat(3), () => {}, { jobs: 8 });
	const theme = { fg: (_: string, s: string) => s, bold: (s: string) => s } as any;
	const tui = { terminal: { rows: 30 }, requestRender() {} } as any;
	const check = (map: MemoryMap) => { for (const w of [20, 33, 61, 80, 157]) for (const l of map.render(w)) expect(visibleWidth(l)).toBeLessThanOrEqual(w); };
	check(new MemoryMap(tui, theme, m, "空", () => {}));
	for (let i = 0; i < 900; i++) m.append(i % 2 ? "echo" : "user", i % 2 ? `结果 ${"长输出 ".repeat(200)}` : `第 ${i} 条：中文和 English mixed 🙂`, new Date(Date.UTC(2026, 8, 1) + i * 3_600_000).toISOString());
	for (let t = 0; m.owed > 0 && t < 400; t++) await new Promise((r) => setTimeout(r, 5));
	m.render();
	const map = new MemoryMap(tui, theme, m, "长对话", () => {});
	check(map);
	map.handleInput("g");
	for (let k = 0; k < 12; k++) { map.handleInput("\r"); check(map); } // down to the original message
	map.dispose();
	await m.close();
	rmSync(dir, { recursive: true });
});
