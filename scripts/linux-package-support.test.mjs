import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { projectRoot, removeTemporary } from "./release-support.mjs";
import { payloadFiles, verifyPayloadFiles } from "./linux-package-support.mjs";

test("Linux archive inventory detects corrupted, missing and extra payload files", async () => {
  const parent = path.join(projectRoot, "test-results");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "linux-payload-"));
  try {
    await mkdir(path.join(root, "usr/bin"), { recursive: true });
    await writeFile(path.join(root, "usr/bin/ompide"), "binary fixture");
    const expected = await payloadFiles(root);
    await verifyPayloadFiles(root, expected);
    await writeFile(
      path.join(root, "release-manifest.json"),
      "inventory itself is excluded"
    );
    await verifyPayloadFiles(root, expected);
    await assert.rejects(verifyPayloadFiles(root, []), /permissions changed/);
    await writeFile(path.join(root, "usr/bin/ompide"), "corrupt fixture");
    await assert.rejects(
      verifyPayloadFiles(root, expected),
      /permissions changed/
    );
    await writeFile(path.join(root, "usr/bin/ompide"), "binary fixture");
    await writeFile(path.join(root, "unexpected"), "extra");
    await assert.rejects(
      verifyPayloadFiles(root, expected),
      /permissions changed/
    );
  } finally {
    await removeTemporary(root, parent, "linux-payload-");
  }
});

test(
  "portable launcher resolves its own directory and preserves arguments",
  { skip: process.platform === "win32" },
  async () => {
    const parent = path.join(projectRoot, "test-results");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(
      path.join(parent, "linux-payload-launcher's files-")
    );
    try {
      await mkdir(path.join(root, "usr/bin"), { recursive: true });
      await copyFile(
        path.join(projectRoot, "packaging/linux/ompide"),
        path.join(root, "ompide")
      );
      const executable = path.join(root, "usr/bin/ompide");
      await writeFile(executable, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
      await chmod(executable, 0o755);
      const args = ["argument with spaces", "literal$()", "--last"];
      assert.equal(
        execFileSync("sh", [path.join(root, "ompide"), ...args], {
          encoding: "utf8",
          cwd: projectRoot,
        }),
        args.join("\n") + "\n"
      );
      const expected = await payloadFiles(root);
      await chmod(executable, 0o644);
      await assert.rejects(
        verifyPayloadFiles(root, expected),
        /permissions changed/
      );
    } finally {
      await removeTemporary(root, parent, "linux-payload-launcher's files-");
    }
  }
);
