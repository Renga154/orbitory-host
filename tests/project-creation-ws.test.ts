import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { connect, type TestWsClient } from "./helpers/wsClient.js";
import type { ProjectCatalogSnapshotSource } from "../src/ws.js";
import type { ProjectDescriptor, ProjectsSnapshotPayload } from "../src/types.js";

const PAIRING_TOKEN = process.env["ORBITORY_PAIRING_TOKEN"];
assert.ok(PAIRING_TOKEN, "ORBITORY_PAIRING_TOKEN must be set for tests to run.");

const initialSnapshot: ProjectsSnapshotPayload = {
  projects: [],
  resumableSessions: [],
  creation: { providerIds: ["claude-template"], maxNameLength: 64 },
};

let server: TestServer;
let client: TestWsClient;
let createCalls: Array<{ requestId: string; name: string; providerId: string }> = [];
let projectMutationCount = 0;
const createdProjectsByRequestId = new Map<
  string,
  {
    requestId: string;
    name: string;
    providerId: string;
    project: ProjectDescriptor;
  }
>();
const createdProjectIdsByName = new Map<string, string>();

function makeProject(requestId: string, name: string, providerId: string): ProjectDescriptor {
  return {
    id: `project_${requestId}`,
    hostId: "host_test",
    displayName: name,
    providerIds: [providerId],
    defaultProviderId: providerId,
    startable: true,
    riskLevel: "high",
    warnings: ["created_by_orbitory"],
    resumableSessionCount: 0,
  };
}

function currentSnapshot(): ProjectsSnapshotPayload {
  return {
    ...initialSnapshot,
    projects: [...createdProjectsByRequestId.values()].map((entry) => entry.project),
  };
}

function projectCreateEnvelope(requestId: string, name: string, providerId = "claude-template") {
  return {
    type: "project.create",
    version: 1,
    timestamp: new Date().toISOString(),
    sessionId: null,
    payload: {
      requestId,
      name,
      providerId,
    },
  };
}

function countReceived(client: TestWsClient, type: string, requestId?: string): number {
  return client.received.filter((event) => {
    if (event.type !== type) {
      return false;
    }
    if (requestId === undefined) {
      return true;
    }
    const payload = event.payload as { requestId?: string };
    return payload.requestId === requestId;
  }).length;
}

before(async () => {
  const catalog: ProjectCatalogSnapshotSource = {
    async snapshot() {
      return currentSnapshot();
    },
    async createProject(requestId, name, providerId) {
      createCalls.push({ requestId, name, providerId });

      const previous = createdProjectsByRequestId.get(requestId);
      if (previous) {
        if (previous.name !== name || previous.providerId !== providerId) {
          return {
            ok: false,
            code: "request_id_conflict",
            message: "This project request id was already used with different values.",
          };
        }
        return { ok: true, project: previous.project, snapshot: currentSnapshot() };
      }

      if (createdProjectIdsByName.has(name)) {
        return {
          ok: false,
          code: "project_already_exists",
          message: "A project or folder with that name already exists.",
        };
      }

      const project = makeProject(requestId, name, providerId);
      createdProjectsByRequestId.set(requestId, { requestId, name, providerId, project });
      createdProjectIdsByName.set(name, project.id);
      projectMutationCount += 1;
      return { ok: true, project, snapshot: currentSnapshot() };
    },
  };
  server = await startTestServer({ projectCatalog: catalog });
  client = connect(`${server.wsUrl}/ws?token=${encodeURIComponent(PAIRING_TOKEN!)}`);
  await client.waitForOpen();
  await client.waitFor((event) => event.type === "projects.snapshot", 3000);
});

after(async () => {
  client.close();
  await server.close();
});

test("project.create accepts only the opaque name/provider request and returns the sanitized project", async () => {
  client.send(projectCreateEnvelope("create_ws_001", "Aomori Apple LP"));

  const created = await client.waitFor(
    (event) =>
      event.type === "project.created" &&
      (event.payload as { requestId?: string }).requestId === "create_ws_001",
    3000,
  );
  assert.deepEqual(createCalls, [
    {
      requestId: "create_ws_001",
      name: "Aomori Apple LP",
      providerId: "claude-template",
    },
  ]);
  const createdProject = (created.payload as { project: ProjectDescriptor }).project;
  assert.deepEqual(
    createdProject,
    makeProject("create_ws_001", "Aomori Apple LP", "claude-template"),
  );

  const refreshed = await client.waitFor(
    (event) =>
      event.type === "projects.snapshot" &&
      (event.payload as ProjectsSnapshotPayload).projects.some(
        (project) => project.id === createdProject.id,
      ),
    3000,
  );
  const wire = JSON.stringify([created, refreshed]).toLowerCase();
  for (const forbidden of [
    "workingdirectory",
    '"path"',
    '"command"',
    '"args"',
    '"env"',
    '"token"',
  ]) {
    assert.equal(wire.includes(forbidden), false, `project creation wire leaked ${forbidden}`);
  }
});

