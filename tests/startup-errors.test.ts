import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { formatStartupError } from "../src/startupErrors.js";

describe("formatStartupError", () => {
  test("turns EADDRINUSE into actionable Orbitory guidance", () => {
    const message = formatStartupError(Object.assign(new Error("listen failed"), { code: "EADDRINUSE" }), 4000);

    assert.match(message, /Port 4000 is already in use/);
    assert.match(message, /tap Refresh in Orbitory/);
    assert.match(message, /PORT=4001/);
    assert.equal(message.includes("at Server.setupListenHandle"), false);
  });
});
