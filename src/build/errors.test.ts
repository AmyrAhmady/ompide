import { expect, it } from "vitest";
import { buildErrorDetails } from "./errors";

it("preserves native error codes and multiline details verbatim", () => {
  const detail = "Permission denied (os error 13)\n/home/omid/project/compiler";
  expect(buildErrorDetails({ code: "permissionDenied", detail })).toEqual({
    code: "permissionDenied",
    detail,
  });
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
