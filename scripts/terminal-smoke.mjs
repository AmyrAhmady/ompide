// Real Windows desktop PTY, tabbed panel and custom window controls. No mocked IPC.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect as baseExpect } from "@playwright/test";

const expect = baseExpect.configure({ timeout: 20000 });
const processId = Number(process.argv[process.argv.indexOf("--pid") + 1]);
assert.ok(
  Number.isInteger(processId) && processId > 0,
  "pass --pid for the test app"
);
const directory = await mkdtemp(path.join(tmpdir(), "pawn-terminal-smoke-"));
const first = path.join(directory, "first workspace");
const second = path.join(directory, "second workspace");
const preferences = path.join(
  process.env.APPDATA,
  "mp.open.editor/preferences.json"
);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = browser.contexts()[0];
const page =
  context.pages().find((tab) => tab.url().includes(":1420/")) ??
  context.pages()[0] ??
  (await context.waitForEvent("page", { timeout: 30000 }));
await page.waitForURL((url) => url.port === "1420", {
  timeout: 30000,
  waitUntil: "domcontentloaded",
});
page.setDefaultTimeout(20000);
const errors = [];
const evidence = [];
const shellPids = [];
page.on("pageerror", (error) => errors.push(error.stack || error.message));
let previous;
let seeded = false;

function probe(action = "inspect", screenshot) {
  const args = [
    "-NoProfile",
    "-File",
    "scripts/window-probe.ps1",
    "-ProcessId",
    String(processId),
    "-Action",
    action,
  ];
  if (screenshot) args.push("-Screenshot", screenshot);
  return JSON.parse(
    execFileSync("powershell", args, { encoding: "utf8", windowsHide: true })
  );
}

function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function evaluate(operation, argument) {
  return page.evaluate(
    async ({ operation, argument }) => {
      const urls = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name);
      const { workbench } = await import(
        urls.find((url) => /\/src\/app\/workbench\.ts(?:\?|$)/.test(url))
      );
      const { native } = await import(
        urls.find((url) => /\/src\/lib\/native\.ts(?:\?|$)/.test(url))
      );
      return await (0, eval)(operation)(workbench, native, argument);
    },
    { operation: operation.toString(), argument }
  );
}

const terminal = page.getByRole("region", { name: "Terminal", exact: true });
const controls = page.locator(".terminal-header-controls");
const surface = () => page.locator(".terminal-surface:not([hidden])");
const text = () => surface().locator(".xterm-rows").textContent();

async function send(command) {
  await surface().locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(command, { delay: 2 });
  await page.keyboard.press("Enter");
}

async function shellPid() {
  await send("Write-Output ('PAWN_SHELL_PID='+$PID)");
  await expect
    .poll(async () => /PAWN_SHELL_PID=(\d+)/.exec(await text())?.[1])
    .toBeTruthy();
  const pid = Number(/PAWN_SHELL_PID=(\d+)/.exec(await text())[1]);
  shellPids.push(pid);
  return pid;
}

