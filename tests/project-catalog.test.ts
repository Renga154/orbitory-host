import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fakeCodex = path.join(__dirname, "fixtures", "fake-codex-app-server.js");
const previousConfigPath = process.env["ORBITORY_AGENT_CONFIG_PATH"];
const previousCodexHome = process.env["CODEX_HOME"];

afterEach(() => {
  if (previousConfigPath === undefined) delete process.env["ORBITORY_AGENT_CONFIG_PATH"];
  else process.env["ORBITORY_AGENT_CONFIG_PATH"] = previousConfigPath;
  if (previousCodexHome === undefined) delete process.env["CODEX_HOME"];
  else process.env["CODEX_HOME"] = previousCodexHome;
});

function prepareFakeCodexHome(
  root: string,
  scenario: {
    cwd: string;
    secondCwd?: string;
    exitAfterList?: boolean;
    listDelayMs?: number;
  },
): string {
  const codexHome = path.join(root, "codex-home");
  const sessions = path.join(codexHome, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, "orbitory-test-scenario.json"), JSON.stringify(scenario));
  fs.writeFileSync(path.join(codexHome, "auth.json"), "must-not-be-copied");
  fs.writeFileSync(path.join(codexHome, "config.toml"), "must-not-be-copied");
  process.env["CODEX_HOME"] = codexHome;
  return codexHome;
}

test("project catalog exposes opaque ids while keeping paths and Codex ids host-only", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbitory-project-catalog-"));
  const first = path.join(root, "first-project");
  const second = path.join(root, "second-project");
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  const sourceCodexHome = prepareFakeCodexHome(root, {
    cwd: first,
    secondCwd: second,
    exitAfterList: true,
  });
  const configPath = path.join(root, "orbitory.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: [
        {
          id: "codex-template",
          displayName: "Codex",
          agentType: "codex",
          command: fakeCodex,
          args: [],
          workingDirectory: first,
          enabled: true,
          io: "codex-jsonl",
          sandbox: { mode: "none", required: false },
        },
      ],
      projectCatalog: {
        codexHistory: { enabled: true, providerId: "codex-template", maxSessions: 10 },
      },
    }),
  );
  process.env["ORBITORY_AGENT_CONFIG_PATH"] = configPath;

  const { ProjectCatalog } = await import("../src/projectCatalog.js");
  const catalog = new ProjectCatalog();
  const snapshot = await catalog.snapshot(true);

  assert.deepEqual(snapshot.projects.map((project) => project.displayName), ["first-project", "second-project"]);
  assert.equal(snapshot.resumableSessions.length, 2, "subagent history must be skipped");
  assert.ok(snapshot.projects.every((project) => project.id.startsWith("project_")));
  assert.ok(snapshot.resumableSessions.every((session) => session.id.startsWith("resume_")));
  assert.equal(
    fs.existsSync(path.join(sourceCodexHome, "catalog-write-probe")),
    false,
    "app-server writable state must not touch the real Codex home",
  );

  const wire = JSON.stringify(snapshot);
  for (const forbidden of [
    root,
    first,
    second,
    "thread-secret",
    "session-secret",
    "secret preview",
    '"cwd"',
    '"workingDirectory"',
    '"command"',
  ]) {
    assert.equal(wire.includes(forbidden), false, `wire snapshot leaked ${forbidden}`);
  }

  const resume = snapshot.resumableSessions[0]!;
  const resolved = catalog.resolveLaunch(resume.projectId, resume.providerId, resume.id);
  assert.ok(resolved);
  assert.ok(resolved.codexThreadId?.startsWith("thread-secret-"));
  assert.equal(catalog.resolveLaunch(resume.projectId, "wrong-provider", resume.id), undefined);
  assert.equal(catalog.resolveLaunch("stale-project", resume.providerId, resume.id), undefined);
});

test("Codex history discovery is disabled unless explicitly enabled", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbitory-project-opt-in-"));
  const project = path.join(root, "configured-project");
  fs.mkdirSync(project);
  prepareFakeCodexHome(root, { cwd: project });
  const configPath = path.join(root, "orbitory.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: [
        {
          id: "codex-template",
          displayName: "Codex",
          agentType: "codex",
          command: fakeCodex,
          args: [],
          workingDirectory: project,
          enabled: true,
          io: "codex-jsonl",
          sandbox: { mode: "none", required: false },
        },
      ],
    }),
  );
  process.env["ORBITORY_AGENT_CONFIG_PATH"] = configPath;

  const { ProjectCatalog } = await import("../src/projectCatalog.js");
  const snapshot = await new ProjectCatalog().snapshot(true);
  assert.equal(snapshot.projects.length, 1, "configured project remains available");
  assert.equal(snapshot.resumableSessions.length, 0, "history must require explicit opt-in");
  assert.equal(snapshot.projects[0]?.warnings.includes("codex_history_experimental"), false);
});

