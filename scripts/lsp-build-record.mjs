import { goAtLeast } from "./go-toolchain.mjs";

export function localBuildMatches(
  record,
  pin,
  tool,
  actualHash,
  reproducible = false,
  target = "windows/amd64"
) {
  if (record?.schemaVersion !== 1 || record.executableSha256 !== actualHash)
    return false;
  if (actualHash === tool.executableSha256) return true;
  if (reproducible && tool.executableSha256) return false;
  const build = record.build;
  return (
    build?.version === pin.version &&
    build.sourceCommit === pin.source.commit &&
    build.sourceSha256 === pin.source.sha256 &&
    build.patchSha256 === pin.patch.sha256 &&
    goAtLeast(build.goVersion, pin.minimumGoVersion) &&
    build.target === target &&
    (!reproducible || build.goVersion === pin.goVersion)
  );
}

export function buildRecord(pin, goVersion, target = "windows/amd64") {
  return {
    version: pin.version,
    sourceCommit: pin.source.commit,
    sourceSha256: pin.source.sha256,
    patchSha256: pin.patch.sha256,
    goVersion,
    target,
  };
}
