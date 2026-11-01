import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { copyPackageNotices, npmPackages } from "./release-notices.mjs";
import {
  listFiles,
  cargoExecutable,
  peInfo,
  projectRoot,
  releaseSettings,
  removeTemporary,
  sha256,
  verifyPackage,
} from "./release-support.mjs";

async function fixture() {
  const parent = path.join(projectRoot, "test-results");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "release-test-"));
  return {
    directory,
    cleanup: () => removeTemporary(directory, parent, "release-test-"),
  };
}

test("release versions agree and reject a mismatched native version", async () => {
  const { directory, cleanup } = await fixture();
  try {
    for (const file of [
      "package.json",
      "src-tauri/tauri.conf.json",
      "src-tauri/Cargo.toml",
      "rust-toolchain.toml",
      "toolchain/tools.json",
      "toolchain/tools-linux.json",
      "toolchain/pawnlsp-build.json",
    ]) {
      await mkdir(path.dirname(path.join(directory, file)), {
        recursive: true,
      });
      await cp(path.join(projectRoot, file), path.join(directory, file));
    }
    assert.equal(
      (await releaseSettings(directory)).version,
      (await releaseSettings()).version
    );
    const config = JSON.parse(
      await readFile(path.join(directory, "src-tauri/tauri.conf.json"), "utf8")
    );
    config.version = "99.0.0";
    await writeFile(
      path.join(directory, "src-tauri/tauri.conf.json"),
      JSON.stringify(config)
    );
    await assert.rejects(releaseSettings(directory), /versions must match/);
  } finally {
    await cleanup();
  }
});

test("release manifests reject corruption and unrecorded files", async () => {
  const { directory, cleanup } = await fixture();
  try {
    const settings = await releaseSettings();
    await writeFile(path.join(directory, "payload.txt"), "expected");
    const manifest = {
      schemaVersion: 1,
      version: settings.version,
      target: settings.target,
      files: [
        {
          path: "payload.txt",
          size: 8,
          sha256: sha256(Buffer.from("expected")),
        },
      ],
    };
    await writeFile(
      path.join(directory, "release-manifest.json"),
      JSON.stringify(manifest)
    );
    await writeFile(path.join(directory, "payload.txt"), "modified");
    await assert.rejects(
      verifyPackage(directory, settings),
      /checksum mismatch/
    );
    await writeFile(path.join(directory, "unexpected.txt"), "extra");
    await assert.rejects(verifyPackage(directory, settings), /unexpected/);
  } finally {
    await cleanup();
  }
});

test("release enumeration rejects a directory junction instead of following it", async () => {
  const { directory, cleanup } = await fixture();
  try {
    const target = path.join(directory, "target");
    await mkdir(target);
    await symlink(
      target,
      path.join(directory, "link"),
      process.platform === "win32" ? "junction" : "dir"
    );
    await assert.rejects(listFiles(directory), /Links and special files/);
  } finally {
    await cleanup();
  }
});

test("staging cleanup refuses a parent-directory mismatch", async () => {
  const { directory, cleanup } = await fixture();
  try {
    await assert.rejects(
      removeTemporary(directory, directory, "release-test-"),
      /Refusing/
    );
    assert.ok(await readFile(path.join(projectRoot, "package.json")));
  } finally {
    await cleanup();
  }
});

test("dependency notices preserve nested legal files and reject outside paths", async () => {
  const { directory, cleanup } = await fixture();
  try {
    const source = path.join(directory, "package");
    const destination = path.join(directory, "notices");
    await mkdir(path.join(source, "vscode"), { recursive: true });
    await writeFile(path.join(source, "LICENSE"), "upstream license\n");
    await chmod(path.join(source, "LICENSE"), 0o444);
    await writeFile(
      path.join(source, "vscode/ThirdPartyNotices.txt"),
      "upstream notices\n"
    );
    const info = {
      ecosystem: "npm",
      name: "@example/editor",
      version: "1.0.0",
    };
    const result = await copyPackageNotices(source, destination, info);
    assert.equal(result.notices.length, 2);
    assert.ok(
      (await stat(path.join(destination, result.notices[0]))).mode & 0o200
    );
    assert.equal(
      await readFile(path.join(destination, result.notices[0]), "utf8"),
      "upstream license\n"
    );
    await assert.rejects(
      copyPackageNotices(source, destination, info, "../outside.txt"),
      /outside its package/
    );
  } finally {
    await cleanup();
  }
});

