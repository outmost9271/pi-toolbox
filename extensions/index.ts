import { appendFile, chmod, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CONFIG_DIR_NAME,
	createBashTool,
	DynamicBorder,
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

interface ToolboxConfig {
	version: 1;
	enabled: string[];
}

interface LoadedConfig {
	exists: boolean;
	config: ToolboxConfig;
	warnings: string[];
}

interface ToolboxProcessState {
	__piToolboxApprovedCwds?: Set<string>;
}

const processState = globalThis as typeof globalThis & ToolboxProcessState;
const explicitlyApprovedCwds = (processState.__piToolboxApprovedCwds ??= new Set<string>());

function projectConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
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

		if (!raw || typeof raw !== "object") {
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

async function readProjectConfig(cwd: string): Promise<LoadedConfig> {
	const path = projectConfigPath(cwd);
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

	if (!raw || typeof raw !== "object") {
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

async function writeProjectConfig(cwd: string, enabled: Iterable<string>): Promise<void> {
	const path = projectConfigPath(cwd);
	const config: ToolboxConfig = { version: 1, enabled: [...new Set(enabled)].sort() };
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
	await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporaryPath, path);
	await chmod(path, 0o600);
}

function selectedCapabilities(capabilities: Capability[], enabled: ReadonlySet<string>): Capability[] {
	return capabilities.filter((capability) => enabled.has(capability.id));
}

function formatStatus(capabilities: Capability[], enabled: ReadonlySet<string>, active: boolean): string {
	if (capabilities.length === 0) return `未在 ${TOOLBOX_ROOT} 中发现能力`;
	const lines = capabilities.map(
		(capability) => `${enabled.has(capability.id) ? "●" : "○"} ${capability.id} — ${capability.description}`,
	);
	if (enabled.size > 0 && !active) lines.unshift("当前项目尚未受信任，已配置能力本次未加载。", "");
	return lines.join("\n");
}

function getToolboxArgumentCompletions(
	argumentPrefix: string,
	capabilities: Capability[],
	enabledIds: ReadonlySet<string>,
): AutocompleteItem[] | null {
	const actions = ["list", "status", "enable", "disable"];
	if (!argumentPrefix.includes(" ")) {
		const query = argumentPrefix.trim();
		const matches = actions.filter((action) => action.startsWith(query));
		return matches.length > 0
			? matches.map((action) => ({
					value: action === "enable" || action === "disable" ? `${action} ` : action,
					label: action,
				}))
			: null;
	}

	const match = argumentPrefix.match(/^(enable|disable)\s+(.*)$/);
	if (!match) return null;
	const action = match[1];
	const query = match[2].trim().toLowerCase();
	const candidates = capabilities.filter((capability) =>
		action === "enable" ? !enabledIds.has(capability.id) : enabledIds.has(capability.id),
	);
	const filtered = candidates.filter((capability) =>
		`${capability.id} ${capability.name} ${capability.description}`.toLowerCase().includes(query),
	);
	return filtered.length > 0
		? filtered.map((capability) => ({
				value: `${action} ${capability.id}`,
				label: capability.id,
				description: capability.description,
			}))
		: null;
}

function getToolboxArgumentPrefix(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
): string | undefined {
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
	let enabledIds = new Set<string>();
	let runtimeActive = false;
	let discoveryWarnings: string[] = [];

	async function refreshState(cwd: string): Promise<LoadedConfig> {
		runtimeCwd = cwd;
		const discovery = await discoverCapabilities();
		const loaded = await readProjectConfig(cwd);
		capabilities = discovery.capabilities;
		const knownIds = new Set(capabilities.map((capability) => capability.id));
		const unknownIds = loaded.config.enabled.filter((id) => !knownIds.has(id));
		enabledIds = new Set(loaded.config.enabled.filter((id) => knownIds.has(id)));
		discoveryWarnings = [
			...discovery.warnings,
			...loaded.warnings,
			...(unknownIds.length > 0 ? [`${projectConfigPath(cwd)}: 未发现能力 ${unknownIds.join(", ")}`] : []),
		];
		return loaded;
	}

	function enableBashPaths(cwd: string): void {
		const binPaths = [
			...new Set(selectedCapabilities(capabilities, enabledIds).flatMap((capability) => capability.resolvedBinPaths)),
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

	async function approveExplicitChange(ctx: ExtensionCommandContext): Promise<boolean> {
		if (ctx.isProjectTrusted() || explicitlyApprovedCwds.has(resolve(ctx.cwd))) return true;
		if (!ctx.hasUI) return false;
		const approved = await ctx.ui.confirm(
			"启用当前项目的 Toolbox 配置？",
			`${ctx.cwd}\n\n启用后，Agent 可以访问所选能力及其共享认证。`,
		);
		if (approved) explicitlyApprovedCwds.add(resolve(ctx.cwd));
		return approved;
	}

	async function persistAndReload(ctx: ExtensionCommandContext, nextEnabled: Set<string>): Promise<void> {
		if (!(await approveExplicitChange(ctx))) {
			ctx.ui.notify("未修改 Toolbox 配置", "warning");
			return;
		}

		const configPath = projectConfigPath(ctx.cwd);
		const excludeWarning = await ensureLocalGitExclude(pi, ctx.cwd, configPath);
		await writeProjectConfig(ctx.cwd, nextEnabled);
		if (excludeWarning) ctx.ui.notify(excludeWarning, "warning");
		await ctx.reload();
	}

	async function showSelector(ctx: ExtensionCommandContext): Promise<void> {
		await refreshState(ctx.cwd);
		if (capabilities.length === 0) {
			ctx.ui.notify(`未在 ${TOOLBOX_ROOT} 中发现能力`, "warning");
			return;
		}
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/toolbox 不带参数时需要 TUI 模式", "error");
			return;
		}

		const initial = new Set(enabledIds);
		const selected = new Set(enabledIds);
		await ctx.ui.custom((tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
			container.addChild(new Text(theme.fg("accent", theme.bold("项目能力配置")), 1, 0));

			const items: SettingItem[] = capabilities.map((capability) => ({
				id: capability.id,
				label: capability.name,
				description: capability.description,
				currentValue: selected.has(capability.id) ? "启用" : "关闭",
				values: ["启用", "关闭"],
			}));
			const settings = new SettingsList(
				items,
				Math.min(items.length + 2, 15),
				getSettingsListTheme(),
				(id, value) => {
					if (value === "启用") selected.add(id);
					else selected.delete(id);
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

		const changed =
			initial.size !== selected.size || [...initial].some((capabilityId) => !selected.has(capabilityId));
		if (changed) await persistAndReload(ctx, selected);
	}

	pi.on("project_trust", async (event, ctx) => {
		const loaded = await readProjectConfig(event.cwd);
		if (!loaded.exists || loaded.config.enabled.length === 0 || !ctx.hasUI) {
			return { trusted: "undecided" };
		}
		const trusted = await ctx.ui.confirm(
			"信任项目的 Toolbox 配置？",
			`${event.cwd}\n\n项目请求启用：${loaded.config.enabled.join(", ")}。`,
		);
		return { trusted: trusted ? "yes" : "no", remember: true };
	});

	pi.on("session_start", async (_event, ctx) => {
		await refreshState(ctx.cwd);
		if (ctx.mode === "tui") {
			ctx.ui.addAutocompleteProvider((current) =>
				createToolboxAutocompleteProvider(current, (argumentPrefix) =>
					getToolboxArgumentCompletions(argumentPrefix, capabilities, enabledIds),
				),
			);
		}
		runtimeActive = ctx.isProjectTrusted() || explicitlyApprovedCwds.has(resolve(ctx.cwd));
		if (runtimeActive) enableBashPaths(ctx.cwd);
		else if (enabledIds.size > 0) ctx.ui.notify("Toolbox 配置因项目未受信任而未加载", "warning");
		for (const warning of discoveryWarnings) ctx.ui.notify(warning, "warning");
	});

	pi.on("resources_discover", async (event, ctx) => {
		if (event.cwd !== runtimeCwd) await refreshState(event.cwd);
		const active = ctx.isProjectTrusted() || explicitlyApprovedCwds.has(resolve(event.cwd));
		if (!active) return { skillPaths: [] };
		return {
			skillPaths: [
				...new Set(
					selectedCapabilities(capabilities, enabledIds).flatMap((capability) => capability.resolvedSkillPaths),
				),
			],
		};
	});

	pi.registerCommand("toolbox", {
		description: "启用或关闭当前项目的共享能力",
		getArgumentCompletions: (argumentPrefix) =>
			getToolboxArgumentCompletions(argumentPrefix, capabilities, enabledIds),
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				await showSelector(ctx);
				return;
			}

			await refreshState(ctx.cwd);
			const [action, capabilityId, ...extra] = input.split(/\s+/);
			if (extra.length > 0 || !["list", "status", "enable", "disable"].includes(action)) {
				ctx.ui.notify("用法：/toolbox [list|status|enable <能力>|disable <能力>]", "error");
				return;
			}

			if (action === "list" || action === "status") {
				const active = ctx.isProjectTrusted() || explicitlyApprovedCwds.has(resolve(ctx.cwd));
				ctx.ui.notify(formatStatus(capabilities, enabledIds, active), "info");
				return;
			}

			if (!capabilityId) {
				ctx.ui.notify(`/toolbox ${action} 需要能力名称`, "error");
				return;
			}
			const capability = capabilities.find((item) => item.id === capabilityId);
			if (!capability) {
				ctx.ui.notify(`未知能力：${capabilityId}`, "error");
				return;
			}

			const nextEnabled = new Set(enabledIds);
			if (action === "enable") {
				if (nextEnabled.has(capabilityId)) {
					ctx.ui.notify(`${capabilityId} 已启用`, "info");
					return;
				}
				nextEnabled.add(capabilityId);
			} else {
				if (!nextEnabled.has(capabilityId)) {
					ctx.ui.notify(`${capabilityId} 已关闭`, "info");
					return;
				}
				nextEnabled.delete(capabilityId);
			}

			await persistAndReload(ctx, nextEnabled);
		},
	});
}
