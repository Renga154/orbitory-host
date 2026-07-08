/**
 * Centralized output secret scrubbing for the Orbitory host-agent.
 *
 * Everything a spawned terminal-agent process writes to stdout/stderr is
 * untrusted from a secrets-hygiene perspective: a build log can echo an API
 * key, a stack trace can embed a connection string, a misconfigured tool can
 * dump its environment. This module is the single place where that output is
 * scrubbed BEFORE it crosses the trust boundary to the iOS client — i.e.
 * before it becomes a `terminal.output` line, a marker-derived
 * `activity.summary.updated` / `agent.status.changed` summary, a stored
 * `session.logs` entry (served via `session.snapshot` and `GET /sessions`),
 * or a `session.failed` reason built from a process error message.
 *
 * `TerminalAgentProvider` (src/providers/AgentProvider.ts) is the intended
 * consumer: it scrubs every raw output line *first*, before marker parsing,
 * truncation, storage, or emission — so no downstream path can see the
 * unscrubbed text. `MockAgentProvider` output is hardcoded, reviewed copy
 * and does not pass through this module.
 *
 * ## What is matched (pattern-based, best effort)
 *
 * - Anthropic API keys (`sk-ant-…`)
 * - OpenAI-style API keys (`sk-…`, incl. `sk-proj-…`)
 * - GitHub tokens (`ghp_/gho_/ghu_/ghs_/ghr_…`, `github_pat_…`)
 * - AWS access key ids (`AKIA…`)
 * - Slack tokens (`xox[abprs]-…`)
 * - JWTs (`eyJ….….…`)
 * - `Authorization:` header values, and `Bearer <token>` anywhere
 * - `KEY=value` / `key: value` / JSON `"key": value` assignments whose *name*
 *   contains a secretish keyword *anywhere* — including at the very start
 *   (`TOKEN=…`, `PASSWORD=…`) or as the entire name (`secret=…`) — from the
 *   set: secret, token, password/passwd, credential(s), api key,
 *   access/private/auth key. The name (and separator) are kept, the value is
 *   redacted, whether the value is quoted or bare.
 * - PEM private key blocks (`-----BEGIN … PRIVATE KEY-----` bodies),
 *   including blocks split across streamed lines (see `StreamScrubber`) and
 *   blocks whose END marker never arrives (fail closed: everything after the
 *   BEGIN stays redacted)
 * - Caller-supplied literal secrets (e.g. the host-agent's own
 *   `ORBITORY_PAIRING_TOKEN` value), matched exactly
 *
 * ## Honest limitations — do NOT oversell this
 *
 * Pattern-based scrubbing can only catch secrets that *look like* secrets.
 * It cannot catch: an arbitrary high-entropy string with no recognizable
 * prefix, a password printed bare with no `name=` context, secrets split
 * across two output chunks mid-token, base64/hex-encoded or otherwise
 * transformed secrets, or provider formats not in the list above. It also
 * deliberately over-redacts in places (e.g. `TOKENS_PER_SECOND=5` matches
 * the `token` keyword rule) because a false redaction is annoying while a
 * false pass is a leak. This layer reduces accidental exposure; it is not a
 * guarantee, and `docs/security.md` §4 documents it as such. Do not
 * configure a command whose routine output is sensitive and rely on this
 * alone.
 */

/** Replacement text for anything the scrubber matches. */
export const REDACTED = "[REDACTED_SECRET]";

const PEM_BEGIN = /-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----/;
const PEM_END = /-----END[A-Z0-9 ]*PRIVATE KEY-----/;

/**
 * Ordered pattern rules. Order matters only where matches could overlap
 * (e.g. `Authorization: Bearer xyz` — the header rule runs first and
 * swallows the whole value); every rule uses the same replacement, so
 * overlap is cosmetic, not a correctness issue.
 */
