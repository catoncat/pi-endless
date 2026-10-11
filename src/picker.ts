/** A list you can type into: every key narrows it (fuzzy), ↑↓ / PgUp PgDn move, enter picks, esc leaves. For /mem model. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, fuzzyFilter, matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { t } from "./i18n";

export interface PickItem { value: string; label: string; hint?: string; search?: string }

export class Picker {
	private input = new Input({ prompt: "› " });
	private shown: PickItem[];
	private sel = 0;
	private top = 0;
	private _focused = false;

	constructor(private tui: TUI, private theme: Theme, private title: string, private items: PickItem[], private done: (value?: string) => void) {
		this.shown = items;
	}

	// Focusable: the field shows the terminal cursor (and the IME window for Chinese input).
	get focused() { return this._focused; }
	set focused(v: boolean) { this._focused = v; this.input.focused = v; }
	invalidate() {}

	private get rows() { return Math.max(5, Math.min(15, this.tui.terminal.rows - 10)); }

	handleInput(data: string) {
		const move = (to: number) => { this.sel = Math.max(0, Math.min(this.shown.length - 1, to)); };
		if (matchesKey(data, "escape")) { this.done(); return; }
		if (matchesKey(data, "enter")) { const it = this.shown[this.sel]; if (it) this.done(it.value); return; }
		if (matchesKey(data, "up")) move(this.sel - 1);
		else if (matchesKey(data, "down")) move(this.sel + 1);
		else if (matchesKey(data, "pageUp")) move(this.sel - this.rows);
		else if (matchesKey(data, "pageDown")) move(this.sel + this.rows);
		else {
			const before = this.input.getValue();
			this.input.handleInput(data);
			const q = this.input.getValue();
			if (q !== before) {
				this.shown = q.trim() ? fuzzyFilter(this.items, q, (it) => it.search ?? it.label) : this.items;
				this.sel = 0;
				this.top = 0;
			}
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme, W = Math.max(20, width), rows = this.rows;
		if (this.sel < this.top) this.top = this.sel;
		if (this.sel >= this.top + rows) this.top = this.sel - rows + 1;
		const count = th.fg("dim", ` ${this.shown.length}/${this.items.length}`);
		const out = [th.fg("accent", th.bold(this.title)), (this.input.render(Math.max(10, W - visibleWidth(count)))[0] ?? "") + count];
		if (!this.shown.length) out.push(th.fg("dim", t("  nothing matches", "  没有匹配的")));
		for (let k = this.top; k < Math.min(this.shown.length, this.top + rows); k++) {
			const it = this.shown[k], on = k === this.sel;
			const hint = it.hint ? `  ${th.fg("dim", it.hint)}` : "";
			out.push(truncateToWidth(`${on ? th.fg("accent", "→ ") : "  "}${on ? th.fg("accent", it.label) : it.label}${hint}`, W));
		}
		const above = this.top, below = this.shown.length - Math.min(this.shown.length, this.top + rows);
		out.push(th.fg("dim", `${above || below ? `${above ? `↑${above} ` : ""}${below ? `↓${below} ` : ""}· ` : ""}${t("type to search · enter pick · esc cancel", "打字搜索 · enter 选定 · esc 取消")}`));
		return out.map((l) => truncateToWidth(l, W));
	}
}
