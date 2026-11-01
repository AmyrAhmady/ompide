import { execFileSync } from "node:child_process";

export function goBuildEnvironment(
  environment,
  download,
  reproducible = false
) {
  return {
    ...environment,
    GOTOOLCHAIN: "local",
    CGO_ENABLED: "0",
    GOTELEMETRY: "off",
    ...(download ? {} : { GOPROXY: "off", GOSUMDB: "off" }),
    GOOS: "windows",
    GOARCH: "amd64",
    ...(reproducible ? { GOFLAGS: "", GOWORK: "off" } : {}),
  };
}

export function goModuleDirectory(go, module, options, run = execFileSync) {
  const metadata = JSON.parse(
    run(go, ["mod", "download", "-json", module], {
      ...options,
      encoding: "utf8",
      windowsHide: true,
    })
  );
  if (typeof metadata.Dir !== "string" || !metadata.Dir || metadata.Error)
    throw new Error(
      `Module source unavailable for ${module}: ${metadata.Error ?? "Go did not return a source directory"}`
    );
  return metadata.Dir;
}

export function goVersionParts(version) {
  const match = /^go(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? match.slice(1).map(Number) : undefined;
}

export function goAtLeast(actual, minimum) {
  const left = goVersionParts(actual);
  const right = goVersionParts(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

/** Use normal executable lookup; an explicit CLI option is available for reproduction. */
export async function selectGo(
  { executable = "go", version, exactVersion, environment },
  run = execFileSync
) {
  const requirement = exactVersion
    ? `${exactVersion} exactly`
    : `${version} or newer (stable)`;
  try {
    const actual = run(executable, ["version"], {
      encoding: "utf8",
      env: { ...environment, GOTOOLCHAIN: "local" },
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 8192,
    }).trim();
    const match = /^go version (go\d+\.\d+\.\d+) windows\/amd64$/.exec(actual);
    if (
      !match ||
      !goAtLeast(match[1], version) ||
      (exactVersion && match[1] !== exactVersion)
    )
      throw new Error(`reported ${actual}`);
    return { executable, version: match[1] };
  } catch (error) {
    throw new Error(
      `Build requires ${requirement} for Windows x64. Install compatible Go on PATH or use --go <path-to-go.exe>. Checked ${executable}: ${error.message}`,
      { cause: error }
    );
  }
}

export function goExecutableArgument(args) {
  const index = args.indexOf("--go");
  if (index < 0) return undefined;
  if (
    args.filter((arg) => arg === "--go").length !== 1 ||
    !args[index + 1] ||
    args[index + 1].startsWith("--")
  )
    throw new Error("--go requires one executable path");
  return args[index + 1];
}
