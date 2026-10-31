import { goAtLeast } from "./go-toolchain.mjs";

export function localBuildMatches(
  record,
  pin,
  tool,
  actualHash,
  reproducible = false
) {
  if (record?.schemaVersion !== 1 || record.executableSha256 !== actualHash)
    return false;
  if (actualHash === tool.executableSha256) return true;
  if (reproducible) return false;
  const build = record.build;
  return (
    build?.version === pin.version &&
    build.sourceCommit === pin.source.commit &&
    build.sourceSha256 === pin.source.sha256 &&
    build.patchSha256 === pin.patch.sha256 &&
    goAtLeast(build.goVersion, pin.minimumGoVersion) &&
    build.target === "windows/amd64"
  );
}

export function buildRecord(pin, goVersion) {
  return {
    version: pin.version,
    sourceCommit: pin.source.commit,
    sourceSha256: pin.source.sha256,
    patchSha256: pin.patch.sha256,
    goVersion,
    target: "windows/amd64",
  };
}
