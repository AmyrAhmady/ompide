import { describeError, t } from "../lib/i18n";

/** Advice supplements the real nonzero exit status and verbatim Git output. */
export function describeGitError(error: unknown): string {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    error.code !== "gitFailed" ||
    !("detail" in error) ||
    typeof error.detail !== "string"
  )
    return describeError(error);
  const detail = error.detail;
  if (
    /authentication failed|cannot prompt because user interactivity has been disabled|could not read (?:username|password)|permission denied \(publickey\)|returned error: (?:401|403)|terminal prompts disabled/i.test(
      detail
    )
  )
    return t("scm.authFailure");
  if (
    /certificate (?:problem|verify failed)|SSL peer certificate|server certificate verification failed|schannel.*(?:untrusted|certificate)/i.test(
      detail
    )
  )
    return t("scm.certificateFailure");
  if (/not possible to fast-forward|divergent branches/i.test(detail))
    return t("scm.pullDiverged");
  if (
    /non-fast-forward|\[rejected\].*(?:fetch first|stale info)|\[remote rejected\]/i.test(
      detail
    )
  )
    return t("scm.pushRejected");
  if (
    /could not resolve host|failed to connect|couldn't connect|connection (?:refused|reset)|timed out|repository .* not found|returned error: (?:404|5\d\d)/i.test(
      detail
    )
  )
    return t("scm.connectionFailure");
  return describeError(error);
}
