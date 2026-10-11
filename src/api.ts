/**
 * Read-only access to endless conversations for anyone outside the pi that writes them: other agents, scripts, tools.
 * Never writes, never takes the lock (a snapshot of what is on disk). Tool calls and tool output are left out unless
 * asked for: they hold file contents and command output, which is where secrets end up.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Memory, end, flat, start, type Entry, type Kind } from "./core";

export const memHome = () => process.env.MEM_HOME ?? join(homedir(), ".pi", "memory");
const TOOLISH = new Set<Kind>(["tool", "echo"]);
const HIDDEN = "(tool traffic hidden; ask with includeTools to see it)";

export interface Options { includeTools?: boolean }
export interface ConversationInfo { name: string; messages: number; first?: string; last?: string; lastSaid?: string; openIn?: string }
/** How the model holds a message right now: verbatim in the view, summarized alone, or inside a line covering many. */
export interface Held { as: "verbatim" | "summarized" | "inside" | "absent"; line?: string; covers?: number; text?: string }
export interface Message { conversation: string; i: number; kind: Kind; date: string; text: string; held: Held }

/** After a rename the old name is a file {renamedTo}; follow it. */
export function resolveName(name: string, home = memHome()): string {
	for (let hop = 0; hop < 5; hop++) {
		const p = join(home, name);
		if (!existsSync(p)) throw new Error(`No conversation named ${name} in ${home}`);
		if (statSync(p).isDirectory()) return name;
		name = JSON.parse(readFileSync(p, "utf8")).renamedTo;
	}
	throw new Error("rename pointers loop");
}

export function conversationNames(home = memHome()): string[] {
	return existsSync(home) ? readdirSync(home, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name).sort() : [];
}

export function heldAs(m: Memory, i: number): Held {
	const c = m.view.covering(i), e = m.log[i];
	if (!c || !e) return { as: "absent" };
	const node = m.node(c), line = `${start(c)}+${end(c) - start(c)}`;
	if (c.l > 0) return { as: "inside", line, covers: end(c) - start(c), text: node?.text };
	const verbatim = !node || flat(node.text).replace(/^\d+(\+\d+)?\|/, "") === flat(`${e.kind}: ${e.text}`);
	return verbatim ? { as: "verbatim", line } : { as: "summarized", line, text: node.text };
}

export class Conversation {
	readonly memory: Memory;
	private constructor(readonly name: string, readonly dir: string) {
		this.memory = new Memory(dir, async () => { throw new Error("read-only"); }, () => {}, { readOnly: true });
	}

	static open(name: string, home = memHome()): Conversation {
		const real = resolveName(name, home);
		return new Conversation(real, join(home, real));
	}

	info(): ConversationInfo {
		const log = this.memory.log;
		const lastSaid = [...log].reverse().find((e) => e.kind === "user")?.text;
		let openIn: string | undefined;
		try {
			const lock = JSON.parse(readFileSync(join(this.dir, "lock.json"), "utf8")) as { pid: number; cwd?: string };
			process.kill(lock.pid, 0);
			openIn = lock.cwd ?? "another pi";
		} catch { /* not open anywhere */ }
		return { name: this.name, messages: log.length, first: log[0]?.date, last: log.at(-1)?.date, lastSaid: lastSaid && flat(lastSaid).slice(0, 200), openIn };
	}

	/** The view: what the model reads every turn, oldest line first. `lines` keeps only the newest N (0 = all). */
	view(lines = 0): { text: string; shown: number; total: number } {
		const all = this.memory.view.parts.map((p) => this.memory.renderLine(p));
		const keep = lines > 0 ? all.slice(-lines) : all;
		return { text: keep.join("\n"), shown: keep.length, total: all.length };
	}

	/** Original messages containing text (any case), newest first. */
	search(text: string, opts: Options & { before?: number; limit?: number } = {}): Message[] {
		const needle = text.toLowerCase(), out: Message[] = [], log = this.memory.log, limit = opts.limit ?? 20;
		for (let i = Math.min(opts.before ?? log.length, log.length) - 1; i >= 0 && out.length < limit; i--) {
			const e = log[i];
			if (TOOLISH.has(e.kind) && (!opts.includeTools || /^(zoom|search|date)[ :]/.test(e.text))) continue;
			if (e.text.toLowerCase().includes(needle)) out.push(this.toMessage(e, opts));
		}
		return out;
	}

	message(i: number, opts: Options = {}): Message {
		const e = this.memory.log[i];
		if (!e) throw new Error(`${this.name} has no message ${i} (0 to ${this.memory.T - 1})`);
		return this.toMessage(e, opts);
	}

	/** Messages after a moment (ISO date) or after a message number, oldest first. */
	since(after: string | number, opts: Options & { limit?: number } = {}): Message[] {
		const log = this.memory.log;
		const from = typeof after === "number" ? after + 1 : log.findIndex((e) => e.date > new Date(after).toISOString());
		if (from < 0) return [];
		return log.slice(from).filter((e) => opts.includeTools || !TOOLISH.has(e.kind)).slice(0, opts.limit ?? 200).map((e) => this.toMessage(e, opts));
	}

	/** Open line id+n into its two halves; n = 1 is message id whole (tool traffic hidden unless asked). */
	zoom(id: number, n: number, opts: Options = {}): string {
		if (n === 1 && TOOLISH.has(this.memory.log[id]?.kind) && !opts.includeTools) return `${id}+1|${this.memory.log[id].kind}: ${HIDDEN}`;
		return this.memory.zoom(id, n);
	}

	private toMessage(e: Entry, opts: Options): Message {
		const hide = TOOLISH.has(e.kind) && !opts.includeTools;
		const held = heldAs(this.memory, e.i);
		return { conversation: this.name, i: e.i, kind: e.kind, date: e.date, text: hide ? HIDDEN : e.text, held: hide ? { as: held.as, line: held.line, covers: held.covers } : held };
	}
}

export function listConversations(home = memHome()): ConversationInfo[] {
	return conversationNames(home).flatMap((n) => { try { return [Conversation.open(n, home).info()]; } catch { return []; } })
		.sort((a, b) => (b.last ?? "").localeCompare(a.last ?? ""));
}

/** Search one conversation or all of them, newest first across conversations. */
export function search(text: string, opts: Options & { conversation?: string; limit?: number; home?: string } = {}): Message[] {
	const names = opts.conversation ? [opts.conversation] : conversationNames(opts.home);
	const hits = names.flatMap((n) => Conversation.open(n, opts.home).search(text, { ...opts, limit: opts.limit ?? 20 }));
	return hits.sort((a, b) => b.date.localeCompare(a.date)).slice(0, opts.limit ?? 20);
}
