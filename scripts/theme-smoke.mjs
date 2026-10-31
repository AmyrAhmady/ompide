// Real WebView file imports, theme customization, Monaco rendering and persistence.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect as baseExpect } from "@playwright/test";

const expect = baseExpect.configure({ timeout: 15_000 });
const root = fileURLToPath(new URL("../", import.meta.url));
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = browser.contexts()[0];
const page =
  context.pages().find((page) => page.url().includes(":1420/")) ??
  context.pages()[0] ??
  (await context.waitForEvent("page"));
await page.waitForURL((url) => url.port === "1420", {
  timeout: 30_000,
  waitUntil: "domcontentloaded",
});
page.setDefaultTimeout(15_000);
const directory = await mkdtemp(path.join(tmpdir(), "pawn-theme-smoke-"));
const preferences = path.join(
  process.env.APPDATA,
  "mp.open.editor/preferences.json"
);
const settingsDialog = () =>
  page.getByRole("dialog", { name: "Settings", exact: true });
const selector = () =>
  settingsDialog().getByLabel("Color theme", { exact: true });
const input = () =>
  settingsDialog().getByLabel("Local JSON theme file", { exact: true });
const draft = () => settingsDialog().getByLabel("Theme JSON", { exact: true });
const errors = [];
const remoteRequests = [];
const evidence = [];
page.on("pageerror", (error) => errors.push(error.stack || error.message));
page.on("request", (request) => {
  const url = new URL(request.url());
  if (
    ["http:", "https:"].includes(url.protocol) &&
    !["localhost", "127.0.0.1", "ipc.localhost"].includes(url.hostname)
  )
    remoteRequests.push(url.href);
});
let previous;
let seeded = false;

async function evaluate(operation, argument) {
  return page.evaluate(
    async ({ operation, argument }) => {
      const source = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((url) => /\/src\/app\/workbench\.ts(?:\?|$)/.test(url));
      const { workbench } = await import(source);
      return await (0, eval)(operation)(workbench, argument);
    },
    { operation: operation.toString(), argument }
  );
}

async function settings() {
  return evaluate((workbench) => workbench.getSnapshot().settings);
}

async function flush() {
  await evaluate((workbench) => Reflect.get(workbench, "settingsQueue"));
  return JSON.parse(await readFile(preferences, "utf8")).settings;
}

async function ready() {
  await expect
    .poll(() => evaluate((workbench) => workbench.getSnapshot().ready))
    .toBe(true);
}

async function importText(text) {
  await input().setInputFiles({
    name: "theme.json",
    mimeType: "application/json",
    buffer: Buffer.from(text),
  });
}

async function screenshot(name) {
  await mkdir(path.join(root, "test-results"), { recursive: true });
  await page.screenshot({
    path: path.join(root, `test-results/theme-${name}.png`),
  });
}

async function background(expected) {
  await expect(page.locator(".workbench")).toHaveCSS(
    "background-color",
    expected
  );
  await expect(page.locator(".monaco-editor-background").first()).toHaveCSS(
    "background-color",
    expected
  );
}

async function command(query) {
  await page.keyboard.press("Control+Shift+p");
  const palette = page.getByRole("dialog", {
    name: "Command Palette…",
    exact: true,
  });
  await palette.getByRole("combobox").fill(query);
  await palette.getByRole("combobox").press("Enter");
  await expect(palette).toHaveCount(0);
}

const ocean = JSON.parse(
  await readFile(path.join(root, "examples/themes/ocean.json"), "utf8")
);

