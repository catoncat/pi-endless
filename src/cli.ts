/**
 * pi-mem — read endless conversations from anywhere: a shell, a script, another agent (CLI), or any MCP client (`pi-mem mcp`).
 * Read-only; tool traffic is hidden unless --include-tools / includeTools.
 */
import { Conversation, listConversations, search, type ConversationInfo, type Held, type Message } from "./api";

const VERSION = "0.1.0";
const short = (iso?: string) => (iso ? iso.slice(0, 16).replace("T", " ") : "");
const flat = (s: string) => s.replace(/[\r\n]+/g, " ");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const heldText = (h: Held) => h.as === "verbatim" ? `verbatim in the view (line ${h.line})` : h.as === "summarized" ? `summarized as line ${h.line}` : h.as === "inside" ? `inside line ${h.line}, a summary of ${h.covers} messages` : "not in the view";

const fmt = {
	list: (cs: ConversationInfo[]) => cs.length ? cs.map((c) => `${c.name}  ${c.messages} messages  ${short(c.first)} → ${short(c.last)}${c.openIn ? `  (open in ${c.openIn})` : ""}${c.lastSaid ? `\n    last said: ${clip(c.lastSaid, 140)}` : ""}`).join("\n") : "No conversations yet.",
	hits: (ms: Message[], q: string, tools = false) => ms.length ? ms.map((m) => {
		const text = flat(m.text), at = Math.max(0, text.toLowerCase().indexOf(q.toLowerCase()) - 60);
		return `${m.conversation} #${m.i} · ${short(m.date)} · ${m.kind}: ${at ? "…" : ""}${clip(text.slice(at), 240)}\n    pi remembers it ${heldText(m.held)}`;
	}).join("\n") : `No message contains "${q}".${tools ? "" : " Tool calls and tool output were not searched (includeTools / --include-tools)."}`,
	message: (m: Message) => `${m.conversation} #${m.i} · ${m.kind} · ${m.date}\npi remembers it ${heldText(m.held)}${m.held.text ? `: ${flat(m.held.text)}` : ""}\n\n${m.text}`,
	messages: (ms: Message[]) => ms.length ? ms.map((m) => `#${m.i} · ${short(m.date)} · ${m.kind}: ${clip(flat(m.text), 300)}`).join("\n") : "Nothing new.",
};

// ------------------------------------------------------------ operations shared by CLI and MCP

type Args = Record<string, unknown>;
const str = (a: Args, k: string) => (typeof a[k] === "string" && a[k] ? (a[k] as string) : undefined);
const num = (a: Args, k: string) => (a[k] === undefined || a[k] === "" ? undefined : Number(a[k]));
const need = (v: string | undefined, what: string) => { if (!v) throw new Error(`${what} is required`); return v; };

const ops: Record<string, { description: string; schema: object; run: (a: Args) => { text: string; data: unknown } }> = {
	list: {
		description: "List the endless conversations (one per topic): name, message count, first and last activity, the user's last message, and where it is open.",
		schema: { type: "object", properties: {} },
		run: () => { const d = listConversations(); return { text: fmt.list(d), data: d }; },
	},
	search: {
		description: "Find original messages containing text (plain text, any case), newest first, in one conversation or all. Each hit says how the conversation's model remembers it now (verbatim, or inside which summary line). Use message or zoom to read more.",
		schema: { type: "object", properties: { text: { type: "string" }, conversation: { type: "string", description: "omit to search all conversations" }, limit: { type: "integer", minimum: 1, default: 20 }, includeTools: { type: "boolean", default: false, description: "also search tool calls and tool output (may contain file contents and secrets)" } }, required: ["text"] },
		run: (a) => { const q = need(str(a, "text"), "text"); const d = search(q, { conversation: str(a, "conversation"), limit: num(a, "limit"), includeTools: a.includeTools === true }); return { text: fmt.hits(d, q, a.includeTools === true), data: d }; },
	},
	view: {
		description: "The conversation's view: what its model reads every turn, one summary line per stretch of history (old stretches coarse, recent ones message by message). Lines read `id+n|text`: messages id to id+n-1. Returns the newest `lines` lines (default 200, 0 for all).",
		schema: { type: "object", properties: { conversation: { type: "string" }, lines: { type: "integer", minimum: 0, default: 200 } }, required: ["conversation"] },
		run: (a) => {
			const v = Conversation.open(need(str(a, "conversation"), "conversation")).view(num(a, "lines") ?? 200);
			return { text: `${v.shown < v.total ? `(newest ${v.shown} of ${v.total} lines; lines: 0 for all)\n` : ""}${v.text}`, data: v };
		},
	},
	zoom: {
		description: "Open view line id+n into the two lines of n/2 under it; n = 1 gives message id whole. n is a power of 2 and id a multiple of n.",
		schema: { type: "object", properties: { conversation: { type: "string" }, id: { type: "integer", minimum: 0 }, n: { type: "integer", minimum: 1 }, includeTools: { type: "boolean", default: false } }, required: ["conversation", "id", "n"] },
		run: (a) => { const t = Conversation.open(need(str(a, "conversation"), "conversation")).zoom(num(a, "id")!, num(a, "n")!, { includeTools: a.includeTools === true }); return { text: t, data: t }; },
	},
	message: {
		description: "One original message, whole, with its date and how the model remembers it now.",
		schema: { type: "object", properties: { conversation: { type: "string" }, id: { type: "integer", minimum: 0 }, includeTools: { type: "boolean", default: false } }, required: ["conversation", "id"] },
		run: (a) => { const d = Conversation.open(need(str(a, "conversation"), "conversation")).message(num(a, "id")!, { includeTools: a.includeTools === true }); return { text: fmt.message(d), data: d }; },
	},
	since: {
		description: "Messages after a moment (ISO date, e.g. 2026-10-11T08:00) or after a message number, oldest first: what happened in the conversation since you last looked.",
		schema: { type: "object", properties: { conversation: { type: "string" }, after: { type: "string", description: "ISO date or message number" }, limit: { type: "integer", minimum: 1, default: 200 }, includeTools: { type: "boolean", default: false } }, required: ["conversation", "after"] },
		run: (a) => {
			const after = need(str(a, "after") ?? (a.after !== undefined ? String(a.after) : undefined), "after");
			const d = Conversation.open(need(str(a, "conversation"), "conversation")).since(/^\d+$/.test(after) ? Number(after) : after, { limit: num(a, "limit"), includeTools: a.includeTools === true });
			return { text: fmt.messages(d), data: d };
		},
	},
};

