import { expect, it } from "vitest";
import { parentPath, pathKey, withinPath, childPath } from "./paths";
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
