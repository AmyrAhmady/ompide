// Actual Git/GCM/HTTPS/CGI through the native Source Control controls.
import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";
import { chromium, expect as baseExpect } from "@playwright/test";
import { gitAuthFixture } from "./git-auth-fixture.mjs";

const expect = baseExpect.configure({ timeout: 30000 });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = browser.contexts()[0];
const page =
  context.pages().find((page) => page.url().includes(":1420/")) ??
  context.pages()[0] ??
  (await context.waitForEvent("page"));
await page.waitForURL((url) => url.port === "1420", {
  timeout: 30000,
  waitUntil: "domcontentloaded",
});
const fixture = await gitAuthFixture();
const preferences = path.join(
  process.env.APPDATA,
  "mp.open.editor/preferences.json"
);
const evidence = [];
const browserErrors = [];
page.on("pageerror", (error) => browserErrors.push(error.message));
let previous;
let seeded = false;

async function evaluate(operation, argument) {
  return page.evaluate(
    async ({ operation, argument }) => {
      const urls = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name);
      const { workbench } = await import(
        urls.find((url) => /\/src\/app\/workbench\.ts(?:\?|$)/.test(url))
      );
      return await (0, eval)(operation)(workbench, argument);
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

async function action(name) {
  await settled();
  await scm.getByRole("button", { name, exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await settled();
  assert.ok(
    !(await page.locator("body").innerText()).includes(fixture.password),
    "Credential appeared in the rendered Git output."
  );
}

async function failRemote(mode, advice, command = "Push branch") {
  fixture.setMode(mode);
  await action(command);
  await expect(scm.getByRole("alert")).toContainText(advice);
}

try {
  try {
    previous = await readFile(preferences);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  seeded = true;
  await writeFile(
    preferences,
    JSON.stringify({
      recentWorkspaces: [fixture.repository],
      recentFiles: [],
      settings: { layout: { sidebar: "sourceControl", sidebarWidth: 330 } },
    })
  );
  await page.reload();
  await expect.poll(() => evaluate((w) => w.getSnapshot().ready)).toBe(true);
  await evaluate((w, root) => w.chooseFolder(root), fixture.repository);
  await refresh();
  await scm
    .locator("summary")
    .filter({ hasText: /^Remotes$/ })
    .click();
  const observedBefore = { ...fixture.counts };
  await refresh();
  assert.deepEqual(
    fixture.counts,
    observedBefore,
    "Status refresh must not contact the remote."
  );
  await action("Push branch");
  await expect(scm.getByRole("alert")).toHaveCount(0);
  assert.equal(
    fixture.git(fixture.remote, ["rev-parse", "main"]),
    fixture.git(fixture.repository, ["rev-parse", "HEAD"])
  );
  assert.ok(
    fixture.counts.challenges > 0 &&
      fixture.counts.authenticated > 0 &&
      fixture.counts.receive > 0
  );
  evidence.push(
    "Native HTTPS push completes a real HTTP 401 challenge using installed GCM and an isolated DPAPI credential store; TLS verification remains enabled."
  );

  fixture.git(fixture.directory, [
    "clone",
    "-b",
    "main",
    fixture.remote,
    fixture.clone,
  ]);
  for (const [key, value] of [
    ["user.name", "Remote fixture"],
    ["user.email", "fixture@example.invalid"],
    ["commit.gpgsign", "false"],
  ])
    fixture.git(fixture.clone, ["config", key, value]);
  await writeFile(
    path.join(fixture.clone, "pulled.txt"),
    "authenticated pull\n"
  );
  fixture.git(fixture.clone, ["add", "--", "pulled.txt"]);
  fixture.git(fixture.clone, ["commit", "-m", "Remote update"]);
  fixture.git(fixture.clone, ["push", fixture.remote, "main"]);
  await action("Pull (fast-forward)");
  await expect(scm.getByRole("alert")).toHaveCount(0);
  assert.equal(
    await readFile(path.join(fixture.repository, "pulled.txt"), "utf8"),
    "authenticated pull\n"
  );
  assert.ok(fixture.counts.upload > 0);
  evidence.push(
    "Native fast-forward pull downloads actual Git objects through authenticated HTTPS and applies the remote file."
  );

  const head = fixture.git(fixture.repository, ["rev-parse", "HEAD"]);
  await failRemote("deny", "authentication or repository access was denied");
  assert.equal(fixture.git(fixture.repository, ["rev-parse", "HEAD"]), head);
  fixture.setMode("ok");
  // Failed authentication erases the rejected fixture credential. Verify the missing-login path too.
  await action("Push branch");
  await expect(scm.getByRole("alert")).toContainText(
    "authentication or repository access was denied"
  );
  fixture.credentials();
  await failRemote(
    "forbidden",
    "authentication or repository access was denied"
  );
  fixture.credentials();
  await failRemote("notfound", "could not access the remote repository");
  await failRemote("unavailable", "could not access the remote repository");
  fixture.setMode("ok");
  fixture.git(fixture.repository, ["config", "--unset", "http.sslCAInfo"]);
  await action("Push branch");
  await expect(scm.getByRole("alert")).toContainText(
    "could not verify the remote certificate"
  );
  fixture.git(fixture.repository, [
    "config",
    "http.sslCAInfo",
    fixture.certFile,
  ]);
  const closedEndpoint = createServer();
  await new Promise((resolve) =>
    closedEndpoint.listen(0, "127.0.0.1", resolve)
  );
  const closedPort = closedEndpoint.address().port;
  await new Promise((resolve) => closedEndpoint.close(resolve));
  const offlineUrl = new URL(fixture.url);
  offlineUrl.port = String(closedPort);
  fixture.git(fixture.repository, [
    "remote",
    "set-url",
    "origin",
    offlineUrl.href,
  ]);
  await action("Push branch");
  await expect(scm.getByRole("alert")).toContainText(
    "could not access the remote repository"
  );
  fixture.git(fixture.repository, ["remote", "set-url", "origin", fixture.url]);
  evidence.push(
    "Denied/missing credentials, HTTP 403/404/503, connection refusal and an untrusted certificate produce actionable translated errors and preserve local HEAD."
  );

  await writeFile(path.join(fixture.repository, "local.txt"), "local commit\n");
  fixture.git(fixture.repository, ["add", "--", "local.txt"]);
  fixture.git(fixture.repository, ["commit", "-m", "Local change"]);
  await writeFile(
    path.join(fixture.remote, "hooks/pre-receive"),
    "#!/bin/sh\necho fixture-policy-rejection >&2\nexit 1\n",
    { mode: 0o755 }
  );
  await refresh();
  await action("Push branch");
  await expect(scm.getByRole("alert")).toContainText(
    "remote rejected this push"
  );
  assert.ok(
    (await scm.locator(".scm-output").innerText()).includes(
      "fixture-policy-rejection"
    )
  );
  await rm(path.join(fixture.remote, "hooks/pre-receive"));
  await writeFile(
    path.join(fixture.clone, "diverged.txt"),
    "remote diverged\n"
  );
  fixture.git(fixture.clone, ["add", "--", "diverged.txt"]);
  fixture.git(fixture.clone, ["commit", "-m", "Diverged remote"]);
  fixture.git(fixture.clone, ["push", fixture.remote, "main"]);
  await action("Push branch");
  await expect(scm.getByRole("alert")).toContainText(
    "remote rejected this push"
  );
  const localHead = fixture.git(fixture.repository, ["rev-parse", "HEAD"]);
  await action("Pull (fast-forward)");
  await expect(scm.getByRole("alert")).toContainText(
    "local and remote branches have diverged"
  );
  assert.equal(
    fixture.git(fixture.repository, ["rev-parse", "HEAD"]),
    localHead
  );
  evidence.push(
    "A real server pre-receive rejection, non-fast-forward push and diverged pull retain Git output and do not rewrite local history."
  );

  await evaluate(
    (w, file) => w.openPath(file),
    path.join(fixture.repository, "main.txt")
  );
  await evaluate((w) =>
    Reflect.get(w, "documents")
      .get(w.getSnapshot().active)
      .model.setValue("unsaved during remote failure\n")
  );
  fixture.setMode("hang");
  const hanging = fixture.counts.hanging;
  await settled();
  await scm.getByRole("button", { name: "Push branch", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await expect.poll(() => fixture.counts.hanging).toBeGreaterThan(hanging);
  await scm.getByRole("button", { name: "Cancel", exact: true }).click();
  await settled();
  await expect(scm.getByRole("alert")).toContainText("cancelled");
  assert.equal(await evaluate((w) => w.getSnapshot().tabs[0].dirty), true);
  assert.equal(
    await evaluate((w) =>
      Reflect.get(w, "documents").get(w.getSnapshot().active).model.getValue()
    ),
    "unsaved during remote failure\n"
  );
  evidence.push(
    "Cancelling a real blocked HTTPS request stops Git and preserves the unsaved editor buffer. Native credential tracing overrides prevent secret output even when repository tracing is enabled."
  );

  assert.deepEqual(browserErrors, []);
  await page.screenshot({ path: "test-results/git-auth-cancelled.png" });
  await writeFile(
    "test-results/git-auth-workflows.json",
    JSON.stringify({ evidence, requests: fixture.counts }, null, 2)
  );
  console.log(evidence.join("\n"));
} catch (error) {
  await page
    .screenshot({ path: "test-results/git-auth-failure.png" })
    .catch(() => undefined);
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
    await fixture.close();
  }
}
