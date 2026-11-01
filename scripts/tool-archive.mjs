import { execFileSync } from "node:child_process";

// GNU tar does not read ZIP archives; Windows' bundled bsdtar does.
export function listToolArchive(
  archive,
  platform = process.platform,
  run = execFileSync
) {
  const zip = platform === "linux" && archive.toLowerCase().endsWith(".zip");
  return run(zip ? "unzip" : "tar", zip ? ["-Z1", archive] : ["-tf", archive], {
    encoding: "utf8",
    windowsHide: true,
  });
}

export function extractToolArchive(
  archive,
  directory,
  platform = process.platform,
  run = execFileSync
) {
  const zip = platform === "linux" && archive.toLowerCase().endsWith(".zip");
  run(
    zip ? "unzip" : "tar",
    zip ? ["-q", archive, "-d", directory] : ["-xf", archive, "-C", directory],
    {
      windowsHide: true,
    }
  );
}