test("an explicitly allowlisted Claude provider can start in discovered project folders", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbitory-project-shared-provider-"));
  const configuredProject = path.join(root, "configured-project");
  const discoveredProject = path.join(root, "discovered-project");
  fs.mkdirSync(configuredProject);
  fs.mkdirSync(discoveredProject);
  prepareFakeCodexHome(root, { cwd: configuredProject, secondCwd: discoveredProject });
  const configPath = path.join(root, "orbitory.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: [
        {
          id: "codex-template",
          displayName: "Codex",
          agentType: "codex",
          command: fakeCodex,
          args: [],
          workingDirectory: configuredProject,
          enabled: true,
          io: "codex-jsonl",
          sandbox: { mode: "none", required: false },
        },
        {
          id: "claude-template",
          displayName: "Claude Code",
          agentType: "claudeCode",
          command: process.execPath,
          args: [],
          workingDirectory: configuredProject,
          enabled: true,
          io: "stream-json",
          sandbox: { mode: "none", required: false },
        },
      ],
      projectCatalog: {
        codexHistory: {
          enabled: true,
          providerId: "codex-template",
          additionalProviderIds: ["claude-template"],
          maxSessions: 10,
        },
      },
    }),
  );
  process.env["ORBITORY_AGENT_CONFIG_PATH"] = configPath;

  const { ProjectCatalog } = await import("../src/projectCatalog.js");
  const catalog = new ProjectCatalog();
  const snapshot = await catalog.snapshot(true);
  const discovered = snapshot.projects.find(
    (project) => project.displayName === "discovered-project",
  );

  assert.ok(discovered);
  assert.deepEqual(discovered.providerIds.sort(), ["claude-template", "codex-template"]);
  const claudeLaunch = catalog.resolveLaunch(discovered.id, "claude-template");
  assert.equal(claudeLaunch?.config.agentType, "claudeCode");
  assert.equal(claudeLaunch?.config.workingDirectory, fs.realpathSync(discoveredProject));
  assert.equal(claudeLaunch?.codexThreadId, undefined);
});

test("history indexing just beyond the old 8-second cutoff still exposes Claude projects", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbitory-project-slow-history-"));
  const configuredProject = path.join(root, "configured-project");
  const discoveredProject = path.join(root, "slow-discovered-project");
  fs.mkdirSync(configuredProject);
  fs.mkdirSync(discoveredProject);
  prepareFakeCodexHome(root, {
    cwd: configuredProject,
    secondCwd: discoveredProject,
    listDelayMs: 8_250,
  });
  const configPath = path.join(root, "orbitory.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: [
        {
          id: "codex-template",
          displayName: "Codex",
          agentType: "codex",
          command: fakeCodex,
          args: [],
          workingDirectory: configuredProject,
          enabled: true,
          io: "codex-jsonl",
          sandbox: { mode: "none", required: false },
        },
        {
          id: "claude-template",
          displayName: "Claude Code",
          agentType: "claudeCode",
          command: process.execPath,
          args: [],
          workingDirectory: configuredProject,
          enabled: true,
          io: "stream-json",
          sandbox: { mode: "none", required: false },
        },
      ],
      projectCatalog: {
        codexHistory: {
          enabled: true,
          providerId: "codex-template",
          additionalProviderIds: ["claude-template"],
          maxSessions: 10,
        },
      },
    }),
  );
  process.env["ORBITORY_AGENT_CONFIG_PATH"] = configPath;

  const { ProjectCatalog } = await import("../src/projectCatalog.js");
  const snapshot = await new ProjectCatalog().snapshot(true);
  const discovered = snapshot.projects.find(
    (project) => project.displayName === "slow-discovered-project",
  );

  assert.ok(discovered, "slow but valid Codex history must not disappear at eight seconds");
  assert.deepEqual(discovered.providerIds.sort(), ["claude-template", "codex-template"]);
});

test("Codex history discovery fails closed for a workspace-only container", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbitory-project-container-"));
  const project = path.join(root, "configured-project");
  fs.mkdirSync(project);
  prepareFakeCodexHome(root, { cwd: project });
  const configPath = path.join(root, "orbitory.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: [
        {
          id: "codex-template",
          displayName: "Codex",
          agentType: "codex",
          command: fakeCodex,
          args: [],
          workingDirectory: project,
          enabled: true,
          io: "codex-jsonl",
          sandbox: {
            mode: "container",
            required: true,
            image: "orbitory/codex:test",
          },
        },
      ],
      projectCatalog: {
        codexHistory: { enabled: true, providerId: "codex-template", maxSessions: 10 },
      },
    }),
  );
  process.env["ORBITORY_AGENT_CONFIG_PATH"] = configPath;

  const { ProjectCatalog } = await import("../src/projectCatalog.js");
  const snapshot = await new ProjectCatalog().snapshot(true);
  assert.equal(snapshot.projects.length, 1, "configured project remains available");
  assert.equal(snapshot.resumableSessions.length, 0, "host history must not bypass container isolation");
});
