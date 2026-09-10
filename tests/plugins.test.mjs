import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
	computePluginStates,
	discoverPluginResources,
	findPlugin,
	getPluginCompletions,
	loadPluginInfo,
	packageIdentity,
	parsePackageEntry,
	pluginShortId,
	setGlobalDisabled,
	setGlobalEnabled,
	setGlobalPluginState,
	setProjectDisabled,
	setProjectEnabled,
	setProjectPluginState,
} from "../extensions/plugins.ts";

const SETMODEL = "git:github.com/outmost9271/pi-setmodel@v1.0.1";
const TOOLBOX = "git:github.com/outmost9271/pi-toolbox";
const BROWSER = "git:github.com/outmost9271/pi-agent-browser-native@v0.6.10-piab.1";
const SETMODEL_IDENTITY = "github.com/outmost9271/pi-setmodel";
const BROWSER_IDENTITY = "github.com/outmost9271/pi-agent-browser-native";

async function makeTempDir() {
	return await mkdtemp(join(tmpdir(), "pi-toolbox-test-"));
}

async function writeJson(path, value) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("plugin identity and short id rules", () => {
	assert.equal(packageIdentity(SETMODEL), SETMODEL_IDENTITY);
	assert.equal(pluginShortId(SETMODEL), "pi-setmodel");
	assert.equal(pluginShortId(TOOLBOX), "pi-toolbox");
	assert.equal(packageIdentity("npm:@scope/pkg@1.2.3"), "@scope/pkg");
});

test("global disable and enable keep other entries and fields", () => {
	const baseDir = "/tmp/agent";
	const packages = [SETMODEL, TOOLBOX];
	const disabled = setGlobalDisabled(packages, SETMODEL_IDENTITY, baseDir, SETMODEL);
	assert.deepEqual(disabled[0], {
		source: SETMODEL,
		extensions: [],
		skills: [],
		prompts: [],
		themes: [],
	});
	assert.equal(disabled[1], TOOLBOX);
	const enabled = setGlobalEnabled(disabled, SETMODEL_IDENTITY, baseDir);
	assert.deepEqual(enabled[0], SETMODEL);
});

test("project disable writes an override entry, project enable writes force includes", () => {
	const baseDir = "/tmp/project/.pi";
	const resources = [
		{ kind: "extensions", path: "dist/extensions/a/index.js" },
		{ kind: "extensions", path: "dist/extensions/b/index.js" },
	];
	const disabled = setProjectDisabled([], SETMODEL_IDENTITY, baseDir, SETMODEL);
	assert.deepEqual(disabled[0], {
		source: SETMODEL,
		extensions: [],
		skills: [],
		prompts: [],
		themes: [],
	});
	const enabled = setProjectEnabled(disabled, SETMODEL_IDENTITY, baseDir, SETMODEL, resources);
	assert.deepEqual(enabled[0], {
		source: SETMODEL,
		autoload: false,
		extensions: ["+dist/extensions/a/index.js", "+dist/extensions/b/index.js"],
	});
	const withoutResources = setProjectEnabled([], SETMODEL_IDENTITY, baseDir, SETMODEL, []);
	assert.deepEqual(withoutResources, { error: "无法发现该插件的资源清单，不能生成项目启用规则" });
});

test("discover package resources from the pi manifest", async () => {
	const dir = await makeTempDir();
	await mkdir(join(dir, "dist", "extensions", "demo"), { recursive: true });
	await writeFile(join(dir, "dist", "extensions", "demo", "index.js"), "export default function () {}\n");
	await writeJson(join(dir, "package.json"), { pi: { extensions: ["./dist/extensions/demo/index.js"] } });
	const discovery = await discoverPluginResources(dir);
	assert.deepEqual(discovery.resources, [{ kind: "extensions", path: "dist/extensions/demo/index.js" }]);
	assert.deepEqual(discovery.warnings, []);
});

