#!/usr/bin/env node
// Measure what one session rebuild costs at the prompt cache.
//
// Drives pi over RPC through the bridge: a few turns with tool calls (optionally
// padded with large file reads), one turn on a different provider, then back —
// which forces the bridge to REBUILD the Claude Code session from pi's history
// and --resume it. Run it under diag/capture-proxy.mjs and compare, in the
// proxy's index.jsonl, the post-rebuild request's cacheRead against
// cacheRead + cacheWrite of the previous bridged request. Warm means equal.
//
//   node diag/capture-proxy.mjs --port 8787 --out /tmp/ab &
//   node --import tsx diag/ab-rebuild.mjs fixed
//   git stash push src/attachments.ts && node --import tsx diag/ab-rebuild.mjs unfixed; git stash pop
//   node diag/diff-captures.mjs /tmp/ab
//
// Env: AB_BIG=1 pads the prefix with three ~19k-token reads; AB_HOOKS=0 runs CC
// with disableHooks; AB_ALT_PROVIDER / AB_ALT_MODEL pick the foreign turn's
// model (default: CLAUDE_BRIDGE_TESTING_ALT_PROVIDER / _MODEL from .env.test).
import { createRpcHarness } from "../tests/lib/rpc-harness.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const label = process.argv[2] ?? "ab";
const foreign = {
	provider: process.env.AB_ALT_PROVIDER ?? process.env.CLAUDE_BRIDGE_TESTING_ALT_PROVIDER,
	modelId: process.env.AB_ALT_MODEL ?? process.env.CLAUDE_BRIDGE_TESTING_ALT_MODEL,
};
if (!foreign.provider || !foreign.modelId) {
	console.error("set AB_ALT_PROVIDER/AB_ALT_MODEL or CLAUDE_BRIDGE_TESTING_ALT_PROVIDER/_MODEL");
	process.exit(2);
}
const hooks = process.env.AB_HOOKS !== "0";
const big = process.env.AB_BIG === "1";
const proxy = process.env.ANTHROPIC_BASE_URL ?? "http://127.0.0.1:8787";
const T = 180_000;

const cwd = mkdtempSync(join(tmpdir(), `ab-rebuild-${label}-`));
mkdirSync(join(cwd, ".pi"));
writeFileSync(join(cwd, ".pi", "claude-bridge.json"), JSON.stringify({ provider: { disableHooks: !hooks } }));
const secret = join(cwd, "secret.txt");
const bigFiles = big ? [0, 1, 2].map((i) => {
	const f = join(cwd, `notes-${i}.txt`);
	const lines = [];
	for (let n = 0; n < 700; n++) lines.push(`${i}-${n}: entry ${n} of notes file ${i}; value=${(n * 7919 + i) % 10007}; tag=${["alpha", "beta", "gamma", "delta"][n % 4]}; status=${n % 3 ? "open" : "closed"}`);
	writeFileSync(f, lines.join("\n") + "\n");
	return f;
}) : [];

const h = createRpcHarness({
	name: `ab-rebuild-${label}`,
	cwd,
	args: ["--model", "claude-bridge/claude-haiku-4-5"],
	env: { ANTHROPIC_BASE_URL: proxy },
	defaultTimeout: T,
});
const say = (m) => console.log(`[${label}] ${m}`);
const turn = async (name, prompt) => { say(name); say("  " + (await h.promptAndWait(prompt)).trim().slice(0, 60)); };
try {
	await h.startAndWait(2500);
	await turn("t1", "The secret number is 42. Acknowledge briefly.");
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
	say(`debug log: ${h.DEBUG_LOG}`);
} finally {
	await h.stop();
	rmSync(cwd, { recursive: true, force: true });
}
