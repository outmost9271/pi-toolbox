import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Optional integration check against an actual Pi executable. No model requests or user config.
const piPath = process.argv[2] ?? process.env.PI_TOOLBOX_TEST_PI;
if (!piPath) throw new Error("Usage: node scripts/verify-rpc.mjs /path/to/pi");
const entryPath = fileURLToPath(new URL("../extensions/index.ts", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "pi-toolbox-rpc-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
const tools = join(root, "tools");
const browserSource = join(root, "packages", "browser");
const protectedSource = join(root, "packages", "pi-toolbox");
const notifications = [];
const pending = new Map();
let child;
let closed;
let stderr = "";
let sequence = 0;
let checks = 0;

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}
async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
function disabledEntry(source) {
  return { source, extensions: [], skills: [], prompts: [], themes: [] };
}
async function snapshotConfigs() {
  return Promise.all([
    join(agentDir, "toolbox.json"), join(cwd, ".pi", "toolbox.json"),
    join(agentDir, "settings.json"), join(cwd, ".pi", "settings.json"),
  ].map((path) => readFile(path, "utf8")));
}
function failPending(error) {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  pending.clear();
}
function request(command) {
  const id = `toolbox-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC timeout: ${command.type}\n${stderr}`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ ...command, id }) + "\n");
  });
}
async function invoke(args, expectedType = "info", expectedMessage) {
  const offset = notifications.length;
  const response = await request({ type: "prompt", message: `/toolbox${args ? " " + args : ""}` });
  assert.equal(response.success, true, response.error);
  assert.equal(response.data?.disposition, "handled", `Unexpected model execution for ${args}`);
  const result = notifications.slice(offset).at(-1);
  if (expectedType !== null) {
    assert.ok(result, `Missing notification for ${args}`);
    assert.equal(result.notifyType, expectedType, `${args}: ${result.message}`);
    if (expectedMessage) assert.match(result.message, expectedMessage);
  }
  checks += 1;
  return result;
}

