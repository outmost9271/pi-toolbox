import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { CombinedAutocompleteProvider, Editor } from "@earendil-works/pi-tui";
import { getToolboxCompletions } from "../extensions/commands.ts";
import { getPluginCompletionCandidates } from "../extensions/plugins.ts";

// Exercise production helpers without starting an agent or reading user config.
const source = readFileSync(new URL("../extensions/index.ts", import.meta.url), "utf8");
const helpers = source.slice(source.indexOf("function completionCandidates("), source.indexOf("export default function"));
const { getToolboxArgumentCompletions, createToolboxAutocompleteProvider } = runInNewContext(
  stripTypeScriptTypes(helpers) + ";({ getToolboxArgumentCompletions, createToolboxAutocompleteProvider })",
  { getToolboxCompletions, getPluginCompletionCandidates },
);
const capabilities = [
  { id: "exa", name: "Exa", description: "Search" },
  { id: "gh", name: "GitHub", description: "GitHub CLI" },
];
const plugins = [
  { id: "pi-toolbox", source: "git:github.com/example/pi-toolbox", protected: true, global: "enabled", project: "inherit", effective: "enabled" },
  { id: "browser", source: "git:github.com/example/browser", protected: false, global: "disabled", project: "inherit", effective: "disabled" },
  { id: "other", source: "npm:other", protected: false, global: "enabled", project: "disabled", effective: "disabled" },
];
const complete = (prefix) => getToolboxArgumentCompletions(prefix, capabilities, new Set(["gh"]), new Map([["exa", "disabled"]]), plugins);
const labels = (prefix) => complete(prefix)?.map((item) => item.label).join() ?? null;
const base = new CombinedAutocompleteProvider([]);
const provider = createToolboxAutocompleteProvider(base, complete);
const options = { signal: new AbortController().signal, force: true };
const delay = () => new Promise((resolve) => setTimeout(resolve, 30));

async function apply(line, label, cursorCol = line.length) {
  const suggestions = await provider.getSuggestions([line], 0, cursorCol, options);
  assert.ok(suggestions, `No suggestions for ${JSON.stringify(line)}`);
  const item = suggestions.items.find((item) => item.label === label);
  assert.ok(item, `Missing ${label} for ${JSON.stringify(line)}`);
  return provider.applyCompletion([line], 0, cursorCol, item, suggestions.prefix);
}

test("top-level candidates are exactly skills and extensions", () => {
  assert.equal(labels(""), "skills,extensions");
  assert.equal(labels("  \t"), "skills,extensions");
  assert.equal(labels("sk"), "skills");
  assert.equal(labels("ext"), "extensions");
});

for (const category of ["skills", "extensions"]) {
  for (const scope of ["global", "project"]) {
    test(`${category}: category -> ${scope} -> action -> object`, async () => {
      const id = category === "skills" ? "exa" : "browser";
      let result = await apply(`/toolbox ${category.slice(0, 2)}`, category);
      assert.equal(result.lines[0], `/toolbox ${category} `);
      result = await apply(result.lines[0] + scope.slice(0, 2), scope);
      assert.equal(result.lines[0], `/toolbox ${category} ${scope} `);
      result = await apply(result.lines[0] + "en", "enable");
      assert.equal(result.lines[0], `/toolbox ${category} ${scope} enable `);
      result = await apply(result.lines[0], id);
      assert.equal(result.lines[0], `/toolbox ${category} ${scope} enable ${id}`);
      assert.equal(result.cursorCol, result.lines[0].length);
    });
  }
}

for (const line of [
  "/toolbox  skills  global ",
  "/toolbox\tskills\tglobal\t",
  "/toolbox skills global\ten",
  "/toolbox  extensions  project  ",
  "/toolbox\textensions\tglobal\ten",
]) {
  test(`whitespace: ${JSON.stringify(line)}`, async () => {
    const result = await apply(line, "enable");
    assert.match(result.lines[0], /^\/toolbox\s+(skills|extensions) (global|project) enable $/);
  });
}

