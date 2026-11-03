import { expect, it } from "vitest";
import {
  parentPath,
  pathKey,
  withinPath,
  childPath,
  reconcilePaths,
  relativePath,
} from "./paths";
it("compares Windows/UNC paths without confusing sibling prefixes or POSIX case", () => {
  expect(pathKey("C:\\Project\\Main.pwn")).toBe(pathKey("c:/project/main.pwn"));
  expect(withinPath("C:/project-other/file", "C:/project")).toBe(false);
  expect(withinPath("c:/Project/inc/file", "C:/project/")).toBe(true);
  expect(withinPath("C:/file", "C:/")).toBe(true);
  expect(withinPath("/tmp/A", "/tmp/a")).toBe(false);
  expect(withinPath("\\\\host\\Share\\file", "//HOST/share")).toBe(true);
  expect(parentPath("C:/main.pwn")).toBe("C:/");
  expect(parentPath("/main.pwn")).toBe("/");
  expect(childPath("/", "main.pwn")).toBe("/main.pwn");
});

it("copies workspace-relative paths with native separators and safe boundaries", () => {
  expect(relativePath("C:\\Project\\scripts\\Main.pwn", "c:/project/")).toBe(
    "scripts\\Main.pwn"
  );
  expect(
    relativePath("\\\\HOST\\Share\\folder\\main.pwn", "//host/share")
  ).toBe("folder\\main.pwn");
  expect(relativePath("/workspace/scripts/Main.pwn", "/workspace/")).toBe(
    "scripts/Main.pwn"
  );
  expect(relativePath("/main.pwn", "/")).toBe("main.pwn");
  expect(relativePath("C:/main.pwn", "C:/")).toBe("main.pwn");
  expect(relativePath("C:/Project", "c:/project/")).toBe(".");
  expect(
    relativePath("/workspace-other/main.pwn", "/workspace")
  ).toBeUndefined();
  expect(relativePath("/Workspace/main.pwn", "/workspace")).toBeUndefined();
});

it("reconciles reopen history for folder and case-only renames without sibling collisions", () => {
  const paths = [
    "C:/project/scripts/closed.inc",
    "C:/project/scripts-other/keep.inc",
    "C:/project/new/closed.inc",
  ];
  expect(reconcilePaths(paths, "c:/project/SCRIPTS", "C:/project/new")).toEqual(
    ["C:/project/new/closed.inc", "C:/project/scripts-other/keep.inc"]
  );
  expect(reconcilePaths(paths, "C:/project/scripts")).toEqual([
    "C:/project/scripts-other/keep.inc",
    "C:/project/new/closed.inc",
  ]);
  expect(
    reconcilePaths(
      ["C:/project/main.pwn"],
      "C:/project/main.pwn",
      "C:/project/MAIN.pwn"
    )
  ).toEqual(["C:/project/MAIN.pwn"]);
});
