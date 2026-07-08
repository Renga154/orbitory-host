#!/usr/bin/env node
/**
 * Orbitory demo terminal agent.
 *
 * A harmless, self-contained script used to exercise `TerminalAgentProvider`
 * end-to-end — manual testing, host-agent automated tests, and the iOS
 * Settings "Start Demo Agent" flow — without depending on any real coding
 * agent CLI.
 *
 * It:
 * - Prints realistic-looking AI coding activity to stdout over a few
 *   seconds, using Orbitory's `[[STATUS]]` / `[[SUMMARY]]` / `[[TESTS_*]]`
 *   marker convention (see `host-agent/src/providers/AgentProvider.ts`'s
 *   `parseTerminalLine`) so `TerminalAgentProvider` can drive real Orbitory
 *   session status/summary/test-result updates instead of only forwarding
 *   raw text.
 * - Optionally reads a line from stdin (a chat message forwarded verbatim by
 *   `TerminalAgentProvider.sendMessage`) and echoes a safe, canned
 *   acknowledgment — it never evaluates, shells out, or otherwise executes
 *   anything it reads.
 * - Never touches real files, never spawns a shell or child process, never
 *   reads environment variables or secrets — it only prints hardcoded
 *   strings and sleeps.
 * - Exits 0 after a short, deterministic lifecycle (a few seconds total),
 *   so it's fast enough for automated tests and manual demos alike.
 *
 * This script is itself part of the *host's* configuration (see
 * `orbitory.config.example.json`) — it is never selected, uploaded, or
 * modified by the iOS client. The client can only ask to start whichever
 * `id` a host operator has already configured and enabled.
 */

function statusLine(status, en, ja) {
  console.log(`[[STATUS]] ${JSON.stringify({ status, summary: { en, ja } })}`);
}

function summaryLine(en, ja) {
  console.log(`[[SUMMARY]] ${JSON.stringify({ en, ja })}`);
}

function testsStarted(en, ja) {
  console.log(`[[TESTS_STARTED]] ${JSON.stringify({ summary: { en, ja } })}`);
}

function testsFinished(status, passedCount, failedCount, durationSeconds, en, ja) {
  console.log(
    `[[TESTS_FINISHED]] ${JSON.stringify({
      status,
      passedCount,
      failedCount,
      durationSeconds,
      summary: { en, ja },
    })}`,
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Optional stdin handling: TerminalAgentProvider forwards `chat.message` text
// here, one line per message. Echo a canned, safe acknowledgment — the text
// is only ever printed back, never parsed as a command or evaluated.
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  const text = chunk.toString().trim();
  if (text.length === 0) return;
  console.log(`Got your message: "${text}". Noted — continuing the demo lifecycle.`);
});

async function main() {
  statusLine(
    "planning",
    "Demo agent starting up and reading the (fake) task description.",
    "デモエージェントを起動し、（架空の）タスク内容を読み込んでいます。",
  );
  await sleep(800);

  statusLine(
    "searching",
    "Searching the (fake) codebase for the relevant file.",
    "関連ファイルを探すため、（架空の）コードベースを調査しています。",
  );
  console.log('$ rg -n "formatCurrency" src/');
  await sleep(400);
  console.log("src/utils/format.ts:12:export function formatCurrency(cents) {");
  await sleep(700);

  statusLine(
    "editing",
    "Editing src/utils/format.ts to fix a rounding edge case.",
    "丸め処理の境界条件を修正するため src/utils/format.ts を編集しています。",
  );
  console.log("Applying edit to src/utils/format.ts");
  await sleep(500);
  // Deliberately print a FAKE api-key-shaped value so anyone watching the
  // Live tab sees the host-agent's output scrubber in action: this line
  // arrives on the phone as `DEMO_API_KEY=[REDACTED_SECRET]`. The value is
  // not a real secret — it exists purely to demonstrate the redaction.
  console.log("$ cat .env");
  console.log("DEMO_API_KEY=sk-demo-fakefakefake1234567890");
  await sleep(400);
  summaryLine(
    "Added a guard for exactly-zero amounts before formatting.",
    "フォーマット処理の前に、金額がちょうどゼロの場合のガードを追加しました。",
  );
  await sleep(600);

  testsStarted("Running the (fake) test suite...", "（架空の）テストスイートを実行中です...");
  console.log("$ npm test");
  console.log("> vitest run");
  await sleep(1200);
  testsFinished("passed", 14, 0, 3, "All 14 tests passed.", "14件すべてのテストに合格しました。");
  console.log("✓ 14 passed (3s)");
  await sleep(500);

  statusLine("editing", "Demo agent finishing up.", "デモエージェントの処理を終了しています。");
  await sleep(400);

  console.log("Done. This was a harmless demo session — no real files were touched.");
  // Explicit process.exit(0), not just setting process.exitCode: stdin is
  // piped (not a TTY) and this script keeps a "data" listener on it for the
  // whole run so it can echo chat messages at any point, which keeps
  // Node's event loop alive indefinitely on its own. Without a forced exit
  // here, the process would just hang forever instead of ever completing.
  process.exit(0);
}

main();
