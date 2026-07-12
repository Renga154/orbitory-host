#!/usr/bin/env node

const THREAD_ID = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const args = process.argv.slice(2);

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function rejectInvocation() {
  process.stderr.write("fake Codex invocation rejected\n");
  process.exitCode = 64;
}

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  if (process.env.ORBITORY_PAIRING_TOKEN !== undefined) {
    process.stderr.write("fake Codex received the pairing token\n");
    process.exitCode = 66;
    return;
  }
  const resume = args[0] === "exec" && args[1] === "resume";
  const scenario = args.find((arg) => arg.startsWith("--scenario=")) ?? "--scenario=normal";
  const expected = resume
    ? ["exec", "resume", scenario, "--skip-git-repo-check", "--json", THREAD_ID, "-"]
    : ["exec", scenario, "--skip-git-repo-check", "--json", "-"];
  if (args.length !== expected.length || args.some((arg, index) => arg !== expected[index])) {
    rejectInvocation();
    return;
  }
  if (scenario === "--scenario=linger" && !resume && prompt === "linger") {
    process.on("SIGTERM", () => {
      // Deliberately resist the graceful stop so the provider must escalate.
    });
    emit({ type: "thread.started", thread_id: THREAD_ID });
    emit({ type: "turn.started" });
    emit({
      type: "item.started",
      item: { id: "item_linger", type: "command_execution", status: "in_progress" },
    });
    setInterval(() => {}, 1_000);
    return;
  }
  if (scenario === "--scenario=stale-resume" && resume && prompt === "continue safely") {
    process.stderr.write(`Error: thread/resume failed: no rollout found for thread id ${THREAD_ID}\n`);
    process.exitCode = 1;
    return;
  }
  let reply;
  if (scenario === "--scenario=privacy" && !resume && prompt === "privacy") {
    emit({
      type: "item.completed",
      item: {
        id: "item_pre_thread_reply",
        type: "agent_message",
        text: `Preflight ${THREAD_ID} touched src/private/secret.ts.`,
      },
    });
    emit({ type: "thread.started", thread_id: THREAD_ID });
    emit({ type: "turn.started" });
    process.stdout.write(
      `not-json ${THREAD_ID} /Users/private/project/secret.ts sk-fakecodexsecret123456789\n`,
    );
    process.stderr.write(
      `stderr ${THREAD_ID} /Users/private/project/secret.ts ghp_fakecodexsecret1234567890\n`,
    );
    emit({
      type: "item.completed",
      item: {
        id: "item_private_file",
        type: "file_change",
        changes: [{ path: "/Users/private/project/secret.ts", kind: "update" }],
      },
    });
    reply =
      `Thread ${THREAD_ID} changed /Users/private/project/secret.ts with ` +
      "sk-fakecodexsecret123456789.";
  } else if (scenario === "--scenario=oversized" && !resume && prompt === "oversized") {
    emit({ type: "thread.started", thread_id: THREAD_ID });
    emit({ type: "turn.started" });
    reply =
      "sk-fakecodexsecret123456789 /Users/private/project/secret.ts " + "x".repeat(5_000);
  } else if (scenario === "--scenario=normal" && !resume && prompt === "first turn; $(touch should-not-run)") {
    reply = "First turn complete.";
  } else if (scenario === "--scenario=normal" && !resume && prompt === "queued one") {
    reply = "Queued first complete.";
  } else if (scenario === "--scenario=normal" && resume && prompt === "queued two") {
    reply = "Queued second complete.";
  } else if (scenario === "--scenario=normal" && resume && prompt === "existing resume") {
    reply = "Existing thread resumed.";
  } else {
    process.stderr.write("fake Codex prompt rejected\n");
    process.exitCode = 65;
    return;
  }

  if (scenario === "--scenario=normal") {
    emit({ type: "thread.started", thread_id: THREAD_ID });
    emit({ type: "turn.started" });
    emit({
      type: "item.started",
      item: {
        id: "item_private_command",
        type: "command_execution",
        command: "cat /Users/private/project/.env",
        aggregated_output: "OPENAI_API_KEY=sk-fakecodexsecret123456789",
        status: "in_progress",
      },
    });
  }
  emit({
    type: "item.completed",
    item: { id: "item_reply", type: "agent_message", text: reply },
  });
  emit({
    type: "turn.completed",
    usage: {
      input_tokens: 10,
      cached_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 1,
    },
  });
});
