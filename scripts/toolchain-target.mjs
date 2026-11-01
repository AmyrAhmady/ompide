import { readFile } from "node:fs/promises";
import path from "node:path";

export function hostTarget(platform = process.platform, arch = process.arch) {
  if (arch !== "x64" || !["win32", "linux"].includes(platform))
    throw new Error(`Unsupported toolchain host: ${platform}/${arch}`);
  return platform === "win32"
    ? {
        manifest: "tools.json",
        target: "x86_64-pc-windows-msvc",
        goos: "windows",
        suffix: ".exe",
      }
    : {
        manifest: "tools-linux.json",
        target: "x86_64-unknown-linux-gnu",
        goos: "linux",
        suffix: "",
      };
}

export async function toolManifest(root) {
  return JSON.parse(
    await readFile(path.join(root, "toolchain", hostTarget().manifest), "utf8")
  );
}

export function compilerEnvironment(
  executable,
  environment = process.env,
  platform = process.platform
) {
  if (platform !== "linux") return environment;
  const library = path.resolve(path.dirname(executable), "../lib");
  return {
    ...environment,
    LD_LIBRARY_PATH: [library, environment.LD_LIBRARY_PATH]
      .filter(Boolean)
      .join(":"),
  };
}
