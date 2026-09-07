import { appendFile, chmod, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	CONFIG_DIR_NAME,
	createBashTool,
	DynamicBorder,
	getAgentDir,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	Container,
	type SettingItem,
	SettingsList,
	Text,
} from "@earendil-works/pi-tui";

const TOOLBOX_ROOT = process.env.PI_TOOLBOX_ROOT ?? "/agent-pi/tools";
const CONFIG_FILE_NAME = "toolbox.json";
const MANIFEST_FILE_NAME = "manifest.json";
const CAPABILITY_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type ProjectOverride = "enabled" | "disabled";
type ConfigScope = "project" | "global";
type ConfigAction = "list" | "status" | "enable" | "disable" | "inherit";

interface CapabilityManifest {
	id: string;
	name: string;
	description: string;
	skillPaths: string[];
	binPaths: string[];
}

interface Capability extends CapabilityManifest {
	root: string;
	resolvedSkillPaths: string[];
	resolvedBinPaths: string[];
}

interface GlobalToolboxConfig {
	version: 1;
	enabled: string[];
}

interface ProjectToolboxConfig {
	version: 2;
	overrides: Record<string, ProjectOverride>;
}

interface LoadedGlobalConfig {
	exists: boolean;
	config: GlobalToolboxConfig;
	warnings: string[];
}

interface LoadedProjectConfig {
	exists: boolean;
	config: ProjectToolboxConfig;
	warnings: string[];
	migratedFromV1: boolean;
}

function globalConfigPath(): string {
	return join(getAgentDir(), CONFIG_FILE_NAME);
}

function projectConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveOwnedPath(root: string, value: string): string | undefined {
	const resolved = resolve(root, value);
	if (resolved === root || resolved.startsWith(`${root}${sep}`)) return resolved;
	return undefined;
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function discoverCapabilities(): Promise<{ capabilities: Capability[]; warnings: string[] }> {
	const capabilities: Capability[] = [];
	const warnings: string[] = [];
	let entries;

	try {
		entries = await readdir(TOOLBOX_ROOT, { withFileTypes: true });
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return { capabilities, warnings };
		return {
			capabilities,
			warnings: [`无法扫描能力目录 ${TOOLBOX_ROOT}: ${error instanceof Error ? error.message : String(error)}`],
		};
	}

	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory()) continue;

		const root = join(TOOLBOX_ROOT, entry.name);
		const manifestPath = join(root, MANIFEST_FILE_NAME);
		let raw: unknown;

		try {
			raw = JSON.parse(await readFile(manifestPath, "utf8"));
		} catch (error) {
			if (!isNodeError(error, "ENOENT")) {
				warnings.push(`${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
			}
			continue;
		}

		if (!isRecord(raw)) {
			warnings.push(`${manifestPath}: 清单必须是 JSON 对象`);
			continue;
		}

		const value = raw as Partial<CapabilityManifest>;
		if (
			typeof value.id !== "string" ||
			!CAPABILITY_ID_PATTERN.test(value.id) ||
			typeof value.name !== "string" ||
			!value.name.trim() ||
			typeof value.description !== "string" ||
			!isStringArray(value.skillPaths) ||
			!isStringArray(value.binPaths)
		) {
			warnings.push(`${manifestPath}: 清单字段无效`);
			continue;
		}

		if (capabilities.some((capability) => capability.id === value.id)) {
			warnings.push(`${manifestPath}: 能力标识 ${value.id} 重复`);
			continue;
		}

		const skillCandidates = value.skillPaths.map((path) => resolveOwnedPath(root, path));
		const binCandidates = value.binPaths.map((path) => resolveOwnedPath(root, path));
		if (skillCandidates.some((path) => path === undefined) || binCandidates.some((path) => path === undefined)) {
			warnings.push(`${manifestPath}: 路径不能离开能力目录`);
			continue;
		}

		const resolvedSkillPaths: string[] = [];
		const resolvedBinPaths: string[] = [];
		for (const path of skillCandidates as string[]) {
			if (await isDirectory(path)) resolvedSkillPaths.push(path);
			else warnings.push(`${manifestPath}: Skill 目录不存在：${path}`);
		}
		for (const path of binCandidates as string[]) {
			if (await isDirectory(path)) resolvedBinPaths.push(path);
			else warnings.push(`${manifestPath}: bin 目录不存在：${path}`);
		}

		capabilities.push({
			id: value.id,
			name: value.name,
			description: value.description,
			skillPaths: value.skillPaths,
			binPaths: value.binPaths,
			root,
			resolvedSkillPaths,
			resolvedBinPaths,
		});
	}

	return { capabilities, warnings };
}

async function readGlobalConfig(): Promise<LoadedGlobalConfig> {
	const path = globalConfigPath();
	let raw: unknown;

	try {
		raw = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (isNodeError(error, "ENOENT")) {
			return { exists: false, config: { version: 1, enabled: [] }, warnings: [] };
		}
		return {
			exists: true,
			config: { version: 1, enabled: [] },
			warnings: [`${path}: ${error instanceof Error ? error.message : String(error)}`],
		};
	}

	if (!isRecord(raw)) {
		return { exists: true, config: { version: 1, enabled: [] }, warnings: [`${path}: 配置必须是 JSON 对象`] };
	}

	const value = raw as { version?: unknown; enabled?: unknown };
	if (value.version !== 1 || !isStringArray(value.enabled)) {
		return {
			exists: true,
			config: { version: 1, enabled: [] },
			warnings: [`${path}: 仅支持 { "version": 1, "enabled": string[] }`],
		};
	}

	const enabled = [...new Set(value.enabled.filter((id) => CAPABILITY_ID_PATTERN.test(id)))];
	const warnings = enabled.length === value.enabled.length ? [] : [`${path}: 已忽略无效或重复的能力标识`];
	return { exists: true, config: { version: 1, enabled }, warnings };
}

async function readProjectConfig(cwd: string): Promise<LoadedProjectConfig> {
	const path = projectConfigPath(cwd);
	let raw: unknown;

	try {
		raw = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (isNodeError(error, "ENOENT")) {
			return { exists: false, config: { version: 2, overrides: {} }, warnings: [], migratedFromV1: false };
		}
		return {
			exists: true,
			config: { version: 2, overrides: {} },
			warnings: [`${path}: ${error instanceof Error ? error.message : String(error)}`],
			migratedFromV1: false,
		};
	}

	if (!isRecord(raw)) {
		return {
			exists: true,
			config: { version: 2, overrides: {} },
			warnings: [`${path}: 配置必须是 JSON 对象`],
			migratedFromV1: false,
		};
	}

	const value = raw as { version?: unknown; enabled?: unknown; overrides?: unknown };
	if (value.version === 1 && isStringArray(value.enabled)) {
		const enabled = [...new Set(value.enabled.filter((id) => CAPABILITY_ID_PATTERN.test(id)))];
		const overrides = Object.fromEntries(enabled.map((id) => [id, "enabled" as const]));
		const warnings = enabled.length === value.enabled.length ? [] : [`${path}: 已忽略无效或重复的能力标识`];
		return {
			exists: true,
			config: { version: 2, overrides },
			warnings,
			migratedFromV1: true,
		};
	}

	if (value.version !== 2 || !isRecord(value.overrides)) {
		return {
			exists: true,
			config: { version: 2, overrides: {} },
			warnings: [`${path}: 仅支持 version 2 overrides，或旧版 version 1 enabled`],
			migratedFromV1: false,
		};
	}

	const overrides: Record<string, ProjectOverride> = {};
	let ignored = false;
	for (const [id, state] of Object.entries(value.overrides)) {
		if (CAPABILITY_ID_PATTERN.test(id) && (state === "enabled" || state === "disabled")) {
			overrides[id] = state;
		} else {
			ignored = true;
		}
	}
	return {
		exists: true,
		config: { version: 2, overrides },
		warnings: ignored ? [`${path}: 已忽略无效的项目覆盖项`] : [],
		migratedFromV1: false,
	};
}

function escapeGitIgnorePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/([*?[\]\\])/g, "\\$1").replace(/^([#!])/, "\\$1");
}

async function ensureLocalGitExclude(
	pi: ExtensionAPI,
	cwd: string,
	configPath: string,
): Promise<string | undefined> {
	const rootResult = await pi.exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 5_000 });
	if (rootResult.code !== 0) return undefined;

	const repositoryRoot = rootResult.stdout.trim();
	const relativeConfigPath = relative(repositoryRoot, configPath).replace(/\\/g, "/");
	if (!relativeConfigPath || relativeConfigPath.startsWith("../")) return undefined;

	const trackedResult = await pi.exec(
		"git",
		["-C", repositoryRoot, "ls-files", "--error-unmatch", "--", relativeConfigPath],
		{ timeout: 5_000 },
	);
	if (trackedResult.code === 0) {
		return `${configPath} 已被 Git 跟踪；插件不会自动修改索引`;
	}

	const excludeResult = await pi.exec(
		"git",
		["-C", cwd, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
		{ timeout: 5_000 },
	);
	if (excludeResult.code !== 0) {
		return `无法定位本地 Git 排除文件：${excludeResult.stderr.trim() || `exit ${excludeResult.code}`}`;
	}

	const rawExcludePath = excludeResult.stdout.trim();
	const excludePath = isAbsolute(rawExcludePath) ? rawExcludePath : resolve(cwd, rawExcludePath);
	let existing = "";
	try {
		existing = await readFile(excludePath, "utf8");
	} catch (error) {
		if (!isNodeError(error, "ENOENT")) {
			return `无法读取 ${excludePath}: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	const pattern = `/${escapeGitIgnorePath(relativeConfigPath)}`;
	if (existing.split(/\r?\n/).includes(pattern)) return undefined;

	await mkdir(dirname(excludePath), { recursive: true });
	const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
	await appendFile(excludePath, `${prefix}# pi-toolbox 本机项目配置\n${pattern}\n`, "utf8");
	return undefined;
}

async function writeJsonConfig(path: string, config: GlobalToolboxConfig | ProjectToolboxConfig): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
	await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporaryPath, path);
	await chmod(path, 0o600);
}

async function writeGlobalConfig(enabled: Iterable<string>): Promise<void> {
	await writeJsonConfig(globalConfigPath(), { version: 1, enabled: [...new Set(enabled)].sort() });
}

async function writeProjectConfig(cwd: string, overrides: ReadonlyMap<string, ProjectOverride>): Promise<void> {
	const sortedOverrides = Object.fromEntries([...overrides.entries()].sort(([left], [right]) => left.localeCompare(right)));
	await writeJsonConfig(projectConfigPath(cwd), { version: 2, overrides: sortedOverrides });
}

function computeEffectiveEnabled(
	capabilities: Capability[],
	globalEnabled: ReadonlySet<string>,
	projectOverrides: ReadonlyMap<string, ProjectOverride>,
): Set<string> {
	const knownIds = new Set(capabilities.map((capability) => capability.id));
	const effective = new Set([...globalEnabled].filter((id) => knownIds.has(id)));
	for (const [id, state] of projectOverrides) {
		if (!knownIds.has(id)) continue;
		if (state === "enabled") effective.add(id);
		else effective.delete(id);
	}
	return effective;
}

function selectedCapabilities(capabilities: Capability[], enabled: ReadonlySet<string>): Capability[] {
	return capabilities.filter((capability) => enabled.has(capability.id));
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
	return left.size === right.size && [...left].every((value) => right.has(value));
}

function mapsEqual(
	left: ReadonlyMap<string, ProjectOverride>,
	right: ReadonlyMap<string, ProjectOverride>,
): boolean {
	return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
}

function formatGlobalStatus(capabilities: Capability[], globalEnabled: ReadonlySet<string>): string {
	if (capabilities.length === 0) return `未在 ${TOOLBOX_ROOT} 中发现能力`;
	return capabilities
		.map(
			(capability) =>
				`${globalEnabled.has(capability.id) ? "●" : "○"} ${capability.id} — 全局${globalEnabled.has(capability.id) ? "开启" : "关闭"}`,
		)
		.join("\n");
}

function formatProjectStatus(
	capabilities: Capability[],
	globalEnabled: ReadonlySet<string>,
	projectOverrides: ReadonlyMap<string, ProjectOverride>,
): string {
	if (capabilities.length === 0) return `未在 ${TOOLBOX_ROOT} 中发现能力`;
	const effective = computeEffectiveEnabled(capabilities, globalEnabled, projectOverrides);
	const lines = capabilities.map((capability) => {
		const globalOn = globalEnabled.has(capability.id);
		const override = projectOverrides.get(capability.id);
		let source: string;
		if (override === "enabled") {
			source = globalOn ? "项目明确开启（与全局一致）" : "项目明确开启（覆盖全局关闭）";
		} else if (override === "disabled") {
			source = globalOn ? "项目明确关闭（覆盖全局开启）" : "项目明确关闭（与全局一致）";
		} else {
			source = `继承全局${globalOn ? "开启" : "关闭"}`;
		}
		return `${effective.has(capability.id) ? "●" : "○"} ${capability.id} — ${source}`;
	});
	return lines.join("\n");
}

function actionsForScope(scope: ConfigScope): ConfigAction[] {
	return scope === "global"
		? ["list", "status", "enable", "disable"]
		: ["list", "status", "enable", "disable", "inherit"];
}

function actionNeedsCapability(action: ConfigAction): boolean {
	return action === "enable" || action === "disable" || action === "inherit";
}

function completionCandidates(
	scope: ConfigScope,
	action: ConfigAction,
	capabilities: Capability[],
	globalEnabled: ReadonlySet<string>,
	projectOverrides: ReadonlyMap<string, ProjectOverride>,
): Capability[] {
	if (scope === "global") {
		if (action === "enable") return capabilities.filter((capability) => !globalEnabled.has(capability.id));
		if (action === "disable") return capabilities.filter((capability) => globalEnabled.has(capability.id));
		return [];
	}
	if (action === "enable") return capabilities.filter((capability) => projectOverrides.get(capability.id) !== "enabled");
	if (action === "disable") return capabilities.filter((capability) => projectOverrides.get(capability.id) !== "disabled");
	if (action === "inherit") return capabilities.filter((capability) => projectOverrides.has(capability.id));
	return [];
}

function completeActions(prefix: string, scope: ConfigScope, valuePrefix: string): AutocompleteItem[] | null {
	const matches = actionsForScope(scope).filter((action) => action.startsWith(prefix));
	return matches.length > 0
		? matches.map((action) => ({
				value: `${valuePrefix}${action}${actionNeedsCapability(action) ? " " : ""}`,
				label: action,
			}))
		: null;
}

function completeCapabilities(
	scope: ConfigScope,
	action: ConfigAction,
	query: string,
	capabilities: Capability[],
	globalEnabled: ReadonlySet<string>,
	projectOverrides: ReadonlyMap<string, ProjectOverride>,
	valuePrefix: string,
): AutocompleteItem[] | null {
	const normalizedQuery = query.trim().toLowerCase();
	const filtered = completionCandidates(scope, action, capabilities, globalEnabled, projectOverrides).filter(
		(capability) =>
			`${capability.id} ${capability.name} ${capability.description}`.toLowerCase().includes(normalizedQuery),
	);
	return filtered.length > 0
		? filtered.map((capability) => ({
				value: `${valuePrefix}${action} ${capability.id}`,
				label: capability.id,
				description: capability.description,
			}))
		: null;
}

function getToolboxArgumentCompletions(
	argumentPrefix: string,
	capabilities: Capability[],
	globalEnabled: ReadonlySet<string>,
	projectOverrides: ReadonlyMap<string, ProjectOverride>,
): AutocompleteItem[] | null {
	// Match command parsing while retaining a trailing separator for chained completion.
	// Keep the provider's original prefix unchanged so insertion replaces the full input.
	argumentPrefix = argumentPrefix.replace(/^[ \t]+/, "").replace(/[ \t]+/g, " ");
	if (!argumentPrefix.includes(" ")) {
		const query = argumentPrefix.trim();
		const topLevel = ["project", "global", ...actionsForScope("project")].filter((value) => value.startsWith(query));
		return topLevel.length > 0
			? topLevel.map((value) => ({
					value: `${value}${value === "project" || value === "global" || actionNeedsCapability(value as ConfigAction) ? " " : ""}`,
					label: value,
				}))
			: null;
	}

	const scopedMatch = argumentPrefix.match(/^(project|global)\s+(.*)$/);
	if (scopedMatch) {
		const scope = scopedMatch[1] as ConfigScope;
		const remainder = scopedMatch[2];
		const valuePrefix = `${scope} `;
		if (!remainder.includes(" ")) return completeActions(remainder.trim(), scope, valuePrefix);
		const actionMatch = remainder.match(/^(enable|disable|inherit)\s+(.*)$/);
		if (!actionMatch) return null;
		const action = actionMatch[1] as ConfigAction;
		if (scope === "global" && action === "inherit") return null;
		return completeCapabilities(
			scope,
			action,
			actionMatch[2],
			capabilities,
			globalEnabled,
			projectOverrides,
			valuePrefix,
		);
	}

	const legacyMatch = argumentPrefix.match(/^(enable|disable|inherit)\s+(.*)$/);
	if (!legacyMatch) return null;
	return completeCapabilities(
		"project",
		legacyMatch[1] as ConfigAction,
		legacyMatch[2],
		capabilities,
		globalEnabled,
		projectOverrides,
		"",
	);
}

function getToolboxArgumentPrefix(lines: string[], cursorLine: number, cursorCol: number): string | undefined {
	const line = lines[cursorLine] ?? "";
	const beforeCursor = line.slice(0, cursorCol);
	const match = beforeCursor.match(/^\/toolbox\s(.*)$/);
	return match?.[1];
}

function createToolboxAutocompleteProvider(
	current: AutocompleteProvider,
	getCompletions: (argumentPrefix: string) => AutocompleteItem[] | null,
): AutocompleteProvider {
	return {
		triggerCharacters: current.triggerCharacters,
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const argumentPrefix = getToolboxArgumentPrefix(lines, cursorLine, cursorCol);
			if (argumentPrefix === undefined) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}
			const items = getCompletions(argumentPrefix);
			return items && items.length > 0 ? { items, prefix: argumentPrefix } : null;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			if (getToolboxArgumentPrefix(lines, cursorLine, cursorCol) !== undefined) return true;
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export default function toolboxExtension(pi: ExtensionAPI): void {
	let runtimeCwd = process.cwd();
	let capabilities: Capability[] = [];
	let globalEnabledIds = new Set<string>();
	let projectOverrides = new Map<string, ProjectOverride>();
	let effectiveEnabledIds = new Set<string>();
	let discoveryWarnings: string[] = [];

	function recomputeEffective(): void {
		effectiveEnabledIds = computeEffectiveEnabled(
			capabilities,
			globalEnabledIds,
			projectOverrides,
		);
	}

	async function refreshState(cwd: string): Promise<LoadedProjectConfig> {
		runtimeCwd = cwd;
		const [discovery, loadedGlobal, loadedProject] = await Promise.all([
			discoverCapabilities(),
			readGlobalConfig(),
			readProjectConfig(cwd),
		]);
		capabilities = discovery.capabilities;
		const knownIds = new Set(capabilities.map((capability) => capability.id));
		const unknownGlobalIds = loadedGlobal.config.enabled.filter((id) => !knownIds.has(id));
		const unknownProjectIds = Object.keys(loadedProject.config.overrides).filter((id) => !knownIds.has(id));
		globalEnabledIds = new Set(loadedGlobal.config.enabled.filter((id) => knownIds.has(id)));
		projectOverrides = new Map(
			Object.entries(loadedProject.config.overrides).filter(([id]) => knownIds.has(id)),
		);
		discoveryWarnings = [
			...discovery.warnings,
			...loadedGlobal.warnings,
			...loadedProject.warnings,
			...(unknownGlobalIds.length > 0
				? [`${globalConfigPath()}: 未发现能力 ${unknownGlobalIds.join(", ")}`]
				: []),
			...(unknownProjectIds.length > 0
				? [`${projectConfigPath(cwd)}: 未发现能力 ${unknownProjectIds.join(", ")}`]
				: []),
		];
		return loadedProject;
	}

	function enableBashPaths(cwd: string): void {
		const binPaths = [
			...new Set(
				selectedCapabilities(capabilities, effectiveEnabledIds).flatMap(
					(capability) => capability.resolvedBinPaths,
				),
			),
		];
		if (binPaths.length === 0) return;

		const bashTool = createBashTool(cwd, {
			spawnHook: ({ command, cwd: commandCwd, env }) => ({
				command,
				cwd: commandCwd,
				env: {
					...env,
					PATH: [...binPaths, env.PATH].filter(Boolean).join(delimiter),
				},
			}),
		});
		pi.registerTool(bashTool);
	}

	async function persistProjectAndReload(
		ctx: ExtensionCommandContext,
		nextOverrides: Map<string, ProjectOverride>,
	): Promise<void> {
		const path = projectConfigPath(ctx.cwd);
		const excludeWarning = await ensureLocalGitExclude(pi, ctx.cwd, path);
		await writeProjectConfig(ctx.cwd, nextOverrides);
		if (excludeWarning) ctx.ui.notify(excludeWarning, "warning");
		await ctx.reload();
	}

	async function persistGlobalAndReload(ctx: ExtensionCommandContext, nextEnabled: Set<string>): Promise<void> {
		await writeGlobalConfig(nextEnabled);
		await ctx.reload();
	}

	async function showGlobalSelector(ctx: ExtensionCommandContext): Promise<void> {
		await refreshState(ctx.cwd);
		if (capabilities.length === 0) {
			ctx.ui.notify(`未在 ${TOOLBOX_ROOT} 中发现能力`, "warning");
			return;
		}
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Toolbox 配置界面需要 TUI 模式", "error");
			return;
		}

		const initial = new Set(globalEnabledIds);
		const selected = new Set(globalEnabledIds);
		await ctx.ui.custom((tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
			container.addChild(new Text(theme.fg("accent", theme.bold("全局能力默认值")), 1, 0));
			const items: SettingItem[] = capabilities.map((capability) => ({
				id: capability.id,
				label: capability.name,
				description: `${capability.description}；所有项目默认${selected.has(capability.id) ? "开启" : "关闭"}`,
				currentValue: selected.has(capability.id) ? "开启" : "关闭",
				values: ["开启", "关闭"],
			}));
			const settings = new SettingsList(
				items,
				Math.min(items.length + 2, 15),
				getSettingsListTheme(),
				(id, value) => {
					if (value === "开启") selected.add(id);
					else selected.delete(id);
					const item = items.find((item) => item.id === id);
					const capability = capabilities.find((capability) => capability.id === id);
					if (item && capability) item.description = `${capability.description}；所有项目默认${selected.has(id) ? "开启" : "关闭"}`;
				},
				() => done(undefined),
				{ enableSearch: true },
			);
			container.addChild(settings);
			container.addChild(new Text(theme.fg("dim", "输入搜索 · Enter 切换 · Esc 保存并关闭"), 1, 0));
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					settings.handleInput?.(data);
					tui.requestRender();
				},
			};
		});
		if (!setsEqual(initial, selected)) await persistGlobalAndReload(ctx, selected);
	}

	async function showProjectSelector(ctx: ExtensionCommandContext): Promise<void> {
		await refreshState(ctx.cwd);
		if (capabilities.length === 0) {
			ctx.ui.notify(`未在 ${TOOLBOX_ROOT} 中发现能力`, "warning");
			return;
		}
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Toolbox 配置界面需要 TUI 模式", "error");
			return;
		}

		const initial = new Map(projectOverrides);
		const selected = new Map(projectOverrides);
		await ctx.ui.custom((tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
			container.addChild(new Text(theme.fg("accent", theme.bold("当前项目能力覆盖")), 1, 0));
			const items: SettingItem[] = capabilities.map((capability) => {
				const globalOn = globalEnabledIds.has(capability.id);
				const inheritValue = `继承（全局${globalOn ? "开启" : "关闭"}）`;
				const override = selected.get(capability.id);
				return {
					id: capability.id,
					label: capability.name,
					description: `${capability.description}；当前最终${override === "enabled" || (!override && globalOn) ? "开启" : "关闭"}`,
					currentValue: override === "enabled" ? "开启" : override === "disabled" ? "关闭" : inheritValue,
					values: [inheritValue, "开启", "关闭"],
				};
			});
			const settings = new SettingsList(
				items,
				Math.min(items.length + 2, 15),
				getSettingsListTheme(),
				(id, value) => {
					if (value === "开启") selected.set(id, "enabled");
					else if (value === "关闭") selected.set(id, "disabled");
					else selected.delete(id);
					const item = items.find((item) => item.id === id);
					const capability = capabilities.find((capability) => capability.id === id);
					const on = selected.get(id) === "enabled" || (!selected.has(id) && globalEnabledIds.has(id));
					if (item && capability) item.description = `${capability.description}；保存后最终${on ? "开启" : "关闭"}`;
				},
				() => done(undefined),
				{ enableSearch: true },
			);
			container.addChild(settings);
			container.addChild(new Text(theme.fg("dim", "继承 → 开启 → 关闭 · Esc 保存并关闭"), 1, 0));
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					settings.handleInput?.(data);
					tui.requestRender();
				},
			};
		});
		if (!mapsEqual(initial, selected)) await persistProjectAndReload(ctx, selected);
	}

	async function showScopeSelector(ctx: ExtensionCommandContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/toolbox 不带参数时需要 TUI 模式", "error");
			return;
		}
		const projectChoice = "当前项目（覆盖全局）";
		const globalChoice = "全局（所有项目默认值）";
		const selected = await ctx.ui.select("选择 Toolbox 配置范围", [projectChoice, globalChoice]);
		if (selected === projectChoice) await showProjectSelector(ctx);
		else if (selected === globalChoice) await showGlobalSelector(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		await refreshState(ctx.cwd);
		if (ctx.mode === "tui") {
			ctx.ui.addAutocompleteProvider((current) =>
				createToolboxAutocompleteProvider(current, (argumentPrefix) =>
					getToolboxArgumentCompletions(
						argumentPrefix,
						capabilities,
						globalEnabledIds,
						projectOverrides,
					),
				),
			);
		}
		recomputeEffective();
		enableBashPaths(ctx.cwd);
		for (const warning of discoveryWarnings) ctx.ui.notify(warning, "warning");
	});

	pi.on("resources_discover", async (event, ctx) => {
		if (event.cwd !== runtimeCwd) await refreshState(event.cwd);
		recomputeEffective();
		return {
			skillPaths: [
				...new Set(
					selectedCapabilities(capabilities, effectiveEnabledIds).flatMap(
						(capability) => capability.resolvedSkillPaths,
					),
				),
			],
		};
	});

	pi.registerCommand("toolbox", {
		description: "配置全局能力默认值和当前项目覆盖",
		getArgumentCompletions: (argumentPrefix) =>
			getToolboxArgumentCompletions(
				argumentPrefix,
				capabilities,
				globalEnabledIds,
				projectOverrides,
			),
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				await showScopeSelector(ctx);
				return;
			}

			await refreshState(ctx.cwd);
			recomputeEffective();
			const tokens = input.split(/\s+/);
			let scope: ConfigScope = "project";
			if (tokens[0] === "project" || tokens[0] === "global") scope = tokens.shift() as ConfigScope;
			if (tokens.length === 0) {
				if (scope === "global") await showGlobalSelector(ctx);
				else await showProjectSelector(ctx);
				return;
			}

			const action = tokens.shift() as ConfigAction;
			if (!actionsForScope(scope).includes(action) || tokens.length > (actionNeedsCapability(action) ? 1 : 0)) {
				ctx.ui.notify(
					"用法：/toolbox [project|global] [list|status|enable <能力>|disable <能力>|inherit <能力>]",
					"error",
				);
				return;
			}

			if (action === "list" || action === "status") {
				ctx.ui.notify(
					scope === "global"
						? formatGlobalStatus(capabilities, globalEnabledIds)
						: formatProjectStatus(capabilities, globalEnabledIds, projectOverrides),
					"info",
				);
				return;
			}

			const capabilityId = tokens[0];
			if (!capabilityId) {
				ctx.ui.notify(`/toolbox ${scope} ${action} 需要能力名称`, "error");
				return;
			}
			if (!capabilities.some((capability) => capability.id === capabilityId)) {
				ctx.ui.notify(`未知能力：${capabilityId}`, "error");
				return;
			}

			if (scope === "global") {
				const nextEnabled = new Set(globalEnabledIds);
				if (action === "enable") nextEnabled.add(capabilityId);
				else nextEnabled.delete(capabilityId);
				if (setsEqual(globalEnabledIds, nextEnabled)) {
					ctx.ui.notify(`${capabilityId} 的全局状态未变化`, "info");
					return;
				}
				await persistGlobalAndReload(ctx, nextEnabled);
				return;
			}

			const nextOverrides = new Map(projectOverrides);
			if (action === "enable") nextOverrides.set(capabilityId, "enabled");
			else if (action === "disable") nextOverrides.set(capabilityId, "disabled");
			else nextOverrides.delete(capabilityId);
			if (mapsEqual(projectOverrides, nextOverrides)) {
				ctx.ui.notify(`${capabilityId} 的项目覆盖未变化`, "info");
				return;
			}
			await persistProjectAndReload(ctx, nextOverrides);
		},
	});
}
