import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export function goVersionParts(version) {
  const match = /^go(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? match.slice(1).map(Number) : undefined;
}

export function goAtLeast(actual, minimum) {
  const left = goVersionParts(actual);
  const right = goVersionParts(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

/** Select a local compiler without invoking a shell or allowing Go to download a toolchain. */
export async function selectGo(
  {
    override,
    searchPath,
    cached,
    version,
    exactVersion,
    checksum,
    environment,
  },
  run = execFileSync
) {
  const requirement = exactVersion
    ? `${exactVersion} exactly`
    : `${version} or newer (stable)`;
  const failures = [];

  const probe = (executable) => {
    try {
      const actual = run(executable, ["version"], {
        encoding: "utf8",
        env: { ...environment, GOTOOLCHAIN: "local" },
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 8192,
      }).trim();
      const match = /^go version (go\d+\.\d+\.\d+) windows\/amd64$/.exec(
        actual
      );
      if (
        !match ||
        !goAtLeast(match[1], version) ||
        (exactVersion && match[1] !== exactVersion)
      )
        throw new Error(`reported ${actual}`);
      return match[1];
    } catch (error) {
      failures.push(`${executable}: ${error.message}`);
      return false;
    }
  };

  if (override) {
    const actualVersion = probe(override);
    if (actualVersion)
      return {
        executable: override,
        source: "OMPIDE_GO",
        version: actualVersion,
      };
    throw new Error(
      `OMPIDE_GO must point to ${requirement} for Windows x64. ${failures.join("; ")}`
    );
  }
  for (const directory of (searchPath ?? "").split(path.delimiter)) {
    if (!directory.trim()) continue;
    const executable = path.join(directory.replace(/^"|"$/g, ""), "go.exe");
    try {
      if (!(await stat(executable)).isFile()) continue;
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
      failures.push(`${executable}: ${error.message}`);
      continue;
    }
    const actualVersion = probe(executable);
    if (actualVersion)
      return { executable, source: "PATH", version: actualVersion };
  }
  try {
    const hash = createHash("sha256")
      .update(await readFile(cached))
      .digest("hex");
    if (hash !== checksum)
      throw new Error("Cached Go executable checksum mismatch");
    const actualVersion = probe(cached);
    if (actualVersion)
      return { executable: cached, source: "cache", version: actualVersion };
  } catch (error) {
    if (error.code !== "ENOENT") failures.push(`${cached}: ${error.message}`);
  }
  throw new Error(
    `Build requires ${requirement} for Windows x64. Install it on PATH or set OMPIDE_GO to its go.exe. Go is not downloaded automatically.${failures.length ? ` Checked: ${failures.join("; ")}` : ""}`
  );
}