test("PE validation rejects nonexecutables and out-of-bounds headers", () => {
  assert.throws(() => peInfo(Buffer.alloc(64)), /Not a Windows executable/);
  const bytes = Buffer.alloc(64);
  bytes.write("MZ");
  bytes.writeUInt32LE(0xffffff00, 60);
  assert.throws(() => peInfo(bytes), /Invalid PE header/);
});

test(
  "compiler runtime discovery supports numeric and alias v143/v145 layouts",
  {
    skip: process.platform !== "win32",
  },
  async () => {
    const { directory, cleanup } = await fixture();
    try {
      const locate = (installation, environment = {}) =>
        JSON.parse(
          execFileSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-File",
              path.join(projectRoot, "scripts/find-vc-runtime.ps1"),
              ...(installation ? ["-InstallationPath", installation] : []),
            ],
            {
              windowsHide: true,
              encoding: "utf8",
              stdio: "pipe",
              env: { ...process.env, ...environment },
            }
          )
        );
      const installed = locate();
      for (const [version, crt] of [
        ["14.42.34433", "Microsoft.VC143.CRT"],
        ["v143", "Microsoft.VC143.CRT"],
        ["14.50.35717", "Microsoft.VC145.CRT"],
        ["v145", "Microsoft.VC145.CRT"],
      ]) {
        const installation = path.join(directory, version);
        const redist = path.join(installation, "VC/Redist/MSVC");
        const wrongFolder = path.join(redist, "debug_nonredist/x86", crt);
        await mkdir(wrongFolder, { recursive: true });
        await cp(installed.path, path.join(wrongFolder, "vcruntime140.dll"));
        assert.throws(() => locate(installation), /runtime was not found/);
        const correctFolder = path.join(redist, version, "x86", crt);
        await mkdir(correctFolder, { recursive: true });
        const expected = path.join(correctFolder, "vcruntime140.dll");
        await cp(installed.path, expected);
        const found = locate(installation);
        assert.equal(found.path, expected);
        assert.equal(found.version, installed.version);
        assert.equal(
          locate(undefined, { VSINSTALLDIR: installation }).path,
          expected
        );
        assert.match(found.signer, /O=Microsoft Corporation/);
      }
    } finally {
      await cleanup();
    }
  }
);

test(
  "Windows archives use portable paths, extract intact and reject traversal",
  {
    skip: process.platform !== "win32",
  },
  async () => {
    const { directory, cleanup } = await fixture();
    try {
      const input = path.join(directory, "input");
      const extracted = path.join(directory, "extracted");
      const archive = path.join(directory, "test.zip");
      await mkdir(path.join(input, "nested"), { recursive: true });
      await writeFile(
        path.join(input, "nested/notice.txt"),
        "preserved text\n"
      );
      const run = (mode, target) =>
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-File",
            path.join(projectRoot, "scripts/release-archive.ps1"),
            "-Mode",
            mode,
            "-Archive",
            archive,
            "-Directory",
            target,
          ],
          { windowsHide: true, encoding: "utf8", stdio: "pipe" }
        );
      run("Create", input);
      const bytes = await readFile(archive);
      assert.ok(bytes.includes(Buffer.from("nested/notice.txt")));
      assert.ok(!bytes.includes(Buffer.from("nested\\notice.txt")));
      run("Extract", extracted);
      assert.equal(
        await readFile(path.join(extracted, "nested/notice.txt"), "utf8"),
        "preserved text\n"
      );
      const unsafe = Buffer.from(bytes);
      let index = 0;
      while ((index = unsafe.indexOf("nested/notice.txt", index)) >= 0) {
        unsafe.write("../bad/notice.txt", index);
        index += 17;
      }
      await writeFile(archive, unsafe);
      assert.throws(
        () => run("Extract", path.join(directory, "unsafe")),
        /Unsafe release archive entry/
      );
    } finally {
      await cleanup();
    }
  }
);