// ------------------------------------------------------------ MCP over stdio (JSON-RPC 2.0, one message per line)

function mcp() {
	let buf = "";
	const send = (msg: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
	const handle = (req: { id?: number | string; method: string; params?: { name?: string; arguments?: Args; protocolVersion?: string } }) => {
		if (req.id === undefined) return; // notifications (initialized, cancelled) need no answer
		try {
			if (req.method === "initialize") return send({ id: req.id, result: { protocolVersion: req.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pi-mem", version: VERSION }, instructions: "Read-only access to the user's endless pi conversations (one per topic). Start with list or search; read more with message, zoom or view." } });
			if (req.method === "ping") return send({ id: req.id, result: {} });
			if (req.method === "tools/list") return send({ id: req.id, result: { tools: Object.entries(ops).map(([name, o]) => ({ name, description: o.description, inputSchema: o.schema, annotations: { readOnlyHint: true } })) } });
			if (req.method === "tools/call") {
				const op = ops[req.params?.name ?? ""];
				if (!op) return send({ id: req.id, error: { code: -32602, message: `Unknown tool ${req.params?.name}` } });
				try { return send({ id: req.id, result: { content: [{ type: "text", text: op.run(req.params?.arguments ?? {}).text }] } }); }
				catch (e) { return send({ id: req.id, result: { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true } }); }
			}
			send({ id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } });
		} catch (e) {
			send({ id: req.id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
		}
	};
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => {
		buf += chunk;
		const lines = buf.split("\n");
		buf = lines.pop()!;
		for (const line of lines) {
			if (!line.trim()) continue;
			try { handle(JSON.parse(line)); } catch { send({ id: null, error: { code: -32700, message: "Parse error" } }); }
		}
	});
}

// ------------------------------------------------------------ CLI

const USAGE = `pi-mem — read your endless pi conversations (read-only)

  pi-mem list
  pi-mem search <text> [-c <conversation>] [--limit N]
  pi-mem view <conversation> [--lines N]          (default 200 newest, 0 = all)
  pi-mem zoom <conversation> <id>+<n>
  pi-mem message <conversation> <id>
  pi-mem since <conversation> <ISO date | message id> [--limit N]
  pi-mem mcp                                      (MCP server on stdio)

  --json            machine-readable output
  --include-tools   include tool calls and tool output (file contents, command output: may hold secrets)
  MEM_HOME          where conversations live (default ~/.pi/memory)`;

function main(argv: string[]) {
	const flags: Args = {}, pos: string[] = [];
	for (let k = 0; k < argv.length; k++) {
		const a = argv[k];
		if (a === "--json" || a === "--include-tools") flags[a.slice(2)] = true;
		else if (a === "-c" || a === "--conversation") flags.conversation = argv[++k];
		else if (a === "--limit" || a === "--lines") flags[a.slice(2)] = argv[++k];
		else if (a === "-h" || a === "--help") flags.help = true;
		else if (a === "-v" || a === "--version") { console.log(VERSION); return; }
		else pos.push(a);
	}
	const [cmd, ...rest] = pos;
	if (!cmd || flags.help) { console.log(USAGE); return; }
	if (cmd === "mcp") { mcp(); return; }
	const args: Args = { ...flags, includeTools: flags["include-tools"] === true };
	if (cmd === "search") args.text = rest.join(" ");
	else if (cmd === "zoom") { args.conversation = rest[0]; const [id, n] = /^\d+\+\d+$/.test(rest[1] ?? "") ? rest[1].split("+") : [rest[1], rest[2]]; args.id = id; args.n = n; }
	else if (cmd === "message") { args.conversation = rest[0]; args.id = rest[1]; }
	else if (cmd === "since") { args.conversation = rest[0]; args.after = rest[1]; }
	else if (cmd === "view") args.conversation = rest[0];
	const op = ops[cmd];
	if (!op) { console.error(`Unknown command ${cmd}\n\n${USAGE}`); process.exitCode = 2; return; }
	try {
		const r = op.run(args);
		console.log(flags.json ? JSON.stringify(r.data, null, 1) : r.text);
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		process.exitCode = 1;
	}
}

main(process.argv.slice(2));
