import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actionsForScope,
  getToolboxCompletions,
  parseToolboxCommand,
  TOOLBOX_CATEGORIES,
  TOOLBOX_HELP,
} from "../extensions/commands.ts";

for (const category of ["skills", "extensions"]) {
  for (const scopeArgument of ["", "project", "global"]) {
    const scope = scopeArgument || "project";
    const prefix = [category, scopeArgument].filter(Boolean).join(" ");
    test(`default status: ${prefix}`, () => {
      assert.deepEqual(parseToolboxCommand(prefix), { category, scope, action: "status" });
      assert.deepEqual(parseToolboxCommand(`${prefix} status`), { category, scope, action: "status" });
    });
    for (const action of ["enable", "disable", "inherit"]) {
      const id = category === "skills" ? "exa" : "browser";
      const input = `${prefix} ${action} ${id}`;
      test(`parse mutation: ${input}`, () => {
        const expected = action === "inherit" && scope === "global" ? undefined : { category, scope, action, id };
        assert.deepEqual(parseToolboxCommand(input), expected);
      });
    }
    if (category === "skills") {
      test(`explicit config: ${prefix}`, () => {
        assert.deepEqual(parseToolboxCommand(`${prefix} config`), { category, scope, action: "config" });
      });
    } else {
      test(`optional status object: ${prefix}`, () => {
        assert.deepEqual(parseToolboxCommand(`${prefix} status browser`), { category, scope, action: "status", id: "browser" });
      });
    }
  }
}

for (const input of [
  "", "project", "global", "status", "list", "enable exa", "disable exa", "inherit exa",
  "project enable exa", "global enable exa", "plugin status", "plugins", "plugins status",
  "plugin disable browser", "plugin global disable browser", "skills list", "extensions list",
  "Skills status", "unknown status", "skills extensions status", "extensions skills status",
  "global skills status", "skills project global status", "extensions global project status",
  "skills enable", "extensions disable", "skills inherit", "extensions inherit",
  "skills status exa", "skills config exa", "extensions config", "extensions global config",
  "skills enable exa extra", "extensions status browser extra", "extensions status global browser",
]) {
  test(`reject removed or malformed command: ${JSON.stringify(input)}`, () => {
    assert.equal(parseToolboxCommand(input), undefined);
  });
}

test("command parsing accepts whitespace without changing scope order", () => {
  assert.deepEqual(parseToolboxCommand(" \t skills\t global \t enable  exa\n"), {
    category: "skills", scope: "global", action: "enable", id: "exa",
  });
  assert.deepEqual(parseToolboxCommand("extensions\nproject\tstatus\tbrowser"), {
    category: "extensions", scope: "project", action: "status", id: "browser",
  });
});

test("action sets reflect category and scope", () => {
  assert.deepEqual(TOOLBOX_CATEGORIES, ["skills", "extensions"]);
  assert.deepEqual(actionsForScope("skills", "project"), ["status", "enable", "disable", "inherit", "config"]);
  assert.deepEqual(actionsForScope("skills", "global"), ["status", "enable", "disable", "config"]);
  assert.deepEqual(actionsForScope("extensions", "project"), ["status", "enable", "disable", "inherit"]);
  assert.deepEqual(actionsForScope("extensions", "global"), ["status", "enable", "disable"]);
  assert.match(TOOLBOX_HELP, /\/toolbox skills /);
  assert.match(TOOLBOX_HELP, /\/toolbox extensions /);
  assert.doesNotMatch(TOOLBOX_HELP, /\/toolbox (?:plugin|plugins|project|global|enable|list)\b/);
});

test("terminal completions produce parseable commands", () => {
  for (const category of TOOLBOX_CATEGORIES) {
    for (const scope of ["project", "global"]) {
      for (const action of actionsForScope(category, scope)) {
        for (const prefix of [`${category} ${scope} ${action}`, `${category} ${scope} ${action} `]) {
          const items = getToolboxCompletions(prefix, () => [{ id: "demo" }]) ?? [];
          for (const item of items) {
            if (!item.value.endsWith(" ")) assert.ok(parseToolboxCommand(item.value), item.value);
          }
        }
      }
    }
  }
});
