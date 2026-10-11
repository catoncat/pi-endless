/**
 * /mem — the conversation at a glance, and the way back to anything in it.
 *
 * What a user opens it for, most frequent first:
 *   find   "where did we talk about X?"      → `/` searches every original message as you type; hits are ticks on the timeline
 *   check  "what does it remember of that?"  → every hit and line says how the model holds it (word for word, or inside which summary)
 *   see    "how big is this, how sharp?"     → said vs read, and a timeline whose height is how finely each stretch is remembered
 * Lines and hits are grouped by day; enter opens down to the original words; `t` hides tool traffic.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import { end, flat, start, type Entry, type Memory, type Part } from "./core";
import { t } from "./i18n";
import { heldAs } from "./api";

type Item = { p: Part } | { e: Entry };
type ListFrame = { kind: "list"; label: string; parts: () => Part[]; sel: number; top: number };
type SearchFrame = { kind: "search"; label: string; hits: Entry[]; sel: number; top: number };
type MessageFrame = { kind: "message"; label: string; i: number; top: number; needle?: string };
type Frame = ListFrame | SearchFrame | MessageFrame;

const BLOCKS = " ▏▎▍▌▋▊▉█";
const SPARK = "▁▂▃▄▅▆▇█";
const PREVIEW = 3;
const MAX_HITS = 2000;
const QUIET = new Set(["tool", "echo"]); // tool traffic recedes; what you and pi said stands out
const KIND: Record<string, () => string> = { user: () => t("you", "你"), pi: () => "pi", tool: () => t("tool", "工具"), echo: () => t("result", "结果"), work: () => t("report", "报告"), note: () => t("note", "备注") };

export const fmtBytes = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
const pad2 = (n: number) => String(n).padStart(2, "0");
const hhmm = (iso: string) => { const d = new Date(iso); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const ymd = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const dayKey = (iso: string) => ymd(iso);
const dayLabel = (iso: string) => {
	const d = new Date(iso), today = new Date(), yesterday = new Date(Date.now() - 86_400_000);
	if (ymd(iso) === ymd(today.toISOString())) return t("today", "今天");
	if (ymd(iso) === ymd(yesterday.toISOString())) return t("yesterday", "昨天");
	const wd = [t("Sun", "周日"), t("Mon", "周一"), t("Tue", "周二"), t("Wed", "周三"), t("Thu", "周四"), t("Fri", "周五"), t("Sat", "周六")][d.getDay()];
	const sameYear = d.getFullYear() === today.getFullYear();
	return t(`${wd} ${d.toLocaleString("en", { month: "short" })} ${d.getDate()}${sameYear ? "" : ` ${d.getFullYear()}`}`, `${sameYear ? "" : `${d.getFullYear()}年`}${d.getMonth() + 1}月${d.getDate()}日 ${wd}`);
};
const padTo = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visibleWidth(s)));
const bar = (value: number, max: number, width: number) => {
	const eighths = max > 0 ? Math.round((value / max) * width * 8) : 0;
	const full = Math.floor(eighths / 8), rest = eighths % 8;
	return "█".repeat(full) + (rest ? BLOCKS[rest] : value > 0 && !full ? "▏" : "");
};
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Line text as people read it: the log's kind prefixes (user:, echo:) become you:, result: at each line start. */
const pretty = (text: string) => flat(text.split("\n").map((l) => unaddress(l).replace(/^(user|pi|tool|echo|work|note):\s*/, (_, k: string) => `${KIND[k]?.() ?? k}: `)).join("\n"));
/** Lines summarized before the address was cut off by the harness still start with "263|". */
const unaddress = (s: string) => s.replace(/^\d+(\+\d+)?\|/, "");
const stripKind = (text: string, kind?: string) => (kind ? unaddress(text).replace(new RegExp(`^${kind}:\\s*`, "i"), "") : text);

export class MemoryMap {
	private stack: Frame[];
	private off: () => void;
	private input = new Input({ prompt: "/ " });
	private hideTools = true; // you come here for the conversation; t brings the tool traffic back
	private lower?: string[]; // lowercased log, built on the first search
	private listHeight = 10;
	private _focused = false;