const PATTERN_RULES: ReadonlyArray<{ name: string; apply: (text: string) => string }> = [
  {
    // Whole PEM private-key blocks within a single string. `(?:END…|$)`
    // fails closed: a BEGIN with no END redacts through to the end of the
    // text rather than leaving the key body visible.
    name: "pem-private-key-block",
    apply: (text) =>
      text.replace(
        /-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END[A-Z0-9 ]*PRIVATE KEY-----|$)/g,
        REDACTED,
      ),
  },
  {
    name: "authorization-header",
    apply: (text) => text.replace(/\b(authorization)(\s*:\s*)[^\n]+/gi, `$1$2${REDACTED}`),
  },
  {
    name: "bearer-token",
    apply: (text) => text.replace(/\b(bearer)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1$2${REDACTED}`),
  },
  {
    // Anthropic keys start with sk-ant-; listed before the generic sk- rule
    // for clarity, though both produce the same replacement.
    name: "anthropic-api-key",
    apply: (text) => text.replace(/\bsk-ant-[A-Za-z0-9_-]{8,}/g, REDACTED),
  },
  {
    name: "openai-style-api-key",
    apply: (text) => text.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED),
  },
  {
    name: "github-token",
    apply: (text) =>
      text
        .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, REDACTED)
        .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, REDACTED),
  },
  {
    name: "aws-access-key-id",
    apply: (text) => text.replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED),
  },
  {
    name: "slack-token",
    apply: (text) => text.replace(/\bxox[abprs]-[A-Za-z0-9-]{8,}\b/g, REDACTED),
  },
  {
    name: "jwt",
    apply: (text) =>
      text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, REDACTED),
  },
  {
    // `NAME=value` / `name: value` (and JSON-style `"name": value`) where the
    // NAME contains a secretish keyword ANYWHERE — including at the very start
    // (`TOKEN=…`, `PASSWORD=…`, `SECRET=…`), which an earlier version of this
    // rule missed by requiring a character before the keyword. The keyword
    // prefix/suffix are both optional, so a name that IS exactly a keyword
    // matches. An optional closing quote after the name is tolerated so a
    // JSON key like `"api_key": "…"` is caught, not just shell-style
    // `API_KEY=…`. Keeps the name + separator, redacts the value (quoted or
    // bare). Deliberately broad — over-redaction (e.g. `TOKENS_PER_SECOND=5`)
    // is accepted, per the module doc.
    name: "secretish-assignment",
    apply: (text) =>
      text.replace(
        /\b([A-Za-z0-9_-]*(?:secret|token|passwd|password|credentials?|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth[_-]?key)[A-Za-z0-9_-]*)(["']?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s'"]+)/gi,
        `$1$2${REDACTED}`,
      ),
  },
];

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scrubs secrets from a (possibly multi-line) string. Pure and stateless —
 * suitable for one-shot text like process error messages, and directly
 * unit-testable. For line-by-line streamed output where a PEM block can
 * span many separate lines, use `StreamScrubber` instead, which carries the
 * necessary state across calls.
 *
 * `extraLiteralSecrets` are exact strings to always redact wherever they
 * appear (e.g. the host-agent's own pairing token). Literals shorter than 4
 * characters are ignored — matching those would shred unrelated text.
 */
export function scrubSecrets(text: string, extraLiteralSecrets: readonly string[] = []): string {
  let result = text;
  for (const rule of PATTERN_RULES) {
    result = rule.apply(result);
  }
  for (const literal of extraLiteralSecrets) {
    if (literal.length >= 4) {
      result = result.replace(new RegExp(escapeRegExp(literal), "g"), REDACTED);
    }
  }
  return result;
}

/**
 * Stateful, line-oriented scrubber for streamed process output. One instance
 * per independent stream (stdout and stderr each get their own, since a PEM
 * block printed to one stream must not affect the other): tracks whether the
 * stream is currently inside a `-----BEGIN … PRIVATE KEY-----` block so the
 * key body is redacted even though each line arrives separately. If the
 * closing END line never arrives, every subsequent line stays redacted —
 * fail closed, by design.
 */
export class StreamScrubber {
  private inPrivateKeyBlock = false;

  constructor(private readonly extraLiteralSecrets: readonly string[] = []) {}

  scrubLine(line: string): string {
    if (this.inPrivateKeyBlock) {
      if (PEM_END.test(line)) {
        this.inPrivateKeyBlock = false;
      }
      return REDACTED;
    }

    if (PEM_BEGIN.test(line)) {
      // A block that both opens and closes on this one line is handled by
      // the pure scrubber's block rule; otherwise remember we're inside one.
      if (!PEM_END.test(line)) {
        this.inPrivateKeyBlock = true;
      }
      return REDACTED;
    }

    return scrubSecrets(line, this.extraLiteralSecrets);
  }
}
