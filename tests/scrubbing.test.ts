/**
 * Unit tests for the centralized output secret scrubber (src/scrubbing.ts):
 * every supported pattern family redacts, normal developer-log text passes
 * through untouched, multiline input (including PEM blocks split across
 * streamed lines) is handled, and caller-supplied literal secrets (e.g. the
 * pairing token) are always redacted. Pure — no server or process involved;
 * the end-to-end "no raw secret ever reaches a WebSocket client" checks live
 * in tests/terminal-provider.test.ts.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { REDACTED, scrubSecrets, StreamScrubber } from "../src/scrubbing.js";

describe("scrubSecrets: known secret patterns are redacted", () => {
  const cases: Array<{ name: string; input: string; mustNotContain: string }> = [
    {
      name: "Anthropic API key",
      input: "using key sk-ant-api03-abcdefghijklmnop to call the API",
      mustNotContain: "sk-ant-api03-abcdefghijklmnop",
    },
    {
      name: "OpenAI-style API key",
      input: "OPENAI says: sk-proj-abcdefghijklmnop123456 accepted",
      mustNotContain: "sk-proj-abcdefghijklmnop123456",
    },
    {
      name: "GitHub classic token",
      input: "pushing with ghp_abcdefghijklmnopqrstuvwx12345678",
      mustNotContain: "ghp_abcdefghijklmnopqrstuvwx12345678",
    },
    {
      name: "GitHub fine-grained token",
      input: "auth github_pat_abcdefghijklmnopqrstuv_more",
      mustNotContain: "github_pat_abcdefghijklmnopqrstuv_more",
    },
    {
      name: "AWS access key id",
      input: "aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE",
      mustNotContain: "AKIAIOSFODNN7EXAMPLE",
    },
    {
      name: "Slack token",
      input: "SLACK: xoxb-1234567890-abcdefghij",
      mustNotContain: "xoxb-1234567890-abcdefghij",
    },
    {
      name: "JWT",
      input:
        "session jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      mustNotContain: "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    },
    {
      name: "Bearer token",
      input: "curl -H 'Authorization: Bearer abc123def456ghi789'",
      mustNotContain: "abc123def456ghi789",
    },
    {
      name: "Authorization header (non-bearer scheme)",
      input: "> authorization: Basic dXNlcjpwYXNzd29yZA==",
      mustNotContain: "dXNlcjpwYXNzd29yZA",
    },
    {
      name: ".env-style KEY=value",
      input: "MY_API_KEY=super-secret-value-42",
      mustNotContain: "super-secret-value-42",
    },
    {
      name: "password assignment with colon",
      input: "db_password: hunter2-but-longer",
      mustNotContain: "hunter2-but-longer",
    },
    {
      name: "quoted secret assignment",
      input: 'export SECRET_TOKEN="quoted secret value"',
      mustNotContain: "quoted secret value",
    },
  ];

  for (const { name, input, mustNotContain } of cases) {
    test(name, () => {
      const scrubbed = scrubSecrets(input);
      assert.equal(
        scrubbed.includes(mustNotContain),
        false,
        `expected the secret to be gone; got: ${scrubbed}`,
      );
      assert.ok(scrubbed.includes(REDACTED), `expected ${REDACTED} in: ${scrubbed}`);
    });
  }

  test("KEY=value redaction keeps the key name, redacts only the value", () => {
    assert.equal(scrubSecrets("MY_API_KEY=super-secret-value-42"), `MY_API_KEY=${REDACTED}`);
  });

  // Regression: an earlier version of the secretish-assignment rule required a
  // character BEFORE the keyword, so a name that STARTS WITH (or exactly IS) a
  // keyword — the most common env-var spellings — leaked. It also missed
  // JSON-quoted keys. All of these must redact, even when the value itself has
  // no recognizable secret prefix (so only the name rule can catch it).
  test("names that start with / exactly are a secret keyword are redacted (regression)", () => {
    const bareKeywordNames = [
      "PASSWORD=plainvalue123",
      "TOKEN=plainvalue123",
      "SECRET=plainvalue123",
      "API_KEY=plainvalue123",
      "APIKEY=plainvalue123",
      "credentials=plainvalue123",
      "passwd=plainvalue123",
      "ACCESS_KEY=plainvalue123",
      "PRIVATE_KEY=plainvalue123",
      "AUTH_KEY=plainvalue123",
      "password: plainvalue123",
    ];
    for (const line of bareKeywordNames) {
      const scrubbed = scrubSecrets(line);
      assert.equal(scrubbed.includes("plainvalue123"), false, `leaked: ${line} -> ${scrubbed}`);
      assert.ok(scrubbed.includes(REDACTED));
    }
  });

  test("JSON-style quoted secret keys are redacted even with a non-prefixed value", () => {
    const scrubbed = scrubSecrets('"password": "plainvalue123"');
    assert.equal(scrubbed.includes("plainvalue123"), false, scrubbed);
    assert.ok(scrubbed.includes(REDACTED));
  });

  test("the rule over-redacts by design (documented): TOKENS_PER_SECOND=5 is redacted", () => {
    assert.equal(scrubSecrets("TOKENS_PER_SECOND=5"), `TOKENS_PER_SECOND=${REDACTED}`);
  });
});

describe("scrubSecrets: normal log lines pass through untouched", () => {
  const normalLines = [
    "this is a normal log line",
    "$ npm install",
    "> vitest run",
    "✓ 14 passed (3s)",
    "Applying edit to src/utils/format.ts",
    '$ rg -n "formatCurrency" src/',
    "task-management refactor in progress", // contains "sk-" inside a word — must NOT match
    "Compiled successfully in 1240ms",
    "GET /orders?limit=20&offset=0 200",
    'hello; rm -rf / && echo pwned `whoami`', // shell noise is not a secret
  ];

  for (const line of normalLines) {
    test(JSON.stringify(line), () => {
      assert.equal(scrubSecrets(line), line);
    });
  }
});

describe("scrubSecrets: multiline input", () => {
  test("a full PEM private key block is redacted, surrounding text survives", () => {
    const input = [
      "before the key",
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA0m5c9GkYRt6C",
      "z8fakefakefakefakefakefake==",
      "-----END RSA PRIVATE KEY-----",
      "after the key",
    ].join("\n");
    const scrubbed = scrubSecrets(input);
    assert.equal(scrubbed.includes("MIIEowIBAAKCAQEA0m5c9GkYRt6C"), false);
    assert.equal(scrubbed.includes("BEGIN RSA PRIVATE KEY"), false);
    assert.ok(scrubbed.includes("before the key"));
    assert.ok(scrubbed.includes("after the key"));
    assert.ok(scrubbed.includes(REDACTED));
  });

  test("an unterminated PEM block redacts through to the end (fail closed)", () => {
    const input = "ok line\n-----BEGIN PRIVATE KEY-----\nkeymaterialAAAA\nkeymaterialBBBB";
    const scrubbed = scrubSecrets(input);
    assert.equal(scrubbed.includes("keymaterialAAAA"), false);
    assert.equal(scrubbed.includes("keymaterialBBBB"), false);
    assert.ok(scrubbed.startsWith("ok line"));
  });

  test("multiple secrets across multiple lines are all redacted", () => {
    const input = "line1 sk-ant-firstsecret111111\nline2 ghp_secondsecret2222222222\nline3 clean";
    const scrubbed = scrubSecrets(input);
    assert.equal(scrubbed.includes("sk-ant-firstsecret111111"), false);
    assert.equal(scrubbed.includes("ghp_secondsecret2222222222"), false);
    assert.ok(scrubbed.includes("line3 clean"));
  });
});

describe("scrubSecrets: extra literal secrets (pairing token)", () => {
  test("a supplied literal is redacted wherever it appears", () => {
    const token = "orbitory-test-token";
    const scrubbed = scrubSecrets(`connecting with ${token} now; token=${token}`, [token]);
    assert.equal(scrubbed.includes(token), false);
    assert.ok(scrubbed.includes(REDACTED));
  });

  test("literals shorter than 4 chars are ignored (would shred unrelated text)", () => {
    assert.equal(scrubSecrets("abcabc", ["ab"]), "abcabc");
  });

  test("literals containing regex metacharacters are matched literally", () => {
    const weird = "sec.ret+tok(en)";
    assert.equal(scrubSecrets(`x ${weird} y`, [weird]).includes(weird), false);
  });
});

describe("StreamScrubber: line-by-line streamed output", () => {
  test("a PEM block split across separately-delivered lines is fully redacted", () => {
    const scrubber = new StreamScrubber();
    const lines = [
      "normal line before",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAfake1",
      "b3BlbnNzaC1rZXktdjEAAAAfake2",
      "-----END OPENSSH PRIVATE KEY-----",
      "normal line after",
    ];
    const out = lines.map((l) => scrubber.scrubLine(l));
    assert.equal(out[0], "normal line before");
    assert.equal(out[1], REDACTED);
    assert.equal(out[2], REDACTED);
    assert.equal(out[3], REDACTED);
    assert.equal(out[4], REDACTED);
    assert.equal(out[5], "normal line after");
  });

  test("an unterminated streamed PEM block keeps redacting (fail closed)", () => {
    const scrubber = new StreamScrubber();
    scrubber.scrubLine("-----BEGIN EC PRIVATE KEY-----");
    assert.equal(scrubber.scrubLine("keymaterial1"), REDACTED);
    assert.equal(scrubber.scrubLine("keymaterial2"), REDACTED);
    assert.equal(scrubber.scrubLine("still not an END marker"), REDACTED);
  });

  test("PEM state on one scrubber instance does not affect another (per-stream isolation)", () => {
    const stdout = new StreamScrubber();
    const stderr = new StreamScrubber();
    stdout.scrubLine("-----BEGIN PRIVATE KEY-----");
    assert.equal(stderr.scrubLine("this stderr line is unrelated"), "this stderr line is unrelated");
    assert.equal(stdout.scrubLine("keymaterial"), REDACTED);
  });

  test("ordinary pattern rules still apply outside PEM blocks", () => {
    const scrubber = new StreamScrubber(["orbitory-test-token"]);
    const out = scrubber.scrubLine("SECRET_TOKEN=abc123 and orbitory-test-token here");
    assert.equal(out.includes("abc123"), false);
    assert.equal(out.includes("orbitory-test-token"), false);
  });
});
