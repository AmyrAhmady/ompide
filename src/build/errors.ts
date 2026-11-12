import { describeError } from "../lib/i18n";

export function projectErrorDescription(error: unknown) {
  const details = buildErrorDetails(error);
  const parameters =
    typeof error === "object" && error !== null && "parameters" in error
      ? error.parameters
      : undefined;
  const manifest =
    typeof parameters === "object" &&
    parameters !== null &&
    "manifest" in parameters &&
    typeof parameters.manifest === "string"
      ? parameters.manifest
      : undefined;
  return {
    message: describeError(error),
    manifest,
    field:
      typeof parameters === "object" &&
      parameters !== null &&
      "field" in parameters &&
      typeof parameters.field === "string"
        ? parameters.field
        : undefined,
    // Structured config errors are already translated with their specific context.
    // Preserve external/native details for older or unexpected failures too.
    detail: details?.code?.startsWith("projectConfig")
      ? undefined
      : details?.detail,
  };
}

export interface BuildErrorDetails {
  code?: string;
  detail?: string;
}

export function buildErrorDetails(
  error: unknown
): BuildErrorDetails | undefined {
  if (typeof error === "string") {
    return error.trim() ? { detail: error } : undefined;
  }
  if (typeof error !== "object" || error === null) return undefined;

  const code =
    "code" in error && typeof error.code === "string" && error.code.trim()
      ? error.code
      : undefined;
  const detail =
    "detail" in error && typeof error.detail === "string" && error.detail.trim()
      ? error.detail
      : error instanceof Error && error.message.trim()
        ? error.message
        : undefined;
  return code || detail ? { code, detail } : undefined;
}