test("project.create rejects path/config injection before calling the catalog", async () => {
  const callsBefore = createCalls.length;
  client.send({
    type: "project.create",
    version: 1,
    timestamp: new Date().toISOString(),
    sessionId: null,
    payload: {
      requestId: "create_ws_hostile",
      name: "hostile",
      providerId: "claude-template",
      workingDirectory: "/tmp/hostile",
      command: "rm",
    },
  });

  const error = await client.waitFor(
    (event) =>
      event.type === "error" &&
      (event.payload as { code?: string }).code === "invalid_payload",
    3000,
  );
  assert.equal((error.payload as { recoverable?: boolean }).recoverable, false);
  assert.equal(createCalls.length, callsBefore);
});

test("project.create replays the original result for the same requestId without duplicating the mutation", async () => {
  const observer = connect(`${server.wsUrl}/ws?token=${encodeURIComponent(PAIRING_TOKEN!)}`);
  await observer.waitForOpen();
  await observer.waitFor((event) => event.type === "projects.snapshot", 3000);

  try {
    const requestId = "create_ws_replay_001";
    const name = "Replay Orbitory Project";

    client.send(projectCreateEnvelope(requestId, name));
    const firstCreated = await client.waitFor(
      (event) =>
        event.type === "project.created" &&
        (event.payload as { requestId?: string }).requestId === requestId,
      3000,
    );
    const firstProject = (firstCreated.payload as { project: ProjectDescriptor }).project;
    const firstSnapshot = await client.waitFor(
      (event) =>
        event.type === "projects.snapshot" &&
        (event.payload as ProjectsSnapshotPayload).projects.some(
          (project) => project.id === firstProject.id,
        ),
      3000,
    );
    const mutationsBeforeReplay = projectMutationCount;

    observer.send(projectCreateEnvelope(requestId, name));
    const replayed = await observer.waitFor(
      (event) =>
        event.type === "project.created" &&
        (event.payload as { requestId?: string }).requestId === requestId,
      3000,
    );
    const replayedProject = (replayed.payload as { project: ProjectDescriptor }).project;
    const replayedSnapshot = await observer.waitFor(
      (event) =>
        event.type === "projects.snapshot" &&
        (event.payload as ProjectsSnapshotPayload).projects.some(
          (project) => project.id === replayedProject.id,
        ),
      3000,
    );
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(replayedProject.id, firstProject.id);
    assert.equal(replayedProject.displayName, firstProject.displayName);
    assert.equal(
      (firstSnapshot.payload as ProjectsSnapshotPayload).projects.filter(
        (project) => project.id === firstProject.id,
      ).length,
      1,
    );
    assert.equal(
      (replayedSnapshot.payload as ProjectsSnapshotPayload).projects.filter(
        (project) => project.id === replayedProject.id,
      ).length,
      1,
    );
    assert.equal(projectMutationCount, mutationsBeforeReplay);
    assert.equal(
      createCalls.filter((call) => call.requestId === requestId).length,
      2,
    );
    assert.equal(countReceived(client, "project.created", requestId), 1);
    assert.equal(countReceived(observer, "project.created", requestId), 1);
    assert.equal(countReceived(client, "error", requestId), 0);
    assert.equal(countReceived(observer, "error", requestId), 0);
  } finally {
    observer.close();
  }
});

test("project.create requestId conflicts stay on the requesting socket and echo the requestId", async () => {
  const observer = connect(`${server.wsUrl}/ws?token=${encodeURIComponent(PAIRING_TOKEN!)}`);
  await observer.waitForOpen();
  await observer.waitFor((event) => event.type === "projects.snapshot", 3000);

  try {
    const requestId = "create_ws_conflict_001";
    client.send(projectCreateEnvelope(requestId, "Conflict Base Project"));
    await client.waitFor(
      (event) =>
        event.type === "project.created" &&
        (event.payload as { requestId?: string }).requestId === requestId,
      3000,
    );
    await client.waitFor(
      (event) =>
        event.type === "projects.snapshot" &&
        (event.payload as ProjectsSnapshotPayload).projects.some(
          (project) => project.id === `project_${requestId}`,
        ),
      3000,
    );
    const mutationsBeforeConflict = projectMutationCount;

    observer.send(projectCreateEnvelope(requestId, "Conflict Changed Project"));
    const error = await observer.waitFor(
      (event) =>
        event.type === "error" &&
        (event.payload as { code?: string; requestId?: string }).code ===
          "request_id_conflict" &&
        (event.payload as { requestId?: string }).requestId === requestId,
      3000,
    );
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(error.payload["recoverable"], true);
    assert.equal(projectMutationCount, mutationsBeforeConflict);
    assert.equal(
      createCalls.filter((call) => call.requestId === requestId).length,
      2,
    );
    assert.equal(countReceived(client, "error", requestId), 0);
    assert.equal(countReceived(observer, "error", requestId), 1);
    assert.equal(countReceived(client, "project.created", requestId), 1);
    assert.equal(countReceived(observer, "project.created", requestId), 0);
  } finally {
    observer.close();
  }
});
