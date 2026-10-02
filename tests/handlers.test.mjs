import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { initTheme } from "@earendil-works/pi-coding-agent";

// Use Pi's real extension loader, but only isolated fixture configuration and mock UI/reload.
const hostDirectory = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { loadExtensions } = await import(pathToFileURL(join(hostDirectory, "core/extensions/loader.js")).href);
const entryPath = fileURLToPath(new URL("../extensions/index.ts", import.meta.url));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalToolboxRoot = process.env.PI_TOOLBOX_ROOT;
const BROWSER = "git:github.com/example/browser";
const TOOLBOX = "git:github.com/example/pi-toolbox";
let root, agentDir, cwd, toolboxRoot, extension, command;
let notifications, reloads, ctx;

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}
async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
function configPaths() {
  return [join(agentDir, "toolbox.json"), join(cwd, ".pi", "toolbox.json"), join(agentDir, "settings.json"), join(cwd, ".pi", "settings.json")];
}
async function snapshotConfigs() {
  return Promise.all(configPaths().map((path) => readFile(path, "utf8")));
}
async function invoke(args) {
  notifications.length = 0;
  await command.handler(args, ctx);
  return notifications.at(-1);
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-toolbox-handlers-"));
  agentDir = join(root, "agent");
  cwd = join(root, "project");
  toolboxRoot = join(root, "tools");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_TOOLBOX_ROOT = toolboxRoot;
  for (const id of ["exa", "gh"]) {
    await mkdir(join(toolboxRoot, id, "skill"), { recursive: true });
    await mkdir(join(toolboxRoot, id, "bin"), { recursive: true });
    await writeJson(join(toolboxRoot, id, "manifest.json"), { id, name: id, description: id, skillPaths: ["skill"], binPaths: ["bin"] });
  }
  for (const id of ["browser", "pi-toolbox"]) {
    const installDir = join(agentDir, "git", "github.com", "example", id);
    await mkdir(join(installDir, "extensions"), { recursive: true });
    await writeFile(join(installDir, "extensions", "index.js"), "export default function () {}\n");
    await writeJson(join(installDir, "package.json"), { pi: { extensions: ["extensions/index.js"] } });
  }
  initTheme("dark", false);
  const loaded = await loadExtensions([entryPath], cwd);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  extension = loaded.extensions[0];
  command = extension.commands.get("toolbox");
  assert.ok(command);
});

beforeEach(async () => {
  await writeJson(join(agentDir, "toolbox.json"), { version: 1, enabled: ["exa"] });
  await writeJson(join(cwd, ".pi", "toolbox.json"), { version: 2, overrides: { exa: "disabled", gh: "enabled" } });
  await writeJson(join(agentDir, "settings.json"), { theme: "dark", packages: [{ source: BROWSER, extensions: [], skills: [], prompts: [], themes: [] }, TOOLBOX] });
  await writeJson(join(cwd, ".pi", "settings.json"), { other: true, packages: [{ source: BROWSER, autoload: false, extensions: ["+extensions/index.js"] }] });
  notifications = [];
  reloads = 0;
  ctx = {
    cwd, mode: "rpc", hasUI: true,
    sessionManager: { getSessionId: () => "toolbox-test", getSessionFile: () => undefined },
    ui: {
      notify(message, type) { notifications.push({ message, type }); },
      select() { throw new Error("Unexpected selection UI"); },
      custom() { throw new Error("Unexpected custom TUI"); },
    },
    async reload() { reloads += 1; },
  };
});

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalToolboxRoot === undefined) delete process.env.PI_TOOLBOX_ROOT;
  else process.env.PI_TOOLBOX_ROOT = originalToolboxRoot;
  if (root) await rm(root, { recursive: true, force: true });
});

test("real loader registers only toolbox and the two top-level candidates", () => {
  assert.deepEqual([...extension.commands.keys()], ["toolbox"]);
  assert.deepEqual(command.getArgumentCompletions("").map((item) => item.label), ["skills", "extensions"]);
});

test("root is non-mutating help outside TUI", async () => {
  const before = await snapshotConfigs();
  const result = await invoke("");
  assert.equal(result.type, "info");
  assert.match(result.message, /\/toolbox skills/);
  assert.match(result.message, /\/toolbox extensions/);
  assert.equal(reloads, 0);
  assert.deepEqual(await snapshotConfigs(), before);
});

for (const args of ["skills", "skills project", "skills global", "extensions", "extensions project", "extensions global", "extensions status browser", "extensions global status browser"]) {
  test(`query handler does not write or reload: ${args}`, async () => {
    const before = await snapshotConfigs();
    const result = await invoke(args);
    assert.equal(result.type, "info");
    if (args === "skills") assert.match(result.message, /○ exa — 项目明确关闭/);
    if (args === "skills global") assert.match(result.message, /● exa — 全局开启/);
    if (args.startsWith("extensions")) assert.match(result.message, args.includes("global") ? /○ browser/ : /● browser/);
    assert.equal(reloads, 0);
    assert.deepEqual(await snapshotConfigs(), before);
  });
}