try {
  probe("place");
  try {
    previous = await readFile(preferences);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await evaluate(async (_w, native) => native.terminalCloseAll());
  await mkdir(first, { recursive: true });
  await mkdir(second);
  await writeFile(path.join(first, "notes.txt"), "terminal fixture\n");
  await mkdir(path.dirname(preferences), { recursive: true });
  await writeFile(
    preferences,
    JSON.stringify({
      recentWorkspaces: [first, second],
      settings: {
        theme: "dark",
        layout: { panelVisible: true, panel: "terminal", panelHeight: 350 },
      },
    })
  );
  seeded = true;
  await page.reload();
  await expect.poll(() => evaluate((w) => w.getSnapshot().ready)).toBe(true);
  await expect(surface()).toHaveCount(0);
  await expect(
    page.getByRole("tablist", { name: "Panel views" })
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Terminal", exact: true })
  ).toHaveAttribute("aria-selected", "true");
  evidence.push(
    "Restored Terminal tab remains empty until an explicit New Terminal action."
  );
  await page.getByRole("button", { name: first, exact: true }).click();
  await expect.poll(() => evaluate((w) => w.getSnapshot().root)).toBe(first);
  await controls
    .getByRole("combobox", { name: "Shell profile" })
    .selectOption("pwsh");
  await controls
    .getByRole("button", { name: "New Terminal", exact: true })
    .click();
  await expect(terminal.locator(".terminal-cwd")).toContainText(first);
  await expect.poll(text).toContain("PS ");
  const originalPid = await shellPid();
  await send(
    "Write-Output ('UNICODE_'+[char]0x03bb+' '+[char]::ConvertFromUtf32(0x1f600))"
  );
  await expect.poll(text).toContain("UNICODE_λ 😀");
  await send(
    "[Console]::WriteLine(([char]27)+'[31mANSI_RED'+([char]27)+'[0m')"
  );
  await expect.poll(text).toContain("ANSI_RED");
  evidence.push(
    "Real PowerShell starts in the selected workspace and renders Unicode and ANSI output."
  );

  const promptsBefore = ((await text()).match(/PS /g) ?? []).length;
  await send("Write-Output ('SLEEP_'+'START'); Start-Sleep -Seconds 30");
  await expect.poll(text).toContain("SLEEP_START");
  await page.keyboard.press("Control+c");
  await expect
    .poll(async () => ((await text()).match(/PS /g) ?? []).length)
    .toBeGreaterThan(promptsBefore);
  // ConPTY/PowerShell can flush input briefly after repainting the prompt.
  await page.waitForTimeout(300);
  await send("Write-Output ('INTERRUPT_'+'OK')");
  await expect.poll(text).toContain("INTERRUPT_OK");
  await send("Start-Sleep -Milliseconds 500; Write-Output ('HIDDEN_'+'OK')");
  await page.getByRole("tab", { name: "Problems", exact: true }).click();
  await expect(controls).toBeHidden();
  await page.getByRole("tab", { name: "Build Output", exact: true }).click();
  await page.getByRole("tab", { name: "Terminal", exact: true }).click();
  await expect.poll(text).toContain("HIDDEN_OK");
  await page.getByRole("button", { name: "Hide panel" }).click();
  assert.equal(running(originalPid), true);
  await page.keyboard.press("Control+Backquote");
  await expect(terminal).toBeVisible();
  await expect(controls).toBeVisible();
  for (const name of ["Clear", "Copy", "Paste"])
    await expect(
      controls.getByRole("button", { name, exact: true })
    ).toHaveCount(0);
  await expect.poll(text).toContain("HIDDEN_OK");
  await page.getByRole("tab", { name: "Terminal", exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(
    page.getByRole("tab", { name: "Build Output", exact: true })
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("tab", { name: "Terminal", exact: true })
  ).toBeFocused();
  await send("[Console]::Write(('x'*400000)); Write-Output ('FLOOD_'+'END')");
  await page.getByRole("tab", { name: "Problems", exact: true }).click();
  await page.getByRole("tab", { name: "Terminal", exact: true }).click();
  await expect.poll(text).toContain("FLOOD_END");
  evidence.push(
    "Ctrl+C interrupts a live command. Session output survives tab changes and hiding; tab arrows/Home/End work."
  );

  // Exercise clipboard UI wiring with an isolated browser clipboard so the
  // user's real clipboard (which may contain an image) is never overwritten.
  await page.evaluate(() => {
    const clipboard = {
      value: "Write-Output ('PASTE_'+'OKλ😀')",
      readText: async () => clipboard.value,
      writeText: async (text) => {
        clipboard.value = text;
      },
    };
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: clipboard,
    });
  });
  await surface().locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+Shift+v");
  await page.keyboard.press("Enter");
  await expect.poll(text).toContain("PASTE_OKλ😀");
  const copiedRow = surface()
    .locator(".xterm-rows > div")
    .filter({ hasText: /^PASTE_OKλ😀/ })
    .first();
  const copiedBounds = await copiedRow.boundingBox();
  assert.ok(copiedBounds);
  await page.mouse.move(
    copiedBounds.x + 1,
    copiedBounds.y + copiedBounds.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    copiedBounds.x + 200,
    copiedBounds.y + copiedBounds.height / 2,
    { steps: 8 }
  );
  await page.mouse.up();
  await page.keyboard.press("Control+Shift+c");
  await expect
    .poll(() => page.evaluate(() => globalThis.navigator.clipboard.value))
    .toContain("PASTE_OKλ😀");
  evidence.push(
    "Unicode pasted input and selection copy work with the isolated clipboard."
  );
  await controls
    .getByRole("combobox", { name: "Shell profile" })
    .selectOption("cmd");
  await controls
    .getByRole("button", { name: "New Terminal", exact: true })
    .click();
  await expect.poll(text).toContain("Microsoft Windows");
  await send("echo CMD_TERMINAL_OK");
  await expect.poll(text).toContain("CMD_TERMINAL_OK");
  await send("exit 9");
  await expect.poll(text).toContain("Process exited with code 9.");
  await controls
    .getByRole("button", { name: "Kill Terminal", exact: true })
    .click();
  await expect.poll(text).toContain("PASTE_OK");
  assert.equal(running(originalPid), true);
  evidence.push(
    "Independent cmd session renders real output/exit code; closing it preserves the PowerShell session."
  );

  await evaluate(
    async (w, _native, nextRoot) => w.chooseFolder(nextRoot),
    second
  );
  await expect(terminal.locator(".terminal-cwd")).toContainText(first);
  await send("Write-Output ('RETAINED_CWD='+$PWD.Path)");
  await expect.poll(text).toContain("RETAINED_CWD=" + first);
  await controls
    .getByRole("combobox", { name: "Shell profile" })
    .selectOption("pwsh");
  await controls
    .getByRole("button", { name: "New Terminal", exact: true })
    .click();
  await expect(terminal.locator(".terminal-cwd")).toContainText(second);
  await expect.poll(text).toContain("PS ");
  const secondPid = await shellPid();
  await send(
    "$child=Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList '-NoLogo','-NoProfile','-Command','Start-Sleep -Seconds 120' -WindowStyle Hidden -PassThru; Write-Output ('DESCENDANT_PID='+$child.Id)"
  );
  await expect
    .poll(async () => /DESCENDANT_PID=(\d+)/.exec(await text())?.[1])
    .toBeTruthy();
  const childPid = Number(/DESCENDANT_PID=(\d+)/.exec(await text())[1]);
  shellPids.push(childPid);
  assert.equal(running(childPid), true);
  await controls
    .getByRole("button", { name: "Kill Terminal", exact: true })
    .click();
  await expect.poll(() => running(secondPid)).toBe(false);
  await expect.poll(() => running(childPid)).toBe(false);
  evidence.push(
    "Workspace switching preserves existing cwd; new sessions use the new root. Kill cleans the shell and its real child process."
  );

  const badRoot = await evaluate(async (_w, native) => {
    try {
      await native.terminalStart("cmd", "C:\\", 80, 24, () => {});
      return "accepted";
    } catch (error) {
      return error.code;
    }
  });
  assert.equal(badRoot, "terminalWorkspaceChanged");

  const resize = page.getByRole("separator", {
    name: "Resize Bottom Panel",
    exact: true,
  });
  await resize.focus();
  await page.keyboard.press("Shift+ArrowUp");
  await send(
    "Write-Output ('PTY_SIZE='+[Console]::WindowWidth+'x'+[Console]::WindowHeight)"
  );
  await expect.poll(text).toMatch(/PTY_SIZE=\d+x\d+/);
  const dimensions = /PTY_SIZE=(\d+)x(\d+)/.exec(await text());
  assert.ok(Number(dimensions[1]) > 20 && Number(dimensions[2]) > 2);
  for (const theme of ["dark", "light"]) {
    await evaluate(async (w, _native, theme) => w.settings({ theme }), theme);
    await page.screenshot({ path: `test-results/terminal-${theme}.png` });
  }
  await evaluate(async (w) => {
    const source = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((url) => /\/src\/app\/workbench\.ts(?:\?|$)/.test(url));
    const { parseTheme } = await import(
      new URL("../settings/theme.ts", source).href
    );
    await w.settings({
      theme: "custom",
      customTheme: parseTheme({
        name: "Terminal fixture",
        type: "dark",
        colors: {
          "terminal.background": "#102030",
          "terminal.foreground": "#ddeeff",
          "titleBar.activeBackground": "#203040",
        },
      }),
    });
  });
  await expect
    .poll(() =>
      terminal.evaluate(
        (element) => globalThis.getComputedStyle(element).backgroundColor
      )
    )
    .toBe("rgb(16, 32, 48)");
  await page.screenshot({ path: "test-results/terminal-custom.png" });
  evidence.push(
    "PTY resize reaches the real console; Light/Dark/custom terminal/title themes render and custom colors apply."
  );

  const geometry = probe();
  assert.equal(geometry.overlayHit, 9, "native HTMAXBUTTON snap region");
  assert.equal(geometry.topResizeHit, 12, "native HTTOP resize region");
  const nativeScale = await page.evaluate(() => globalThis.devicePixelRatio);
  assert.equal(
    geometry.overlay.Right - geometry.overlay.Left,
    Math.round(46 * nativeScale)
  );
  probe("hover", "test-results/titlebar-native-snap.png");
  probe("activate-maximize");
  await expect.poll(() => probe().maximized).toBe(true);
  await page
    .getByRole("button", { name: "Restore", exact: true })
    .press("Space");
  await expect.poll(() => probe().maximized).toBe(false);
  await page.getByRole("button", { name: "Minimize", exact: true }).click();
  await expect.poll(() => probe().minimized).toBe(true);
  probe("restore");
  probe("place");
  const beforeDrag = probe().window;
  probe("drag");
  const afterDrag = probe().window;
  assert.ok(
    beforeDrag.Left !== afterDrag.Left || beforeDrag.Top !== afterDrag.Top,
    "native drag moves the window"
  );
  probe("snap-left");
  const snapped = probe().window;
  assert.ok(
    snapped.Left <= 0 &&
      snapped.Right - snapped.Left !== beforeDrag.Right - beforeDrag.Left,
    "Windows snap changes bounds"
  );
  probe("restore");
  evidence.push(
    "Native maximize/restore/minimize, draggable title, edge hit testing and Windows Win+Left snapping pass. Native snap flyout captured for inspection."
  );

  await evaluate(async (w) => {
    await w.newFile();
    Reflect.get(w, "documents")
      .get(w.getSnapshot().active)
      .model.setValue("// unsaved titlebar fixture");
  });
  await page.getByRole("button", { name: "Close Window", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(running(originalPid), true);
  assert.equal(
    probe().overlayHit,
    9,
    "cancelled close must retain snap overlay"
  );
  await expect
    .poll(() => evaluate((w) => w.getSnapshot().tabs.some((tab) => tab.dirty)))
    .toBe(true);
  evidence.push(
    "Cancel in the dirty-close prompt preserves edits, the live terminal and the native snap overlay."
  );
  assert.deepEqual(errors, []);
  assert.equal(await terminal.locator(".terminal-error").count(), 0);
  // Renderer navigation must retire PTYs instead of orphaning hidden processes.
  await evaluate(async (w) => {
    const unlisten = w.subscribe(() => {
      if (w.getSnapshot().prompt) w.answerPrompt("discard");
    });
    try {
      await w.closeAll();
    } finally {
      unlisten();
    }
  });
  await page.reload();
  await expect.poll(() => running(originalPid)).toBe(false);
  await expect.poll(() => evaluate((w) => w.getSnapshot().ready)).toBe(true);
  await expect(surface()).toHaveCount(0);
  assert.equal(probe().overlayHit, 9);
  await controls
    .getByRole("button", { name: "New Terminal", exact: true })
    .click();
  await expect.poll(text).toContain("PS ");
  await expect(terminal.locator(".terminal-cwd")).not.toContainText(directory);
  await shellPid();
  evidence.push(
    "WebView reload retires native PTYs and preserves window chrome; no shell is started automatically afterward."
  );
  console.log(evidence.join("\n"));
} catch (error) {
  await page
    .screenshot({ path: "test-results/terminal-failure.png" })
    .catch(() => {});
  console.error("Terminal/titlebar verification failed", error);
  throw error;
} finally {
  try {
    const closed = page.waitForEvent("close", { timeout: 20000 });
    await evaluate(async (w) => {
      await Reflect.get(w, "settingsQueue").catch(() => undefined);
      w.subscribe(() => {
        if (w.getSnapshot().prompt) w.answerPrompt("discard");
      });
      await w.quit();
    });
    await closed;
    for (const pid of shellPids)
      await expect.poll(() => running(pid)).toBe(false);
  } finally {
    if (seeded) {
      if (previous) await writeFile(preferences, previous);
      else await rm(preferences, { force: true });
    }
    await browser.close();
    const absolute = path.resolve(directory);
    assert.ok(
      path.dirname(absolute) === path.resolve(tmpdir()) &&
        path.basename(absolute).startsWith("pawn-terminal-smoke-")
    );
    await rm(absolute, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}
