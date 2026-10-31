import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { localBuildMatches, buildRecord } from "./lsp-build-record.mjs";

const pin = JSON.parse(
  await readFile(
    new URL("../toolchain/pawnlsp-build.json", import.meta.url),
    "utf8"
  )
);
const tool = JSON.parse(
  await readFile(new URL("../toolchain/tools.json", import.meta.url), "utf8")
).tools.find((item) => item.name === "pawnlsp");

test("local tool cache validates actual hash, pinned source/patch and compiler minimum", () => {
  const hash = "a".repeat(64);
  const record = {
    schemaVersion: 1,
    executableSha256: hash,
    build: buildRecord(pin, "go1.27.3"),
  };
  assert.equal(localBuildMatches(record, pin, tool, hash), true);
  assert.equal(localBuildMatches(record, pin, tool, hash, true), false);
  assert.equal(localBuildMatches(record, pin, tool, "b".repeat(64)), false);
  for (const changed of [
    { sourceCommit: "stale" },
    { sourceSha256: "wrong" },
    { patchSha256: "wrong" },
    { version: "wrong" },
    { goVersion: "go1.26.4" },
    { target: "windows/arm64" },
  ])
    assert.equal(
      localBuildMatches(
        { ...record, build: { ...record.build, ...changed } },
        pin,
        tool,
        hash
      ),
      false
    );
  assert.equal(
    localBuildMatches({ ...record, build: undefined }, pin, tool, hash),
    false
  );
});

test("official release hash remains usable without local build metadata", () => {
  const record = { schemaVersion: 1, executableSha256: tool.executableSha256 };
  assert.equal(
    localBuildMatches(record, pin, tool, tool.executableSha256, true),
    true
  );
  assert.equal(
    localBuildMatches(
      { ...record, schemaVersion: 2 },
      pin,
      tool,
      tool.executableSha256
    ),
    false
  );
});
