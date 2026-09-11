#!/usr/bin/env node
// Pair the captures of ab-cache-bench runs and report what the rebuild boundary
// cost the prompt cache.
//
//   node diag/ab-cache-report.mjs /tmp/ab/runs.jsonl /tmp/ab/captures
//
// The foreign turn runs on a different provider, so it never reaches the
// capture proxy; a run's CC requests are the contiguous /v1/messages rows inside
// its window. The rebuild is the request whose message count jumps by >=3:
// importMessages splits a tool-result message into two records, while a normal
// continuation only appends the assistant reply and the new prompt (+2). `prior`
// is the request before it and `reuse` the one after.
//
// Reported per run: raw input/cacheRead/cacheWrite for prior → rebuild → reuse,
//   retained-prefix ratio = rebuild.cacheRead / (prior.cacheRead + prior.cacheWrite)
//     — prior `input` is deliberately excluded: those tokens were not cached,
//   cache-write reduction = prior.cacheWrite - rebuild.cacheWrite,
// whether the deterministic hook token is actually in each request, the first
// message index where prior and rebuild diverge, and request/session ids.
// Groups are printed as a table with per-cell values and median/range.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const [runsPath, captureDir] = process.argv.slice(2);
if (!runsPath || !captureDir) {
	console.error("usage: node diag/ab-cache-report.mjs <runs.jsonl> <capture-dir>");
	process.exit(2);
}
const TOKEN = "BLUE-HARBOR-7";

