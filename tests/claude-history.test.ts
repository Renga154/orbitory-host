import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const previousClaudeConfigDir = process.env["CLAUDE_CONFIG_DIR"];

afterEach(() => {
  if (previousClaudeConfigDir === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
  else process.env["CLAUDE_CONFIG_DIR"] = previousClaudeConfigDir;
});

test("duplicate Claude titles remain distinguishable without using conversation text", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbitory-claude-title-"));
  const project = path.join(root, "project");
  const history = path.join(root, "claude-home", "projects", "-project");
  fs.mkdirSync(project);
  fs.mkdirSync(history, { recursive: true });
  process.env["CLAUDE_CONFIG_DIR"] = path.join(root, "claude-home");

  const ids = [
    "11111111-2222-4333-8444-555555555555",
    "66666666-7777-4888-8999-aaaaaaaaaaaa",
  ];
  for (const id of ids) {
    fs.writeFileSync(
      path.join(history, `${id}.jsonl`),
      JSON.stringify({
        sessionId: id,
        cwd: project,
        slug: "general-coding-session",
        timestamp: "2026-07-14T01:02:03.000Z",
        message: { content: "private-conversation-title-must-not-be-used" },
      }),
    );
  }

  const { queryClaudeSessions } = await import("../src/claudeHistory.js");
  const sessions = queryClaudeSessions(10);

  assert.equal(sessions.length, 2);
  assert.equal(new Set(sessions.map((session) => session.title)).size, 2);
  assert.ok(sessions.every((session) => session.title.startsWith("General coding session")));
  const wire = JSON.stringify(sessions.map(({ title, updatedAt }) => ({ title, updatedAt })));
  assert.equal(wire.includes("private-conversation-title-must-not-be-used"), false);
  assert.equal(wire.includes(project), false);
  assert.ok(ids.every((id) => !wire.includes(id)));
});
