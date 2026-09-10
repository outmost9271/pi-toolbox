/**
 * Pi package 插件管控：发现 settings 中的 packages，计算插件级三态，并读写 pi 原生的过滤规则。
 *
 * 配置格式与 `pi config` 完全同构（均经本机 pi 0.85.1 实测）：
 * - 全局禁用：{ "source": "...", "extensions": [], "skills": [], "prompts": [], "themes": [] }
 * - 项目禁用：覆盖条目 + 四类空数组
 * - 项目启用（全局禁用时）：{ "source": "...", "autoload": false, "extensions": ["+相对路径", ...] }
 * - 项目继承：不写该包
 *
 * 本模块只依赖 node: 内置模块，便于测试直接导入。
 */

import { chmod, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export type PluginResourceKind = "extensions" | "skills" | "prompts" | "themes";
export type PluginState = "enabled" | "disabled" | "partial" | "custom";
export type PluginProjectState = "inherit" | PluginState;
export type PluginAction = "enable" | "disable" | "inherit";

export const PLUGIN_RESOURCE_KINDS: readonly PluginResourceKind[] = ["extensions", "skills", "prompts", "themes"];
export const PLUGIN_COMMAND_NAMES: readonly string[] = ["plugin", "plugins"];
export const PROJECT_DIR_NAME = ".pi";
export const SETTINGS_FILE_NAME = "settings.json";
export const PROTECTED_PLUGIN_IDS: readonly string[] = ["pi-toolbox", "pi-setmodel"];

const FILE_EXTENSIONS: Record<PluginResourceKind, string[]> = {
	extensions: [".ts", ".js"],
	skills: [".md"],
	prompts: [".md"],
	themes: [".json"],
};

const CONVENTIONAL_DIRS: Record<PluginResourceKind, string> = {
	extensions: "extensions",
	skills: "skills",
	prompts: "prompts",
	themes: "themes",
};

export interface CompletionItem {
	value: string;
	label: string;
	description?: string;
}

export interface PluginResource {
	kind: PluginResourceKind;
	path: string;
}

export interface PackageEntryInfo {
	index: number;
	raw: unknown;
	source: string;
	identity: string;
	id: string;
	autoload: boolean;
	filters: Partial<Record<PluginResourceKind, string[]>>;
	hasFilters: boolean;
}

export interface PluginInfo {
	id: string;
	source: string;
	identity: string;
	protected: boolean;
	installDir?: string;
	resources: PluginResource[];
	resourceWarnings: string[];
	globalEntry: PackageEntryInfo;
	projectEntry?: PackageEntryInfo;
	global: PluginState;
	project: PluginProjectState;
	effective: PluginState;
}

export interface PluginLoadResult {
	plugins: PluginInfo[];
	warnings: string[];
}

interface KindFilter {
	includes: string[];
	excludes: string[];
	allowPatterns: string[];
	denyPatterns: string[];
}

interface SettingsFile {
	path: string;
	exists: boolean;
	fileMode: number;
	invalid?: boolean;
	warnings: string[];
	data: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function globToRegExp(pattern: string): RegExp {
	let source = "";
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index] as string;
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				source += ".*";
				index += 1;
			} else {
				source += "[^/]*";
			}
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${source}$`);
}

function matchesResourcePattern(pattern: string, path: string): boolean {
	if (!pattern.includes("*") && !pattern.includes("?")) return pattern === path;
	return globToRegExp(pattern).test(path);
}

export function splitSourceRef(source: string): { base: string; ref?: string } {
	if (!source.startsWith("git:")) return { base: source };
	const body = source.slice(4);
	const match = body.match(/^(.*)@([^/@]*)$/);
	return match ? { base: match[1] as string, ref: match[2] } : { base: body };
}

export function packageIdentity(source: string): string {
	if (source.startsWith("git:")) return splitSourceRef(source).base;
	if (source.startsWith("npm:")) return source.slice(4).replace(/@[^/@]*$/, "");
	return source;
}

export function pluginShortId(source: string): string {
	const identity = packageIdentity(source);
	const name = identity.split("/").filter(Boolean).pop() ?? identity;
	return name.replace(/^git@/, "").replace(/\.git$/, "");
}

export function resolveInstallDir(
	source: string,
	scope: "global" | "project",
	agentDir: string,
	cwd: string,
): string | undefined {
	if (source.startsWith("git:")) {
		const base = splitSourceRef(source).base.replace(/^git@/, "");
		const root = scope === "global" ? join(agentDir, "git") : join(cwd, PROJECT_DIR_NAME, "git");
		return join(root, base);
	}
	if (source.startsWith("npm:")) {
		const name = source.slice(4).replace(/@[^/@]*$/, "");
		const root =
			scope === "global"
				? join(agentDir, "npm", "node_modules")
				: join(cwd, PROJECT_DIR_NAME, "npm", "node_modules");
		return join(root, name);
	}
	const baseDir = scope === "global" ? agentDir : join(cwd, PROJECT_DIR_NAME);
	return isAbsolute(source) ? source : resolve(baseDir, source);
}

function entryIdentity(source: string, baseDir: string): string {
	return source.startsWith("git:") || source.startsWith("npm:") ? packageIdentity(source) : resolve(baseDir, source);
}

export function parsePackageEntry(raw: unknown, index: number, baseDir: string): PackageEntryInfo | undefined {
	if (typeof raw === "string") {
		const source = raw.trim();
		if (!source) return undefined;
		const identity = entryIdentity(source, baseDir);
		return { index, raw, source, identity, id: pluginShortId(identity), autoload: true, filters: {}, hasFilters: false };
	}
	if (!isRecord(raw) || typeof raw.source !== "string" || !raw.source.trim()) return undefined;
	const source = raw.source.trim();
	const filters: Partial<Record<PluginResourceKind, string[]>> = {};
	for (const kind of PLUGIN_RESOURCE_KINDS) {
		if (isStringArray(raw[kind])) filters[kind] = raw[kind] as string[];
	}
	const identity = entryIdentity(source, baseDir);
	return {
		index,
		raw,
		source,
		identity,
		id: pluginShortId(identity),
		autoload: raw.autoload !== false,
		filters,
		hasFilters: Object.keys(filters).length > 0,
	};
}

export function parsePackages(packages: unknown, baseDir: string): { entries: PackageEntryInfo[]; warnings: string[] } {
	const entries: PackageEntryInfo[] = [];
	const warnings: string[] = [];
	if (packages === undefined) return { entries, warnings };
	if (!Array.isArray(packages)) return { entries, warnings: ["packages 必须是数组，已忽略"] };
	for (let index = 0; index < packages.length; index += 1) {
		const entry = parsePackageEntry(packages[index], index, baseDir);
		if (entry) entries.push(entry);
		else warnings.push(`packages[${index}] 条目无效，已忽略`);
	}
	return { entries, warnings };
}

function parseKindFilter(values: string[]): KindFilter {
	const filter: KindFilter = { includes: [], excludes: [], allowPatterns: [], denyPatterns: [] };
	for (const value of values) {
		if (value.startsWith("+")) filter.includes.push(value.slice(1));
		else if (value.startsWith("-") && !value.startsWith("--")) filter.excludes.push(value.slice(1));
		else if (value.startsWith("!")) filter.denyPatterns.push(value.slice(1));
		else filter.allowPatterns.push(value);
	}
	return filter;
}

function resourceAllowed(filter: KindFilter, path: string): boolean {
	if (filter.includes.includes(path)) return true;
	if (filter.excludes.includes(path)) return false;
	if (filter.denyPatterns.some((pattern) => matchesResourcePattern(pattern, path))) return false;
	if (filter.allowPatterns.length > 0) {
		return filter.allowPatterns.some((pattern) => matchesResourcePattern(pattern, path));
	}
	return true;
}

function filterState(values: string[] | undefined, resources: string[], emptyMeansDisabled: boolean): PluginState {
	if (values === undefined) return "enabled";
	if (values.length === 0) return emptyMeansDisabled ? "disabled" : "enabled";
	const filter = parseKindFilter(values);
	const hasInclude = filter.includes.length > 0;
	const hasExclude = filter.excludes.length > 0 || filter.denyPatterns.length > 0;
	const hasPatterns = filter.allowPatterns.length > 0;
	if (hasInclude && !hasExclude && !hasPatterns) return "enabled";
	if (resources.length === 0) {
		if (hasInclude) return "enabled";
		if (hasExclude) return "disabled";
		return "custom";
	}
	const allowed = resources.filter((path) => resourceAllowed(filter, path));
	if (allowed.length === resources.length) return hasPatterns ? "custom" : "enabled";
	if (allowed.length === 0) return "disabled";
	return hasPatterns ? "custom" : "partial";
}

function combineKindStates(states: PluginState[]): PluginState {
	if (states.every((state) => state === "enabled")) return "enabled";
	if (states.every((state) => state === "disabled")) return "disabled";
	if (states.includes("custom")) return "custom";
	return "partial";
}

function resourcesByKind(resources: PluginResource[], kind: PluginResourceKind): string[] {
	return resources.filter((resource) => resource.kind === kind).map((resource) => resource.path);
}

function globalPluginState(entry: PackageEntryInfo, resources: PluginResource[]): PluginState {
	if (!entry.hasFilters) return "enabled";
	return combineKindStates(
		PLUGIN_RESOURCE_KINDS.map((kind) => filterState(entry.filters[kind], resourcesByKind(resources, kind), true)),
	);
}

function deltaProjectState(entry: PackageEntryInfo, resources: PluginResource[]): PluginProjectState {
	let hasInclude = false;
	let hasExclude = false;
	let hasPattern = false;
	for (const kind of PLUGIN_RESOURCE_KINDS) {
		const values = entry.filters[kind];
		if (!values || values.length === 0) continue; // 空数组在 delta 中无效（pi 实测）
		const filter = parseKindFilter(values);
		if (filter.includes.length > 0) hasInclude = true;
		if (filter.excludes.length > 0 || filter.denyPatterns.length > 0) {
			hasExclude = true;
			const kindResources = resourcesByKind(resources, kind);
			if (kindResources.length > 0 && kindResources.every((path) => !resourceAllowed(filter, path))) {
				// 该类资源被全部排除。
			}
		}
		if (filter.allowPatterns.length > 0) hasPattern = true;
	}
	if (hasInclude && hasExclude) return "partial";
	if (hasInclude) return "enabled";
	if (hasExclude) return "disabled";
	if (hasPattern) return "custom";
	return "inherit";
}

function overrideProjectState(entry: PackageEntryInfo, resources: PluginResource[]): PluginState {
	if (!entry.hasFilters) return "enabled";
	const allEmpty = PLUGIN_RESOURCE_KINDS.every(
		(kind) => entry.filters[kind] === undefined || (entry.filters[kind] as string[]).length === 0,
	);
	if (allEmpty) return "disabled";
	return combineKindStates(
		PLUGIN_RESOURCE_KINDS.map((kind) => filterState(entry.filters[kind], resourcesByKind(resources, kind), true)),
	);
}

export function computePluginStates(
	globalEntry: PackageEntryInfo,
	projectEntry: PackageEntryInfo | undefined,
	resources: PluginResource[],
): { global: PluginState; project: PluginProjectState; effective: PluginState } {
	const global = globalPluginState(globalEntry, resources);
	if (!projectEntry) return { global, project: "inherit", effective: global };

	if (!projectEntry.autoload) {
		const project = deltaProjectState(projectEntry, resources);
		if (project === "inherit") return { global, project, effective: global };
		if (project === "enabled" || project === "partial") {
			return { global, project, effective: project };
		}
		if (project === "disabled") return { global, project, effective: "disabled" };
		return { global, project, effective: "custom" };
	}

	const project = overrideProjectState(projectEntry, resources);
	if (project === "enabled" && global === "disabled" && !projectEntry.hasFilters) {
		// 覆盖条目不带过滤时不能恢复被全局禁用的插件（pi 实测），按实际效果标注。
		return { global, project, effective: "disabled" };
	}
	return { global, project, effective: project };
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

function stripDotSlash(value: string): string {
	return value.replace(/^\.\//, "").replace(/\/$/, "");
}

async function expandManifestEntry(
	installDir: string,
	kind: PluginResourceKind,
	value: string,
	warnings: string[],
): Promise<PluginResource[]> {
	const normalized = value.replace(/^\.\//, "");
	if (normalized.startsWith("!")) return [];
	const relativePath = stripDotSlash(normalized);
	const target = isAbsolute(normalized) ? normalized : join(installDir, normalized);
	if (normalized.includes("*") || normalized.includes("?")) {
		const regex = globToRegExp(normalized);
		const matches: PluginResource[] = [];
		const walk = async (directory: string, prefix: string): Promise<void> => {
			let children;
			try {
				children = await readdir(directory, { withFileTypes: true });
			} catch {
				return;
			}
			for (const child of children) {
				if (child.name === "node_modules" || child.name.startsWith(".")) continue;
				const childPath = prefix ? `${prefix}/${child.name}` : child.name;
				if (child.isDirectory()) await walk(join(directory, child.name), childPath);
				else if (regex.test(childPath)) matches.push({ kind, path: childPath });
			}
		};
		await walk(installDir, "");
		if (matches.length === 0) warnings.push(`${kind} 通配模式未匹配到资源：${value}`);
		return matches;
	}
	if (await isFile(target)) return [{ kind, path: relativePath }];
	if (await isDirectory(target)) {
		const children = await readdir(target, { withFileTypes: true });
		if (kind === "skills") {
			const skills: PluginResource[] = [];
			for (const child of children) {
				if (child.isDirectory() && (await isFile(join(target, child.name, "SKILL.md")))) {
					skills.push({ kind, path: `${relativePath}/${child.name}` });
				}
			}
			if (skills.length > 0) return skills;
			return children
				.filter((child) => child.isFile() && child.name.endsWith(".md"))
				.map((child) => ({ kind, path: `${relativePath}/${child.name}` }));
		}
		const extensions = FILE_EXTENSIONS[kind];
		return children
			.filter((child) => child.isFile() && extensions.some((extension) => child.name.endsWith(extension)))
			.map((child) => ({ kind, path: `${relativePath}/${child.name}` }));
	}
	warnings.push(`${kind} 资源不存在：${value}`);
	return [];
}

async function discoverKindResources(
	installDir: string,
	kind: PluginResourceKind,
	manifestValue: unknown,
	warnings: string[],
): Promise<PluginResource[]> {
	if (isStringArray(manifestValue) && manifestValue.length > 0) {
		const resources: PluginResource[] = [];
		for (const value of manifestValue) {
			if (typeof value !== "string") continue;
			resources.push(...(await expandManifestEntry(installDir, kind, value, warnings)));
		}
		return resources;
	}
	const conventional = join(installDir, CONVENTIONAL_DIRS[kind]);
	if (!(await isDirectory(conventional))) return [];
	if (kind === "skills") {
		const children = await readdir(conventional, { withFileTypes: true });
		const skills: PluginResource[] = [];
		for (const child of children) {
			if (child.isDirectory() && (await isFile(join(conventional, child.name, "SKILL.md")))) {
				skills.push({ kind, path: `${CONVENTIONAL_DIRS[kind]}/${child.name}` });
			}
		}
		return skills;
	}
	const children = await readdir(conventional, { withFileTypes: true });
	const extensions = FILE_EXTENSIONS[kind];
	return children
		.filter((child) => child.isFile() && extensions.some((extension) => child.name.endsWith(extension)))
		.map((child) => ({ kind, path: `${CONVENTIONAL_DIRS[kind]}/${child.name}` }));
}

export function dedupeResources(resources: PluginResource[]): PluginResource[] {
	const seen = new Set<string>();
	return resources.filter((resource) => {
		const key = `${resource.kind}:${resource.path}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export async function discoverPluginResources(
	installDir: string,
): Promise<{ resources: PluginResource[]; warnings: string[] }> {
	const warnings: string[] = [];
	if (!(await isDirectory(installDir))) {
		return { resources: [], warnings: [`安装目录不存在：${installDir}`] };
	}
	let manifest: Record<string, unknown> | undefined;
	try {
		const parsed: unknown = JSON.parse(await readFile(join(installDir, "package.json"), "utf8"));
		if (isRecord(parsed)) manifest = parsed;
	} catch {
		manifest = undefined;
	}
	const manifestPi = manifest && isRecord(manifest.pi) ? (manifest.pi as Record<string, unknown>) : undefined;
	const resources: PluginResource[] = [];
	for (const kind of PLUGIN_RESOURCE_KINDS) {
		const manifestValue = manifestPi?.[kind];
		if (manifestValue !== undefined && !isStringArray(manifestValue)) {
			warnings.push(`package.json 的 pi.${kind} 不是字符串数组，已忽略`);
		}
		resources.push(...(await discoverKindResources(installDir, kind, manifestValue, warnings)));
	}
	return { resources: dedupeResources(resources), warnings };
}

export async function readSettingsFile(path: string): Promise<SettingsFile> {
	let raw: string;
	let fileMode = 0o600;
	try {
		raw = await readFile(path, "utf8");
		try {
			fileMode = (await stat(path)).mode & 0o777;
		} catch {
			fileMode = 0o600;
		}
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return { path, exists: false, fileMode, warnings: [], data: {} };
		return {
			path,
			exists: false,
			fileMode,
			warnings: [`读取失败：${error instanceof Error ? error.message : String(error)}`],
			data: {},
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			path,
			exists: true,
			fileMode,
			invalid: true,
			warnings: [`JSON 无效（未修改）：${error instanceof Error ? error.message : String(error)}`],
			data: {},
		};
	}
	if (!isRecord(parsed)) {
		return { path, exists: true, fileMode, invalid: true, warnings: ["配置必须是 JSON 对象（未修改）"], data: {} };
	}
	return { path, exists: true, fileMode, warnings: [], data: parsed };
}

export async function writeSettingsFile(file: SettingsFile): Promise<void> {
	await mkdir(dirname(file.path), { recursive: true });
	const temporaryPath = join(dirname(file.path), `.${basename(file.path)}.${process.pid}.${Date.now()}.tmp`);
	await writeFile(temporaryPath, `${JSON.stringify(file.data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporaryPath, file.path);
	await chmod(file.path, file.exists ? file.fileMode : 0o600);
}

function clonePackages(packages: unknown): unknown[] {
	return Array.isArray(packages) ? packages.map((entry) => (isRecord(entry) ? { ...entry } : entry)) : [];
}

function disabledEntry(source: string): Record<string, unknown> {
	return { source, extensions: [], skills: [], prompts: [], themes: [] };
}

function findEntryIndex(entries: PackageEntryInfo[], identity: string): number {
	return entries.findIndex((entry) => entry.identity === identity);
}

function packagesChanged(before: unknown[], after: unknown[]): boolean {
	return JSON.stringify(before) !== JSON.stringify(after);
}

export function setGlobalDisabled(packages: unknown[], identity: string, baseDir: string, source: string): unknown[] {
	const next = clonePackages(packages);
	const parsed = parsePackages(next, baseDir).entries;
	const index = findEntryIndex(parsed, identity);
	if (index < 0) return next;
	next[index] = disabledEntry(parsed[index]?.source ?? source);
	return next;
}

export function setGlobalEnabled(packages: unknown[], identity: string, baseDir: string): unknown[] {
	const next = clonePackages(packages);
	const parsed = parsePackages(next, baseDir).entries;
	const index = findEntryIndex(parsed, identity);
	if (index < 0) return next;
	const entry = parsed[index] as PackageEntryInfo;
	if (!entry.hasFilters) return next;
	next[index] = entry.source;
	return next;
}

export function setProjectDisabled(packages: unknown[], identity: string, baseDir: string, source: string): unknown[] {
	const next = clonePackages(packages);
	const parsed = parsePackages(next, baseDir).entries;
	const index = findEntryIndex(parsed, identity);
	const entry = disabledEntry(source);
	if (index < 0) next.push(entry);
	else next[index] = entry;
	return next;
}

export function setProjectEnabled(
	packages: unknown[],
	identity: string,
	baseDir: string,
	source: string,
	resources: PluginResource[],
): unknown[] | { error: string } {
	const includes: Partial<Record<PluginResourceKind, string[]>> = {};
	for (const kind of PLUGIN_RESOURCE_KINDS) {
		const paths = resources.filter((resource) => resource.kind === kind).map((resource) => `+${resource.path}`);
		if (paths.length > 0) includes[kind] = paths;
	}
	if (Object.keys(includes).length === 0) {
		return { error: "无法发现该插件的资源清单，不能生成项目启用规则" };
	}
	const next = clonePackages(packages);
	const parsed = parsePackages(next, baseDir).entries;
	const index = findEntryIndex(parsed, identity);
	const entry: Record<string, unknown> = { source, autoload: false, ...includes };
	if (index < 0) next.push(entry);
	else next[index] = entry;
	return next;
}

export function removePackageEntry(packages: unknown[], identity: string, baseDir: string): unknown[] {
	const next = clonePackages(packages);
	const parsed = parsePackages(next, baseDir).entries;
	const index = findEntryIndex(parsed, identity);
	if (index >= 0) next.splice(index, 1);
	return next;
}

export interface SetPluginStateResult {
	changed: boolean;
	warnings: string[];
	error?: string;
}

export async function setProjectPluginState(options: {
	cwd: string;
	plugin: PluginInfo;
	action: PluginAction;
}): Promise<SetPluginStateResult> {
	if (options.action === "disable" && options.plugin.protected) {
		return { changed: false, warnings: [], error: `${options.plugin.id} 在保护名单中，不允许禁用` };
	}
	const path = join(options.cwd, PROJECT_DIR_NAME, SETTINGS_FILE_NAME);
	const file = await readSettingsFile(path);
	if (file.invalid) return { changed: false, warnings: file.warnings, error: "项目 settings.json 无效，已中止写入" };
	const baseDir = dirname(path);
	const before = Array.isArray(file.data.packages) ? (file.data.packages as unknown[]) : [];
	let after: unknown[];
	if (options.action === "inherit") {
		after = removePackageEntry(file.data.packages, options.plugin.identity, baseDir);
	} else if (options.action === "disable") {
		after = setProjectDisabled(file.data.packages, options.plugin.identity, baseDir, options.plugin.source);
	} else {
		const result = setProjectEnabled(
			file.data.packages,
			options.plugin.identity,
			baseDir,
			options.plugin.source,
			options.plugin.resources,
		);
		if (!Array.isArray(result)) return { changed: false, warnings: [], error: result.error };
		after = result;
	}
	if (!packagesChanged(before, after)) return { changed: false, warnings: file.warnings };
	file.data.packages = after;
	await writeSettingsFile(file);
	return { changed: true, warnings: file.warnings };
}

export async function setGlobalPluginState(options: {
	agentDir: string;
	plugin: PluginInfo;
	action: "enable" | "disable";
}): Promise<SetPluginStateResult> {
	if (options.action === "disable" && options.plugin.protected) {
		return { changed: false, warnings: [], error: `${options.plugin.id} 在保护名单中，不允许禁用` };
	}
	const path = join(options.agentDir, SETTINGS_FILE_NAME);
	const file = await readSettingsFile(path);
	if (file.invalid) return { changed: false, warnings: file.warnings, error: "全局 settings.json 无效，已中止写入" };
	const baseDir = dirname(path);
	const before = Array.isArray(file.data.packages) ? (file.data.packages as unknown[]) : [];
	const after =
		options.action === "disable"
			? setGlobalDisabled(file.data.packages, options.plugin.identity, baseDir, options.plugin.source)
			: setGlobalEnabled(file.data.packages, options.plugin.identity, baseDir);
	if (!packagesChanged(before, after)) return { changed: false, warnings: file.warnings };
	file.data.packages = after;
	await writeSettingsFile(file);
	return { changed: true, warnings: file.warnings };
}

export async function loadPluginInfo(options: { cwd: string; agentDir: string }): Promise<PluginLoadResult> {
	const warnings: string[] = [];
	const globalPath = join(options.agentDir, SETTINGS_FILE_NAME);
	const projectPath = join(options.cwd, PROJECT_DIR_NAME, SETTINGS_FILE_NAME);
	const [globalFile, projectFile] = await Promise.all([readSettingsFile(globalPath), readSettingsFile(projectPath)]);
	for (const warning of globalFile.warnings) warnings.push(`${globalPath}: ${warning}`);
	for (const warning of projectFile.warnings) warnings.push(`${projectPath}: ${warning}`);
	if (globalFile.invalid || projectFile.invalid) {
		return { plugins: [], warnings };
	}

	const globalParsed = parsePackages(globalFile.data.packages, dirname(globalPath));
	const projectParsed = parsePackages(projectFile.data.packages, dirname(projectPath));
	for (const warning of globalParsed.warnings) warnings.push(`${globalPath}: ${warning}`);
	for (const warning of projectParsed.warnings) warnings.push(`${projectPath}: ${warning}`);

	const projectByIdentity = new Map(projectParsed.entries.map((entry) => [entry.identity, entry]));
	const plugins: PluginInfo[] = [];
	for (const globalEntry of globalParsed.entries) {
		const projectEntry = projectByIdentity.get(globalEntry.identity);
		const installDir = resolveInstallDir(globalEntry.source, "global", options.agentDir, options.cwd);
		const discovery = installDir
			? await discoverPluginResources(installDir)
			: { resources: [], warnings: [`无法定位安装目录：${globalEntry.source}`] };
		const plugin: PluginInfo = {
			id: globalEntry.id,
			source: globalEntry.source,
			identity: globalEntry.identity,
			protected: PROTECTED_PLUGIN_IDS.includes(globalEntry.id),
			installDir,
			resources: discovery.resources,
			resourceWarnings: discovery.warnings,
			globalEntry,
			projectEntry,
			global: "enabled",
			project: "inherit",
			effective: "enabled",
		};
		const states = computePluginStates(globalEntry, projectEntry, discovery.resources);
		plugin.global = states.global;
		plugin.project = states.project;
		plugin.effective = states.effective;
		plugins.push(plugin);
	}
	for (const entry of projectParsed.entries) {
		if (!plugins.some((plugin) => plugin.identity === entry.identity)) {
			warnings.push(`${projectPath}: 项目包 ${entry.source} 未在全局 settings 中声明，暂不纳入插件管控`);
		}
	}
	return { plugins, warnings };
}

function stateSymbol(state: string): string {
	if (state === "enabled") return "●";
	if (state === "disabled") return "○";
	if (state === "partial") return "◐";
	return "◆";
}

function stateLabel(state: PluginState, scope: "global" | "project" | "effective"): string {
	const prefix = scope === "global" ? "全局" : scope === "project" ? "项目" : "最终";
	if (state === "enabled") return `${prefix}启用`;
	if (state === "disabled") return `${prefix}禁用`;
	if (state === "partial") return `${prefix}部分禁用`;
	return `${prefix}自定义过滤`;
}

function projectStateLabel(plugin: PluginInfo): string {
	if (plugin.project === "inherit") return `继承（${stateLabel(plugin.global, "global")}）`;
	return stateLabel(plugin.project, "project");
}

export function formatPluginsList(plugins: PluginInfo[]): string {
	if (plugins.length === 0) return "未在全局 settings 中发现任何插件";
	return plugins
		.map((plugin) => `${stateSymbol(plugin.effective)} ${plugin.id}${plugin.protected ? " [保护]" : ""} — ${projectStateLabel(plugin)}`)
		.join("\n");
}

export function formatPluginDetail(plugin: PluginInfo): string {
	const lines = [
		`${stateSymbol(plugin.effective)} ${plugin.id}${plugin.protected ? " [保护]" : ""}`,
		`source: ${plugin.source}`,
		`${stateLabel(plugin.global, "global")} · ${projectStateLabel(plugin)} · ${stateLabel(plugin.effective, "effective")}`,
	];
	if (plugin.resources.length > 0) {
		const summary = PLUGIN_RESOURCE_KINDS.map((kind) => {
			const count = plugin.resources.filter((resource) => resource.kind === kind).length;
			return count > 0 ? `${kind} ${count}` : undefined;
		}).filter(Boolean);
		lines.push(`资源: ${summary.join(" · ")}`);
		if (plugin.project === "enabled" || plugin.effective !== "enabled") {
			for (const resource of plugin.resources) lines.push(`  ${resource.kind}: ${resource.path}`);
		}
	}
	for (const warning of plugin.resourceWarnings) lines.push(`警告: ${warning}`);
	return lines.join("\n");
}

export function findPlugin(plugins: PluginInfo[], id: string): PluginInfo | undefined {
	return plugins.find((plugin) => plugin.id === id);
}

const PROJECT_PLUGIN_ACTIONS = ["status", "enable", "disable", "inherit", "global"];
const GLOBAL_PLUGIN_ACTIONS = ["status", "enable", "disable"];

export function getPluginCompletions(argumentPrefix: string, plugins: PluginInfo[]): CompletionItem[] | null {
	const normalized = argumentPrefix.replace(/^[ \t]+/, "").replace(/[ \t]+/g, " ");
	if (!/^plugins?(\s|$)/.test(normalized)) return null;
	const parts = normalized.split(" ");
	if (parts[0] === "plugins") {
		if (parts.length === 1) return [{ value: "plugins ", label: "plugins" }];
		const query = parts[1] as string;
		const matches = ["status", "list"].filter((value) => value.startsWith(query));
		return matches.length > 0 ? matches.map((value) => ({ value: `plugins ${value}`, label: value })) : null;
	}
	if (parts.length === 1 || (parts.length === 2 && parts[1] === "")) {
		return PROJECT_PLUGIN_ACTIONS.map((value) => ({
			value: `plugin ${value}${value === "status" ? "" : " "}`,
			label: value,
		}));
	}
	if (parts[1] === "global") {
		if (parts.length <= 3 && (parts.length === 2 || parts[2] === "")) {
			return GLOBAL_PLUGIN_ACTIONS.map((value) => ({
				value: `plugin global ${value}${value === "status" ? "" : " "}`,
				label: value,
			}));
		}
		const action = parts[2] as "status" | "enable" | "disable";
		if (action === "status") return null;
		const candidates = plugins
			.filter((plugin) => {
				if (action === "disable") return !plugin.protected && plugin.global !== "disabled";
				return plugin.global !== "enabled";
			})
			.map((plugin) => ({
				value: `plugin global ${action} ${plugin.id}`,
				label: plugin.id,
				description: plugin.protected ? "受保护" : undefined,
			}));
		return candidates.length > 0 ? candidates : null;
	}
	const action = parts[1] as "status" | "enable" | "disable" | "inherit";
	if (action === "status") return null;
	const candidates = plugins
		.filter((plugin) => {
			if (action === "disable") return !plugin.protected && plugin.effective !== "disabled";
			if (action === "enable") return plugin.effective !== "enabled";
			return plugin.project !== "inherit";
		})
		.map((plugin) => ({
			value: `plugin ${action} ${plugin.id}`,
			label: plugin.id,
			description: plugin.protected ? "受保护" : undefined,
		}));
	return candidates.length > 0 ? candidates : null;
}
