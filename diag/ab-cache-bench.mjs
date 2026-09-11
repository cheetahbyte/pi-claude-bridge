#!/usr/bin/env node
// One run of the hook_additional_context rebuild A/B.
//
// Same shape as ab-rebuild.mjs — tool turns, one turn on a foreign provider,
// then back, forcing the bridge to rebuild the CC session from pi's history and
// --resume it — plus a deterministic project-level UserPromptSubmit hook so a
// hooks-on run is guaranteed to have hook context in the rebuilt prefix.
//
// Run under diag/capture-proxy.mjs (point ANTHROPIC_BASE_URL at it) and pair the
// runs with diag/ab-cache-report.mjs.
//
//   BENCH_LABEL=fixed-big-on-r1 BENCH_ARM=fixed BENCH_BIG=1 \
//     BENCH_RUNS_FILE=/tmp/ab/runs.jsonl node --import tsx diag/ab-cache-bench.mjs
//
// Env: BENCH_LABEL (required, unique per run), BENCH_ARM=fixed|baseline (label
// only), BENCH_HOOKS=0 runs CC with disableHooks (negative control), BENCH_BIG=1
// pads the prefix with three ~19k-token reads, BENCH_RUNS_FILE appends this run's
// capture window + log paths, BENCH_KEEP=1 leaves the session cwd in place.
import { createRpcHarness } from "../tests/lib/rpc-harness.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const label = process.env.BENCH_LABEL;
if (!label) {
	console.error("set BENCH_LABEL");
	process.exit(2);
}
const arm = process.env.BENCH_ARM ?? "unlabelled";
const hooks = process.env.BENCH_HOOKS !== "0";
const big = process.env.BENCH_BIG === "1";
const proxy = process.env.ANTHROPIC_BASE_URL ?? "http://127.0.0.1:8791";
const runsFile = process.env.BENCH_RUNS_FILE;
const keepCwd = process.env.BENCH_KEEP === "1";
const foreign = {
	provider: process.env.AB_ALT_PROVIDER ?? process.env.CLAUDE_BRIDGE_TESTING_ALT_PROVIDER,
	modelId: process.env.AB_ALT_MODEL ?? process.env.CLAUDE_BRIDGE_TESTING_ALT_MODEL,
};
if (!foreign.provider || !foreign.modelId) {
	console.error("set AB_ALT_PROVIDER/AB_ALT_MODEL or CLAUDE_BRIDGE_TESTING_ALT_PROVIDER/_MODEL");
	process.exit(2);
}
const T = 180_000;

// Fixed text so every run's hook context is byte-identical. Only this copy of
// the project (the temp arm checkout) ever sees it; user settings are untouched.
// Purely descriptive on purpose: an imperative here reads as an injected
// instruction, the model starts refusing the turns, and refusals change the very
// prompt bytes under test. The marker is what the report greps for.
const HOOK_TEXT = "Workspace note: pi-claude-bridge, Node >= 20, tabs in TypeScript. Env marker BLUE-HARBOR-7.";

const cwd = mkdtempSync(join(tmpdir(), `ab-cache-${label}-`));
mkdirSync(join(cwd, ".pi"), { recursive: true });
writeFileSync(join(cwd, ".pi", "claude-bridge.json"), JSON.stringify({ provider: { disableHooks: !hooks } }));
if (hooks) {
	mkdirSync(join(cwd, ".claude"), { recursive: true });
	writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({
		hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `echo "${HOOK_TEXT}"` }] }] },
	}));
}
const secret = join(cwd, "secret.txt");
const bigFiles = big ? [0, 1, 2].map((i) => {
	const f = join(cwd, `notes-${i}.txt`);
	const lines = [];
	for (let n = 0; n < 700; n++) lines.push(`${i}-${n}: entry ${n} of notes file ${i}; value=${(n * 7919 + i) % 10007}; tag=${["alpha", "beta", "gamma", "delta"][n % 4]}; status=${n % 3 ? "open" : "closed"}`);
	writeFileSync(f, lines.join("\n") + "\n");
	return f;
}) : [];

const h = createRpcHarness({
	name: `ab-cache-${label}`,
	cwd,
	args: ["--model", "claude-bridge/claude-haiku-4-5"],
	env: { ANTHROPIC_BASE_URL: proxy },
	defaultTimeout: T,
});
const say = (m) => console.log(`[${label}] ${m}`);
const turn = async (name, prompt) => { say(name); say("  " + (await h.promptAndWait(prompt)).trim().slice(0, 60)); };

const startedAt = new Date().toISOString();
let status = "ok";
try {
	await h.startAndWait(2500);
	await turn("t1 (hook context)", "The secret number is 42. Acknowledge briefly.");
	await turn("t2 (write)", `Write the secret number to ${secret}. Just the number, nothing else.`);
	await turn("t3 (read)", `Read ${secret} and tell me what's in it.`);
	for (const f of bigFiles) await turn(`pad ${f}`, `Read the whole file ${f} with the read tool, then reply with just OK.`);
	say(`switch -> ${foreign.provider}/${foreign.modelId}`);
	await h.send({ type: "set_model", ...foreign });
	await turn("t4 (foreign)", "What is 42 * 2? Just the number.");
	say("switch -> claude-bridge");
	await h.send({ type: "set_model", provider: "claude-bridge", modelId: "claude-haiku-4-5" });
	await turn("t5 (REBUILD boundary)", "Repeat the secret number once more. Just the number.");
	await turn("t6 (reuse)", "And once more, just the number.");
} catch (error) {
	status = `failed: ${error.message}`;
	say(status);
	throw error;
} finally {
	const endedAt = new Date().toISOString();
	try {
		await h.stop();
	} finally {
		if (runsFile) {
			appendFileSync(runsFile, JSON.stringify({
				label, arm, hooks, big, startedAt, endedAt, status,
				debugLog: h.DEBUG_LOG, cwd,
			}) + "\n");
		}
		if (!keepCwd) rmSync(cwd, { recursive: true, force: true });
	}
}
say(`done (${status})`);