test("PE imports resolve section-relative addresses and reject an invalid DLL pointer", () => {
  const bytes = Buffer.alloc(0x600);
  bytes.write("MZ");
  bytes.writeUInt32LE(0x80, 60);
  bytes.write("PE\0\0", 0x80);
  bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(240, 0x94);
  bytes.writeUInt16LE(0x20b, 0x98);
  bytes.writeUInt32LE(0x1000, 0x110);
  bytes.write(".idata", 0x188);
  bytes.writeUInt32LE(0x200, 0x190);
  bytes.writeUInt32LE(0x1000, 0x194);
  bytes.writeUInt32LE(0x200, 0x198);
  bytes.writeUInt32LE(0x200, 0x19c);
  bytes.writeUInt32LE(0x1040, 0x20c);
  bytes.write("VCRUNTIME140.dll\0", 0x240);
  assert.deepEqual(peInfo(bytes), {
    machine: 0x8664,
    imports: ["vcruntime140.dll"],
  });
  bytes.writeUInt32LE(0x9000, 0x20c);
  assert.throws(() => peInfo(bytes), /outside the executable/);
});

test("npm notices use the npm invocation or normal system command instead of a guessed installation path", () => {
  const calls = [];
  const run = (...args) => {
    calls.push(args);
    return "[]";
  };
  npmPackages({}, { npm_execpath: "custom-npm-cli.js" }, run);
  assert.equal(calls[0][0], process.execPath);
  assert.equal(calls[0][1][0], "custom-npm-cli.js");
  npmPackages({}, {}, run);
  assert.equal(calls[1][0], process.platform === "win32" ? "cmd.exe" : "npm");
  if (process.platform === "win32")
    assert.equal(calls[1][2].windowsVerbatimArguments, true);
});

test("Cargo artifact discovery honors its reported target directory and rejects ambiguous builds", async () => {
  const { directory, cleanup } = await fixture();
  try {
    const target = path.join(directory, "custom build output");
    const metadata = (exe, args) => {
      assert.equal(exe, "cargo");
      assert.ok(args.includes("metadata"));
      return JSON.stringify({ target_directory: target });
    };
    const options = {
      root: directory,
      profile: "release",
      target: "x86_64-pc-windows-msvc",
      binary: "ompide.exe",
    };
    await assert.rejects(
      cargoExecutable(options, metadata),
      /No application build/
    );
    const native = path.join(target, "release", "ompide.exe");
    await mkdir(path.dirname(native), { recursive: true });
    await writeFile(native, "fixture");
    assert.equal(await cargoExecutable(options, metadata), native);
    const cross = path.join(target, options.target, "release", "ompide.exe");
    await mkdir(path.dirname(cross), { recursive: true });
    await writeFile(cross, "fixture");
    await assert.rejects(
      cargoExecutable(options, metadata),
      /Multiple application builds/
    );
    assert.equal(
      await cargoExecutable({ ...options, executable: cross }, () => {
        throw new Error("explicit paths do not need discovery");
      }),
      cross
    );
    const bridge = path.join(target, "debug", "pawn-lsp-bridge.exe");
    await mkdir(path.dirname(bridge), { recursive: true });
    await writeFile(bridge, "fixture");
    assert.equal(
      await cargoExecutable(
        { ...options, profile: "debug", binary: "pawn-lsp-bridge.exe" },
        metadata
      ),
      bridge
    );
  } finally {
    await cleanup();
  }
});
