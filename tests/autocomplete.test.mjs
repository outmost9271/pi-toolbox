import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { CombinedAutocompleteProvider, Editor } from "@earendil-works/pi-tui";

// Exercise the production helpers without starting an agent or reading user config.
const source = readFileSync(new URL("../extensions/index.ts", import.meta.url), "utf8");
const helpers = source.slice(source.indexOf("function actionsForScope("), source.indexOf("export default function"));
const { getToolboxArgumentCompletions, createToolboxAutocompleteProvider } = runInNewContext(
  stripTypeScriptTypes(helpers) + ";({ getToolboxArgumentCompletions, createToolboxAutocompleteProvider })",
  { PLUGIN_COMMAND_NAMES: ["plugin", "plugins"], getPluginCompletions: () => null },
);
const capabilities = [
  { id: "exa", name: "Exa", description: "Search" },
  { id: "gh", name: "GitHub", description: "GitHub CLI" },
];
const complete = (prefix) => getToolboxArgumentCompletions(prefix, capabilities, new Set(["gh"]), new Map([["exa", "disabled"]]));
const base = new CombinedAutocompleteProvider([]);
const provider = createToolboxAutocompleteProvider(base, complete);
const options = { signal: new AbortController().signal, force: true };

async function apply(line, label, cursorCol = line.length) {
  const suggestions = await provider.getSuggestions([line], 0, cursorCol, options);
  assert.ok(suggestions, `No suggestions for ${JSON.stringify(line)}`);
  const item = suggestions.items.find((item) => item.label === label);
  assert.ok(item, `Missing ${label} for ${JSON.stringify(line)}`);
  return provider.applyCompletion([line], 0, cursorCol, item, suggestions.prefix);
}

for (const scope of ["global", "project"]) {
  test(`${scope}: scope -> action -> capability`, async () => {
    let result = await apply(`/toolbox ${scope[0]}`, scope);
    assert.equal(result.lines[0], `/toolbox ${scope} `);
    result = await apply(result.lines[0], "enable");
    assert.equal(result.lines[0], `/toolbox ${scope} enable `);
    result = await apply(result.lines[0], "exa");
    assert.equal(result.lines[0], `/toolbox ${scope} enable exa`);
    assert.equal(result.cursorCol, result.lines[0].length);
  });
}

for (const line of ["/toolbox  global ", "/toolbox\tglobal\t", "/toolbox global\ten", "/toolbox  project  "]) {
  test(`whitespace: ${JSON.stringify(line)}`, async () => {
    const result = await apply(line, "enable");
    assert.match(result.lines[0], /^\/toolbox\s+(global|project) enable $/);
  });
}

test("real editor Tab completes global with an extra separator", async () => {
  const identity = (text) => text;
  const editor = new Editor({ requestRender() {} }, {
    borderColor: identity,
    selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
  });
  editor.setAutocompleteProvider(provider);
  editor.setText("/toolbox  g");
  editor.handleInput("\t");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(editor.getText(), "/toolbox global ");
  editor.handleInput("e");
  editor.handleInput("n");
  await new Promise((resolve) => setTimeout(resolve, 30));
  editor.handleInput("\t");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(editor.getText(), "/toolbox global enable ");
  editor.handleInput("\t");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(editor.getText(), "/toolbox global enable exa");
});

test("global candidates use global state, not project overrides", () => {
  assert.equal(complete("global enable ").map((item) => item.label).join(), "exa");
  assert.equal(complete("global disable ").map((item) => item.label).join(), "gh");
  assert.equal(complete("global inherit "), null);
  assert.equal(complete("project inherit ").map((item) => item.label).join(), "exa");
});

test("legacy completion and cursor suffix are preserved", async () => {
  assert.equal((await apply("/toolbox en", "enable")).lines[0], "/toolbox enable ");
  const result = await apply("/toolbox global en tail", "enable", "/toolbox global en".length);
  assert.equal(result.lines[0], "/toolbox global enable  tail");
  assert.equal(result.cursorCol, "/toolbox global enable ".length);
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
});
