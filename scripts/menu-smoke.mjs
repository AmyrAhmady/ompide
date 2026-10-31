// Frontend interaction regression: no Tauri rebuild, native IPC, or mocked editor services.
// Uses the installed Edge browser and a test-owned Vite server on an ephemeral loopback port.
import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const server = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "0"],
  { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
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
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const heading = (label) =>
    page.locator(".menu summary").getByText(label, { exact: true });
  const opened = page.locator(".menu[open]");
  const assertOpen = async (label) => {
    await expect(opened).toHaveCount(1);
    await expect(
      page.getByRole("menu", { name: label, exact: true })
    ).toBeVisible();
  };
  await mkdir(path.join(root, "test-results"), { recursive: true });
  for (const theme of ["light", "dark"]) {
    await heading("View").click();
    await page
      .getByRole("menuitem", { name: "Settings Ctrl+,", exact: true })
      .click({ timeout: 60_000 });
    await expect(opened).toHaveCount(0);
    await page.getByLabel("Color theme", { exact: true }).selectOption(theme);
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();

    await expect(page.locator(".app-mark .app-logo")).toBeVisible();
    await expect(page.locator(".empty-editor .app-logo")).toBeVisible();
    expect(await page.locator('link[rel="icon"]').getAttribute("href")).toBe(
      "/favicon.ico"
    );
    await expect
      .poll(() =>
        page
          .locator(".app-logo")
          .evaluateAll((images) =>
            images.every((image) => image.complete && image.naturalWidth > 0)
          )
      )
      .toBe(true);
    const alpha = await page
      .locator(".app-mark .app-logo")
      .evaluate((image) => {
        const canvas = image.ownerDocument.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height
        ).data;
        return {
          corner: pixels[3],
          center:
            pixels[
              (Math.floor(canvas.height / 2) * canvas.width +
                Math.floor(canvas.width / 2)) *
                4 +
                3
            ],
        };
      });
    expect(alpha.corner).toBe(0);
    expect(alpha.center).toBeGreaterThan(0);
    await page.screenshot({
      path: path.join(root, `test-results/branding-${theme}.png`),
    });

    await expect(page.locator(".menu summary")).toHaveText([
      "File",
      "Edit",
      "View",
      "Go",
      "Build",
      "Terminal",
      "Help",
    ]);
    await page.evaluate(() => {
      globalThis.menuExternalLinks = [];
      globalThis.open = (url, target, features) => {
        globalThis.menuExternalLinks.push({ url, target, features });
        return null;
      };
    });
    for (const label of ["Repository", "Donate"]) {
      await heading("Help").click();
      await page.getByRole("menuitem", { name: label, exact: true }).click();
      await expect(opened).toHaveCount(0);
    }
    expect(await page.evaluate(() => globalThis.menuExternalLinks)).toEqual([
      {
        url: "https://github.com/AmyrAhmady/ompide",
        target: "_blank",
        features: "noopener,noreferrer",
      },
      {
        url: "https://donate.amii.ir",
        target: "_blank",
        features: "noopener,noreferrer",
      },
    ]);
    await heading("Help").click();
    await page.getByRole("menuitem", { name: "Credits", exact: true }).click();
    const credits = page.getByRole("dialog", { name: "Credits", exact: true });
    await expect(credits).toBeVisible();
    await expect(credits.locator(".app-logo")).toBeVisible();
    await expect(credits).toContainText("Created by Amyr Ahmady.");
    await expect(
      credits.getByRole("link", { name: "AmyrAhmady on GitHub" })
    ).toHaveAttribute("href", "https://github.com/AmyrAhmady");
    await expect(
      credits.getByRole("link", { name: "Donate", exact: true })
    ).toHaveAttribute("href", "https://donate.amii.ir");
    await page.screenshot({
      path: path.join(root, `test-results/credits-${theme}.png`),
    });
    await page.keyboard.press("Escape");
    await expect(credits).toHaveCount(0);
    await expect(heading("Help")).toBeFocused();
    await heading("Help").click();
    await page.getByRole("menuitem", { name: "Credits", exact: true }).click();
    await credits.getByRole("button", { name: "Close", exact: true }).click();
    await expect(credits).toHaveCount(0);

    // Reproduce the reported File/Edit/View/Go stacking sequence with real pointer input.
    for (let repeat = 0; repeat < 3; repeat++) {
      await heading("File").click();
      await assertOpen("File");
      for (const label of ["Edit", "View", "Go"]) {
        await heading(label).hover();
        await assertOpen(label);
      }
      await heading("Go").click();
      await expect(opened).toHaveCount(0);
    }
    await heading("File").hover();
    await expect(opened).toHaveCount(0); // Hover does not activate an idle menu bar.
    await heading("File").click();
    await page.locator(".window-title").click();
    await expect(opened).toHaveCount(0);

    // Keyboard navigation wraps, skips disabled commands, and restores focus on dismissal.
    const viewCommands = [
      "Command Palette… Ctrl+Shift+P",
      "Problems",
      "Settings Ctrl+,",
      "Search Workspace Ctrl+Shift+F",
      "Source Control Ctrl+Shift+G",
      "Toggle Sidebar Ctrl+B",
      "Toggle Bottom Panel Ctrl+J",
      "Reset Layout",
    ];
    await heading("View").focus();
    for (const name of viewCommands) {
      await page.keyboard.press("ArrowDown");
      await expect(
        page.getByRole("menuitem", { name, exact: true })
      ).toBeFocused();
    }
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("menuitem", { name: viewCommands[0], exact: true })
    ).toBeFocused();
    await page.keyboard.press("End");
    await expect(
      page.getByRole("menuitem", { name: viewCommands.at(-1), exact: true })
    ).toBeFocused();
    await page.keyboard.press("Home");
    await expect(
      page.getByRole("menuitem", { name: viewCommands[0], exact: true })
    ).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await assertOpen("Go");
    await expect(heading("Go")).toBeFocused(); // Every Go command is disabled in an empty browser preview.
    await page.keyboard.press("ArrowLeft");
    await assertOpen("View");
    await expect(
      page.getByRole("menuitem", {
        name: "Command Palette… Ctrl+Shift+P",
        exact: true,
      })
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(opened).toHaveCount(0);
    await expect(heading("View")).toBeFocused();
    await page.keyboard.press("Space");
    await assertOpen("View");
    await page.keyboard.press("Tab");
    await expect(opened).toHaveCount(0);
    await expect(heading("Go")).toBeFocused();

    await heading("View").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowDown"); // Skip Command Palette to Problems.
    await page.keyboard.press("Enter"); // Run Problems through the focused menu item.
    await expect(opened).toHaveCount(0);
    await expect(page.locator(".problems-panel")).toBeVisible();
    await heading("File").click();
    await page.keyboard.press("Control+j");
    await expect(opened).toHaveCount(0);
    await expect(page.locator(".problems-panel")).toHaveCount(0);

    await page.setViewportSize({ width: 521, height: 394 }); // Effective viewport at high display scaling.
    await heading("File").click();
    for (const label of ["File", "Edit", "View", "Go"]) {
      await heading(label).hover();
      await assertOpen(label);
      const bounds = await page
        .getByRole("menu", { name: label, exact: true })
        .boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(521);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(394);
    }
    await page.screenshot({
      path: path.join(root, `test-results/menu-${theme}.png`),
    });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1280, height: 800 });
  }
  expect(errors).toEqual([]);
  console.log(
    "Menu regression passed: Help placement, repository/donation targets, Credits content/links/focus, single dropdown, hover/click switching, outside/Escape/Tab/shortcut dismissal, keyboard navigation, Light/Dark and scaled viewport."
  );
} finally {
  await browser?.close();
  server.kill();
}