test("discover package resources from conventional directories", async () => {
	const dir = await makeTempDir();
	await mkdir(join(dir, "extensions"), { recursive: true });
	await writeFile(join(dir, "extensions", "index.ts"), "export default function () {}\n");
	const discovery = await discoverPluginResources(dir);
	assert.deepEqual(discovery.resources, [{ kind: "extensions", path: "extensions/index.ts" }]);
});

test("plugin state computation matrix", () => {
	const resources = [{ kind: "extensions", path: "a.js" }];
	const enabled = parsePackageEntry(SETMODEL, 0, "/tmp/agent");
	const disabled = parsePackageEntry(
		{ source: SETMODEL, extensions: [], skills: [], prompts: [], themes: [] },
		0,
		"/tmp/agent",
	);

	let states = computePluginStates(enabled, undefined, resources);
	assert.deepEqual(states, { global: "enabled", project: "inherit", effective: "enabled" });

	states = computePluginStates(disabled, undefined, resources);
	assert.deepEqual(states, { global: "disabled", project: "inherit", effective: "disabled" });

	const deltaInclude = parsePackageEntry({ source: SETMODEL, autoload: false, extensions: ["+a.js"] }, 0, "/tmp/pi");
	states = computePluginStates(disabled, deltaInclude, resources);
	assert.deepEqual(states, { global: "disabled", project: "enabled", effective: "enabled" });

	const deltaExclude = parsePackageEntry({ source: SETMODEL, autoload: false, extensions: ["-a.js"] }, 0, "/tmp/pi");
	states = computePluginStates(enabled, deltaExclude, resources);
	assert.deepEqual(states, { global: "enabled", project: "disabled", effective: "disabled" });

	const deltaEmpty = parsePackageEntry({ source: SETMODEL, autoload: false, extensions: [] }, 0, "/tmp/pi");
	states = computePluginStates(enabled, deltaEmpty, resources);
	assert.deepEqual(states, { global: "enabled", project: "inherit", effective: "enabled" });

	const overrideEmpty = parsePackageEntry(
		{ source: SETMODEL, extensions: [], skills: [], prompts: [], themes: [] },
		0,
		"/tmp/pi",
	);
	states = computePluginStates(enabled, overrideEmpty, resources);
	assert.deepEqual(states, { global: "enabled", project: "disabled", effective: "disabled" });

	const overrideBare = parsePackageEntry({ source: SETMODEL }, 0, "/tmp/pi");
	states = computePluginStates(disabled, overrideBare, resources);
	assert.deepEqual(states, { global: "disabled", project: "enabled", effective: "disabled" });
});

test("loadPluginInfo merges global and project settings", async () => {
	const cwd = await makeTempDir();
	const agentDir = await makeTempDir();
	await writeJson(join(agentDir, "settings.json"), { other: 1, packages: [SETMODEL] });
	await writeJson(join(cwd, ".pi", "settings.json"), {
		packages: [{ source: SETMODEL, autoload: false, extensions: ["+a.js"] }],
	});
	const loaded = await loadPluginInfo({ cwd, agentDir });
	assert.equal(loaded.plugins.length, 1);
	const plugin = loaded.plugins[0];
	assert.equal(plugin.id, "pi-setmodel");
	assert.equal(plugin.global, "enabled");
	assert.equal(plugin.project, "enabled");
	assert.equal(plugin.effective, "enabled");
	assert.equal(plugin.protected, true);
});

