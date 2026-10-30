// Verify the pinned restore contract using local sources only: no acquisition.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pawn = path.join(
  root,
  "src-tauri/binaries/pawn-x86_64-pc-windows-msvc.exe"
);
const directory = await mkdtemp(path.join(tmpdir(), "pawn-dependencies-"));
const lockPath = path.join(directory, "pawn.lock");
const includePath = path.join(directory, "include");

function restore() {
  const result = spawnSync(
    pawn,
    ["restore", "--project", directory, "--format", "json"],
    { encoding: "utf8", windowsHide: true, timeout: 15_000 }
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(
    report.dependencies.map((item) => ({
      ...item,
      path: path.resolve(item.path),
    })),
    [{ name: "local/include", path: includePath, status: "local" }]
  );
  assert.equal(report.resources, undefined);
}

try {
  await mkdir(includePath);
  await writeFile(
    path.join(includePath, "library.inc"),
    "// local dependency\n"
  );
  await writeFile(path.join(directory, "main.pwn"), "main() {}\n");
  await writeFile(
    path.join(directory, "pawn.json"),
    JSON.stringify({
      entry: "main.pwn",
      dependencies: ["includes://local/include"],
    })
  );
  const locks = [
    {
      schemaVersion: 1,
      packages: [
        {
          name: "local/include",
          source: { type: "local", url: "include" },
          kind: "includes",
          commit: "",
          resolved: "local",
        },
      ],
    },
    {
      version: 1,
      generated: "2026-10-30T00:00:00Z",
      sampctl_version: "1.14.1",
      dependencies: {
        "includes://local/include": {
          user: "local",
          repo: "include",
          scheme: "includes",
          local: "include",
        },
      },
    },
  ];
  for (const lock of locks) {
    const text = JSON.stringify(lock);
    await writeFile(lockPath, text);
    restore();
    assert.equal(await readFile(lockPath, "utf8"), text);
    assert.equal(
      await readFile(path.join(includePath, "library.inc"), "utf8"),
      "// local dependency\n"
    );
  }
  console.log(
    "Pinned PawnKit restore: both local lock formats pass; inputs unchanged."
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
