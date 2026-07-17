/** Bounded, metadata-only discovery of local Claude Code conversations. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { scrubSecrets } from "./scrubbing.js";

const SESSION_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/iu;
const SEGMENT_BYTES = 128 * 1024;
const MAX_CANDIDATE_MULTIPLIER = 4;
const MAX_TITLE_CHARS = 120;
const REDACTED_PATH = "[REDACTED_PATH]";

export interface ClaudeHistoryRecord {
  id: string;
  cwd: string;
  title: string;
  updatedAt: string;
}

interface Candidate {
  filePath: string;
  sessionId: string;
  size: number;
  mtimeMs: number;
}

function resolveClaudeConfigDirectory(): string | undefined {
  const configured = process.env["CLAUDE_CONFIG_DIR"]?.trim();
  const candidate = configured && path.isAbsolute(configured)
    ? configured
    : path.join(os.homedir(), ".claude");
  try {
    const resolved = fs.realpathSync(candidate);
    return fs.statSync(resolved).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function directSessionCandidates(maxSessions: number): Candidate[] {
  const configDirectory = resolveClaudeConfigDirectory();
  if (!configDirectory) return [];
  const projectsDirectory = path.join(configDirectory, "projects");

  let projectEntries: fs.Dirent[];
  try {
    projectEntries = fs.readdirSync(projectsDirectory, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates: Candidate[] = [];
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;
    const projectDirectory = path.join(projectsDirectory, projectEntry.name);
    let sessionEntries: fs.Dirent[];
    try {
      sessionEntries = fs.readdirSync(projectDirectory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isFile() || !SESSION_FILE_PATTERN.test(sessionEntry.name)) continue;
      const filePath = path.join(projectDirectory, sessionEntry.name);
      try {
        const stat = fs.statSync(filePath);
        candidates.push({
          filePath,
          sessionId: sessionEntry.name.slice(0, -".jsonl".length),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      } catch {
        // A session may disappear while Claude rotates history; skip it.
      }
    }
  }

  return candidates
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Math.max(maxSessions, maxSessions * MAX_CANDIDATE_MULTIPLIER));
}

function readAt(fd: number, start: number, length: number): string {
  if (length <= 0) return "";
  const buffer = Buffer.allocUnsafe(length);
  const bytesRead = fs.readSync(fd, buffer, 0, length, start);
  return buffer.subarray(0, bytesRead).toString("utf8");
}

/** Read complete lines from bounded head/tail segments, never the whole large transcript. */
function readMetadataLines(candidate: Candidate): string[] {
  let fd: number | undefined;
  try {
    fd = fs.openSync(candidate.filePath, "r");
    const headLength = Math.min(candidate.size, SEGMENT_BYTES);
    const headText = readAt(fd, 0, headLength);
    const headLines = headText.split("\n");
    if (headLength < candidate.size) headLines.pop();

    if (candidate.size <= SEGMENT_BYTES) return headLines;
    const tailStart = Math.max(headLength, candidate.size - SEGMENT_BYTES);
    if (tailStart >= candidate.size) return headLines;
    const tailLines = readAt(fd, tailStart, candidate.size - tailStart).split("\n");
    if (tailStart > 0) tailLines.shift();
    return [...headLines, ...tailLines];
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best-effort close after a racing history rotation.
      }
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function compactTitle(value: string): string {
  const compact = value.replaceAll(/\s+/gu, " ").trim();
  return compact.length <= MAX_TITLE_CHARS
    ? compact
    : `${compact.slice(0, MAX_TITLE_CHARS - 1)}…`;
}

function redactPaths(value: string, cwd: string): string {
  return value
    .replaceAll(cwd, REDACTED_PATH)
    .replace(/(^|[\s("'`=])\/(?:[^/\s"'`<>:]+\/)*[^/\s"'`<>:,;)}\]]+/gmu, `$1${REDACTED_PATH}`)
    .replace(/\b[A-Za-z]:\\(?:[^\\\s"'`<>:]+\\)*[^\\\s"'`<>:,;)}\]]+/gu, REDACTED_PATH);
}

function fallbackTitle(updatedAt: string): string {
  const normalized = updatedAt.replace("T", " ").replace(/:\d{2}\.\d{3}Z$/u, " UTC");
  return `Claude Code · ${normalized}`;
}

function appendTitleSuffix(title: string, suffix: string): string {
  const maxBaseLength = Math.max(1, MAX_TITLE_CHARS - suffix.length);
  const base = title.length <= maxBaseLength
    ? title
    : `${title.slice(0, Math.max(1, maxBaseLength - 1))}…`;
  return `${base}${suffix}`;
}

function distinctTitles(sessions: ClaudeHistoryRecord[]): ClaudeHistoryRecord[] {
  const titleCounts = new Map<string, number>();
  for (const session of sessions) {
    titleCounts.set(session.title, (titleCounts.get(session.title) ?? 0) + 1);
  }

  const withTimes = sessions.map((session) => {
    if ((titleCounts.get(session.title) ?? 0) < 2) return session;
    const time = session.updatedAt
      .replace("T", " ")
      .replace(/\.\d{3}Z$/u, " UTC");
    return { ...session, title: appendTitleSuffix(session.title, ` · ${time}`) };
  });

  const timedCounts = new Map<string, number>();
  for (const session of withTimes) {
    timedCounts.set(session.title, (timedCounts.get(session.title) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return withTimes.map((session) => {
    if ((timedCounts.get(session.title) ?? 0) < 2) return session;
    const ordinal = (seen.get(session.title) ?? 0) + 1;
    seen.set(session.title, ordinal);
    return { ...session, title: appendTitleSuffix(session.title, ` #${ordinal}`) };
  });
}

function displayTitle(
  customTitle: string | undefined,
  slug: string | undefined,
  cwd: string,
  updatedAt: string,
): string {
  let source = customTitle?.trim();
  if (!source && slug?.trim()) {
    const humanized = slug.trim().replaceAll(/[-_]+/gu, " ");
    source = humanized.length > 0
      ? `${humanized[0]!.toLocaleUpperCase()}${humanized.slice(1)}`
      : undefined;
  }
  if (!source) return fallbackTitle(updatedAt);
  const safe = compactTitle(redactPaths(scrubSecrets(source), cwd));
  return safe || fallbackTitle(updatedAt);
}

function parseCandidate(candidate: Candidate): ClaudeHistoryRecord | undefined {
  let cwd: string | undefined;
  let customTitle: string | undefined;
  let slug: string | undefined;
  let latestTimestampMs = Number.NEGATIVE_INFINITY;
  let sawMatchingSession = false;

  for (const line of readMetadataLines(candidate)) {
    if (!line.trim()) continue;
    let record: Record<string, unknown> | undefined;
    try {
      record = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (!record || record["sessionId"] !== candidate.sessionId) continue;
    sawMatchingSession = true;
    if (typeof record["cwd"] === "string" && path.isAbsolute(record["cwd"])) {
      cwd = record["cwd"];
    }
    if (typeof record["customTitle"] === "string" && record["customTitle"].trim()) {
      customTitle = record["customTitle"];
    }
    if (typeof record["slug"] === "string" && record["slug"].trim()) {
      slug = record["slug"];
    }
    if (typeof record["timestamp"] === "string") {
      const parsed = Date.parse(record["timestamp"]);
      if (Number.isFinite(parsed)) latestTimestampMs = Math.max(latestTimestampMs, parsed);
    }
  }

  if (!sawMatchingSession || !cwd) return undefined;
  const updatedAt = new Date(
    Number.isFinite(latestTimestampMs) ? latestTimestampMs : candidate.mtimeMs,
  ).toISOString();
  return {
    id: candidate.sessionId,
    cwd,
    title: displayTitle(customTitle, slug, cwd, updatedAt),
    updatedAt,
  };
}

export function queryClaudeSessions(maxSessions: number): ClaudeHistoryRecord[] {
  const sessions: ClaudeHistoryRecord[] = [];
  for (const candidate of directSessionCandidates(maxSessions)) {
    const parsed = parseCandidate(candidate);
    if (!parsed) continue;
    sessions.push(parsed);
    if (sessions.length >= maxSessions) break;
  }
  return distinctTitles(sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
}
