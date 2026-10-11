/**
 * /mem map — the whole conversation on one screen.
 * Top: how much has been said vs how much the model reads per turn (same scale).
 * Middle: the timeline, one cell per stretch of messages; taller = remembered in finer detail; the selected line's stretch lit.
 * Bottom: the lines of the view, newest last; enter opens a line into its two halves, down to the original message.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import { end, flat, start, type Memory, type Part } from "./core";
import { t } from "./i18n";

type Frame = { kind: "lines"; parts: Part[]; sel: number; top: number; label: string } | { kind: "message"; i: number; top: number; label: string };

const BLOCKS = " ▏▎▍▌▋▊▉█";
const SPARK = "▁▂▃▄▅▆▇█";

export const fmtBytes = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
const pad2 = (n: number) => String(n).padStart(2, "0");
const when = (iso: string) => { const d = new Date(iso); return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const KIND: Record<string, () => string> = { user: () => t("you", "你"), pi: () => "pi", tool: () => t("tool", "工具"), echo: () => t("result", "结果"), work: () => t("report", "报告"), note: () => t("note", "备注") };
const QUIET = new Set(["tool", "echo"]); // tool traffic recedes; what you and pi said stands out
const day = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const padTo = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visibleWidth(s)));
const span = (p: Part) => (p.l === 0 ? `#${start(p)}` : `#${start(p)}–${end(p) - 1}`);
const bar = (value: number, max: number, width: number) => {
	const eighths = max > 0 ? Math.round((value / max) * width * 8) : 0;
	const full = Math.floor(eighths / 8), rest = eighths % 8;
	return "█".repeat(full) + (rest ? BLOCKS[rest] : value > 0 && !full ? "▏" : "");
};

/** The read bar in the timeline's two colors: [summarized][one line per message], on the same scale as the said bar. */
const readBar = (th: Theme, brief: number, fine: number, max: number, width: number) => {
	const chars = [...bar(brief + fine, max, width)], cut = Math.round((brief / Math.max(1, brief + fine)) * chars.length);
	return th.fg("muted", chars.slice(0, cut).join("")) + th.fg("success", chars.slice(cut).join(""));
};

export class MemoryMap {
	private stack: Frame[];
	private off: () => void;

	constructor(private tui: TUI, private theme: Theme, private m: Memory, private name: string, private done: () => void) {
		const parts = m.view.parts;
		this.stack = [{ kind: "lines", parts, sel: Math.max(0, parts.length - 1), top: 0, label: name }];
		this.off = m.onChange(() => this.tui.requestRender()); // summaries keep landing while you look
	}

	dispose() { this.off(); }
	invalidate() {}

	private get frame() { return this.stack[this.stack.length - 1]; }
	private get height() { return Math.max(18, this.tui.terminal.rows - 4); }
	private selected(): Part | undefined {
		const f = this.frame;
		return f.kind === "lines" ? f.parts[f.sel] : { l: 0, i: f.i };
	}

