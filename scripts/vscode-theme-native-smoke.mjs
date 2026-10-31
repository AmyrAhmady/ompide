// Production WebView smoke: native preferences, packaged CSP and real registry traffic.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { projectRoot } from "./release-support.mjs";

const preferences = path.join(
  process.env.APPDATA,
  "mp.open.editor/preferences.json"
);
let previous;
try {
  previous = await readFile(preferences);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await mkdir(path.dirname(preferences), { recursive: true });
await writeFile(preferences, JSON.stringify({ settings: { theme: "dark" } }));
let app;
let browser;
try {
  app = spawn(path.join(projectRoot, "src-tauri/target/debug/ompide.exe"), [], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222",
    },
  });
  for (let i = 0; i < 100; i++) {
    try {
      browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  assert.ok(browser, "Native CDP startup timed out");
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent("page"));
  await page.waitForLoadState("domcontentloaded");
  page.setDefaultTimeout(15000);
  const remote = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).protocol === "https:")
      remote.push(request.url());
  });
  await expect(
    page.getByRole("navigation", { name: "ompide", exact: true })
  ).toBeVisible();
  const open = async () => {
    await expect
      .poll(
        async () => {
          if (await dialog().isVisible()) return true;
          await page.keyboard.press("Control+k");
          await page.keyboard.press("Control+t");
          return dialog().isVisible();
        },
        { timeout: 15000 }
      )
      .toBe(true);
  };
  const dialog = () =>
    page.getByRole("dialog", { name: "Select Color Theme", exact: true });
  await open();
  await dialog().getByRole("combobox").fill("Light");
  await expect(page.locator(".workbench")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)"
  );
  assert.equal(
    JSON.parse(await readFile(preferences, "utf8")).settings.theme,
    "dark"
  );
  await page.keyboard.press("Escape");
  await expect(page.locator(".workbench")).toHaveCSS(
    "background-color",
    "rgb(30, 30, 30)"
  );
  assert.equal(remote.length, 0);
  await open();
  await dialog()
    .getByLabel("VS Code color theme JSON or VSIX file")
    .setInputFiles({
      name: "native.jsonc",
      mimeType: "application/json",
      buffer: Buffer.from(
        '// native import\n{"name":"Native Theme","type":"light","colors":{"editor.background":"#eaf7ff","sideBar.background":"#ddeeff"}}'
      ),
    });
  await dialog()
    .getByRole("option", { name: /Native Theme/ })
    .click();
  await expect
    .poll(
      async () =>
        JSON.parse(await readFile(preferences, "utf8")).settings.customTheme
          ?.name
    )
    .toBe("Native Theme");
  await page.reload();
  await expect(page.locator(".workbench")).toHaveCSS(
    "background-color",
    "rgb(234, 247, 255)"
  );
  await open();
  await dialog().getByRole("combobox").fill("dracula");
  await dialog()
    .getByRole("button", { name: "Search Open VSX…", exact: true })
    .click();
  const download = dialog()
    .getByRole("button")
    .filter({ hasText: "Download themes" });
  await expect(download.first()).toBeVisible({ timeout: 60000 });
  await download.first().click();
  await expect(
    dialog()
      .getByRole("option")
      .filter({ hasText: /Dracula/ })
      .first()
  ).toBeVisible({ timeout: 60000 });
  await dialog()
    .getByRole("option")
    .filter({ hasText: /Dracula/ })
    .first()
    .click();
  await expect
    .poll(
      async () =>
        JSON.parse(await readFile(preferences, "utf8")).settings.installedThemes
          ?.length
    )
    .toBeGreaterThan(1);
  await page.reload();
  await open();
  await dialog().getByRole("combobox").fill("Dracula");
  await expect(
    dialog()
      .getByRole("option")
      .filter({ hasText: /nszihan/ })
      .first()
  ).toBeVisible();
  await page.screenshot({
    path: path.join(projectRoot, "test-results/vscode-theme-native.png"),
  });
  await page.keyboard.press("Escape");
  assert.ok(remote.some((url) => url.includes("open-vsx.org/api/-/search")));
  assert.ok(remote.some((url) => url.includes("openvsx.eclipsecontent.org")));
  assert.deepEqual(errors, []);
  console.log(
    "Native VS Code themes passed: shortcut, preview/cancel without preference writes, JSONC import/reload, real Open VSX search/download through packaged CSP, installed themes after restart."
  );
} finally {
  await browser?.close();
  if (app?.pid && app.exitCode === null)
    await new Promise((resolve) =>
      execFile("taskkill", ["/PID", String(app.pid), "/T", "/F"], () =>
        resolve()
      )
    );
  if (previous) await writeFile(preferences, previous);
  else await writeFile(preferences, "{}");
}
