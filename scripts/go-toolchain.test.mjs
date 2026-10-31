import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  selectGo,
  goAtLeast,
  goBuildEnvironment,
  goModuleDirectory,
} from "./go-toolchain.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "ompide-go-selection-"));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("ompide-go-selection-"));
    await rm(directory, { recursive: true, force: true });
  });
  const installed = path.join(directory, "installed Go");
  await mkdir(installed);
  const system = path.join(installed, "go.exe");
  const cached = path.join(directory, "cached-go.exe");
  const bytes = Buffer.from("cached compiler fixture");
  await writeFile(system, "system compiler fixture");
  await writeFile(cached, bytes);
  return {
    directory,
    system,
    options: {
      searchPath: installed,
      cached,
      version: "go1.26.5",
      checksum: createHash("sha256").update(bytes).digest("hex"),
      environment: { GOTOOLCHAIN: "auto" },
    },
  };
}

test("uses installed Go before an absent cache and prevents implicit toolchain downloads", async (t) => {
  const { system, options, directory } = await fixture(t);
  options.cached = path.join(directory, "not-installed.exe");
  const result = await selectGo(options, (executable, args, settings) => {
    assert.equal(executable, system);
    assert.deepEqual(args, ["version"]);
    assert.equal(settings.env.GOTOOLCHAIN, "local");
    assert.equal(settings.windowsHide, true);
    return "go version go1.26.5 windows/amd64\r\n";
  });
  assert.deepEqual(result, {
    executable: system,
    source: "PATH",
    version: "go1.26.5",
  });
});

test("explicit override wins and an invalid override does not silently fall back", async (t) => {
  const { options } = await fixture(t);
  options.override = "explicit-go.exe";
  const result = await selectGo(options, (executable) => {
    assert.equal(executable, "explicit-go.exe");
    return "go version go1.26.5 windows/amd64";
  });
  assert.equal(result.source, "OMPIDE_GO");
  await assert.rejects(
    selectGo(options, () => "go version go1.26.4 windows/amd64"),
    /OMPIDE_GO must point/
  );
});

test("falls back from an incompatible system compiler to a checksum-verified cache", async (t) => {
  const { system, options } = await fixture(t);
  const result = await selectGo(options, (executable) =>
    executable === system
      ? "go version go1.26.4 windows/amd64"
      : "go version go1.26.5 windows/amd64"
  );
  assert.deepEqual(result, {
    executable: options.cached,
    source: "cache",
    version: "go1.26.5",
  });
});

test("rejects a corrupt cache without running it", async (t) => {
  const { options } = await fixture(t);
  options.searchPath = "";
  options.checksum = "0".repeat(64);
  await assert.rejects(
    selectGo(options, () => {
      throw new Error("must not execute corrupt Go");
    }),
    /Cached Go executable checksum mismatch/
  );
});

test("reports missing tools and rejects the wrong architecture or version suffix", async (t) => {
  const { options, directory } = await fixture(t);
  options.searchPath = "";
  options.cached = path.join(directory, "missing.exe");
  await assert.rejects(
    selectGo(options),
    /Install it on PATH or set OMPIDE_GO/
  );
  options.override = "explicit-go.exe";
  for (const actual of [
    "go version go1.26.5 windows/arm64",
    "go version go1.27rc1 windows/amd64",
    "go version devel go1.28 windows/amd64",
  ])
    await assert.rejects(
      selectGo(options, () => actual),
      /OMPIDE_GO must point/
    );
});

test("finds a compatible compiler after missing and incompatible PATH entries", async (t) => {
  const { options, system, directory } = await fixture(t);
  const old = path.join(directory, "old");
  await mkdir(old);
  await writeFile(path.join(old, "go.exe"), "old fixture");
  options.searchPath = [
    path.join(directory, "missing"),
    old,
    `"${path.dirname(system)}"`,
  ].join(path.delimiter);
  const result = await selectGo(options, (executable) =>
    executable === system
      ? "go version go1.26.5 windows/amd64"
      : "go version go1.25.1 windows/amd64"
  );
  assert.equal(result.executable, system);
});

test("accepts newer stable Go releases with numeric version comparisons", async (t) => {
  const { options } = await fixture(t);
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
          { ...options, override: "newer-go.exe" },
          () => `go version ${version} windows/amd64`
        )
      ).version,
      version
    );
  }
  assert.equal(goAtLeast("go1.9.9", "go1.26.5"), false);
});
test("reproducible builds can still require the exact release compiler", async (t) => {
  const { options } = await fixture(t);
  await assert.rejects(
    selectGo(
      { ...options, exactVersion: "go1.26.5", override: "new-go.exe" },
      () => "go version go1.27.3 windows/amd64"
    ),
    /go1.26.5 exactly/
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
