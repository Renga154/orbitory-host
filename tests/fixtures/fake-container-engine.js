#!/usr/bin/env node
/**
 * Fake container engine — an argv-recording, behavior-simulating stand-in for
 * the docker/podman CLIENT, used by the automated container-sandbox tests so
 * the suite NEVER needs Docker/Podman installed, a running daemon, a network,
 * or an image pull. It is injected via the `ORBITORY_CONTAINER_ENGINE_PATH`
 * test hook (see package.json's "test" script and src/sandbox.ts).
 *
 * What it does:
 * 1. Verifies it was invoked as `<engine> run …` (anything else exits 64).
 * 2. Parses the argv the way the real engine would (flags → image → command),
 *    then prints, as plain stdout lines the tests can assert on end to end:
 *      FAKE_ENGINE_ARGV_JSON: [ ...the full argv... ]
 *      CONTAINER_ENV_KEYS: <sorted names from `-e KEY` flags>   (names only!)
 *      FAKE_ENGINE: run image=<image>
 * 3. Then simulates the CONTAINERIZED agent, driven by flags found in the
 *    command vector after the image (which Orbitory passed through verbatim
 *    from host config): plain stdout/stderr lines, stdin echo, optional fake
 *    secrets (to prove scrubbing), a delay, and an exit code.
 *
 * It never contacts a daemon, never runs a container, never touches real
 * files, never spawns anything, and never prints an environment VALUE.
 */

const argv = process.argv.slice(2);

if (argv[0] !== "run") {
  console.error(`fake-container-engine: unsupported command "${argv[0] ?? ""}" (only "run" is simulated).`);
  process.exit(64);
}

// Flags the real `docker run` argv we build can contain (see buildContainerArgv).
const VALUE_FLAGS = new Set([
  "--name",
  "--network",
  "--memory",
  "--cpus",
  "--pids-limit",
  "--workdir",
  "--tmpfs",
  "--user",
  "--security-opt",
  "--cap-drop",
  "-v",
  "-e",
]);
const BOOLEAN_FLAGS = new Set(["--rm", "-i", "--read-only"]);

const envKeys = [];
let i = 1;
while (i < argv.length) {
  const token = argv[i];
  if (BOOLEAN_FLAGS.has(token)) {
    i += 1;
    continue;
  }
  if (VALUE_FLAGS.has(token)) {
    if (token === "-e" && typeof argv[i + 1] === "string") {
      envKeys.push(argv[i + 1]);
    }
    i += 2;
    continue;
  }
  break; // first non-flag token = image
}
const image = argv[i] ?? "(missing image)";
const inner = argv.slice(i + 1);

console.log(`FAKE_ENGINE_ARGV_JSON: ${JSON.stringify(argv)}`);
console.log(`CONTAINER_ENV_KEYS: ${envKeys.slice().sort().join(",")}`);
console.log(`FAKE_ENGINE: run image=${image}`);

// --- Simulate the containerized agent, driven by the inner command vector ---

const exitCodeArg = inner.find((a) => a.startsWith("--exit-code="));
let exitCode = exitCodeArg ? Number(exitCodeArg.split("=")[1]) : 0;
if (inner.includes("--fail")) exitCode = 2;

const delayArg = inner.find((a) => a.startsWith("--delay-ms="));
const delayMs = delayArg ? Number(delayArg.split("=")[1]) : 120;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// stdin: Orbitory forwards initialPrompt / chat.message through the engine
// client's stdin (`run -i`). Echo an acknowledgment — text is only printed
// back, never evaluated.
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  const text = chunk.toString().trim();
  if (text.length > 0) {
    console.log(`Received prompt: "${text}" (container fake).`);
  }
});

async function main() {
  console.log("Container agent (fake) starting up.");
  await sleep(delayMs);
  console.error("warning: this is the FAKE container engine, not a real container.");
  console.log("Editing src/example.ts (container fake).");
  await sleep(delayMs);

  if (inner.includes("--print-secrets")) {
    // Every value fabricated; tests assert none reaches a client.
    console.log("Loaded config: ANTHROPIC_API_KEY=sk-ant-api03-fakecontainer1234");
    console.log("git remote: https://ghp_fakecontainerfake567890abcdefgh@github.com/x/y");
    console.log("bare assignment TOKEN=fake-container-bare-token-99");
    console.error("stderr note: OPENAI_KEY=sk-fakecontainerstderr555555");
    await sleep(delayMs);
  }

  if (exitCode === 0) {
    console.log("Done. Simulated container run complete; nothing real happened.");
  } else {
    console.error(`fatal: fake container agent failed on purpose (exit ${exitCode}).`);
  }

  // Explicit exit: the stdin listener keeps the event loop alive otherwise.
  process.exit(exitCode);
}

main();
