// Real desktop layout, pointer/keyboard resizing, focus and preference persistence.
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
  (await context.waitForEvent("page", { timeout: 30_000 }));
await page.waitForURL((url) => url.port === "1420", {
  timeout: 30_000,
  waitUntil: "domcontentloaded",
});
page.setDefaultTimeout(15_000);
const directory = await mkdtemp(path.join(tmpdir(), "pawn-layout-smoke-"));
const preferences = path.join(
  process.env.APPDATA,
  "mp.open.editor/preferences.json"
);
const seed = {
  sidebarWidth: 310,
  panelHeight: 240,
  sidebarVisible: true,
  sidebar: "explorer",
  panelVisible: false,
  panel: "problems",
};
const errors = [];
const evidence = [];
page.on("pageerror", (error) => errors.push(error.stack || error.message));
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

const sidebar = () => page.locator("#workspace-sidebar");
const panel = () => page.locator("#workspace-panel");
const vertical = () =>
  page.getByRole("separator", { name: "Resize Sidebar", exact: true });
const horizontal = () =>
  page.getByRole("separator", { name: "Resize Bottom Panel", exact: true });
const layout = () =>
  evaluate((workbench) => workbench.getSnapshot().settings.layout);
const size = (element, axis) =>
  element.evaluate(
    (element, axis) => Math.round(element.getBoundingClientRect()[axis]),
    axis
  );

