#!/usr/bin/env node
// Is the upstream recipe (Taelin's OptChat/UniiChat gist) newer than the version this code follows?
// Prints the diff between the pinned revision and the latest one, and checks that docs/upstream/optchat.md
// holds the pinned revision verbatim (the theory source kept in the repo). No dependencies; needs `git` for the diff.
// usage: node scripts/check-recipe.mjs [--quiet] [--write]
//   --write  rewrite docs/upstream/optchat.md from the pinned revision (after bumping `pinned revision` in docs/recipe.md)
//   exit 0 = up to date, 2 = upstream changed, 3 = local copy differs from the pinned revision, 1 = error
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const recipe = readFileSync(join(here, "..", "docs", "recipe.md"), "utf8");
const pinned = /pinned revision: `([0-9a-f]{40})`/.exec(recipe)?.[1];
const gistId = /gist id: `([0-9a-f]+)`/.exec(recipe)?.[1];
if (!pinned || !gistId) { console.error("docs/recipe.md must contain `gist id: ...` and `pinned revision: ...`"); process.exit(1); }
const quiet = process.argv.includes("--quiet");
const write = process.argv.includes("--write");
const copyPath = join(here, "..", "docs", "upstream", "optchat.md");
const MARK = "<!-- verbatim below -->\n";

const api = async (path) => {
	const res = await fetch(`https://api.github.com/gists/${gistId}${path}`, { headers: { accept: "application/vnd.github+json", "user-agent": "pi-endless-check-recipe" } });
	if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}`);
	return res.json();
};
const content = (gist) => Object.values(gist.files)[0]?.content ?? "";

try {
	const meta = await api("");
	const latest = meta.history[0];
	// The local copy must be exactly the pinned revision: the code cites it as its source.
	const old = await api(`/${pinned}`);
	const pinnedText = content(old);
	const local = existsSync(copyPath) ? readFileSync(copyPath, "utf8").split(MARK)[1] : undefined;
	if (local !== pinnedText) {
		if (!write) {
			console.log(`LOCAL COPY OUT OF SYNC: ${copyPath} is ${local === undefined ? "missing" : "not"} the pinned revision ${pinned.slice(0, 7)}${local === undefined ? "" : " verbatim"}; run with --write`);
			process.exit(3);
		}
		const h = meta.history.find((x) => x.version === pinned);
		const header = [
			"<!--",
			`Upstream: ${meta.description} — by ${meta.owner?.login ?? "VictorTaelin"}`,
			`URL: https://gist.github.com/${gistId}/${pinned}`,
			`Revision: ${pinned} (committed ${h?.committed_at ?? "?"}), file ${Object.keys(old.files)[0]}`,
			"Copied verbatim as the theory source of this repository; written by scripts/check-recipe.mjs --write, never edit by hand.",
			"Not covered by this repository's MIT license; all rights stay with the author. Excluded from the npm package.",
			"How the code maps to it and where it deliberately deviates: docs/recipe.md.",
			"-->",
			"",
		].join("\n");
		mkdirSync(dirname(copyPath), { recursive: true });
		writeFileSync(copyPath, header + MARK + pinnedText);
		console.log(`wrote ${copyPath} from ${pinned.slice(0, 7)}`);
	}
	if (latest.version === pinned) {
		if (!quiet) console.log(`recipe up to date: ${pinned.slice(0, 7)} (${latest.committed_at})`);
		process.exit(0);
	}
	const newer = meta.history.filter((h) => h.committed_at > meta.history.find((x) => x.version === pinned)?.committed_at);
	console.log(`UPSTREAM CHANGED: pinned ${pinned.slice(0, 7)}, latest ${latest.version.slice(0, 7)} (${latest.committed_at}); ${newer.length} newer revision(s):`);
	for (const h of newer) console.log(`  ${h.version.slice(0, 7)} ${h.committed_at} +${h.change_status?.additions ?? "?"} -${h.change_status?.deletions ?? "?"}`);
	const cur = await api(`/${latest.version}`);
	const dir = mkdtempSync(join(tmpdir(), "recipe-"));
	writeFileSync(join(dir, "pinned.md"), content(old));
	writeFileSync(join(dir, "latest.md"), content(cur));
	const diff = spawnSync("git", ["diff", "--no-index", "--no-color", "--stat", join(dir, "pinned.md"), join(dir, "latest.md")], { encoding: "utf8" });
	console.log(diff.stdout);
	console.log(`full diff: git diff --no-index ${join(dir, "pinned.md")} ${join(dir, "latest.md")}`);
	console.log(`next: read the diff, update docs/recipe.md (pinned revision, mapping, deviations), run --write to refresh docs/upstream/optchat.md, then change the code where the design changed.`);
	process.exit(2);
} catch (e) {
	console.error(`check-recipe failed: ${e.message}`);
	process.exit(1);
}
