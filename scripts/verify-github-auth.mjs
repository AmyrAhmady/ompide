// Optional live, read-only verification. Credentials and private repository names
// stay in memory; the report contains only success flags and HTTP/exit statuses.
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("GIT_TRACE") && key !== "GIT_CURL_VERBOSE"
  )
);
Object.assign(environment, {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GCM_TRACE: "0",
  GCM_TRACE_SECRETS: "0",
});

function git(args, input) {
  return spawnSync(
    "git",
    [
      "-c",
      "credential.interactive=false",
      "-c",
      "credential.trace=false",
      "-c",
      "credential.traceSecrets=false",
      ...args,
    ],
    {
      input,
      env: environment,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    }
  );
}

async function verify() {
  const report = {
    cachedCredential: false,
    authenticatedApi: false,
    authenticatedPrivateGitRead: false,
  };
  const credential = git(
    ["credential", "fill"],
    "protocol=https\nhost=github.com\n\n"
  );
  const password =
    credential.status === 0
      ? credential.stdout
          .split("\n")
          .find((line) => line.startsWith("password="))
          ?.slice(9)
      : undefined;
  if (!password) return report;
  report.cachedCredential = true;
  const headers = {
    Authorization: `Bearer ${password}`,
    "User-Agent": "Pawn-IDE-auth-verification",
    Accept: "application/vnd.github+json",
  };
  const user = await fetch("https://api.github.com/user", {
    headers,
    signal: globalThis.AbortSignal.timeout(20000),
    redirect: "error",
  });
  report.apiStatus = user.status;
  await user.body?.cancel();
  if (!user.ok) return report;
  report.authenticatedApi = true;
  const repositories = await fetch(
    "https://api.github.com/user/repos?visibility=private&affiliation=owner&per_page=1",
    {
      headers,
      signal: globalThis.AbortSignal.timeout(20000),
      redirect: "error",
    }
  );
  if (!repositories.ok) {
    await repositories.body?.cancel();
    return report;
  }
  const selected = (await repositories.json()).find(
    (repository) =>
      repository.private &&
      repository.clone_url?.startsWith("https://github.com/")
  );
  if (!selected) return report;
  const result = git(["ls-remote", "--exit-code", selected.clone_url, "HEAD"]);
  report.gitExitCode = result.status;
  report.authenticatedPrivateGitRead =
    result.status === 0 && /^[a-f0-9]{40,64}\s+HEAD/m.test(result.stdout);
  return report;
}

try {
  const report = await verify();
  await writeFile(
    "test-results/git-host-auth.json",
    JSON.stringify(report, null, 2)
  );
  console.log(JSON.stringify(report));
  if (!report.authenticatedPrivateGitRead) process.exitCode = 2;
} catch (error) {
  // Never print child output, exception messages, URLs or credential material.
  console.error(
    "Read-only GitHub authentication verification unavailable:",
    error.name
  );
  process.exitCode = 2;
}
