import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { hostTarget, compilerEnvironment } from "./toolchain-target.mjs";

test("tool manifests and executable names follow the supported host", () => {
  assert.equal(hostTarget("linux", "x64").target, "x86_64-unknown-linux-gnu");
  assert.equal(hostTarget("linux", "x64").suffix, "");
  assert.equal(hostTarget("win32", "x64").manifest, "tools.json");
  assert.equal(hostTarget("win32", "x64").suffix, ".exe");
  assert.throws(() => hostTarget("darwin", "x64"), /Unsupported/);
  assert.throws(() => hostTarget("linux", "arm64"), /Unsupported/);
});

test("Linux compiler library lookup is confined to the child environment", () => {
  const environment = { PATH: "system", LD_LIBRARY_PATH: "/custom" };
  const executable = path.resolve("compiler/bin/pawncc");
  const result = compilerEnvironment(executable, environment, "linux");
  assert.equal(
    result.LD_LIBRARY_PATH,
    `${path.resolve("compiler/lib")}:/custom`
  );
  assert.equal(environment.LD_LIBRARY_PATH, "/custom");
  assert.equal(
    compilerEnvironment(executable, environment, "win32"),
    environment
  );
});
