// Check real TextMate rendering without native IPC or an installed language server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { projectRoot } from "./release-support.mjs";

const server = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "0"],
  { cwd: projectRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
);
let browser;
try {
  const url = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`Vite startup timed out: ${output}`)),
      30_000
    );
    const read = (chunk) => {
      output = (output + chunk.toString()).slice(-16_384);
      const address = output.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
      if (address) {
        clearTimeout(timer);
        resolve(address);
      }
    };
    server.stdout.on("data", read);
    server.stderr.on("data", read);
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Vite exited (${code}): ${output}`));
    });
  });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });

  const evaluate = (operation, argument) =>
    page.evaluate(
      async ({ operation, argument }) => {
        const source = performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .find((url) => /\/src\/app\/workbench\.ts(?:\?|$)/.test(url));
        const { workbench } = await import(source);
        return (0, eval)(operation)(workbench, argument);
      },
      { operation: operation.toString(), argument }
    );
  await expect
    .poll(() => evaluate((workbench) => workbench.getSnapshot().ready), {
      timeout: 60_000,
    })
    .toBe(true);

  await evaluate(async (w) => {
    await w.newFile();
  });
  await page.keyboard.press("Control+Shift+P");
  await page
    .getByRole("combobox", { name: "Search commands" })
    .fill("color theme");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Select Color Theme",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  console.log("Preview and import checks starting");
  const remote = [];
  page.on("request", (request) => {
    if (new URL(request.url()).protocol === "https:")
      remote.push(request.url());
  });
  const query = () => dialog.getByRole("combobox");
  await query().fill("Light");
  await expect(page.locator(".monaco-editor-background").first()).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)"
  );
  await page.keyboard.press("Escape");
  await expect(page.locator(".monaco-editor-background").first()).toHaveCSS(
    "background-color",
    "rgb(30, 30, 30)"
  );
  assert.equal(remote.length, 0);
  const open = async () => {
    await page.keyboard.press("Control+Shift+P");
    await page
      .getByRole("combobox", { name: "Search commands" })
      .fill("color theme");
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
  };
  await open();
  const theme = {
    name: "Imported fixture",
    type: "dark",
    colors: {
      "editor.background": "#10232a",
      "sideBar.background": "#16333d",
      "panel.background": "#14303a",
      "menu.background": "#192f3b",
    },
    tokenColors: [
      {
        scope: ["storage", "keyword"],
        settings: { foreground: "#ff55aa", fontStyle: "bold italic" },
      },
    ],
  };
  await dialog
    .getByLabel("VS Code color theme JSON or VSIX file")
    .setInputFiles({
      name: "theme.jsonc",
      mimeType: "application/json",
      buffer: Buffer.from("// example\n" + JSON.stringify(theme)),
    });
  await expect(
    dialog.getByRole("option", { name: /Imported fixture/ })
  ).toBeVisible();
  await expect(page.locator(".monaco-editor-background").first()).toHaveCSS(
    "background-color",
    "rgb(16, 35, 42)"
  );
  await dialog.getByRole("option", { name: /Imported fixture/ }).click();
  await expect(dialog).not.toBeVisible();
  await expect
    .poll(() => evaluate((w) => w.getSnapshot().settings.customTheme.name))
    .toBe("Imported fixture");
  await evaluate(async (w) => {
    await w.newFile();
    Reflect.get(w, "codeEditor").getModel().setValue("public OnReady() {}");
  });
  await expect
    .poll(() =>
      page
        .locator(".view-lines .view-line")
        .first()
        .locator("span")
        .filter({ hasText: /^public$/ })
        .last()
        .evaluate((el) => globalThis.getComputedStyle(el).color)
    )
    .toBe("rgb(255, 85, 170)");
  await open();
  await dialog
    .getByLabel("VS Code color theme JSON or VSIX file")
    .setInputFiles({
      name: "bad.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        '{"colors":{"editor.background":"url(https://evil.test)"}}'
      ),
    });
  await expect(dialog.getByRole("alert")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".monaco-editor-background").first()).toHaveCSS(
    "background-color",
    "rgb(16, 35, 42)"
  );
  await page
    .locator(".menu summary")
    .filter({ hasText: /^View$/ })
    .click();
  await expect(page.locator('.menu[open] [role="menu"]')).toHaveCSS(
    "background-color",
    "rgb(25, 47, 59)"
  );
  await page.keyboard.press("Escape");
  const plistResult = await page.evaluate(async () => {
    const resource = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((url) => /\/src\/settings\/theme-package\.ts(?:\?|$)/.test(url));
    const { resolveTheme } = await import(resource);
    return resolveTheme(
      new Map([
        [
          "theme.tmTheme",
          '<plist version="1.0"><dict><key>name</key><string>Legacy</string><key>settings</key><array><dict><key>scope</key><string>storage</string><key>settings</key><dict><key>foreground</key><string>#123456</string></dict></dict></array></dict></plist>',
        ],
      ]),
      "theme.tmTheme"
    );
  });
  assert.equal(plistResult.tokenColors[0].settings.foreground, "#123456");
  await open();
  await query().fill("dracula");
  await dialog
    .getByRole("button", { name: "Search Open VSX…", exact: true })
    .click();
  const download = dialog
    .getByRole("button")
    .filter({ hasText: "Download themes" });
  await expect(download.first()).toBeVisible({ timeout: 60000 });
  console.log("Live registry search passed; downloading theme package");
  await download.first().click();
  await expect(
    dialog
      .getByRole("option")
      .filter({ hasText: /Dracula/i })
      .first()
  ).toBeVisible({ timeout: 60000 });
  await dialog
    .getByRole("option")
    .filter({ hasText: /Dracula/i })
    .first()
    .click();
  await expect(dialog).not.toBeVisible();
  assert.ok(remote.some((url) => url.includes("/api/-/search")));
  assert.ok(remote.some((url) => url.endsWith(".vsix")));
  await mkdir(path.join(projectRoot, "test-results"), { recursive: true });
  await open();
  await page.screenshot({
    path: path.join(projectRoot, "test-results/vscode-theme-picker.png"),
  });
  await page.keyboard.press("Escape");
  const snapshot = await evaluate((w) => w.getSnapshot().settings);
  assert.ok(snapshot.installedThemes.length >= 2);
  assert.ok(snapshot.installedThemes.some((item) => item.publisher));
  assert.deepEqual(errors, []);
  console.log(
    "VS Code theme picker passed: preview/cancel, JSONC import, scope arrays/font styles, invalid import protection, Open VSX live search/download/checksum, multiple installed variants, no startup network requests."
  );
} finally {
  await browser?.close();
  server.kill();
}
