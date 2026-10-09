#!/usr/bin/env node
// Is the upstream recipe (Taelin's OptChat/UniiChat gist) newer than the version this code follows?
// Prints the diff between the pinned revision and the latest one. No dependencies; needs `git` for the diff.
// usage: node scripts/check-recipe.mjs [--quiet]      exit 0 = up to date, 2 = upstream changed, 1 = error
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
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

const api = async (path) => {
	const res = await fetch(`https://api.github.com/gists/${gistId}${path}`, { headers: { accept: "application/vnd.github+json", "user-agent": "pi-endless-check-recipe" } });
	if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}`);
	return res.json();
};
const content = (gist) => Object.values(gist.files)[0]?.content ?? "";

try {
	const meta = await api("");
	const latest = meta.history[0];
	if (latest.version === pinned) {
		if (!quiet) console.log(`recipe up to date: ${pinned.slice(0, 7)} (${latest.committed_at})`);
		process.exit(0);
	}
	const newer = meta.history.filter((h) => h.committed_at > meta.history.find((x) => x.version === pinned)?.committed_at);
	console.log(`UPSTREAM CHANGED: pinned ${pinned.slice(0, 7)}, latest ${latest.version.slice(0, 7)} (${latest.committed_at}); ${newer.length} newer revision(s):`);
	for (const h of newer) console.log(`  ${h.version.slice(0, 7)} ${h.committed_at} +${h.change_status?.additions ?? "?"} -${h.change_status?.deletions ?? "?"}`);
	const [old, cur] = await Promise.all([api(`/${pinned}`), api(`/${latest.version}`)]);
	const dir = mkdtempSync(join(tmpdir(), "recipe-"));
	writeFileSync(join(dir, "pinned.md"), content(old));
	writeFileSync(join(dir, "latest.md"), content(cur));
	const diff = spawnSync("git", ["diff", "--no-index", "--no-color", "--stat", join(dir, "pinned.md"), join(dir, "latest.md")], { encoding: "utf8" });
	console.log(diff.stdout);
	console.log(`full diff: git diff --no-index ${join(dir, "pinned.md")} ${join(dir, "latest.md")}`);
	console.log(`next: read the diff, update docs/recipe.md (pinned revision, mapping, deviations) and the code where the design changed.`);
	process.exit(2);
} catch (e) {
	console.error(`check-recipe failed: ${e.message}`);
	process.exit(1);
}