try {
  for (const id of ["exa", "gh"]) {
    await mkdir(join(tools, id, "skill"), { recursive: true });
    await mkdir(join(tools, id, "bin"), { recursive: true });
    await writeJson(join(tools, id, "manifest.json"), { id, name: id, description: id, skillPaths: ["skill"], binPaths: ["bin"] });
  }
  for (const source of [browserSource, protectedSource]) {
    await mkdir(join(source, "extensions"), { recursive: true });
    await writeFile(join(source, "extensions", "index.js"), "export default function () {}\n");
    await writeJson(join(source, "package.json"), { pi: { extensions: ["extensions/index.js"] } });
  }
  await writeJson(join(agentDir, "toolbox.json"), { version: 1, enabled: ["exa"] });
  await writeJson(join(cwd, ".pi", "toolbox.json"), { version: 2, overrides: { exa: "disabled", gh: "enabled" } });
  await writeJson(join(agentDir, "settings.json"), { theme: "dark", packages: [disabledEntry(browserSource), protectedSource] });
  await writeJson(join(cwd, ".pi", "settings.json"), { fixtureMarker: true, packages: [{ source: browserSource, autoload: false, extensions: ["+extensions/index.js"] }] });

  child = spawn(piPath, [
    "--mode", "rpc", "--no-session", "--offline", "--approve", "--no-extensions", "-e", entryPath,
    "--model", "openai/gpt-4o-mini", "--thinking", "off",
  ], {
    cwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_TOOLBOX_ROOT: tools, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  closed = new Promise((resolve) => child.once("close", (code, signal) => {
    failPending(new Error(`Pi exited: ${code ?? signal}\n${stderr}`));
    resolve({ code, signal });
  }));
  child.on("error", (error) => failPending(error));
  child.stdin.on("error", (error) => failPending(error));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-20_000); });
  child.stdout.setEncoding("utf8");
  let buffer = "";
  child.stdout.on("data", (data) => {
    buffer += data;
    let separator;
    while ((separator = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, separator).replace(/\r$/, "");
      buffer = buffer.slice(separator + 1);
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); }
      catch { failPending(new Error(`Invalid RPC record: ${line}`)); continue; }
      if (record.type === "extension_ui_request" && record.method === "notify") notifications.push(record);
      if (record.type === "response" && pending.has(record.id)) {
        const waiter = pending.get(record.id);
        pending.delete(record.id);
        clearTimeout(waiter.timer);
        waiter.resolve(record);
      }
      if (record.type === "agent_start") {
        failPending(new Error("Unexpected model request during extension-only verification"));
        child.kill("SIGTERM");
      }
    }
  });

  const commands = await request({ type: "get_commands" });
  assert.equal(commands.success, true, commands.error);
  assert.ok(commands.data.commands.some((command) => command.name === "toolbox"));
  const before = await snapshotConfigs();
  await invoke("", "info", /\/toolbox skills/);
  for (const args of ["skills", "skills project", "skills status"]) await invoke(args, "info", /○ exa/);
  for (const args of ["skills global", "skills global status"]) await invoke(args, "info", /● exa/);
  for (const args of ["extensions", "extensions project", "extensions status browser"]) await invoke(args, "info", /● browser/);
  for (const args of ["extensions global", "extensions global status browser"]) await invoke(args, "info", /○ browser/);
  for (const args of ["enable exa", "global enable gh", "plugin disable browser", "plugins", "skills list", "extensions list", "skills global inherit exa", "extensions global inherit browser", "extensions config", "skills config", "skills global config"]) await invoke(args, "error");
  assert.deepEqual(await snapshotConfigs(), before);

  // Skills writes reload silently; verify persisted state rather than requiring a notification.
  await invoke("skills enable exa", null);
  assert.deepEqual(await readJson(join(cwd, ".pi", "toolbox.json")), { version: 2, overrides: { exa: "enabled", gh: "enabled" } });
  await invoke("skills project enable exa", "info", /未变化/);
  await invoke("skills inherit exa", null);
  await invoke("skills disable gh", null);
  assert.deepEqual(await readJson(join(cwd, ".pi", "toolbox.json")), { version: 2, overrides: { gh: "disabled" } });
  await invoke("skills global enable gh", null);
  await invoke("skills global disable exa", null);
  assert.deepEqual(await readJson(join(agentDir, "toolbox.json")), { version: 1, enabled: ["gh"] });

  await invoke("extensions disable browser");
  assert.deepEqual((await readJson(join(cwd, ".pi", "settings.json"))).packages, [disabledEntry(browserSource)]);
  await invoke("extensions project disable browser", "info", /未变化/);
  await invoke("extensions enable browser");
  assert.deepEqual((await readJson(join(cwd, ".pi", "settings.json"))).packages, [{ source: browserSource, autoload: false, extensions: ["+extensions/index.js"] }]);
  await invoke("extensions inherit browser");
  assert.deepEqual(await readJson(join(cwd, ".pi", "settings.json")), { fixtureMarker: true, packages: [] });
  await invoke("extensions global enable browser");
  assert.deepEqual((await readJson(join(agentDir, "settings.json"))).packages, [browserSource, protectedSource]);
  await invoke("extensions global disable browser");
  const protectedBefore = await snapshotConfigs();
  await invoke("extensions disable pi-toolbox", "error", /保护名单/);
  await invoke("extensions global disable pi-toolbox", "error", /保护名单/);
  assert.deepEqual(await snapshotConfigs(), protectedBefore);
  const reloaded = await request({ type: "get_commands" });
  assert.ok(reloaded.data.commands.some((command) => command.name === "toolbox"));
  const state = await request({ type: "get_state" });
  assert.equal(state.data.isStreaming, false);
  assert.equal(state.data.messageCount, 0);
  console.log(`RPC smoke verification passed: ${checks} command checks, actual reloads, no model requests, isolated configuration.`);
} catch (error) {
  if (stderr) console.error(stderr);
  throw error;
} finally {
  if (child) {
    child.stdin.end();
    const forceStop = setTimeout(() => child.kill("SIGKILL"), 5_000);
    const exit = await closed;
    clearTimeout(forceStop);
    if (exit.code !== 0) process.exitCode = 1;
  }
  await rm(root, { recursive: true, force: true });
}
