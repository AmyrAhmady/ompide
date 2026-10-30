// Native dependency inspection; every source/asset is reviewed without fetching.
import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect as baseExpect } from "@playwright/test";

const expect = baseExpect.configure({ timeout: 15_000 });
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "pawn-dependency-review-"));
const preferences = path.join(
  process.env.APPDATA,
  "mp.open.editor/preferences.json"
);
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
      const resources = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name);
      const { workbench } = await import(
        resources.find((url) => /\/src\/app\/workbench\.ts(?:\?|$)/.test(url))
      );
      const { native } = await import(
        resources.find((url) => /\/src\/lib\/native\.ts(?:\?|$)/.test(url))
      );
      return await (0, eval)(operation)(workbench, native, argument);
    },
    { operation: operation.toString(), argument }
  );
}

async function configure() {
  await page.keyboard.press("F1");
  const palette = page.getByRole("dialog", {
    name: "Command Palette…",
    exact: true,
  });
  await palette.getByRole("combobox").fill("configure project");
  await palette.getByRole("combobox").press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Configure Project…",
    exact: true,
  });
  await expect(
    dialog.getByRole("button", { name: "Review Dependencies", exact: true })
  ).toBeEnabled();
  return dialog;
}

async function review(dialog) {
  await dialog
    .getByRole("button", { name: "Review Dependencies", exact: true })
    .click();
  await expect(dialog.locator(".dependency-review")).toHaveAttribute(
    "aria-busy",
    "false"
  );
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
  await mkdir(path.dirname(preferences), { recursive: true });
  seeded = true;
  await writeFile(
    preferences,
    JSON.stringify({
      recentWorkspaces: [directory],
      recentFiles: [],
      settings: { theme: "dark" },
    })
  );
  await page.reload();
  await expect
    .poll(() => evaluate((workbench) => workbench.getSnapshot().ready))
    .toBe(true);
  const unauthorized = await evaluate(async (workbench, native, folder) => {
    try {
      await native.reviewDependencies(folder);
      return "allowed";
    } catch (error) {
      return error.code;
    }
  }, directory);
  assert.equal(unauthorized, "noWorkspace");
  await page.getByRole("button", { name: directory, exact: true }).click();
  let dialog = await configure();
  await review(dialog);
  await expect(
    dialog.getByText("No dependencies are declared in the saved manifest.", {
      exact: true,
    })
  ).toBeVisible();
  await expect(dialog.getByText(/^No saved lockfile was found/)).toBeVisible();
  assert.equal(
    await evaluate((workbench) => workbench.getSnapshot().build.phase),
    "idle"
  );
  await assert.rejects(stat(path.join(directory, "dependencies")), {
    code: "ENOENT",
  });
  evidence.push(
    "Missing-lock review is actionable, read-only and does not start Build or create dependencies."
  );

  const manifestPath = path.join(directory, "pawn.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.dependencies = ["openmultiplayer/omp-stdlib:1.0.0"];
  manifest.dev_dependencies = ["user/test-helpers"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const digest = "sha256:" + "a".repeat(64);
  const lock = {
    schemaVersion: 1,
    packages: [
      {
        name: "openmultiplayer/omp-stdlib",
        source: {
          type: "git",
          url: "https://github.com/openmultiplayer/omp-stdlib",
        },
        commit: "0123456789abcdef0123456789abcdef01234567",
        kind: "includes",
        resolved: "1.0.0",
      },
    ],
    resources: [
      {
        package: "openmultiplayer/omp-stdlib",
        resource: "headers",
        target: "windows-amd64",
        url: "https://example.org/headers.zip",
        checksum: digest,
        files: [{ destination: "include/headers.inc" }],
      },
    ],
  };
  const lockPath = path.join(directory, "pawn.lock");
  const lockText = JSON.stringify(lock);
  await writeFile(lockPath, lockText);
  await review(dialog);
  await expect(
    dialog.getByText("openmultiplayer/omp-stdlib:1.0.0", { exact: true })
  ).toBeVisible();
  await expect(
    dialog.getByText("(development)", { exact: true })
  ).toBeVisible();
  const dependency = dialog.locator("details").filter({
    has: page.locator("summary", {
      hasText: /^openmultiplayer\/omp-stdlib$/,
    }),
  });
  await dependency.locator("summary").click();
  await expect(
    dependency.getByText(lock.packages[0].commit, { exact: true })
  ).toBeVisible();
  const resource = dialog.locator("details").filter({
    has: page.locator("summary", { hasText: "headers (windows-amd64)" }),
  });
  await resource.locator("summary").click();
  await expect(resource.getByText(digest, { exact: true })).toBeVisible();
  await expect(
    resource.getByText(path.join(directory, "include/headers.inc"), {
      exact: true,
    })
  ).toBeVisible();
  await dialog.locator(".dependency-review").screenshot({
    path: path.join(root, "test-results/dependency-review-dark.png"),
  });
  await evaluate((workbench) => workbench.settings({ theme: "light" }));
  await dialog.locator(".dependency-review").screenshot({
    path: path.join(root, "test-results/dependency-review-light.png"),
  });
  assert.equal(await readFile(lockPath, "utf8"), lockText);
  await assert.rejects(stat(path.join(directory, "dependencies")), {
    code: "ENOENT",
  });
  await assert.rejects(stat(path.join(directory, "include/headers.inc")), {
    code: "ENOENT",
  });
  evidence.push(
    "Real native review displays declarations, development dependencies, locked commits, resource URLs/checksums/targets and destinations without fetching the advertised source or asset. Both themes captured."
  );

  await dialog
    .getByRole("button", { name: "Open Lockfile", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const editor = page.getByRole("textbox", { name: "Pawn IDE", exact: true });
  await editor.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n// unsaved lock edit");
  dialog = await configure();
  await review(dialog);
  await expect(
    dialog.getByText(/^The manifest or lockfile has unsaved changes/)
  ).toBeVisible();
  assert.equal(await readFile(lockPath, "utf8"), lockText);
  assert.equal(
    await evaluate((workbench) =>
      workbench
        .getSnapshot()
        .tabs.some((tab) => tab.name === "pawn.lock" && tab.dirty)
    ),
    true
  );
  evidence.push(
    "Open Lockfile reaches the real Monaco buffer; a subsequent saved-input review preserves dirty edits and explicitly identifies them."
  );

  await writeFile(lockPath, "invalid lock JSON");
  await review(dialog);
  await expect(dialog.getByRole("alert")).toContainText(
    "Dependencies could not be reviewed."
  );
  await writeFile(
    lockPath,
    JSON.stringify({
      version: 1,
      generated: "2026-10-30T00:00:00Z",
      sampctl_version: "1.14.1",
      dependencies: {
        "github.com/openmultiplayer/omp-stdlib": {
          user: "openmultiplayer",
          repo: "omp-stdlib",
          commit: lock.packages[0].commit,
        },
      },
    })
  );
  await review(dialog);
  await expect(
    dialog.getByText("1 locked source", { exact: true })
  ).toBeVisible();
  const denied = await evaluate(async (workbench, native, folder) => {
    try {
      await native.reviewDependencies(folder);
      return "allowed";
    } catch (error) {
      return error.code;
    }
  }, path.dirname(directory));
  assert.equal(denied, "permissionDenied");
  evidence.push(
    "Malformed lock review reports a localized error and recovers with the alternate compatible schema; direct IPC rejects an outside project."
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(remoteRequests, []);
  await writeFile(
    path.join(root, "test-results/dependency-review.json"),
    JSON.stringify(evidence, null, 2)
  );
  console.log(evidence.join("\n"));
} catch (error) {
  console.error("Dependency review failed:", error);
  console.error("UI:", (await page.locator("body").innerText()).slice(-4000));
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