	constructor(private tui: TUI, private theme: Theme, private m: Memory, private name: string, private done: () => void) {
		const root: ListFrame = { kind: "list", label: name, parts: () => this.visibleParts(m.view.parts), sel: 0, top: 0 };
		root.sel = Math.max(0, root.parts().length - 1);
		this.stack = [root];
		this.off = m.onChange(() => this.tui.requestRender()); // summaries keep landing while you look
	}

	// Focusable: the search field shows the terminal cursor (and the IME window) only while it is being typed in.
	get focused() { return this._focused; }
	set focused(v: boolean) { this._focused = v; this.input.focused = v && this.frame.kind === "search"; }

	dispose() { this.off(); }
	invalidate() {}

	private get frame() { return this.stack[this.stack.length - 1]; }
	private get height() { return Math.max(18, this.tui.terminal.rows - 4); }
	private push(f: Frame) { this.stack.push(f); this.focused = this._focused; }
	private pop() { if (this.stack.length > 1) this.stack.pop(); else this.done(); this.focused = this._focused; }

	private visibleParts(parts: Part[]): Part[] {
		if (!this.hideTools) return parts;
		return parts.filter((p) => p.l > 0 || !QUIET.has(this.m.log[p.i]?.kind));
	}
	private items(f: ListFrame | SearchFrame): Item[] {
		return f.kind === "list" ? f.parts().map((p) => ({ p })) : f.hits.map((e) => ({ e }));
	}
	private dateOf(it: Item) { return "e" in it ? it.e.date : this.m.log[start(it.p)]?.date ?? ""; }
	/** The selected stretch of the conversation, for the timeline. */
	private selectedSpan(): Part | undefined {
		const f = this.frame;
		if (f.kind === "message") return { l: 0, i: f.i };
		const it = this.items(f)[f.sel];
		return it ? ("e" in it ? { l: 0, i: it.e.i } : it.p) : undefined;
	}

	private runSearch(q: string): Entry[] {
		const needle = q.trim().toLowerCase();
		if (!needle) return [];
		const log = this.m.log;
		if (!this.lower || this.lower.length !== log.length) this.lower = log.map((e) => e.text.toLowerCase());
		const hits: Entry[] = [];
		for (let i = log.length - 1; i >= 0 && hits.length < MAX_HITS; i--) {
			const e = log[i];
			if (QUIET.has(e.kind) && /^(zoom|search|date)[ :]/.test(e.text)) continue; // its own memory lookups
			if (this.lower[i].includes(needle)) hits.push(e);
		}
		return hits.reverse(); // oldest first, like the view: the newest at the bottom
	}

	/** How the model holds message i right now, in words (the same answer the CLI and MCP give). */
	private heldAs(i: number): { label: string; text?: string } {
		const h = heldAs(this.m, i), e = this.m.log[i];
		if (h.as === "verbatim") return { label: t("in the view word for word", "原样在视图里") };
		if (h.as === "summarized") return { label: t("in the view as", "在视图里写成"), text: stripKind(flat(h.text ?? ""), e?.kind) };
		if (h.as === "inside") {
			const from = this.m.log[Number(h.line!.split("+")[0])];
			return { label: t(`inside a line summing up ${h.covers} messages${from ? ` from ${dayLabel(from.date)}` : ""}`, `在一行概括里（${h.covers} 条${from ? `，自${dayLabel(from.date)}` : ""}）`), text: pretty(h.text ?? "") };
		}
		return { label: "" };
	}

