import { expect, it } from "vitest";
import {
  buildConfiguration,
  validEntryOutput,
  buildOutput,
} from "./configuration";
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
    output: "C:/workspace/release.amx",
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

it("shows the entry-only output override and validates scoped AMX paths", () => {
  const project = info({
    entry: "main.pwn",
    output: "bin/main.amx",
    build: {},
    builds: [{ name: "other", input: "other.pwn" }],
  });
  expect(buildConfiguration(project).output).toBe("C:/workspace/bin/main.amx");
  expect(buildConfiguration(project, "other").output).toBe(
    "C:/workspace/other.amx"
  );
  expect(buildOutput(project, "C:/workspace/main.pwn")).toBe(
    "C:/workspace/bin/main.amx"
  );
  expect(buildOutput(project, "C:/workspace/filterscripts/admin.pwn")).toBe(
    "C:/workspace/filterscripts/admin.amx"
  );
  for (const value of ["", "bin/main.amx", "C:/workspace/main.amx"])
    expect(validEntryOutput(project.project.root, value)).toBe(true);
  for (const value of [
    "../main.amx",
    "bin/../../main.amx",
    ".git/file.amx",
    "D:/main.amx",
    "main.pwn",
  ])
    expect(validEntryOutput(project.project.root, value)).toBe(false);
});
