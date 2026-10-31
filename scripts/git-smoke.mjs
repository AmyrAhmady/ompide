// Real Tauri/Monaco workflows; every Git mutation is confined to disposable repositories.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect as baseExpect } from "@playwright/test";

const expect = baseExpect.configure({ timeout: 20000 });
const directory = await mkdtemp(path.join(tmpdir(), "pawn-git-smoke-"));
const repository = path.join(directory, "repository");
const remote = path.join(directory, "remote.git");
const clone = path.join(directory, "clone");
const preferences = path.join(
  process.env.APPDATA,
  "mp.open.editor/preferences.json"
);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser
  .contexts()[0]
  .pages()
  .find((tab) => tab.url().includes(":1420/"));
assert.ok(page, "native development window required");
const errors = [];
page.on("pageerror", (error) => errors.push(error.stack || error.message));
const evidence = [];
const appearanceOnly = process.argv.includes("--appearance-only");
let previous;
let seeded = false;

function git(...args) {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
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

const scm = page.getByRole("region", { name: "Source Control", exact: true });

async function settled() {
  await expect(
    scm.getByRole("button", { name: "Refresh", exact: true })
  ).toBeEnabled();
}

async function refresh() {
  await settled();
  await scm.getByRole("button", { name: "Refresh", exact: true }).click();
  await settled();
}

async function action(label, confirm = false, container = scm) {
  await settled();
  await container.getByRole("button", { name: label, exact: true }).click();
  if (confirm) {
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Continue", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await settled();
}

try {
  try {
    previous = await readFile(preferences);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(repository);
  git("init", "-b", "main");
  git("config", "user.name", "ompide fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  await writeFile(path.join(repository, "main.txt"), "original version\n");
  git("add", "--", "main.txt");
  git("commit", "-m", "Initial fixture");
  const initial = git("rev-parse", "HEAD");
  await writeFile(path.join(repository, "main.txt"), "staged version\n");
  git("add", "--", "main.txt");
  await writeFile(path.join(repository, "main.txt"), "saved working version\n");
  await writeFile(path.join(repository, "Unicode 🦀.inc"), "// local source\n");
  execFileSync("git", ["init", "--bare", remote], { windowsHide: true });
  git("remote", "add", "origin", remote);
  seeded = true;
  await writeFile(
    preferences,
    JSON.stringify({
      recentWorkspaces: [repository],
      recentFiles: [],
      settings: {},
    })
  );
  await page.reload();
  await expect.poll(() => evaluate((w) => w.getSnapshot().ready)).toBe(true);
  await evaluate((w, _n, root) => w.chooseFolder(root), repository);
  await page
    .getByRole("navigation", { name: "Primary views" })
    .getByRole("button", { name: "Source Control", exact: true })
    .click();
  await refresh();
  await expect(scm.locator(".scm-branch")).toBeVisible();
  const staged = scm.getByRole("region", {
    name: "Staged Changes",
    exact: true,
  });
  const working = scm.getByRole("region", { name: "Changes", exact: true });
  if (!appearanceOnly) {
    await staged.locator(".scm-file").filter({ hasText: "main.txt" }).click();
    await expect(page.locator(".git-diff-view")).toContainText("HEAD → index");
    await expect(
      page
        .locator(".git-diff-view .view-lines")
        .filter({ hasText: "staged version" })
        .first()
    ).toBeVisible();
    await page
      .locator(".git-diff-view")
      .getByRole("button", { name: "Close Editor", exact: true })
      .click();
    await evaluate(
      (w, _n, file) => w.openPath(file),
      path.join(repository, "main.txt")
    );
    await evaluate((w) =>
      Reflect.get(w, "documents")
        .get(w.getSnapshot().active)
        .model.setValue("unsaved editor version\n")
    );
    await working.locator(".scm-file").filter({ hasText: "main.txt" }).click();
    await expect(page.locator(".git-diff-view")).toContainText(
      "unsaved editor buffer"
    );
    await expect(
      page
        .locator(".git-diff-view .view-lines")
        .filter({ hasText: "unsaved editor version" })
        .first()
    ).toBeVisible();
    await page.keyboard.press("Control+w");
    await expect(page.locator(".git-diff-view")).toHaveCount(0);
    await action("Stage main.txt");
    assert.equal(git("show", ":main.txt"), "saved working version");
    assert.equal(await evaluate((w) => w.getSnapshot().tabs[0].dirty), true);
    await scm
      .getByLabel("Commit message", { exact: true })
      .fill("Commit saved source");
    await action("Commit");
    assert.equal(git("show", "HEAD:main.txt"), "saved working version");
    await scm
      .getByLabel("Commit message", { exact: true })
      .fill("Amend saved source");
    await action("Amend last commit", true);
    assert.equal(git("log", "-1", "--format=%s"), "Amend saved source");
    await action("Undo last commit", true);
    assert.equal(git("rev-parse", "HEAD"), initial);
    assert.equal(await evaluate((w) => w.getSnapshot().tabs[0].dirty), true);
    evidence.push(
      "Actual staged/working/unsaved Monaco diffs; stage, commit, amend and soft undo preserve unsaved buffers."
    );
    await scm
      .locator("summary")
      .filter({ hasText: /^Branches$/ })
      .click();
    const branches = scm.locator("details").filter({
      has: page.locator("summary").filter({ hasText: /^Branches$/ }),
    });
    await branches.getByLabel("New branch name").fill("feature");
    await action("Create and switch", false, branches);
    await expect(scm.getByRole("alert")).toContainText("Save or close unsaved");
    assert.equal(git("branch", "--show-current"), "main");
    await action("Save All");
    await refresh();
    await action("Create and switch", false, branches);
    assert.equal(git("branch", "--show-current"), "feature");
    await branches.getByLabel("New branch name").fill("renamed");
    await action("Rename branch", false, branches);
    assert.equal(git("branch", "--show-current"), "renamed");
    await branches.getByLabel("Local branch").selectOption("main");
    await action("Switch branch", true, branches);
    await branches.getByLabel("Local branch").selectOption("renamed");
    await action("Delete branch", true, branches);
    assert.equal(git("branch", "--list", "renamed"), "");
    await action("Stage all");
    await scm
      .getByLabel("Commit message", { exact: true })
      .fill("Save all source");
    await action("Commit");
    evidence.push(
      "Dirty branch change is refused; Save All, create/switch/rename/delete branch and stage-all commit work."
    );
    await scm
      .locator("summary")
      .filter({ hasText: /^Remotes$/ })
      .click();
    await action("Push branch", true);
    assert.equal(git("rev-parse", "origin/main"), git("rev-parse", "HEAD"));
    await scm
      .locator("summary")
      .filter({ hasText: /^Tags$/ })
      .click();
    await scm.getByLabel("New tag name").fill("v1");
    await action("Create tag");
    await action("Push tag", true);
    assert.ok(
      execFileSync(
        "git",
        ["--git-dir", remote, "show-ref", "--verify", "refs/tags/v1"],
        { encoding: "utf8", windowsHide: true }
      ).length
    );
    await action("Delete tag", true);
    execFileSync("git", ["clone", "-b", "main", remote, clone], {
      windowsHide: true,
    });
    for (const [key, value] of [
      ["user.name", "Other fixture"],
      ["user.email", "fixture@example.invalid"],
      ["commit.gpgsign", "false"],
    ])
      execFileSync("git", ["-C", clone, "config", key, value], {
        windowsHide: true,
      });
    await writeFile(path.join(clone, "pulled.txt"), "from local bare remote\n");
    execFileSync("git", ["-C", clone, "add", "--", "pulled.txt"], {
      windowsHide: true,
    });
    execFileSync("git", ["-C", clone, "commit", "-m", "Remote source"], {
      windowsHide: true,
    });
    execFileSync("git", ["-C", clone, "push", "origin", "main"], {
      windowsHide: true,
    });
    await action("Pull (fast-forward)", true);
    assert.equal(
      await readFile(path.join(repository, "pulled.txt"), "utf8"),
      "from local bare remote\n"
    );
    evidence.push(
      "Push, fast-forward pull, create/delete/push tag use only a disposable local bare remote."
    );
    await writeFile(path.join(repository, "main.txt"), "stash content\n");
    await refresh();
    await scm
      .locator("summary")
      .filter({ hasText: /^Stashes$/ })
      .click();
    await scm
      .getByLabel("Stash message", { exact: true })
      .fill("Fixture stash");
    await action("Stash changes", true);
    assert.equal(git("status", "--porcelain"), "");
    await action("Apply");
    assert.equal(
      await readFile(path.join(repository, "main.txt"), "utf8"),
      "stash content\n"
    );
    await action("Stash changes", true);
    await action("Pop", true);
    await action("Drop", true);
    assert.equal(git("stash", "list"), "");
    await action("Stage all");
    await action("Unstage all");
    assert.equal(git("diff", "--cached", "--name-only"), "");
    evidence.push(
      "Stash create/apply/pop/drop and unstage-all alter the real index/worktree as expected."
    );
    // A real configured hook holds the owned child tree so cancellation is observable.
    await action("Stage all");
    await writeFile(
      path.join(repository, ".git/hooks/pre-commit"),
      "#!/bin/sh\necho ready > .git/hook-started\nsleep 30\n",
      { mode: 0o755 }
    );
    await scm
      .getByLabel("Commit message", { exact: true })
      .fill("Cancelled fixture");
    const beforeCancel = git("rev-parse", "HEAD");
    await scm.getByRole("button", { name: "Commit", exact: true }).click();
    await expect
      .poll(async () => {
        try {
          return await readFile(
            path.join(repository, ".git/hook-started"),
            "utf8"
          );
        } catch {
          return "";
        }
      })
      .toContain("ready");
    assert.equal(
      await evaluate(async (_w, n, root) => {
        try {
          await n.recentWorkspace(root);
          return "unexpected success";
        } catch (error) {
          return error.code;
        }
      }, repository),
      "gitBusy"
    );
    await scm.getByRole("button", { name: "Cancel", exact: true }).click();
    await settled();
    assert.equal(git("rev-parse", "HEAD"), beforeCancel);
    await expect(scm.getByRole("alert")).toContainText("cancelled");
    evidence.push(
      "Cancelling a commit kills the real waiting Git/hook subprocess tree and refreshes state without claiming rollback."
    );
  }
  for (const theme of ["light", "dark"]) {
    await evaluate(
      (w, _n, theme) =>
        w.settings({
          theme,
          layout: { ...w.getSnapshot().settings.layout, sidebarWidth: 315 },
        }),
      theme
    );
    await refresh();
    await staged.locator(".scm-file").filter({ hasText: "main.txt" }).click();
    await expect(page.locator(".git-diff-view")).toBeVisible();
    await settled();
    await expect(
      page
        .locator(".git-diff-view .view-lines")
        .filter({
          hasText: appearanceOnly ? "staged version" : "stash content",
        })
        .first()
    ).toBeVisible();
    await page.screenshot({ path: `test-results/git-${theme}.png` });
    await page.keyboard.press("Control+w");
    await expect(page.locator(".git-diff-view")).toHaveCount(0);
  }
  await page.keyboard.press("Control+Shift+e");
  await expect(
    page
      .getByRole("navigation", { name: "Primary views" })
      .getByRole("button", { name: "Explorer", exact: true })
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Control+Shift+f");
  await expect(
    page
      .getByRole("navigation", { name: "Primary views" })
      .getByRole("button", { name: "Search Workspace", exact: true })
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Control+Shift+g");
  await expect(scm).toBeVisible();
  const customTheme = JSON.parse(
    await readFile(
      new URL("../src/settings/themes/dark.json", import.meta.url),
      "utf8"
    )
  );
  customTheme.name = "Git appearance fixture";
  customTheme.colors["activityBar.background"] = "#182a41";
  await evaluate(
    (w, _n, customTheme) => w.settings({ theme: "custom", customTheme }),
    customTheme
  );
  await expect(page.locator(".activity-bar")).toHaveCSS(
    "background-color",
    "rgb(24, 42, 65)"
  );
  await refresh();
  await staged.locator(".scm-file").filter({ hasText: "main.txt" }).click();
  await expect(page.locator(".git-diff-view")).toBeVisible();
  await settled();
  await page.screenshot({ path: "test-results/git-custom.png" });
  await page.keyboard.press("Control+w");
  const sourceButton = page
    .locator(".activity-bar")
    .getByRole("button", { name: "Source Control", exact: true });
  await sourceButton.focus();
  await page.keyboard.press("Home");
  await expect(
    page
      .locator(".activity-bar")
      .getByRole("button", { name: "Explorer", exact: true })
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(sourceButton).toBeFocused();
  await evaluate((w) => Reflect.get(w, "settingsQueue"));
  const stored = JSON.parse(await readFile(preferences, "utf8"));
  assert.equal(stored.settings.layout.sidebar, "sourceControl");
  await evaluate((w) => w.closeAll());
  await page.reload();
  await expect.poll(() => evaluate((w) => w.getSnapshot().ready)).toBe(true);
  assert.equal(
    await evaluate((w) => w.getSnapshot().settings.layout.sidebar),
    "sourceControl"
  );
  evidence.push(
    "Light/Dark and custom theme diff views, activity-bar keyboard navigation and selected-view persistence verified in native WebView2."
  );
  assert.deepEqual(errors, []);
  await writeFile(
    appearanceOnly
      ? "test-results/git-appearance.json"
      : "test-results/git-workflows.json",
    JSON.stringify(evidence, null, 2)
  );
  console.log(evidence.join("\n"));
} catch (error) {
  await page
    .screenshot({ path: "test-results/git-failure.png" })
    .catch(() => undefined);
  console.error("Git workflow verification failed", error);
  throw error;
} finally {
  try {
    const closed = page.waitForEvent("close", { timeout: 15000 });
    await evaluate(async (w) => {
      await Reflect.get(w, "settingsQueue").catch(() => undefined);
      w.subscribe(() => {
        if (w.getSnapshot().prompt) w.answerPrompt("discard");
      });
      await w.quit();
    });
    await closed;
  } finally {
    if (seeded) {
      if (previous) await writeFile(preferences, previous);
      else await rm(preferences, { force: true });
    }
    await browser.close();
    const absolute = path.resolve(directory);
    assert.ok(
      path.dirname(absolute) === path.resolve(tmpdir()) &&
        path.basename(absolute).startsWith("pawn-git-smoke-")
    );
    await rm(absolute, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}