test("project disable round-trips through the settings file", async () => {
	const cwd = await makeTempDir();
	const agentDir = await makeTempDir();
	await writeJson(join(agentDir, "settings.json"), { packages: [BROWSER] });
	const first = await loadPluginInfo({ cwd, agentDir });
	assert.equal(first.plugins[0].id, "pi-agent-browser-native");
	assert.equal(first.plugins[0].protected, false);
	const result = await setProjectPluginState({ cwd, plugin: first.plugins[0], action: "disable" });
	assert.equal(result.changed, true);
	const second = await loadPluginInfo({ cwd, agentDir });
	assert.equal(second.plugins[0].project, "disabled");
	assert.equal(second.plugins[0].effective, "disabled");
	const resultAgain = await setProjectPluginState({ cwd, plugin: second.plugins[0], action: "disable" });
	assert.equal(resultAgain.changed, false);
	const inherit = await setProjectPluginState({ cwd, plugin: second.plugins[0], action: "inherit" });
	assert.equal(inherit.changed, true);
	const third = await loadPluginInfo({ cwd, agentDir });
	assert.equal(third.plugins[0].project, "inherit");
});

test("global disable round-trips and preserves unrelated settings", async () => {
	const cwd = await makeTempDir();
	const agentDir = await makeTempDir();
	await writeJson(join(agentDir, "settings.json"), { theme: "dark", packages: [BROWSER, TOOLBOX] });
	const loaded = await loadPluginInfo({ cwd, agentDir });
	const plugin = loaded.plugins.find((entry) => entry.id === "pi-agent-browser-native");
	const result = await setGlobalPluginState({ agentDir, plugin, action: "disable" });
	assert.equal(result.changed, true);
	const raw = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
	assert.equal(raw.theme, "dark");
	assert.deepEqual(raw.packages[0], { source: BROWSER, extensions: [], skills: [], prompts: [], themes: [] });
	assert.equal(raw.packages[1], TOOLBOX);
});

test("protected plugins reject disable for both scopes", async () => {
	const cwd = await makeTempDir();
	const agentDir = await makeTempDir();
	await writeJson(join(agentDir, "settings.json"), { packages: [TOOLBOX] });
	const loaded = await loadPluginInfo({ cwd, agentDir });
	const plugin = findPlugin(loaded.plugins, "pi-toolbox");
	assert.equal(plugin?.protected, true);
	const project = await setProjectPluginState({ cwd, plugin, action: "disable" });
	assert.match(project.error ?? "", /保护/);
	const global = await setGlobalPluginState({ agentDir, plugin, action: "disable" });
	assert.match(global.error ?? "", /保护/);
});

test("plugin completions follow scope, state and protection", () => {
	const plugins = [
		{ id: "pi-setmodel", protected: true, global: "enabled", project: "inherit", effective: "enabled" },
		{ id: "pi-browser", protected: false, global: "enabled", project: "disabled", effective: "disabled" },
		{ id: "pi-other", protected: false, global: "enabled", project: "inherit", effective: "enabled" },
	];
	const completions = (prefix) => getPluginCompletions(prefix, plugins)?.map((item) => item.value) ?? null;
	assert.deepEqual(completions("plugin enable "), ["plugin enable pi-browser"]);
	assert.deepEqual(completions("plugin disable "), ["plugin disable pi-other"]);
	assert.deepEqual(completions("plugin inherit "), ["plugin inherit pi-browser"]);
	assert.deepEqual(completions("plugin global disable "), [
		"plugin global disable pi-browser",
		"plugin global disable pi-other",
	]);
	assert.equal(completions("plugin global enable "), null);
	assert.equal(completions("plugin status"), null);
	assert.deepEqual(completions("plugins "), ["plugins status", "plugins list"]);
	assert.ok(completions("plugin")?.includes("plugin enable "));
});

test("invalid settings files block writes", async () => {
	const cwd = await makeTempDir();
	const agentDir = await makeTempDir();
	await writeFile(join(agentDir, "settings.json"), "{ not json", "utf8");
	const loaded = await loadPluginInfo({ cwd, agentDir });
	assert.equal(loaded.plugins.length, 0);
	assert.ok(loaded.warnings.some((warning) => warning.includes("JSON 无效")));
	const raw = await readFile(join(agentDir, "settings.json"), "utf8");
	assert.equal(raw, "{ not json");
});

void BROWSER_IDENTITY;