const runs = readFileSync(runsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const index = readFileSync(join(captureDir, "index.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const bodyOf = (n) => {
	try { return readFileSync(join(captureDir, `req-${String(n).padStart(4, "0")}.json`), "utf8"); } catch { return null; }
};
const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);

/** First index where two message arrays' elements stop matching, or -1. */
function firstDiff(a, b) {
	const n = Math.min(a?.length ?? 0, b?.length ?? 0);
	for (let i = 0; i < n; i++) if (hash(a[i]) !== hash(b[i])) return i;
	return (a?.length ?? 0) === (b?.length ?? 0) ? -1 : n;
}

function metrics(row, body) {
	return {
		n: row.n,
		model: row.model,
		messages: row.messages,
		input: row.usage.input,
		cacheRead: row.usage.cacheRead,
		cacheWrite: row.usage.cacheWrite,
		requestId: row.requestId ?? null,
		session: row.session ?? null,
		tokenHits: body ? (body.match(new RegExp(TOKEN, "g")) ?? []).length : null,
	};
}

const results = [];
for (const run of runs) {
	const rows = index.filter((r) =>
		String(r.path).startsWith("/v1/messages") && r.at >= run.startedAt && r.at <= run.endedAt &&
		r.usage && (r.messages ?? 0) > 0 && (r.tools ?? 0) > 0);
	let rebuildIdx = -1;
	for (let i = 1; i < rows.length; i++) if (rows[i].messages - rows[i - 1].messages >= 3) { rebuildIdx = i; break; }
	if (rebuildIdx === -1) {
		let bestDelta = 2;
		for (let i = 1; i < rows.length; i++) if (rows[i].messages - rows[i - 1].messages > bestDelta) { bestDelta = rows[i].messages - rows[i - 1].messages; rebuildIdx = i; }
	}
	const prior = rebuildIdx > 0 ? rows[rebuildIdx - 1] : null;
	const rebuild = rebuildIdx > 0 ? rows[rebuildIdx] : null;
	const reuse = rebuildIdx > 0 ? rows[rebuildIdx + 1] ?? null : null;
	const priorBody = prior ? bodyOf(prior.n) : null;
	const rebuildBody = rebuild ? bodyOf(rebuild.n) : null;
	const reuseBody = reuse ? bodyOf(reuse.n) : null;
	let priorJson = null, rebuildJson = null;
	try { priorJson = JSON.parse(priorBody); } catch {}
	try { rebuildJson = JSON.parse(rebuildBody); } catch {}
	const expected = prior ? prior.usage.cacheRead + prior.usage.cacheWrite : null;
	results.push({
		...run,
		valid: Boolean(prior && rebuild),
		ccRequests: rows.length,
		delta: prior && rebuild ? rebuild.messages - prior.messages : null,
		gapSec: prior && rebuild ? Number(((Date.parse(rebuild.at) - Date.parse(prior.at)) / 1000).toFixed(1)) : null,
		sessions: [...new Set(rows.map((r) => r.session).filter(Boolean))],
		prior: prior ? metrics(prior, priorBody) : null,
		rebuild: rebuild ? metrics(rebuild, rebuildBody) : null,
		reuse: reuse ? metrics(reuse, reuseBody) : null,
		retained: prior && rebuild && expected ? rebuild.usage.cacheRead / expected : null,
		writeReduction: prior && rebuild ? prior.usage.cacheWrite - rebuild.usage.cacheWrite : null,
		firstDiff: priorJson && rebuildJson ? firstDiff(priorJson.messages, rebuildJson.messages) : null,
	});
}

const nums = (xs) => xs.filter((x) => typeof x === "number");
const med = (xs) => { const a = nums(xs).sort((p, q) => p - q); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const range = (xs) => { const a = nums(xs); return a.length ? `${Math.min(...a)}–${Math.max(...a)}` : "-"; };
const pct = (x) => (x === null ? "-" : `${(x * 100).toFixed(1)}%`);

for (const r of results) {
	console.log(`${r.label} arm=${r.arm} hooks=${r.hooks ? "on" : "off"} big=${r.big ? "yes" : "no"} status=${r.status} valid=${r.valid} ccRequests=${r.ccRequests}`);
	if (!r.valid) { console.log("    INVALID: no rebuild boundary (message-count jump) detected in window"); continue; }
	console.log(`    boundary: msgs ${r.prior.messages} -> ${r.rebuild.messages} (+${r.delta}) after ${r.gapSec}s; sessions=${r.sessions.map((s) => String(s).slice(-24)).join(",")}`);
	console.log(`    prior   n=${r.prior.n} reqId=${r.prior.requestId ?? "-"} in=${r.prior.input} read=${r.prior.cacheRead} write=${r.prior.cacheWrite} token=${r.prior.tokenHits}`);
	console.log(`    rebuild n=${r.rebuild.n} reqId=${r.rebuild.requestId ?? "-"} in=${r.rebuild.input} read=${r.rebuild.cacheRead} write=${r.rebuild.cacheWrite} token=${r.rebuild.tokenHits}`);
	console.log(`    reuse   n=${r.reuse?.n ?? "-"} reqId=${r.reuse?.requestId ?? "-"} in=${r.reuse?.input ?? "-"} read=${r.reuse?.cacheRead ?? "-"} write=${r.reuse?.cacheWrite ?? "-"} token=${r.reuse?.tokenHits ?? "-"}`);
	console.log(`    retained=${pct(r.retained)} writeReduction=${r.writeReduction} firstMessageDiff=${r.firstDiff}`);
}

console.log("\n| group | runs | retained rebuild/(prior r+w) | cacheWrite reduction (prior-rebuild) | prior in/r/w | rebuild in/r/w | reuse read | first msg diff | hook token prior/rebuild |");
console.log("|---|---|---|---|---|---|---|---|---|");
const groups = new Map();
for (const r of results) {
	const key = `${r.arm} hooks=${r.hooks ? "on" : "off"} big=${r.big ? "yes" : "no"}`;
	if (!groups.has(key)) groups.set(key, []);
	groups.get(key).push(r);
}
const cell = (rs, fn) => rs.map(fn).join(", ") || "-";
for (const [key, rs] of groups) {
	const v = rs.filter((r) => r.valid);
	console.log(`| ${key} | ${rs.length} (${v.length} valid) | ${cell(v, (r) => pct(r.retained))} | ${cell(v, (r) => r.writeReduction)} | ${cell(v, (r) => `${r.prior.input}/${r.prior.cacheRead}/${r.prior.cacheWrite}`)} | ${cell(v, (r) => `${r.rebuild.input}/${r.rebuild.cacheRead}/${r.rebuild.cacheWrite}`)} | ${cell(v, (r) => r.reuse?.cacheRead ?? "-")} | ${cell(v, (r) => r.firstDiff)} | ${cell(v, (r) => `${r.prior.tokenHits}/${r.rebuild.tokenHits}`)} |`);
}
console.log("\nmedians / ranges (valid runs only):");
for (const [key, rs] of groups) {
	const v = rs.filter((r) => r.valid);
	console.log(`  ${key}: retained median ${pct(med(v.map((r) => r.retained)))} (${cell(v, (r) => pct(r.retained))}); writeReduction median ${med(v.map((r) => r.writeReduction)) ?? "-"} range ${range(v.map((r) => r.writeReduction))}`);
}