	handleInput(data: string) {
		const f = this.frame;
		const page = Math.max(1, this.listHeight - 1);
		const move = (g: ListFrame | SearchFrame, to: number) => { g.sel = Math.max(0, Math.min(this.items(g).length - 1, to)); };
		if (f.kind === "search") {
			if (matchesKey(data, "escape")) this.pop();
			else if (matchesKey(data, "up")) move(f, f.sel - 1);
			else if (matchesKey(data, "down")) move(f, f.sel + 1);
			else if (matchesKey(data, "enter")) { const e = f.hits[f.sel]; if (e) this.push({ kind: "message", label: `${hhmm(e.date)} ${KIND[e.kind]?.() ?? e.kind}`, i: e.i, top: 0, needle: this.input.getValue().trim() }); }
			else {
				const before = this.input.getValue();
				this.input.handleInput(data);
				if (this.input.getValue() !== before) { f.hits = this.runSearch(this.input.getValue()); f.sel = Math.max(0, f.hits.length - 1); f.top = 0; }
			}
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "escape") || data === "q") { this.done(); return; }
		if (matchesKey(data, "left") || matchesKey(data, "backspace")) this.pop();
		else if (data === "/") {
			this.input.setValue("");
			this.push({ kind: "search", label: t("search", "搜索"), hits: [], sel: 0, top: 0 });
		} else if (data === "t") {
			const sel = this.selectedSpan();
			this.hideTools = !this.hideTools;
			if (f.kind === "list" && sel) { const parts = f.parts(); const k = parts.findIndex((p) => end(p) > start(sel)); f.sel = k < 0 ? parts.length - 1 : k; }
		} else if (f.kind === "list") {
			if (matchesKey(data, "up")) move(f, f.sel - 1);
			else if (matchesKey(data, "down")) move(f, f.sel + 1);
			else if (data === "[") move(f, f.sel - page);
			else if (data === "]") move(f, f.sel + page);
			else if (matchesKey(data, "home") || data === "g") move(f, 0);
			else if (matchesKey(data, "end") || data === "G") move(f, Number.MAX_SAFE_INTEGER);
			else if (matchesKey(data, "enter") || matchesKey(data, "right")) {
				const p = f.parts()[f.sel];
				if (!p) return;
				if (p.l === 0) this.push({ kind: "message", label: hhmm(this.m.log[p.i]?.date ?? ""), i: p.i, top: 0 });
				else {
					const kids = [{ l: p.l - 1, i: 2 * p.i }, { l: p.l - 1, i: 2 * p.i + 1 }];
					const from = this.m.log[start(p)];
					this.push({ kind: "list", label: `${from ? `${dayLabel(from.date)} ${hhmm(from.date)} · ` : ""}${t(`${end(p) - start(p)} messages`, `${end(p) - start(p)} 条`)}`, parts: () => this.visibleParts(kids).length ? this.visibleParts(kids) : kids, sel: 0, top: 0 });
				}
			} else return;
		} else {
			if (matchesKey(data, "up")) f.top = Math.max(0, f.top - 1);
			else if (matchesKey(data, "down")) f.top++;
			else if (data === "[") f.top = Math.max(0, f.top - page);
			else if (data === "]" || data === " ") f.top += page;
			else return;
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme, m = this.m, W = width, T = m.T;
		const out: string[] = [];
		const line = (s = "") => out.push(truncateToWidth(s, W));
		const right = (l: string, r: string) => line(l + " ".repeat(Math.max(1, W - visibleWidth(l) - visibleWidth(r))) + r);

		// ---- header: how long this conversation is
		const first = m.log[0]?.date;
		const days = first ? Math.max(1, Math.round((Date.now() - new Date(first).getTime()) / 86_400_000) + 1) : 0;
		right(` ${th.fg("accent", th.bold(`📒 ${this.name}`))}`, th.fg("muted", T ? t(`${T} messages · since ${ymd(first!)} · ${days} ${days === 1 ? "day" : "days"} `, `${T} 条消息 · 自 ${ymd(first!)} · 第 ${days} 天 `) : t("no messages yet ", "还没有消息 ")));
		line();
		if (!T) {
			line(th.fg("muted", t("  Say something: every word is kept, and this map fills in as the conversation grows.", "  说点什么吧：每个字都会留下，这张图会随对话长出来。")));
			line();
			line(th.fg("dim", t("  esc close", "  esc 关闭")));
			return out;
		}

		// ---- said vs read, one scale; the read bar in the timeline's two colors
		const said = m.log.reduce((s, e) => s + e.size, 0), read = m.view.bytes;
		const lineBytes = (p: Part) => Buffer.byteLength(m.renderLine(p), "utf8") + 1;
		const all = m.view.parts.reduce((s, p) => s + lineBytes(p), 0) || 1;
		const fineShare = m.view.parts.filter((p) => p.l === 0).reduce((s, p) => s + lineBytes(p), 0) / all;
		const labels = [t("everything said", "说过的全部"), t("read each turn", "每轮读的")];
		const lw = Math.max(...labels.map(visibleWidth)) + 4, bw = Math.max(8, W - lw - 12);
		const max = Math.max(said, read);
		const readChars = [...bar(read, max, bw)], cut = Math.round((1 - fineShare) * readChars.length);
		right(`  ${padTo(labels[0], lw - 2)}${th.fg("text", bar(said, max, bw))}`, `${fmtBytes(said)} `);
		right(`  ${padTo(labels[1], lw - 2)}${th.fg("muted", readChars.slice(0, cut).join(""))}${th.fg("success", readChars.slice(cut).join(""))}`, `${fmtBytes(read)} `);
		line();

		// ---- timeline: one cell per stretch of messages; height = how finely the view remembers it
		const f = this.frame, tw = Math.max(4, W - 4), sel = this.selectedSpan();
		const cellOf = (msg: number) => Math.min(tw - 1, Math.floor((msg * tw) / T));
		const rows = ["", ""];
		let style = "", runs = ["", ""];
		const flushRun = () => { for (const r of [0, 1]) if (runs[r]) rows[r] += th.fg(style === "lit" ? "accent" : style === "fine" ? "success" : "muted", runs[r]); runs = ["", ""]; };
		for (let c = 0; c < tw; c++) {
			const msg = Math.min(T - 1, Math.floor((c * T) / tw));
			const l = m.view.covering(msg)?.l ?? 0;
			const h = Math.max(1, 16 - 2 * l); // eighths over two rows: one line per message is full height, each halving drops a quarter row
			const next = f.kind !== "search" && sel && msg >= start(sel) && msg < end(sel) ? "lit" : l === 0 ? "fine" : "brief";
			if (next !== style) { flushRun(); style = next; }
			runs[0] += h > 8 ? SPARK[h - 9] : " ";
			runs[1] += h >= 8 ? "█" : SPARK[h - 1];
		}
		flushRun();
		line(`  ${rows[0]}`);
		line(`  ${rows[1]}`);
		// marker row: the selected stretch, or every search hit
		const marks = Array<string>(tw).fill(" ");
		if (f.kind === "search") {
			for (const e of f.hits) marks[cellOf(e.i)] = th.fg("warning", "╵");
			const s = f.hits[f.sel];
			if (s) marks[cellOf(s.i)] = th.fg("accent", "▲");
		} else if (sel) {
			const a = cellOf(start(sel)), b = Math.max(a, cellOf(Math.min(T, end(sel)) - 1));
			if (b - a >= 2) { marks[a] = "╰"; for (let c = a + 1; c < b; c++) marks[c] = "─"; marks[b] = "╯"; for (let c = a; c <= b; c++) marks[c] = th.fg("accent", marks[c]); }
			else marks[a] = th.fg("accent", "▲");
		}
		line(`  ${marks.join("")}`);
		{
			const l = `  ${th.fg("muted", ymd(first!))}`, r = th.fg("muted", `${t("now", "现在")} `);
			const legend = `${th.fg("muted", t("▃ summarized", "▃ 概括"))}${th.fg("dim", "  ·  ")}${th.fg("success", t("█ message by message", "█ 逐条"))}`;
			const gap = W - visibleWidth(l) - visibleWidth(r) - visibleWidth(legend);
			if (gap >= 4) line(l + " ".repeat(Math.floor(gap / 2)) + legend + " ".repeat(Math.ceil(gap / 2)) + r);
			else right(l, r);
		}
		line();

		// ---- where you are: search field, breadcrumb, or the filter in effect
		if (f.kind === "search" || (f.kind === "message" && this.stack.some((g) => g.kind === "search"))) {
			const s = this.stack.find((g): g is SearchFrame => g.kind === "search")!;
			const q = this.input.getValue().trim();
			const count = q ? (s.hits.length >= MAX_HITS ? t(`${MAX_HITS}+ messages`, `${MAX_HITS}+ 条`) : t(`${s.hits.length} ${s.hits.length === 1 ? "message" : "messages"}`, `${s.hits.length} 条`)) : "";
			const field = this.input.render(Math.max(10, W - visibleWidth(count) - 4))[0] ?? "";
			right(` ${f.kind === "search" ? field : th.fg("muted", `/ ${q}`)}`, `${th.fg("muted", count)} `);
		} else if (this.stack.length > 1) {
			line(` ${this.stack.map((g, k) => (k === this.stack.length - 1 ? th.bold(g.label) : th.fg("muted", g.label))).join(th.fg("dim", " › "))}`);
		} else line(this.hideTools ? th.fg("dim", t("  tool calls hidden · t shows them", "  已隐藏工具调用 · t 显示")) : "");

		// ---- body
		const footer = 2, used = out.length + footer + 1;
		if (f.kind === "message") this.renderMessage(f, line, W, used);
		else this.renderList(f, line, W, used);

		// ---- footer: keys; the summarizer speaks only when it is behind or failing
		line();
		const keys = f.kind === "search"
			? t("type to search · ↑↓ · enter open · esc done", "输入即搜 · ↑↓ · enter 打开 · esc 结束")
			: f.kind === "message"
				? t("↑↓ scroll · ← back · esc close", "↑↓ 滚动 · ← 返回 · esc 关闭")
				: W < 100
					? t("/ search · t tools · enter · ← · esc", "/ 搜索 · t 工具 · enter · ← · esc")
					: t("/ search · ↑↓ [ ] g G move · enter open · ← back · t tool calls · esc close", "/ 搜索 · ↑↓ [ ] g G 移动 · enter 展开 · ← 返回 · t 工具调用 · esc 关闭");
		const work = m.lastError ? t("summaries failing: see /mem status", "摘要出错：看 /mem status") : m.pending ? t(`summarizing ${m.pending}…`, `正在写 ${m.pending} 条摘要…`) : "";
		right(` ${th.fg("dim", keys)}`, `${th.fg(m.lastError ? "warning" : "dim", work)} `);
		return out;
	}

