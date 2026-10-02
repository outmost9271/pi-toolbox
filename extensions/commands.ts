/** Shared command grammar and completion stages; no Pi runtime or file access. */
export type ToolboxCategory = "skills" | "extensions";
export type ConfigScope = "project" | "global";
export type ToolboxAction = "status" | "enable" | "disable" | "inherit" | "config";

export const TOOLBOX_CATEGORIES: readonly ToolboxCategory[] = ["skills", "extensions"];
export const TOOLBOX_SCOPES: readonly ConfigScope[] = ["project", "global"];
export const TOOLBOX_HELP = [
	"用法：",
	"/toolbox skills [project|global] [status|config|enable <能力>|disable <能力>|inherit <能力>]",
	"/toolbox extensions [project|global] [status [<插件>]|enable <插件>|disable <插件>|inherit <插件>]",
	"省略作用域时使用当前项目；省略动作时查询状态；全局不支持 inherit。",
].join("\n");

export interface ToolboxCommand {
	category: ToolboxCategory;
	scope: ConfigScope;
	action: ToolboxAction;
	id?: string;
}

export interface CompletionItem {
	value: string;
	label: string;
	description?: string;
}

export interface CompletionObject {
	id: string;
	searchText?: string;
	description?: string;
}

export function actionsForScope(category: ToolboxCategory, scope: ConfigScope): ToolboxAction[] {
	const actions: ToolboxAction[] = ["status", "enable", "disable"];
	if (scope === "project") actions.push("inherit");
	if (category === "skills") actions.push("config");
	return actions;
}

export function actionNeedsObject(action: ToolboxAction): boolean {
	return action === "enable" || action === "disable" || action === "inherit";
}

function actionAcceptsObject(category: ToolboxCategory, action: ToolboxAction): boolean {
	return actionNeedsObject(action) || (category === "extensions" && action === "status");
}

export function parseToolboxCommand(args: string): ToolboxCommand | undefined {
	const tokens = args.trim().split(/\s+/);
	const category = tokens.shift() as ToolboxCategory;
	if (!TOOLBOX_CATEGORIES.includes(category)) return undefined;

	let scope: ConfigScope = "project";
	if (TOOLBOX_SCOPES.includes(tokens[0] as ConfigScope)) scope = tokens.shift() as ConfigScope;
	const action = (tokens.shift() ?? "status") as ToolboxAction;
	if (!actionsForScope(category, scope).includes(action)) return undefined;

	const id = tokens.shift();
	if (tokens.length > 0 || (id && !actionAcceptsObject(category, action))) return undefined;
	if (actionNeedsObject(action) && !id) return undefined;
	return { category, scope, action, ...(id ? { id } : {}) };
}

export function getToolboxCompletions(
	argumentPrefix: string,
	getObjects: (category: ToolboxCategory, scope: ConfigScope, action: ToolboxAction) => CompletionObject[],
): CompletionItem[] | null {
	// Preserve the trailing separator: it selects the next completion stage.
	const normalized = argumentPrefix.replace(/^[ \t]+/, "").replace(/[ \t]+/g, " ");
	const firstSeparator = normalized.indexOf(" ");
	if (firstSeparator < 0) {
		const categories = TOOLBOX_CATEGORIES.filter((category) => category.startsWith(normalized));
		return categories.length > 0
			? categories.map((category) => ({ value: `${category} `, label: category }))
			: null;
	}

	const category = normalized.slice(0, firstSeparator) as ToolboxCategory;
	if (!TOOLBOX_CATEGORIES.includes(category)) return null;
	let remainder = normalized.slice(firstSeparator + 1);
	let scope: ConfigScope = "project";
	let valuePrefix = `${category} `;
	const scopedMatch = remainder.match(/^(project|global) (.*)$/);
	if (scopedMatch) {
		scope = scopedMatch[1] as ConfigScope;
		remainder = scopedMatch[2] as string;
		valuePrefix += `${scope} `;
	}

	const separator = remainder.indexOf(" ");
	if (separator < 0) {
		const candidates: (ConfigScope | ToolboxAction)[] = [
			...(scopedMatch ? [] : TOOLBOX_SCOPES),
			...actionsForScope(category, scope),
		];
		const matches = candidates.filter((candidate) => candidate.startsWith(remainder));
		return matches.length > 0
			? matches.map((candidate) => ({
					value: `${valuePrefix}${candidate}${TOOLBOX_SCOPES.includes(candidate as ConfigScope) || actionAcceptsObject(category, candidate as ToolboxAction) ? " " : ""}`,
					label: candidate,
				}))
			: null;
	}

	const action = remainder.slice(0, separator) as ToolboxAction;
	if (!actionsForScope(category, scope).includes(action) || !actionAcceptsObject(category, action)) return null;
	const query = remainder.slice(separator + 1).trim().toLowerCase();
	const objects = getObjects(category, scope, action).filter((object) =>
		(object.searchText ?? object.id).toLowerCase().includes(query),
	);
	return objects.length > 0
		? objects.map((object) => ({
				value: `${valuePrefix}${action} ${object.id}`,
				label: object.id,
				description: object.description,
			}))
		: null;
}
