import { expect, it } from "vitest";
import { formattingFailure } from "./errors";
import { describeError } from "../lib/i18n";

it("preserves formatter RPC messages including their source context", () => {
  const message =
    "source does not parse cleanly at line 5, column 2\n5 | broken;\n  | ^";
  expect(describeError(formattingFailure({ code: -32603, message }))).toBe(
    `Formatting failed: ${message}`
  );
  expect(formattingFailure("formatter unavailable").parameters.reason).toBe(
    "formatter unavailable"
  );
});

it("uses localized fallback for malformed formatter failures", () => {
  expect(formattingFailure(null).parameters.reason).toBe(describeError(null));
  expect(formattingFailure({ message: " " }).parameters.reason).toBe(
    describeError(null)
  );
});