	/** Lines or hits, grouped by day, the newest at the bottom; the selected one previewed in full below. */
	private renderList(f: ListFrame | SearchFrame, line: (s?: string) => void, W: number, used: number) {
		const th = this.theme, m = this.m, items = this.items(f);
		this.listHeight = Math.max(3, this.height - used - PREVIEW - 1);
		if (f.kind === "search" && !items.length) {
			const q = this.input.getValue().trim();
			line(th.fg("muted", q ? t(`  No message contains "${q}".`, `  没有消息包含「${q}」。`) : t("  Searches every message ever said, word for word (not the summaries).", "  搜索说过的每一条原话（不是摘要）。")));
			for (let k = 1; k < this.listHeight + 1 + PREVIEW; k++) line();
			return;
		}
		f.sel = Math.max(0, Math.min(f.sel, items.length - 1));
		// display rows: a day header whenever the day changes
		type Row = { day: string } | { k: number };
		const rows: Row[] = [];
		let last = "";
		items.forEach((it, k) => { const d = this.dateOf(it); if (d && dayKey(d) !== last) { last = dayKey(d); rows.push({ day: d }); } rows.push({ k }); });
		const at = rows.findIndex((r) => "k" in r && r.k === f.sel);
		const want = at > 0 && "day" in rows[at - 1] ? at - 1 : at; // keep the selected row's day header in sight
		if (want < f.top) f.top = want;
		if (at >= f.top + this.listHeight) f.top = at - this.listHeight + 1;
		f.top = Math.max(0, Math.min(f.top, Math.max(0, rows.length - this.listHeight)));
		const needle = f.kind === "search" ? this.input.getValue().trim() : "";
		const mark = (s: string) => (needle ? s.replace(new RegExp(escapeRe(needle), "gi"), (x) => th.fg("warning", x)) : s);
		const tagW = Math.max(...Object.values(KIND).map((k) => visibleWidth(k())), visibleWidth(t("999 msgs", "999 条")));
		const visible = rows.slice(f.top, f.top + this.listHeight);
		if (visible.length && "k" in visible[0]) { // sticky day header: the first line always says which day you are in
			visible.unshift({ day: this.dateOf(items[visible[0].k]) });
			if (visible.length > this.listHeight) visible.pop();
		}
		for (const r of visible) {
			if ("day" in r) { line(` ${th.fg("dim", "── ")}${th.fg("muted", dayLabel(r.day))}${th.fg("dim", ` ${"─".repeat(Math.max(0, W - visibleWidth(dayLabel(r.day)) - 6))}`)}`); continue; }
			const it = items[r.k], on = r.k === f.sel;
			const isYou = (x: Item) => ("e" in x ? x.e.kind : m.log[start(x.p)]?.kind) === "user" && !("p" in x && x.p.l > 0);
			const date = this.dateOf(it);
			let tag: string, body: string, quiet: boolean;
			if ("e" in it) {
				quiet = QUIET.has(it.e.kind);
				tag = KIND[it.e.kind]?.() ?? it.e.kind;
				const text = flat(it.e.text), hit = text.toLowerCase().indexOf(needle.toLowerCase());
				const room = Math.max(10, W - 30);
				let from = 0;
				if (hit + needle.length > room - 4) { from = Math.max(0, hit - 24); const sp = text.lastIndexOf(" ", from); if (sp > from - 16) from = sp + 1; } // start on a word, the match in sight
				body = `${from ? "…" : ""}${text.slice(from)}`;
			} else {
				const p = it.p, e = m.log[start(p)];
				quiet = p.l === 0 && !!e && QUIET.has(e.kind);
				tag = p.l === 0 ? (KIND[e?.kind ?? ""]?.() ?? "") : t(`${end(p) - start(p)} msgs`, `${end(p) - start(p)} 条`);
				body = p.l === 0 ? stripKind(flat(m.text(p)), e?.kind) : pretty(m.text(p));
			}
			const head = `${on ? th.fg("accent", "▸") : " "} ${th.fg("dim", date ? hhmm(date) : "     ")}  ${th.fg(quiet ? "dim" : "p" in it && it.p.l > 0 ? "muted" : isYou(it) ? "accent" : "text", padTo(tag, tagW))} `;
			const text = mark(truncateToWidth(body, Math.max(4, W - visibleWidth(head) - 2)));
			line(` ${head}${on ? th.bold(text) : quiet ? th.fg("muted", text) : text}`);
		}
		for (let k = visible.length; k < this.listHeight; k++) line();
		line();
		// preview: the selected line in full, or for a hit, how the model holds it
		const it = items[f.sel];
		let pv: string[] = [];
		if (it && "e" in it) {
			const held = this.heldAs(it.e.i);
			const head = th.fg("dim", `${t("pi remembers it", "pi 记得的样子")}: ${held.label}`);
			pv = [head, ...(held.text ? wrapTextWithAnsi(th.fg("muted", held.text), Math.max(10, W - 6)) : [])];
		} else if (it) {
			const e = m.log[start(it.p)];
			pv = wrapTextWithAnsi(th.fg("muted", it.p.l === 0 ? stripKind(flat(m.text(it.p)), e?.kind) : pretty(m.text(it.p))), Math.max(10, W - 6));
		}
		for (let k = 0; k < PREVIEW; k++) line(pv[k] ? `    ${pv[k]}` : "");
	}

