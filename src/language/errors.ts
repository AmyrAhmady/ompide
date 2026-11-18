import { describeError } from "../lib/i18n";

export function formattingFailure(error: unknown) {
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return {
    code: "formattingFailed",
    parameters: { reason: message.trim() ? message : describeError(error) },
  };
}