try {
  try {
    previous = await readFile(preferences);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await cp(path.join(root, "fixtures/minimal"), directory, {
    recursive: true,
    filter: (file) => !file.includes(`${path.sep}output`),
  });
  await mkdir(path.dirname(preferences), { recursive: true });
  seeded = true;
  await writeFile(
    preferences,
    JSON.stringify({
      recentWorkspaces: [directory],
      settings: { theme: "dark" },
    })
  );
  await page.reload();
  await ready();
  await page.getByRole("button", { name: directory, exact: true }).click();
  await page.getByRole("treeitem", { name: "main.pwn", exact: true }).click();
  await page.keyboard.press("Control+,");
  await expect(settingsDialog()).toBeVisible();

  for (const [text, message] of [
    ["{ trailing, }", "not valid JSON"],
    [JSON.stringify({ ...ocean, schemaVersion: 2 }), "schemaVersion 1"],
    [
      JSON.stringify({
        ...ocean,
        colors: { "editor.background": "url(https://example.com/payload)" },
      }),
      "Invalid color token",
    ],
    [" ".repeat(256 * 1024 + 1), "no larger than 256 KiB"],
  ]) {
    await importText(text);
    await expect(settingsDialog().getByRole("alert")).toContainText(message);
    assert.equal((await settings()).theme, "dark");
    await background("rgb(30, 30, 30)");
  }
  evidence.push(
    "Malformed JSON, unsupported schemas, CSS/network payloads and oversized local files show actionable errors and preserve the active theme."
  );

  await importText(`\uFEFF${JSON.stringify(ocean)}`);
  await expect(draft()).toBeVisible();
  assert.equal((await settings()).theme, "dark");
  const normalized = JSON.parse(await draft().inputValue());
  assert.equal(normalized.colors["button.background"], "#0e639c");
  await settingsDialog()
    .getByRole("button", { name: "Apply Custom Theme", exact: true })
    .click();
  await expect(draft()).toHaveCount(0);
  await background("rgb(16, 35, 42)");
  await expect(selector()).toHaveValue("custom");
  await expect(page.locator(".explorer")).toHaveCSS(
    "background-color",
    "rgb(22, 51, 61)"
  );
  await expect(page.locator(".statusbar")).toHaveCSS(
    "background-color",
    "rgb(35, 99, 114)"
  );
  await expect(page.locator(".workbench")).toHaveCSS("color-scheme", "dark");
  assert.equal((await flush()).customTheme.name, "Ocean");
  evidence.push(
    "A partial UTF-8 BOM theme imports without applying until confirmation; omitted tokens inherit dark defaults, and shell/Monaco/persisted selection agree."
  );

  await settingsDialog()
    .getByRole("button", { name: "Customize Theme…", exact: true })
    .click();
  await draft().fill("{}");
  await settingsDialog()
    .getByRole("button", { name: "Apply Custom Theme", exact: true })
    .click();
  await expect(settingsDialog().getByRole("alert")).toContainText(
    "schemaVersion 1"
  );
  await background("rgb(16, 35, 42)");
  await draft().fill(JSON.stringify({ ...ocean, name: "Unsaved theme" }));
  await settingsDialog()
    .getByRole("button", { name: "Cancel Theme Changes", exact: true })
    .click();
  assert.equal((await settings()).customTheme.name, "Ocean");

  for (const [theme, color] of [
    ["light", "rgb(255, 255, 255)"],
    ["dark", "rgb(30, 30, 30)"],
    ["custom", "rgb(16, 35, 42)"],
  ]) {
    await selector().selectOption(theme);
    await background(color);
  }
  await settingsDialog()
    .getByRole("button", { name: "Dismiss", exact: true })
    .click();
  await expect
    .poll(() =>
      page
        .locator(".view-line span")
        .filter({ hasText: /^1$/ })
        .evaluateAll((elements) =>
          elements.map((element) => globalThis.getComputedStyle(element).color)
        )
    )
    .toContain("rgb(255, 158, 101)");
  evidence.push(
    "Invalid edits and Cancel preserve the saved theme; switching Light/Dark/custom clears and reapplies Monaco syntax and background overrides."
  );

  await evaluate((workbench) => {
    const document = Reflect.get(workbench, "documents").get(
      workbench.getSnapshot().active
    );
    document.model.setValue(
      document.model.getValue().replace("Add(1, 2)", "Add(1)")
    );
  });
  await page.keyboard.press("Control+j");
  await expect
    .poll(() => page.locator(".problems-panel li").count())
    .toBeGreaterThan(0);
  await expect(page.locator(".problems-panel")).toHaveCSS(
    "background-color",
    "rgb(20, 48, 58)"
  );
  await screenshot("custom-problems");
  const divider = page.getByRole("separator", {
    name: "Resize Sidebar",
    exact: true,
  });
  await page.getByRole("treeitem", { name: "main.pwn", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(divider).toBeFocused();
  await expect(divider).toHaveCSS("background-color", "rgb(112, 213, 220)");
  await page.locator(".ide-menubar summary").first().click();
  await page
    .getByRole("menuitem", { name: "New File", exact: false })
    .first()
    .hover();
  await screenshot("custom-menu");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+,");
  await screenshot("custom-settings");
  await settingsDialog()
    .getByRole("button", { name: "Customize Theme…", exact: true })
    .click();
  const daylight = {
    schemaVersion: 1,
    name: "Paper",
    base: "light",
    colors: {
      "editor.background": "#f1f7f2",
      "tab.activeBackground": "#f1f7f2",
    },
  };
  await draft().fill(JSON.stringify(daylight));
  await settingsDialog()
    .getByRole("button", { name: "Apply Custom Theme", exact: true })
    .click();
  await background("rgb(241, 247, 242)");
  await expect(page.locator(".explorer")).toHaveCSS(
    "background-color",
    "rgb(243, 243, 243)"
  );
  await settingsDialog()
    .getByRole("button", { name: "Dismiss", exact: true })
    .click();
  await flush();
  await page.keyboard.press("Control+s");
  await page.reload();
  await ready();
  assert.equal((await settings()).theme, "custom");
  assert.equal((await settings()).customTheme.name, "Paper");
  await page.getByRole("button", { name: directory, exact: true }).click();
  await page.getByRole("treeitem", { name: "main.pwn", exact: true }).click();
  await background("rgb(241, 247, 242)");
  await screenshot("custom-light-reloaded");
  evidence.push(
    "Custom themes cover real diagnostics, menus, tabs, explorer, panels, dialogs and syntax; a customized light-base theme survives native preference reload."
  );
  if (process.argv.includes("--audit")) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await evaluate(
      (workbench, customTheme) => workbench.settings({ customTheme }),
      normalized
    );
    await expect
      .poll(() =>
        evaluate((workbench) => workbench.getSnapshot().languagePhase)
      )
      .toBe("ready");
    for (const [theme, color, numeric] of [
      ["light", "rgb(255, 255, 255)", "rgb(9, 134, 88)"],
      ["dark", "rgb(30, 30, 30)", "rgb(181, 206, 168)"],
      ["custom", "rgb(16, 35, 42)", "rgb(255, 158, 101)"],
    ]) {
      await page.keyboard.press("Control+,");
      await selector().selectOption(theme);
      await background(color);
      await screenshot("audit-" + theme + "-settings");
      await settingsDialog()
        .getByRole("button", { name: "Dismiss", exact: true })
        .click();
      await expect
        .poll(() =>
          page
            .locator(".view-line span")
            .filter({ hasText: /^1$/ })
            .evaluateAll((elements) =>
              elements.map(
                (element) => globalThis.getComputedStyle(element).color
              )
            )
        )
        .toContain(numeric);
      await command("problems");
      if (!(await page.locator(".problems-panel").isVisible()))
        await command("problems");
      await expect
        .poll(() => page.locator(".problems-panel li").count())
        .toBeGreaterThan(0);
      await screenshot("audit-" + theme + "-editor");
      await page.locator(".ide-menubar summary").first().click();
      await page
        .getByRole("menuitem", { name: "New File", exact: false })
        .first()
        .hover();
      await screenshot("audit-" + theme + "-menu");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+Shift+p");
      await screenshot("audit-" + theme + "-commands");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+Shift+f");
      await page.getByLabel("Search text", { exact: true }).fill("Add");
      await expect(
        page.locator(".search-results button").first()
      ).toBeVisible();
      await screenshot("audit-" + theme + "-search");
      await command("build output");
      await expect(page.locator(".build-panel")).toBeVisible();
      await screenshot("audit-" + theme + "-build");
      await command("configure project");
      const project = page.getByRole("dialog", {
        name: "Configure Project…",
        exact: true,
      });
      await expect(
        project.getByRole("button", { name: "Build Project", exact: true })
      ).toBeEnabled();
      await screenshot("audit-" + theme + "-project");
      await project
        .getByRole("button", { name: "Dismiss", exact: true })
        .click();
      await page.keyboard.press("Control+n");
      await page
        .getByRole("textbox", { name: "ompide", exact: true })
        .focus();
      await page.keyboard.type("// unsaved theme audit");
      await page.keyboard.press("Control+w");
      const prompt = page.getByRole("dialog", { name: /^Save changes to/ });
      await expect(prompt).toBeVisible();
      await screenshot("audit-" + theme + "-unsaved");
      await prompt
        .getByRole("button", { name: "Discard", exact: true })
        .click();
      await page.keyboard.press("Control+Shift+e");
    }
    evidence.push(
      "Visual audit records Light, Dark and custom themes across real diagnostics, menus, commands, Search, Build output, verified project configuration, Settings and unsaved prompts; default/custom numeric syntax colors are checked after each switch."
    );
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(remoteRequests, []);
  await writeFile(
    path.join(root, "test-results/theme-workflows.json"),
    JSON.stringify(evidence, null, 2)
  );
  console.log(evidence.join("\n"));
} catch (error) {
  console.error("Theme verification failed:", error);
  console.error("Browser errors:", errors);
  console.error("UI:", (await page.locator("body").innerText()).slice(-3500));
  throw error;
} finally {
  try {
    const closed = page.waitForEvent("close", { timeout: 20_000 });
    await evaluate(async (workbench) => {
      await Reflect.get(workbench, "settingsQueue");
      workbench.subscribe(() => {
        if (workbench.getSnapshot().prompt) workbench.answerPrompt("discard");
      });
      await workbench.quit();
    });
    await closed;
  } finally {
    if (seeded) {
      if (previous) await writeFile(preferences, previous);
      else await rm(preferences, { force: true });
    }
    await browser.close();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}
