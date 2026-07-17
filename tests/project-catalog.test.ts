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
const previousClaudeConfigDir = process.env["CLAUDE_CONFIG_DIR"];

afterEach(() => {
  if (previousConfigPath === undefined) delete process.env["ORBITORY_AGENT_CONFIG_PATH"];
  else process.env["ORBITORY_AGENT_CONFIG_PATH"] = previousConfigPath;
  if (previousCodexHome === undefined) delete process.env["CODEX_HOME"];
  else process.env["CODEX_HOME"] = previousCodexHome;
  if (previousClaudeConfigDir === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
  else process.env["CLAUDE_CONFIG_DIR"] = previousClaudeConfigDir;
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
      projectCatalog: { codexHistory: { enabled: false } },
    }),
  );
  assert.equal(
    catalog.resolveLaunch(resume.projectId, resume.providerId, resume.id),
    undefined,
    "disabling history discovery must invalidate cached resume ids immediately",
  );
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

test("explicit Claude history discovery exposes only sanitized opaque resume metadata", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbitory-claude-history-"));
  const configuredProject = path.join(root, "configured-project");
  const claudeProject = path.join(root, "claude-project");
  fs.mkdirSync(configuredProject);
  fs.mkdirSync(claudeProject);
  prepareFakeCodexHome(root, { cwd: configuredProject });

  const claudeConfig = path.join(root, "claude-home");
  const projectHistory = path.join(claudeConfig, "projects", "-private-claude-project");
  fs.mkdirSync(projectHistory, { recursive: true });
  const privateSessionId = "11111111-2222-4333-8444-555555555555";
  fs.writeFileSync(
    path.join(projectHistory, `${privateSessionId}.jsonl`),
    [
      JSON.stringify({
        type: "user",
        sessionId: privateSessionId,
        cwd: claudeProject,
        slug: "polish-checkout-recovery",
        timestamp: "2026-07-14T01:02:03.000Z",
        message: { content: "conversation-secret-must-not-leave-host" },
      }),
      JSON.stringify({
        type: "assistant",
        sessionId: privateSessionId,
        cwd: claudeProject,
        slug: "polish-checkout-recovery",
        timestamp: "2026-07-14T01:03:04.000Z",
        message: { content: "assistant-secret-must-not-leave-host" },
      }),
    ].join("\n"),
  );
  const nestedDir = path.join(projectHistory, privateSessionId, "subagents");
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(
    path.join(nestedDir, "agent-private.jsonl"),
    JSON.stringify({ sessionId: "nested-secret-id", cwd: claudeProject, slug: "must-not-appear" }),
  );
  process.env["CLAUDE_CONFIG_DIR"] = claudeConfig;

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
  const claudeResume = snapshot.resumableSessions.find(
    (session) => session.agentType === "claudeCode",
  );

  assert.ok(claudeResume);
  assert.equal(claudeResume.title, "Polish checkout recovery");
  assert.equal(claudeResume.providerId, "claude-template");
  const resolved = catalog.resolveLaunch(
    claudeResume.projectId,
    claudeResume.providerId,
    claudeResume.id,
  );
  assert.equal(resolved?.claudeSessionId, privateSessionId);
  assert.equal(
    catalog.resolveLaunch(claudeResume.projectId, "codex-template", claudeResume.id),
    undefined,
  );

  const wire = JSON.stringify(snapshot);
  for (const forbidden of [
    root,
    claudeProject,
    privateSessionId,
    "conversation-secret-must-not-leave-host",
    "assistant-secret-must-not-leave-host",
    "nested-secret-id",
    "must-not-appear",
  ]) {
    assert.equal(wire.includes(forbidden), false, `wire snapshot leaked ${forbidden}`);
  }
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

test("opt-in project creation stays inside the host root and survives request retries", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbitory-project-create-"));
  const configuredProject = path.join(root, "configured-project");
  const creationRoot = path.join(root, "created-projects");
  fs.mkdirSync(configuredProject);
  fs.mkdirSync(creationRoot);
  const configPath = path.join(root, "orbitory.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: [
        {
          id: "codex-template",
          displayName: "Codex",
          agentType: "codex",
          command: process.execPath,
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
        creation: {
          enabled: true,
          rootDirectory: creationRoot,
          providerIds: ["codex-template", "claude-template"],
          maxProjects: 1,
        },
      },
    }),
  );
  process.env["ORBITORY_AGENT_CONFIG_PATH"] = configPath;

  try {
    const { ProjectCatalog } = await import("../src/projectCatalog.js");
    const catalog = new ProjectCatalog();
    const initial = await catalog.snapshot(true);
    assert.deepEqual(initial.creation, {
      providerIds: ["codex-template", "claude-template"],
      maxNameLength: 64,
    });

    const created = await catalog.createProject(
      "create_request_1",
      "青森りんごLP",
      "claude-template",
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const directory = path.join(creationRoot, "青森りんごLP");
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(
      fs.statSync(path.join(directory, ".orbitory-project.json")).mode & 0o777,
      0o600,
    );
    assert.equal(created.project.displayName, "青森りんごLP");
    assert.equal(created.project.defaultProviderId, "claude-template");
    assert.ok(created.project.warnings.includes("created_by_orbitory"));
    assert.deepEqual(created.project.providerIds.sort(), ["claude-template", "codex-template"]);

    const resolved = catalog.resolveLaunch(created.project.id, "codex-template");
    assert.equal(resolved?.config.workingDirectory, fs.realpathSync(directory));

    // Retry remains idempotent even after a host process restart because the
    // request id lives only in the host-side ownership marker.
    const restartedCatalog = new ProjectCatalog();
    const retried = await restartedCatalog.createProject(
      "create_request_1",
      "青森りんごLP",
      "claude-template",
    );
    assert.equal(retried.ok, true);
    assert.equal(fs.readdirSync(creationRoot).filter((name) => !name.startsWith(".")).length, 1);

    const conflict = await restartedCatalog.createProject(
      "create_request_1",
      "別プロジェクト",
      "claude-template",
    );
    assert.deepEqual(conflict.ok ? null : conflict.code, "request_id_conflict");

    const duplicate = await restartedCatalog.createProject(
      "create_request_2",
      "青森りんごLP",
      "claude-template",
    );
    assert.deepEqual(duplicate.ok ? null : duplicate.code, "project_already_exists");

    const limited = await restartedCatalog.createProject(
      "create_request_3",
      "二つ目",
      "codex-template",
    );
    assert.deepEqual(limited.ok ? null : limited.code, "project_limit_reached");

    const wire = JSON.stringify(created.snapshot);
    for (const forbidden of [root, creationRoot, directory, '"workingDirectory"', '"requestId"']) {
      assert.equal(wire.includes(forbidden), false, `project snapshot leaked ${forbidden}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("project creation rejects traversal, unsupported providers, and pre-existing links", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbitory-project-create-reject-"));
  const configuredProject = path.join(root, "configured-project");
  const creationRoot = path.join(root, "created-projects");
  const outside = path.join(root, "outside");
  fs.mkdirSync(configuredProject);
  fs.mkdirSync(creationRoot);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(creationRoot, "linked-project"));
  const configPath = path.join(root, "orbitory.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: [
        {
          id: "codex-template",
          displayName: "Codex",
          agentType: "codex",
          command: process.execPath,
          args: [],
          workingDirectory: configuredProject,
          enabled: true,
          io: "codex-jsonl",
        },
      ],
      projectCatalog: {
        creation: {
          enabled: true,
          rootDirectory: creationRoot,
          providerIds: ["codex-template"],
        },
      },
    }),
  );
  process.env["ORBITORY_AGENT_CONFIG_PATH"] = configPath;

  try {
    const { ProjectCatalog } = await import("../src/projectCatalog.js");
    const catalog = new ProjectCatalog();
    for (const [index, name] of ["../escape", "nested/name", ".hidden", "CON", "bad\u0000name"].entries()) {
      const result = await catalog.createProject(`bad_${index}`, name, "codex-template");
      assert.deepEqual(result.ok ? null : result.code, "invalid_project_name");
    }
    const wrongProvider = await catalog.createProject("bad_provider", "valid-name", "unknown");
    assert.deepEqual(
      wrongProvider.ok ? null : wrongProvider.code,
      "project_provider_unavailable",
    );
    const linked = await catalog.createProject(
      "linked_request",
      "linked-project",
      "codex-template",
    );
    assert.deepEqual(linked.ok ? null : linked.code, "project_already_exists");
    assert.equal(fs.existsSync(path.join(outside, ".orbitory-project.json")), false);
    assert.equal(fs.existsSync(path.join(root, "escape")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