async function flush() {
  await evaluate((workbench) => Reflect.get(workbench, "settingsQueue"));
  return JSON.parse(await readFile(preferences, "utf8")).settings.layout;
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

async function beginDrag(element, x, y) {
  const box = await element.boundingBox();
  assert.ok(box);
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + x, start.y + y, { steps: 8 });
}

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
  await mkdir(path.join(directory, "nested"));
  await writeFile(
    path.join(directory, "nested/child.inc"),
    "// nested fixture\n"
  );
  await mkdir(path.dirname(preferences), { recursive: true });
  seeded = true;
  await writeFile(
    preferences,
    JSON.stringify({
      recentWorkspaces: [directory],
      settings: { theme: "dark", layout: seed },
    })
  );
  await page.reload();
  await expect
    .poll(() => evaluate((workbench) => workbench.getSnapshot().ready))
    .toBe(true);
  await expect.poll(() => size(sidebar(), "width")).toBe(310);
  await page.getByRole("button", { name: directory, exact: true }).click();
  await page.getByRole("treeitem", { name: "main.pwn", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "main.pwn", exact: true })
  ).toHaveAttribute("aria-selected", "true");
  const model = await evaluate(async (workbench) => {
    const active = workbench.getSnapshot().active;
    await workbench.openUri(active, 5, 20);
    return Reflect.get(workbench, "documents").get(active).model.id;
  });

  await beginDrag(vertical(), 85, 0);
  await expect.poll(() => size(sidebar(), "width")).toBe(395);
  assert.equal((await layout()).sidebarWidth, 310);
  assert.equal((await flush()).sidebarWidth, 310);
  await page.mouse.up();
  await expect.poll(async () => (await layout()).sidebarWidth).toBe(395);
  assert.equal((await flush()).sidebarWidth, 395);
  assert.equal(
    await evaluate(
      (workbench) =>
        Reflect.get(workbench, "documents").get(workbench.getSnapshot().active)
          .model.id
    ),
    model
  );
  evidence.push(
    "Sidebar drag previews size without writing preferences on mouse movement; release saves the real size and retains the editor model."
  );

  await vertical().press("ArrowLeft");
  await expect.poll(() => size(sidebar(), "width")).toBe(385);
  await vertical().press("Home");
  await expect.poll(() => size(sidebar(), "width")).toBe(170);
  await vertical().press("End");
  await expect.poll(() => size(sidebar(), "width")).toBe(640);
  await vertical().dblclick();
  await expect.poll(() => size(sidebar(), "width")).toBe(235);
  await vertical().press("Shift+ArrowRight");
  await expect.poll(() => size(sidebar(), "width")).toBe(285);
  await flush();
  await beginDrag(vertical(), 40, 0);
  await expect.poll(() => size(sidebar(), "width")).toBe(325);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect.poll(() => size(sidebar(), "width")).toBe(285);
  assert.equal((await flush()).sidebarWidth, 285);
  evidence.push(
    "Arrow/Shift-arrow, Home/End, double-click reset and Escape cancellation work without saving a cancelled drag."
  );

  await page.keyboard.press("Control+j");
  await expect(page.locator(".problems-panel")).toBeVisible();
  await expect.poll(() => size(panel(), "height")).toBe(240);
  await beginDrag(horizontal(), 0, -70);
  await expect.poll(() => size(panel(), "height")).toBe(310);
  assert.equal((await layout()).panelHeight, 240);
  await page.mouse.up();
  await expect.poll(async () => (await layout()).panelHeight).toBe(310);
  await horizontal().press("ArrowDown");
  await expect.poll(() => size(panel(), "height")).toBe(300);
  await horizontal().press("Home");
  await expect.poll(() => size(panel(), "height")).toBe(100);
  await horizontal().press("End");
  assert.ok((await size(page.locator(".editor-area"), "height")) >= 119);
  await horizontal().dblclick();
  await expect.poll(() => size(panel(), "height")).toBe(220);
  await command("build output");
  await expect(page.locator(".build-panel")).toBeVisible();
  await expect(page.locator(".problems-panel")).toHaveCount(0);
  await command("toggle bottom panel");
  await expect(panel()).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Pawn IDE", exact: true })
  ).toBeFocused();
  await command("toggle bottom panel");
  await expect(page.locator(".build-panel")).toBeVisible();
  evidence.push(
    "The bottom panel resizes with mouse/keyboard, preserves editor space, shows one view at a time and reopens the last selected Build view."
  );

  await page.getByRole("treeitem", { name: "nested", exact: true }).click();
  await expect(
    page.getByRole("treeitem", { name: "child.inc", exact: true })
  ).toBeVisible();
  await page.getByRole("treeitem", { name: "child.inc", exact: true }).focus();
  await page.keyboard.press("Control+b");
  await expect(sidebar()).toBeHidden();
  await expect(
    page.getByRole("textbox", { name: "Pawn IDE", exact: true })
  ).toBeFocused();
  await page.keyboard.press("Control+b");
  await expect(
    page.getByRole("treeitem", { name: "child.inc", exact: true })
  ).toBeVisible();
  await page.keyboard.press("Control+Shift+f");
  const query = page.getByLabel("Search text", { exact: true });
  await expect(query).toBeFocused();
  await query.fill("Add");
  await page.keyboard.press("Control+b");
  await expect(sidebar()).toBeHidden();
  await page.keyboard.press("Control+Shift+f");
  await expect(query).toBeFocused();
  await expect(query).toHaveValue("Add");
  evidence.push(
    "Ctrl+B preserves explorer expansion and search input; explicit Search/Explorer commands restore pane visibility and meaningful focus."
  );

  await vertical().press("ArrowRight");
  await horizontal().press("ArrowUp");
  await page.keyboard.press("Control+b");
  const wanted = await layout();
  assert.equal(wanted.sidebarVisible, false);
  assert.equal(wanted.sidebar, "search");
  assert.equal(wanted.panel, "build");
  assert.equal(wanted.panelVisible, true);
  assert.deepEqual(await flush(), wanted);
  await page.reload();
  await expect
    .poll(() => evaluate((workbench) => workbench.getSnapshot().ready))
    .toBe(true);
  assert.deepEqual(await layout(), wanted);
  await expect(sidebar()).toBeHidden();
  await expect(page.locator(".build-panel")).toBeVisible();
  await page.keyboard.press("Control+b");
  await expect(page.locator(".workspace-search")).toBeVisible();
  await expect.poll(() => size(sidebar(), "width")).toBe(wanted.sidebarWidth);
  await expect.poll(() => size(panel(), "height")).toBe(wanted.panelHeight);
  evidence.push(
    "Reload restores native preferences: pane sizes, visibility and selected Search/Build views."
  );

  await page.getByRole("button", { name: directory, exact: true }).click();
  await page.keyboard.press("Control+Shift+e");
  await page.getByRole("treeitem", { name: "main.pwn", exact: true }).click();
  await vertical().press("End");
  await horizontal().press("End");
  const preferred = await layout();
  await page.setViewportSize({ width: 521, height: 394 });
  await expect.poll(() => size(sidebar(), "width")).toBeLessThanOrEqual(238);
  assert.ok((await size(page.locator(".editor-area"), "width")) >= 279);
  assert.ok((await size(page.locator(".editor-area"), "height")) >= 119);
  const bottom = await panel().boundingBox();
  const status = await page.locator(".statusbar").boundingBox();
  assert.ok(bottom.y + bottom.height <= status.y + 1);
  assert.equal((await layout()).sidebarWidth, preferred.sidebarWidth);
  assert.equal((await layout()).panelHeight, preferred.panelHeight);
  await evaluate((workbench) => {
    const document = Reflect.get(workbench, "documents").get(
      workbench.getSnapshot().active
    );
    document.model.setValue(`${document.model.getValue()}\n// unsaved edit\n`);
  });
  const mainPath = path.join(directory, "main.pwn");
  await writeFile(
    mainPath,
    `${await readFile(mainPath, "utf8")}\n// disk edit\n`
  );
  await expect(page.locator(".external-notice")).toContainText(
    "changed on disk"
  );
  await expect
    .poll(async () => {
      const bottom = await panel().boundingBox();
      const status = await page.locator(".statusbar").boundingBox();
      return bottom.y + bottom.height <= status.y + 1;
    })
    .toBe(true);
  assert.ok((await size(page.locator(".editor-area"), "height")) >= 119);
  await page
    .getByRole("button", { name: "Reload from Disk", exact: true })
    .click();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.locator(".external-notice")).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect
    .poll(() => size(sidebar(), "width"))
    .toBe(preferred.sidebarWidth);
  evidence.push(
    "A scaled 521x394 viewport clamps saved sizes, including when a disk-conflict notice appears, while preserving editor space and preferred dimensions for a larger window."
  );

  await command("reset layout");
  await expect.poll(() => size(sidebar(), "width")).toBe(235);
  await expect(panel()).toHaveCount(0);
  await page.keyboard.press("Control+j");
  for (const theme of ["light", "dark"]) {
    await evaluate((workbench, theme) => workbench.settings({ theme }), theme);
    await expect(page.locator(".monaco-editor-background").first()).toHaveCSS(
      "background-color",
      theme === "light" ? "rgb(255, 255, 255)" : "rgb(30, 30, 30)"
    );
    await vertical().focus();
    await mkdir(path.join(root, "test-results"), { recursive: true });
    await page.screenshot({
      path: path.join(root, `test-results/layout-${theme}.png`),
    });
  }
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(root, "test-results/layout-workflows.json"),
    JSON.stringify(evidence, null, 2)
  );
  console.log(evidence.join("\n"));
} catch (error) {
  console.error("Layout verification failed:", error);
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
