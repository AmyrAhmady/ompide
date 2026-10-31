import { expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { parseTheme, parseThemeText } from "./theme";
import { parseSettings } from "./settings";
import { relativeThemePath, resolveTheme, unpackThemes } from "./theme-package";

it("accepts VS Code JSONC, short hex, future UI colors, scope arrays and font-only rules", () => {
  const theme = parseThemeText(`{ // VS Code theme
    "name": "Example", "type": "light",
    "colors": {"editor.background": "#abc", "new.futureColor": "#1234",},
    "tokenColors": [
      {"scope": ["storage", "keyword"], "settings": {"foreground": "#12abef", "fontStyle": "bold italic"}},
      {"scope": "comment", "settings": {"fontStyle": ""}}
    ],
    "semanticHighlighting": true,
    "semanticTokenColors": {"variable.readonly:pawn": {"foreground": "#fed", "italic": true}}
  }`);
  expect(theme.colors["editor.background"]).toBe("#aabbcc");
  expect(theme.colors["new.futureColor"]).toBe("#11223344");
  expect(theme.tokenColors[0].scope).toEqual(["storage", "keyword"]);
  expect(theme.tokenColors[1].settings.fontStyle).toBe("");
  expect(theme.semanticTokenColors?.["variable.readonly:pawn"]).toEqual({
    foreground: "#ffeedd",
    italic: true,
  });
  expect(theme).not.toHaveProperty("schemaVersion");
  expect(theme).not.toHaveProperty("base");
});

it("resolves includes with child overrides and appended syntax rules without network access", () => {
  const files = new Map([
    [
      "themes/base.json",
      JSON.stringify({
        type: "light",
        colors: { "editor.background": "#fafafa" },
        tokenColors: [
          { scope: "comment", settings: { foreground: "#123456" } },
        ],
      }),
    ],
    [
      "themes/child.json",
      JSON.stringify({
        include: "./base.json",
        colors: { "editor.foreground": "#112233" },
        tokenColors: [{ scope: "keyword", settings: { fontStyle: "bold" } }],
      }),
    ],
  ]);
  const theme = resolveTheme(files, "themes/child.json", "Child", "light");
  expect(theme.type).toBe("light");
  expect(theme.colors["editor.background"]).toBe("#fafafa");
  expect(theme.tokenColors.map((rule) => rule.scope)).toEqual([
    "comment",
    "keyword",
  ]);
  expect(() =>
    resolveTheme(new Map([["a.json", '{"include":"a.json"}']]), "a.json")
  ).toThrow();
  expect(() =>
    relativeThemePath("extension/package.json", "../../outside.json")
  ).toThrow();
  expect(() =>
    relativeThemePath("extension/package.json", "https://evil.test/x")
  ).toThrow();
  expect(() =>
    relativeThemePath("extension/package.json", "C:\\private.json")
  ).toThrow();
});

it("extracts only theme data from VSIX and keeps all contributed variants", async () => {
  const packageBytes = zipSync({
    "extension/package.json": strToU8(
      JSON.stringify({
        publisher: "example",
        name: "theme",
        version: "1.2.3",
        license: "MIT",
        main: "./run.js",
        contributes: {
          themes: [
            { label: "Day", uiTheme: "vs", path: "./themes/day.json" },
            { label: "Night", uiTheme: "vs-dark", path: "./themes/night.json" },
          ],
        },
      })
    ),
    "extension/themes/day.json": strToU8(
      '{"colors":{"editor.background":"#eee"}}'
    ),
    "extension/themes/night.json": strToU8(
      '{"include":"base.json","colors":{"editor.background":"#123"}}'
    ),
    "extension/themes/base.json": strToU8(
      '{"tokenColors":[{"scope":"storage","settings":{"foreground":"#abcdef"}}]}'
    ),
    "extension/run.js": strToU8('throw new Error("must never execute");'),
  });
  const themes = await unpackThemes(packageBytes);
  expect(themes).toHaveLength(2);
  expect(themes[0].theme.type).toBe("light");
  expect(themes[1].theme.type).toBe("dark");
  expect(themes[1].theme.colors["editor.background"]).toBe("#112233");
  expect(themes[1].license).toBe("MIT");
  expect(themes[1].theme.tokenColors[0].scope).toBe("storage");
  expect(() =>
    parseTheme({ include: "https://evil.test/theme.json" })
  ).toThrow();
  await expect(unpackThemes(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  await expect(
    unpackThemes(
      zipSync({ "extension/package.json": strToU8('{"contributes":{}}') })
    )
  ).rejects.toThrow();
});

it("migrates existing preferences and retains a selectable installed theme library", () => {
  const settings = parseSettings({
    theme: "custom",
    customTheme: {
      schemaVersion: 1,
      name: "Old",
      base: "light",
      colors: { "editor.background": "#abcdef" },
    },
    installedThemes: [
      { id: "example.theme", theme: { name: "Imported", type: "dark" } },
      { id: "broken", theme: { type: "invalid" } },
    ],
  });
  expect(settings.customTheme?.type).toBe("light");
  expect(settings.customTheme).not.toHaveProperty("base");
  expect(settings.installedThemes).toHaveLength(1);
  expect(parseSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
});
