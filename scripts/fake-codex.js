#!/usr/bin/env node
/**
 * Fake Codex CLI — a harmless, deterministic stand-in used by automated tests
 * and by anyone who wants to exercise the Codex Adapter path WITHOUT installing
 * or running the real Codex CLI. It is NOT the real CLI and makes no attempt to
 * mimic its exact output format (Orbitory's adapter deliberately does not depend
 * on that — see docs/PHASE5_CODEX_ADAPTER.md).
 *
 * What it simulates:
 * - startup + planning/editing activity as plain stdout lines (NO
 *   `[[STATUS]]`-style markers, so it drives exactly the generic terminal
 *   lifecycle a real Codex session would: planning → editing on first output →
 *   completed/failed on exit)
 * - a stderr warning line
 * - reading a prompt / chat message from stdin and echoing an acknowledgment
 * - printing FAKE secrets (to prove the host-agent scrubs them before they
 *   reach a client) — every "secret" here is fabricated
 * - completing successfully (exit 0) or failing on demand (non-zero exit)
 * - optionally printing the NAMES of its environment keys (values are never
 *   printed), so a test can verify the `envAllowlist` policy
 *
 * It never touches real files, never spawns a shell or child process, never
 * reads real credentials, and never reaches the network — it only prints
 * hardcoded strings and sleeps.
 *
 * Usage:
 *   node fake-codex.js [--exit-code=N] [--fail] [--delay-ms=N]
 *                      [--print-secrets] [--print-env-keys]
 */

const exitCodeArg = process.argv.find((a) => a.startsWith("--exit-code="));
let exitCode = exitCodeArg ? Number(exitCodeArg.split("=")[1]) : 0;
if (process.argv.includes("--fail")) exitCode = 2;

const delayArg = process.argv.find((a) => a.startsWith("--delay-ms="));
const delayMs = delayArg ? Number(delayArg.split("=")[1]) : 120;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv.includes("--print-env-keys")) {
  // Names only — never values — so this line survives scrubbing and lets a
  // test assert which env keys the child actually received.
  console.log(`ENV_KEYS: ${Object.keys(process.env).sort().join(",")}`);
}

// stdin: Orbitory forwards session.start's initialPrompt and every
// chat.message here, one line at a time. Echo an acknowledgment — the text is
// only ever printed back, never evaluated or run.
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  const text = chunk.toString().trim();
  if (text.length > 0) {
    console.log(`Received prompt: "${text}". Working on it (fake codex).`);
  }
});

async function main() {
  console.log("Codex (fake) exec starting up.");
  await sleep(delayMs);
  console.log("Reading the project and planning the change.");
  await sleep(delayMs);
  console.error("warning: this is the FAKE Codex, not the real CLI.");
  console.log("Editing src/example.ts (fake codex).");
  await sleep(delayMs);

  if (process.argv.includes("--print-secrets")) {
    // Every value here is fabricated; the test asserts none of them reaches a
    // client. Covers a spread of pattern families on both streams.
    console.log("Loaded config: OPENAI_API_KEY=sk-fakecodexfake1234567890abcd");
    console.log("git remote: https://ghp_fakecodexfake1234567890abcdefgh@github.com/x/y");
    console.log("bare assignment TOKEN=fake-codex-bare-token-77");
    console.error("stderr note: OPENAI_KEY=sk-fakecodexstderr0987654321");
    await sleep(delayMs);
  }

  if (exitCode === 0) {
    console.log("Done. Created a fake change; no real files were touched.");
  } else {
    console.error(`fatal: fake Codex failed on purpose (exit ${exitCode}).`);
  }

  // Explicit exit: the stdin "data" listener keeps the event loop alive for
  // the whole run, so setting process.exitCode alone would hang forever.
  process.exit(exitCode);
}

main();
