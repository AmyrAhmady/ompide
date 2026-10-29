import { expect, it } from "vitest";
import { buildConfiguration } from "./configuration";
import type { ProjectInfo } from "./types";

const info = (configuration: unknown) =>
  ({
    project: { root: "C:/workspace", entry: "C:/workspace/main.pwn" },
    configuration,
  }) as ProjectInfo;
it("shows the entry actually selected by named builds, including inherited defaults", () => {
  const project = info({
    build: { input: "default.pwn", args: ["-d1"], includes: ["include"] },
    builds: [{ name: "release", input: "release.pwn" }, { name: "other" }],
  });
  expect(buildConfiguration(project).entry).toBe("C:/workspace/default.pwn");
  expect(buildConfiguration(project, "release")).toMatchObject({
    entry: "C:/workspace/release.pwn",
    output: "C:/workspace/output/release.amx",
    args: ["-d1"],
    includes: ["include"],
  });
  expect(buildConfiguration(project, "other").entry).toBe(
    "C:/workspace/default.pwn"
  );
  expect(
    buildConfiguration(
      info({ builds: [{ name: "first", input: "first.pwn" }] })
    ).entry
  ).toBe("C:/workspace/first.pwn");
});