for (const category of ["skills", "extensions"]) {
  for (const scope of ["global", "project"]) {
    test(`real editor Tab: ${category} ${scope}`, async () => {
      const identity = (text) => text;
      const editor = new Editor({ requestRender() {} }, {
        borderColor: identity,
        selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
      });
      editor.setAutocompleteProvider(provider);
      editor.setText(`/toolbox  ${category.slice(0, 2)}`);
      editor.handleInput("\t");
      await delay();
      assert.equal(editor.getText(), `/toolbox ${category} `);
      for (const char of scope.slice(0, 2)) editor.handleInput(char);
      await delay();
      editor.handleInput("\t");
      await delay();
      assert.equal(editor.getText(), `/toolbox ${category} ${scope} `);
      for (const char of "en") editor.handleInput(char);
      await delay();
      editor.handleInput("\t");
      await delay();
      assert.equal(editor.getText(), `/toolbox ${category} ${scope} enable `);
      const id = category === "skills" ? "exa" : "browser";
      for (const char of id.slice(0, 2)) editor.handleInput(char);
      await delay();
      editor.handleInput("\t");
      await delay();
      assert.equal(editor.getText(), `/toolbox ${category} ${scope} enable ${id}`);
    });
  }
}

test("scope omission uses project candidates and preserves short syntax", async () => {
  assert.equal((await apply("/toolbox skills en", "enable")).lines[0], "/toolbox skills enable ");
  assert.equal(labels("skills enable "), labels("skills project enable "));
  assert.equal(labels("extensions disable "), labels("extensions project disable "));
});

test("skills candidates use the requested scope and explicit project overrides", () => {
  assert.equal(labels("skills global enable "), "exa");
  assert.equal(labels("skills global disable "), "gh");
  assert.equal(labels("skills project enable "), "exa,gh");
  assert.equal(labels("skills project disable "), "gh");
  assert.equal(labels("skills project inherit "), "exa");
  assert.equal(labels("skills global inherit "), null);
});

test("extensions candidates use explicit overrides and protection", () => {
  assert.equal(labels("extensions global enable "), "browser");
  assert.equal(labels("extensions global disable "), "other");
  assert.equal(labels("extensions project enable "), "pi-toolbox,browser,other");
  assert.equal(labels("extensions project disable "), "browser");
  assert.equal(labels("extensions project inherit "), "other");
  assert.equal(labels("extensions global inherit "), null);
});

test("extension action and object prefixes are filtered", async () => {
  assert.equal((await apply("/toolbox extensions di", "disable")).lines[0], "/toolbox extensions disable ");
  assert.equal((await apply("/toolbox extensions global en", "enable")).lines[0], "/toolbox extensions global enable ");
  assert.equal(labels("extensions global disable ot"), "other");
  assert.equal(labels("extensions status br"), "browser");
  assert.equal(labels("extensions status missing"), null);
});

test("status supports optional extension objects, config only supports skills", async () => {
  assert.equal(labels("extensions status "), "pi-toolbox,browser,other");
  assert.equal(labels("extensions global status "), "pi-toolbox,browser,other");
  assert.equal(labels("skills status "), null);
  assert.ok(complete("skills ").some((item) => item.label === "config"));
  assert.ok(!complete("extensions ").some((item) => item.label === "config"));
  assert.equal((await apply("/toolbox skills global co", "config")).lines[0], "/toolbox skills global config");
});

test("removed commands and list aliases have no completions", () => {
  for (const prefix of ["project", "global ", "status", "enable ", "disable ", "inherit ", "plugin ", "plugins ", "list", "skills list", "extensions list", "extensions global config "]) {
    assert.equal(complete(prefix), null, prefix);
  }
});

test("cursor suffix, replacement prefix and trigger characters are preserved", async () => {
  const line = "/toolbox  extensions  global di tail";
  const cursor = "/toolbox  extensions  global di".length;
  const result = await apply(line, "disable", cursor);
  assert.equal(result.lines[0], "/toolbox extensions global disable  tail");
  assert.equal(result.cursorCol, "/toolbox extensions global disable ".length);
  const suggestions = await provider.getSuggestions([line], 0, cursor, options);
  assert.equal(suggestions.prefix, " extensions  global di");
  const wrapped = createToolboxAutocompleteProvider({ triggerCharacters: ["/"], getSuggestions() {}, applyCompletion() {} }, complete);
  assert.deepEqual(wrapped.triggerCharacters, ["/"]);
});

test("unrelated commands delegate to the original provider", async () => {
  const sentinel = { items: [], prefix: "other" };
  const wrapped = createToolboxAutocompleteProvider({
    getSuggestions: () => sentinel,
    applyCompletion: () => sentinel,
    shouldTriggerFileCompletion: () => false,
  }, complete);
  assert.equal(await wrapped.getSuggestions(["/other "], 0, 7, options), sentinel);
  assert.equal(wrapped.shouldTriggerFileCompletion(["/other "], 0, 7), false);
  assert.equal(wrapped.shouldTriggerFileCompletion(["/toolbox skills "], 0, 16), true);
});
