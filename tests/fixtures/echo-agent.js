#!/usr/bin/env node
/**
 * Minimal, deterministic test-only fixture process for TerminalAgentProvider
 * tests. NOT the product demo agent — see host-agent/scripts/demo-agent.js
 * for that. This one exists purely to give tests precise, fast control over
 * stdout/stderr content, stdin echo, exit code, and (for the Phase 3.5
 * scrubbing/limit tests) fake-secret output, oversized lines, and floods.
 *
 * Every "secret" printed here is fake and exists only so tests can assert
 * the scrubber redacts it before it reaches a client.
 *
 * Usage: node echo-agent.js [--exit-code=N] [--delay-ms=N]
 *                           [--print-secrets] [--huge-line] [--flood=N]
 *                           [--probe-fs-writes]
 */

import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";

const exitCodeArg = process.argv.find((a) => a.startsWith("--exit-code="));
const exitCode = exitCodeArg ? Number(exitCodeArg.split("=")[1]) : 0;

const delayArg = process.argv.find((a) => a.startsWith("--delay-ms="));
const delayMs = delayArg ? Number(delayArg.split("=")[1]) : 200;

const floodArg = process.argv.find((a) => a.startsWith("--flood="));
const floodLines = floodArg ? Number(floodArg.split("=")[1]) : 0;

console.log("hello from stdout");
console.error("hello from stderr");

if (process.argv.includes("--print-secrets")) {
  // stdout: one fake secret for EVERY supported pattern family, plus normal
  // lines that must survive scrubbing untouched.
  console.log("this is a normal log line");
  console.log("ANTHROPIC_KEY_LINE sk-ant-api03-fakefakefakefake1234");
  console.log("OPENAI_KEY_LINE sk-fakefakefakefake1234567890");
  console.log("GITHUB_TOKEN_LINE ghp_fakefakefakefake1234567890abcd");
  console.log("GITHUB_PAT_LINE github_pat_fakefakefakefake1234567890");
  console.log("AWS_KEY_LINE AKIAFAKEFAKEFAKEFAKE");
  console.log("SLACK_TOKEN_LINE xoxb-fake-1234567890-abcdefghij");
  console.log(
    "JWT_LINE eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  );
  console.log("curl -H 'Authorization: Bearer fake.bearer.value1234'");
  console.log("bare keyword assignment TOKEN=bare-fake-token-value-000");
  console.log("MY_API_KEY=super-fake-assignment-value-123");
  console.log("-----BEGIN RSA PRIVATE KEY-----");
  console.log("fakekeymaterialAAAA1111BBBB2222");
  console.log("fakekeymaterialCCCC3333DDDD4444");
  console.log("-----END RSA PRIVATE KEY-----");
  console.log("another normal line after the key block");
  // stderr: prove the second stream is scrubbed independently too — with more
  // than one family, so it's not just a single token that happens to work.
  console.error("stderr leak attempt: SECRET_TOKEN=stderr-fake-secret-999");
  console.error("stderr openai leak: sk-stderrfakefakefake9876543210");
}

if (process.argv.includes("--huge-line")) {
  // A single very long line with a fake secret embedded well before the
  // truncation cutoff — the test asserts the emitted line is BOTH redacted
  // and truncated, proving scrub-before-truncate ordering.
  const hugeLine = `prefix ghp_hugefakehugefake1234567890abcd ${"x".repeat(6000)}`;
  console.log(hugeLine);
}

if (floodLines > 0) {
  for (let i = 1; i <= floodLines; i += 1) {
    console.log(`flood line ${i}`);
  }
}

if (process.argv.includes("--probe-fs-writes")) {
  // Filesystem-write probe used by the sandbox integration test: attempt a
  // write INSIDE the working directory (should succeed) and OUTSIDE it, in the
  // parent directory (should be denied under a write-confining sandbox). Prints
  // a deterministic result line for each so the test can assert enforcement.
  // Cleans up anything it manages to create so it never leaves stray files.
  const cwd = process.cwd();
  const inside = join(cwd, `orbitory-probe-inside-${process.pid}.txt`);
  try {
    writeFileSync(inside, "probe");
    unlinkSync(inside);
    console.log("FS_WRITE inside: ok");
  } catch (e) {
    console.log(`FS_WRITE inside: denied ${e.code}`);
  }
  const outside = join(dirname(cwd), `orbitory-probe-outside-${process.pid}.txt`);
  try {
    writeFileSync(outside, "probe");
    console.log("FS_WRITE outside: ok");
    try {
      unlinkSync(outside);
    } catch {
      // best effort
    }
  } catch (e) {
    console.log(`FS_WRITE outside: denied ${e.code}`);
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  const text = chunk.toString().trim();
  if (text.length > 0) {
    console.log(`echo: ${text}`);
  }
});

setTimeout(() => {
  process.exitCode = exitCode;
  process.exit(exitCode);
}, delayMs);
