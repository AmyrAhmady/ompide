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
