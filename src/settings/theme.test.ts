import { expect, it } from "vitest";
import {
  defaultThemes,
  parseTheme,
  parseThemeText,
  selectedTheme,
  ThemeError,
  themeSizeLimit,
  themeVariables,
} from "./theme";
import { defaults, parseSettings } from "./settings";

it("provides complete light/dark defaults and custom overrides with fallback", () => {
  for (const theme of Object.values(defaultThemes))
    expect(parseTheme(theme)).toEqual(theme);
  const theme = parseTheme({
    schemaVersion: 1,
    name: "Custom",
    base: "dark",
    colors: { "editor.background": "#123456" },
  });
  expect(theme.colors["editor.background"]).toBe("#123456");
  expect(theme.colors["panel.border"]).toBe(
    defaultThemes.dark.colors["panel.border"]
  );
  expect(themeVariables(theme)["--editor-background"]).toBe("#123456");
});

it("persists validated custom themes and clears overrides when a default is selected", () => {
  const customTheme = parseThemeText(
    "\uFEFF" +
      JSON.stringify({
        schemaVersion: 1,
        name: "Ocean",
        base: "light",
        colors: { "editor.background": "#eaf7ff" },
      })
  );
  const settings = parseSettings(
    JSON.parse(JSON.stringify({ ...defaults, theme: "custom", customTheme }))
  );
  expect(selectedTheme(settings)).toEqual(customTheme);
  expect(selectedTheme({ ...settings, theme: "dark" })).toBe(
    defaultThemes.dark
  );
  expect(
    parseSettings({ theme: "custom", customTheme: { schemaVersion: 999 } })
      .theme
  ).toBe("dark");
  expect(parseSettings({ theme: "custom" }).theme).toBe("dark");
});

it("rejects oversized or executable color content with actionable error codes", () => {
  expect(() => parseThemeText(" ".repeat(themeSizeLimit + 1))).toThrowError(
    expect.objectContaining({ code: "themeSize" })
  );
  expect(() => parseThemeText("{ trailing, }")).toThrowError(
    expect.objectContaining({ code: "themeJson" })
  );
  for (const colors of [
    { "editor.background": "url(https://example.com)" },
    { constructor: "#ffffff" },
    { "unknown.token": "#ffffff" },
  ]) {
    expect(() =>
      parseTheme({ schemaVersion: 1, name: "Bad", base: "dark", colors })
    ).toThrow(ThemeError);
  }
  expect(() =>
    parseTheme({
      schemaVersion: 1,
      name: "Bad",
      base: "dark",
      tokenColors: Array(501).fill({
        scope: "keyword",
        settings: { foreground: "#ffffff" },
      }),
    })
  ).toThrowError(expect.objectContaining({ code: "themeSyntax" }));
});
it("rejects unsupported schemas, arbitrary CSS, and malformed syntax colors", () => {
  for (const value of [
    null,
    { schemaVersion: 2 },
    {
      schemaVersion: 1,
      name: "Bad",
      base: "dark",
      colors: { "editor.background": "url(https://example.com)" },
    },
    { schemaVersion: 1, name: "Bad", base: "light", tokenColors: [{}] },
  ])
    expect(() => parseTheme(value)).toThrow();
});
