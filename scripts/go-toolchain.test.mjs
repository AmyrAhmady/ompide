import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  selectGo,
  goAtLeast,
  goBuildEnvironment,
  goModuleDirectory,
  goExecutableArgument,
} from "./go-toolchain.mjs";

test("uses normal system command lookup without private environment variables or caches", async () => {
  const result = await selectGo(
    { version: "go1.26.5", environment: {} },
    (exe, args, options) => {
      assert.equal(exe, "go");
      assert.deepEqual(args, ["version"]);
      assert.equal(options.env.GOTOOLCHAIN, "local");
      return "go version go1.27.3 windows/amd64";
    }
  );
  assert.deepEqual(result, { executable: "go", version: "go1.27.3" });
});
test("allows an explicit compiler path without making it a setup requirement", async () => {
  const executable = path.resolve("custom Go", "bin/go.exe");
  assert.equal(
    (
      await selectGo(
        { executable, version: "go1.26.5", environment: {} },
        (exe) => {
          assert.equal(exe, executable);
          return "go version go1.26.5 windows/amd64";
        }
      )
    ).executable,
    executable
  );
});
test("reports missing, old, prerelease and wrong-architecture system compilers", async () => {
  for (const value of [
    "go version go1.26.4 windows/amd64",
    "go version go1.27rc1 windows/amd64",
    "go version go1.27.3 windows/arm64",
  ])
    await assert.rejects(
      selectGo({ version: "go1.26.5", environment: {} }, () => value),
      /Install compatible Go on PATH/
    );
  await assert.rejects(
    selectGo({ version: "go1.26.5", environment: {} }, () => {
      throw new Error("ENOENT");
    }),
    /ENOENT/
  );
});
test("accepts newer stable releases and retains explicit reproducible version checks", async () => {
  for (const version of [
    "go1.26.5",
    "go1.26.6",
    "go1.26.50",
    "go1.27.0",
    "go1.27.3",
    "go1.100.0",
  ]) {
    assert.equal(goAtLeast(version, "go1.26.5"), true);
    assert.equal(
      (
        await selectGo(
          { version: "go1.26.5", environment: {} },
          () => `go version ${version} windows/amd64`
        )
      ).version,
      version
    );
  }
  assert.equal(goAtLeast("go1.9.9", "go1.26.5"), false);
  await assert.rejects(
    selectGo(
      { version: "go1.26.5", exactVersion: "go1.26.5", environment: {} },
      () => "go version go1.27.3 windows/amd64"
    ),
    /go1.26.5 exactly/
  );
});
test("parses optional compiler CLI paths and rejects incomplete or duplicate flags", () => {
  assert.equal(goExecutableArgument([]), undefined);
  assert.equal(
    goExecutableArgument(["--download", "--go", "C:/custom Go/bin/go.exe"]),
    path.resolve("C:/custom Go/bin/go.exe")
  );
  assert.equal(
    goExecutableArgument(["--go", "./custom Go/bin/go.exe"]),
    path.resolve("./custom Go/bin/go.exe")
  );
  assert.equal(goExecutableArgument(["--go", "go1.26.5"]), "go1.26.5");
  for (const args of [
    ["--go"],
    ["--go", "--rebuild"],
    ["--go", "one", "--go", "two"],
  ])
    assert.throws(
      () => goExecutableArgument(args),
      /requires one executable path/
    );
});
test("uses standard Go caches and preserves configured cache and proxy settings", () => {
  const ordinary = goBuildEnvironment({}, true);
  for (const key of ["GOPATH", "GOMODCACHE", "GOCACHE", "GOPROXY", "GOSUMDB"])
    assert.equal(Object.hasOwn(ordinary, key), false);
  const configured = {
    GOPATH: "user workspace",
    GOMODCACHE: "user modules",
    GOCACHE: "user build cache",
    GOPROXY: "https://proxy.example",
    GOSUMDB: "custom database",
    GOENV: "user-go-env",
  };
  const result = goBuildEnvironment(configured, true);
  for (const [key, value] of Object.entries(configured))
    assert.equal(result[key], value);
  const offline = goBuildEnvironment(configured, false);
  assert.equal(offline.GOMODCACHE, configured.GOMODCACHE);
  assert.equal(offline.GOCACHE, configured.GOCACHE);
  assert.equal(offline.GOPROXY, "off");
  assert.equal(offline.GOSUMDB, "off");
});
test("uses Go-reported module paths rather than constructing a private cache path", () => {
  const environment = goBuildEnvironment({ GOMODCACHE: "custom cache" }, false);
  const directory = path.resolve(
    "custom cache",
    "github.com",
    "!example",
    "module@v1.0.0"
  );
  const resolved = goModuleDirectory(
    "go.exe",
    "github.com/Example/module@v1.0.0",
    { env: environment },
    (executable, args, options) => {
      assert.equal(executable, "go.exe");
      assert.deepEqual(args, [
        "mod",
        "download",
        "-json",
        "github.com/Example/module@v1.0.0",
      ]);
      assert.equal(options.env, environment);
      return JSON.stringify({ Dir: directory });
    }
  );
  assert.equal(resolved, directory);
  for (const value of [
    {},
    { Dir: "" },
    { Dir: directory, Error: "not cached" },
  ])
    assert.throws(
      () =>
        goModuleDirectory("go.exe", "module@v1", {}, () =>
          JSON.stringify(value)
        ),
      /Module source unavailable/
    );
});

test("preserves local Go build/workspace settings and clears them only for reproducible builds", () => {
  const settings = { GOFLAGS: "-tags=local", GOWORK: "user-workspace" };
  assert.equal(goBuildEnvironment(settings, true).GOFLAGS, settings.GOFLAGS);
  assert.equal(goBuildEnvironment(settings, true).GOWORK, settings.GOWORK);
  assert.equal(goBuildEnvironment(settings, true, true).GOFLAGS, "");
  assert.equal(goBuildEnvironment(settings, true, true).GOWORK, "off");
});

test("Linux builds select the installed Linux Go compiler", async () => {
  const options = { version: "go1.26.5", environment: {}, goos: "linux" };
  assert.equal(
    (await selectGo(options, () => "go version go1.27.3 linux/amd64")).version,
    "go1.27.3"
  );
  await assert.rejects(
    selectGo(options, () => "go version go1.27.3 windows/amd64"),
    /Install compatible Go/
  );
  assert.equal(goBuildEnvironment({}, true, true, "linux").GOOS, "linux");
});
