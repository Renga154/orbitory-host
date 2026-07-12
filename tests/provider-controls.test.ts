import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  loadProviderControls,
  resolveProviderSelection,
} from "../src/providerControls.js";

const cachePath = join(tmpdir(), `orbitory-models-${randomBytes(6).toString("hex")}.json`);

afterEach(() => {
  if (existsSync(cachePath)) rmSync(cachePath);
});

describe("provider controls", () => {
  test("publishes only visible, safe Codex models from the host cache", () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        models: [
          { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
          { slug: "codex-hidden", display_name: "Hidden", visibility: "hide" },
          { slug: "../../bad", display_name: "/Users/private", visibility: "list" },
        ],
      }),
    );

    const controls = loadProviderControls("codex", { codexModelCachePath: cachePath });
    assert.deepEqual(
      controls.models.map((model) => model.id),
      ["default", "gpt-5.5"],
    );
    assert.deepEqual(
      controls.launchProfiles.map((profile) => profile.id),
      ["work", "plan", "review"],
    );
  });

  test("resolves only provider-advertised ids", () => {
    const controls = loadProviderControls("claudeCode");
    assert.deepEqual(resolveProviderSelection(controls, "plan", "sonnet"), {
      launchProfileId: "plan",
      intent: "plan",
      modelId: "sonnet",
      modelCliValue: "sonnet",
    });
    assert.equal(resolveProviderSelection(controls, "bypass", "sonnet"), undefined);
    assert.equal(resolveProviderSelection(controls, "work", "raw-model"), undefined);
  });
});