for (const args of ["enable exa", "disable gh", "inherit exa", "status", "project", "global enable gh", "plugin disable browser", "plugins", "skills list", "extensions list", "skills global inherit exa", "extensions global inherit browser", "extensions config", "skills enable", "extensions disable browser extra"]) {
  test(`invalid or removed handler never writes: ${args}`, async () => {
    const before = await snapshotConfigs();
    const result = await invoke(args);
    assert.equal(result.type, "error");
    assert.equal(reloads, 0);
    assert.deepEqual(await snapshotConfigs(), before);
  });
}

test("skills mutations preserve existing configuration and reload only on change", async () => {
  await invoke("skills enable exa");
  assert.deepEqual(await readJson(join(cwd, ".pi", "toolbox.json")), { version: 2, overrides: { exa: "enabled", gh: "enabled" } });
  assert.equal(reloads, 1);
  await invoke("skills project enable exa");
  assert.equal(reloads, 1);
  await invoke("skills inherit exa");
  assert.deepEqual(await readJson(join(cwd, ".pi", "toolbox.json")), { version: 2, overrides: { gh: "enabled" } });
  await invoke("skills disable gh");
  assert.deepEqual(await readJson(join(cwd, ".pi", "toolbox.json")), { version: 2, overrides: { gh: "disabled" } });
  await invoke("skills global enable gh");
  assert.deepEqual(await readJson(join(agentDir, "toolbox.json")), { version: 1, enabled: ["exa", "gh"] });
  await invoke("skills global disable exa");
  assert.deepEqual(await readJson(join(agentDir, "toolbox.json")), { version: 1, enabled: ["gh"] });
  assert.equal(reloads, 5);
});

test("extensions mutations preserve native settings and reload only on change", async () => {
  await invoke("extensions disable browser");
  const disabled = await readJson(join(cwd, ".pi", "settings.json"));
  assert.equal(disabled.other, true);
  assert.deepEqual(disabled.packages, [{ source: BROWSER, extensions: [], skills: [], prompts: [], themes: [] }]);
  await invoke("extensions project disable browser");
  assert.equal(reloads, 1);
  await invoke("extensions enable browser");
  assert.deepEqual((await readJson(join(cwd, ".pi", "settings.json"))).packages, [{ source: BROWSER, autoload: false, extensions: ["+extensions/index.js"] }]);
  await invoke("extensions inherit browser");
  assert.deepEqual((await readJson(join(cwd, ".pi", "settings.json"))).packages, []);
  await invoke("extensions global enable browser");
  assert.deepEqual(await readJson(join(agentDir, "settings.json")), { theme: "dark", packages: [BROWSER, TOOLBOX] });
  await invoke("extensions global disable browser");
  assert.equal(reloads, 5);
});

test("unknown objects and protected extensions never write", async () => {
  const before = await snapshotConfigs();
  for (const args of ["skills enable missing", "extensions enable missing", "extensions status missing", "extensions disable pi-toolbox", "extensions global disable pi-toolbox"]) {
    assert.equal((await invoke(args)).type, "error", args);
  }
  assert.equal(reloads, 0);
  assert.deepEqual(await snapshotConfigs(), before);
});

test("skills config is guarded by mode, not hasUI", async () => {
  const before = await snapshotConfigs();
  for (const args of ["skills config", "skills project config", "skills global config"]) {
    const result = await invoke(args);
    assert.equal(result.type, "error");
    assert.match(result.message, /TUI/);
  }
  assert.equal(reloads, 0);
  assert.deepEqual(await snapshotConfigs(), before);
});

for (const category of ["skills", "extensions"]) {
  test(`TUI root selection opens ${category} status without editing`, async () => {
    const before = await snapshotConfigs();
    ctx.mode = "tui";
    ctx.ui.select = async (_title, options) => {
      assert.deepEqual(options, ["skills", "extensions"]);
      return category;
    };
    assert.equal((await invoke("")).type, "info");
    assert.equal(reloads, 0);
    assert.deepEqual(await snapshotConfigs(), before);
  });
}

for (const scope of ["project", "global"]) {
  test(`skills ${scope} config uses real settings UI and saves on Escape`, async () => {
    ctx.mode = "tui";
    ctx.ui.custom = async (factory) => {
      let done = false;
      const component = factory({ requestRender() {} }, { fg: (_color, text) => text, bold: (text) => text }, {}, () => { done = true; });
      assert.ok(component.render(100).length > 0);
      component.handleInput("\r");
      component.handleInput("\x1b");
      assert.equal(done, true);
    };
    await invoke(`skills ${scope} config`);
    assert.equal(reloads, 1);
    const value = await readJson(scope === "global" ? join(agentDir, "toolbox.json") : join(cwd, ".pi", "toolbox.json"));
    assert.deepEqual(value, scope === "global" ? { version: 1, enabled: [] } : { version: 2, overrides: { gh: "enabled" } });
  });
}

test("session lifecycle still discovers enabled skills and injects bash paths", async () => {
  const start = extension.handlers.get("session_start")[0];
  await start({}, ctx);
  const discover = extension.handlers.get("resources_discover")[0];
  assert.deepEqual((await discover({ cwd }, ctx)).skillPaths, [join(toolboxRoot, "gh", "skill")]);
  const tool = extension.tools.get("bash")?.definition;
  assert.ok(tool);
  const result = await tool.execute("test-path", { command: "printf '%s' \"$PATH\"", timeout: 5 }, undefined, undefined, ctx);
  const output = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
  assert.ok(output.startsWith(join(toolboxRoot, "gh", "bin") + ":"), output);
});
