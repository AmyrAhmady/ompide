import { expect, it } from "vitest";
import { buildErrorDetails, projectErrorDescription } from "./errors";

it("preserves native error codes and multiline details verbatim", () => {
  const detail = "Permission denied (os error 13)\n/home/omid/project/compiler";
  expect(buildErrorDetails({ code: "permissionDenied", detail })).toEqual({
    code: "permissionDenied",
    detail,
  });
});

it("explains configuration failures with field, path and original OS error", () => {
  const error = projectErrorDescription({
    code: "projectConfigPath",
    detail: "projectConfigPath: internal diagnostic representation",
    parameters: {
      field: "pawnkit.includePaths[0]",
      path: "G:\\omp\\windows\\test\\include",
      reason: "The system cannot find the path specified. (os error 3)",
      manifest: "G:\\omp\\windows\\test\\pawn.json",
    },
  });
  expect(error.message).toContain("pawnkit.includePaths[0]");
  expect(error.message).toContain("G:\\omp\\windows\\test\\include");
  expect(error.message).toContain("(os error 3)");
  expect(error.manifest).toBe("G:\\omp\\windows\\test\\pawn.json");
  expect(error.detail).toBeUndefined();
});

it("keeps syntax locations and unexpected error details visible", () => {
  expect(
    projectErrorDescription({
      code: "projectConfigSyntax",
      parameters: {
        path: "/project/pawn.yaml",
        line: 4,
        column: 2,
        reason: "expected a value",
      },
    }).message
  ).toContain("/project/pawn.yaml at line 4, column 2:\nexpected a value");
  expect(
    projectErrorDescription({
      code: "projectInvalid",
      detail: "Unsupported compiler argument: -oelsewhere.amx",
    }).detail
  ).toBe("Unsupported compiler argument: -oelsewhere.amx");
  expect(projectErrorDescription(new Error("IPC disconnected")).detail).toBe(
    "IPC disconnected"
  );
});

it("supports ordinary errors and text without serializing arbitrary objects", () => {
  expect(buildErrorDetails(new Error("IPC disconnected"))).toEqual({
    detail: "IPC disconnected",
  });
  expect(buildErrorDetails("Native command failed")).toEqual({
    detail: "Native command failed",
  });
  for (const error of [null, undefined, 13, " ", {}, { secret: "private" }]) {
    expect(buildErrorDetails(error)).toBeUndefined();
  }
  expect(buildErrorDetails({ code: "permissionDenied", detail: {} })).toEqual({
    code: "permissionDenied",
    detail: undefined,
  });
});