	handleInput(data: string) {
		const f = this.frame;
		const page = Math.max(1, this.listHeight - 1);
		if (matchesKey(data, "escape") || data === "q") { this.done(); return; }
		if (matchesKey(data, "left") || matchesKey(data, "backspace")) { if (this.stack.length > 1) this.stack.pop(); else this.done(); }
		else if (f.kind === "lines") {
			if (matchesKey(data, "up")) f.sel = Math.max(0, f.sel - 1);
			else if (matchesKey(data, "down")) f.sel = Math.min(f.parts.length - 1, f.sel + 1);
			else if (data === "[") f.sel = Math.max(0, f.sel - page);
			else if (data === "]") f.sel = Math.min(f.parts.length - 1, f.sel + page);
			else if (matchesKey(data, "home") || data === "g") f.sel = 0;
			else if (matchesKey(data, "end") || data === "G") f.sel = f.parts.length - 1;
			else if (matchesKey(data, "enter") || matchesKey(data, "right")) {
				const p = f.parts[f.sel];
				if (!p) return;
				if (p.l === 0) this.stack.push({ kind: "message", i: p.i, top: 0, label: span(p) });
				else this.stack.push({ kind: "lines", parts: [{ l: p.l - 1, i: 2 * p.i }, { l: p.l - 1, i: 2 * p.i + 1 }], sel: 0, top: 0, label: span(p) });
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

	private listHeight = 10;

	render(width: number): string[] {
		const th = this.theme, m = this.m, W = width;
		const out: string[] = [];
		const line = (s = "") => out.push(truncateToWidth(s, W));
		const right = (l: string, r: string) => line(l + " ".repeat(Math.max(1, W - visibleWidth(l) - visibleWidth(r))) + r);
		const T = m.T;

		// ---- header
		const first = m.log[0]?.date;
		const days = first ? Math.max(1, Math.round((Date.now() - new Date(first).getTime()) / 86_400_000) + 1) : 0;
		right(` ${th.fg("accent", th.bold(`📒 ${this.name}`))}`, th.fg("muted", T ? t(`${T} messages · since ${day(first!)} · ${days} ${days === 1 ? "day" : "days"} `, `${T} 条消息 · 自 ${day(first!)} · 第 ${days} 天 `) : t("no messages yet ", "还没有消息 ")));
		line();
		if (!T) {
			line(th.fg("muted", t("  Say something: every word is kept, and this map fills in as the conversation grows.", "  说点什么吧：每个字都会留下，这张图会随对话长出来。")));
			line();
			line(th.fg("dim", t("  esc close", "  esc 关闭")));
			return out;
		}

		// ---- said vs read
		const said = m.log.reduce((s, e) => s + e.size, 0), read = m.view.bytes;
		const lineBytes = (p: Part) => Buffer.byteLength(m.renderLine(p), "utf8") + 1;
		const fine = m.view.parts.filter((p) => p.l === 0).reduce((s, p) => s + lineBytes(p), 0);
		const fineShare = read ? Math.min(1, fine / m.view.parts.reduce((s, p) => s + lineBytes(p), 0)) : 0;
		const labels = [t("everything said", "说过的全部"), t("read each turn", "每轮读的")];
		const lw = Math.max(...labels.map(visibleWidth)) + 4, vw = 10, bw = Math.max(10, W - lw - vw - 2);
		right(`  ${padTo(labels[0], lw - 2)}${th.fg("text", bar(said, Math.max(said, read), bw))}`, `${fmtBytes(said)} `);
		right(`  ${padTo(labels[1], lw - 2)}${readBar(th, read * (1 - fineShare), read * fineShare, Math.max(said, read), bw)}`, `${fmtBytes(read)} `);
		line();

		// ---- timeline: one cell per stretch of messages; the glyph is how finely the view remembers it
		const tw = W - 4;
		const sel = this.selected();
		const cellOf = (msg: number) => Math.min(tw - 1, Math.floor((msg * tw) / T));
		const rows = ["", ""];
		let style = "", runs = ["", ""];
		const flush = () => { for (const r of [0, 1]) if (runs[r]) rows[r] += style === "lit" ? th.fg("accent", runs[r]) : th.fg(style === "fine" ? "success" : "muted", runs[r]); runs = ["", ""]; };
		for (let c = 0; c < tw; c++) {
			const msg = Math.min(T - 1, Math.floor((c * T) / tw));
			const l = m.view.covering(msg)?.l ?? 0;
			const h = Math.max(1, 16 - 2 * l); // eighths over two rows: word for word is full height, each halving of detail drops a quarter row
			const next = sel && msg >= start(sel) && msg < end(sel) ? "lit" : l === 0 ? "fine" : "brief";
			if (next !== style) { flush(); style = next; }
			runs[0] += h > 8 ? SPARK[h - 9] : " ";
			runs[1] += h >= 8 ? "█" : SPARK[h - 1];
		}
		flush();
		line(`  ${rows[0]}`);
		line(`  ${rows[1]}`);
		if (sel) {
			const a = cellOf(start(sel)), b = Math.max(a, cellOf(Math.min(T, end(sel)) - 1));
			const mark = b - a >= 2 ? `╰${"─".repeat(b - a - 1)}╯` : "▲";
			line(`  ${" ".repeat(a)}${th.fg("accent", mark)}`);
		} else line();
		{
			const l = `  ${th.fg("muted", day(first!))}`, r = th.fg("muted", `${t("now", "现在")} `);
			const legend = `${th.fg("muted", t("▃ summarized", "▃ 概括"))}${th.fg("dim", "  ·  ")}${th.fg("success", t("█ message by message", "█ 逐条"))}`;
			const gap = W - visibleWidth(l) - visibleWidth(r) - visibleWidth(legend);
			if (gap >= 4) line(l + " ".repeat(Math.floor(gap / 2)) + legend + " ".repeat(Math.ceil(gap / 2)) + r);
			else right(l, r);
		}
		line();

		// ---- breadcrumb
		if (this.stack.length === 1) line();
		else line(` ${this.stack.map((f, k) => (k === this.stack.length - 1 ? th.bold(f.label) : th.fg("muted", f.label))).join(th.fg("dim", " › "))}`);

		// ---- body
		const footerLines = 2;
		const used = out.length + footerLines + 1;
		const f = this.frame;
		if (f.kind === "lines") {
			const PREVIEW = 3;
			const sp = f.parts[f.sel], se = sp && sp.l === 0 ? m.log[sp.i] : undefined;
			const preview = sp ? wrapTextWithAnsi(flat(m.text(sp)).replace(se ? new RegExp(`^${se.kind}:\\s*`, "i") : /^$/, ""), Math.max(10, W - 6)).slice(0, PREVIEW) : [];
			this.listHeight = Math.max(3, this.height - used - PREVIEW - 1);
			if (f.sel < f.top) f.top = f.sel;
			if (f.sel >= f.top + this.listHeight) f.top = f.sel - this.listHeight + 1;
			const sw = Math.max(...f.parts.slice(f.top, f.top + this.listHeight).map((p) => span(p).length));
			const tagW = Math.max(...Object.values(KIND).map((k) => visibleWidth(k())));
			for (let k = f.top; k < Math.min(f.parts.length, f.top + this.listHeight); k++) {
				const p = f.parts[k], on = k === f.sel;
				const entry = m.log[start(p)];
				let head = `${on ? th.fg("accent", "▸") : " "} ${th.fg(on ? "accent" : "muted", span(p).padStart(sw))}  ${th.fg("dim", entry ? when(entry.date) : "")}  `;
				let body = flat(m.text(p));
				const quiet = p.l === 0 && entry && QUIET.has(entry.kind);
				if (p.l === 0 && entry) {
					body = body.replace(new RegExp(`^${entry.kind}:\\s*`, "i"), "");
					head += th.fg(quiet ? "dim" : "accent", padTo(KIND[entry.kind]?.() ?? entry.kind, tagW)) + " ";
				}
				const text = truncateToWidth(body, W - visibleWidth(head) - 2);
				line(` ${head}${on ? th.bold(text) : quiet ? th.fg("muted", text) : text}`);
			}
			for (let k = Math.min(f.parts.length, f.top + this.listHeight) - f.top; k < this.listHeight; k++) line();
			line();
			for (let k = 0; k < PREVIEW; k++) line(preview[k] ? `    ${th.fg("muted", preview[k])}` : "");
		} else {
			const e = m.log[f.i];
			const meta = th.fg("muted", `${KIND[e.kind]?.() ?? e.kind} · ${day(e.date)} ${when(e.date).slice(6)} · ${fmtBytes(e.size)}`);
			const body = e.text.split("\n").flatMap((l) => wrapTextWithAnsi(l, W - 4));
			this.listHeight = Math.max(3, this.height - used - 2);
			f.top = Math.min(f.top, Math.max(0, body.length - this.listHeight));
			line(`   ${meta}`);
			line();
			for (const l of body.slice(f.top, f.top + this.listHeight)) line(`   ${l}`);
			for (let k = body.slice(f.top, f.top + this.listHeight).length; k < this.listHeight; k++) line();
		}

		// ---- footer
		line();
		const keys = W < 100 ? t("↑↓ [ ] g G · enter · ← · esc", "↑↓ [ ] g G · enter · ← · esc") : f.kind === "lines"
			? t("↑↓ move · [ ] page · g G oldest/newest · enter open · ← back · esc close", "↑↓ 移动 · [ ] 翻页 · g G 最早/最新 · enter 展开 · ← 返回 · esc 关闭")
			: t("↑↓ scroll · [ ] page · ← back · esc close", "↑↓ 滚动 · [ ] 翻页 · ← 返回 · esc 关闭");
		const work = m.lastError ? t("summaries failing: see /mem status", "摘要出错：看 /mem status") : m.pending ? t(`summarizing ${m.pending}…`, `正在写 ${m.pending} 条摘要…`) : "";
		right(` ${th.fg("dim", keys)}`, `${th.fg(m.lastError ? "warning" : "dim", work)} `);
		return out;
	}
}
