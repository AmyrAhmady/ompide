import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/** Select a local compiler without invoking a shell or allowing Go to download a toolchain. */
export async function selectGo(
  { override, searchPath, cached, version, checksum, environment },
  run = execFileSync
) {
  const expected = `go version ${version} windows/amd64`;
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
      if (actual !== expected) throw new Error(`reported ${actual}`);
      return true;
    } catch (error) {
      failures.push(`${executable}: ${error.message}`);
      return false;
    }
  };

  if (override) {
    if (probe(override)) return { executable: override, source: "OMPIDE_GO" };
    throw new Error(
      `OMPIDE_GO must point to ${version} for Windows x64. ${failures.join("; ")}`
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
    if (probe(executable)) return { executable, source: "PATH" };
  }
  try {
    const hash = createHash("sha256")
      .update(await readFile(cached))
      .digest("hex");
    if (hash !== checksum)
      throw new Error("Cached Go executable checksum mismatch");
    if (probe(cached)) return { executable: cached, source: "cache" };
  } catch (error) {
    if (error.code !== "ENOENT") failures.push(`${cached}: ${error.message}`);
  }
  throw new Error(
    `Build requires ${version} for Windows x64. Install it on PATH or set OMPIDE_GO to its go.exe. Go is not downloaded automatically.${failures.length ? ` Checked: ${failures.join("; ")}` : ""}`
  );
}