	/** The original message, with how the model holds it now. */
	private renderMessage(f: MessageFrame, line: (s?: string) => void, W: number, used: number) {
		const th = this.theme, e = this.m.log[f.i];
		const held = this.heldAs(f.i);
		line(`   ${th.fg(e.kind === "user" ? "accent" : QUIET.has(e.kind) ? "dim" : "text", KIND[e.kind]?.() ?? e.kind)}${th.fg("muted", ` · ${dayLabel(e.date)} ${hhmm(e.date)} · ${fmtBytes(e.size)}`)}`);
		const heldLines = [th.fg("dim", `${t("pi remembers it", "pi 记得的样子")}: ${held.label}`), ...(held.text ? wrapTextWithAnsi(th.fg("dim", held.text), Math.max(10, W - 6)).slice(0, 2) : [])];
		for (const l of heldLines) line(`   ${l}`);
		line();
		const mark = (s: string) => (f.needle ? s.replace(new RegExp(escapeRe(f.needle), "gi"), (x) => th.fg("warning", x)) : s);
		const body = e.text.split("\n").flatMap((l) => wrapTextWithAnsi(mark(l), Math.max(10, W - 4)));
		this.listHeight = Math.max(3, this.height - used - heldLines.length - 2);
		f.top = Math.min(f.top, Math.max(0, body.length - this.listHeight));
		const shown = body.slice(f.top, f.top + this.listHeight);
		for (const l of shown) line(`   ${l}`);
		for (let k = shown.length; k < this.listHeight; k++) line();
	}
}
