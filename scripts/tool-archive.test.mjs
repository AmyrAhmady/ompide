import assert from "node:assert/strict";
import test from "node:test";
import { listToolArchive, extractToolArchive } from "./tool-archive.mjs";

test("Linux ZIP preparation uses unzip with literal path arguments", () => {
  const calls = [];
  const run = (...args) => {
    calls.push(args);
    return "source/main.go\n";
  };
  const archive = "/cache with spaces/source.zip";
  assert.equal(listToolArchive(archive, "linux", run), "source/main.go\n");
  extractToolArchive(archive, "/temporary source", "linux", run);
  assert.deepEqual(
    calls.map(([exe, args]) => [exe, args]),
    [
      ["unzip", ["-Z1", archive]],
      ["unzip", ["-q", archive, "-d", "/temporary source"]],
    ]
  );
});

test("Linux tarballs and Windows ZIPs retain the supported tar commands", () => {
  for (const [platform, archive] of [
    ["linux", "compiler.tar.gz"],
    ["win32", "source.zip"],
  ]) {
    const calls = [];
    const run = (...args) => {
      calls.push(args);
      return "source/\n";
    };
    listToolArchive(archive, platform, run);
    extractToolArchive(archive, "staging", platform, run);
    assert.deepEqual(
      calls.map(([exe, args]) => [exe, args]),
      [
        ["tar", ["-tf", archive]],
        ["tar", ["-xf", archive, "-C", "staging"]],
      ]
    );
  }
});
