import { useEffect, useState } from "react";
import { workbench, type WorkbenchState } from "../app/workbench";
import { Modal } from "../components/Modal";
import { t } from "../lib/i18n";
import {
  fileName,
  parentPath,
  pathKey,
  relativePath,
  withinPath,
} from "../lib/paths";
import { projectErrorDescription } from "./errors";
import {
  buildConfiguration,
  defaultManifest,
  rootManifest,
} from "./configuration";
import type { Discovery, BuildTools } from "./types";

function suggestedEntry(discovery: Discovery, root?: string): string {
  const nestedProjects = discovery.manifests
    .map(parentPath)
    .filter((path) => root && pathKey(path) !== pathKey(root));
  const entries = discovery.entries.filter(
    (path) => !nestedProjects.some((project) => withinPath(path, project))
  );
  if (entries.length === 1) return entries[0];
  const gamemodes = entries.filter(
    (path) =>
      root && /^gamemodes[/\\][^/\\]+$/i.test(relativePath(path, root) ?? "")
  );
  return gamemodes.length === 1 ? gamemodes[0] : "";
}

export function ProjectDialog({
  state,
  setupWorkspaceRoot,
  close,
  build,
}: {
  state: WorkbenchState;
  setupWorkspaceRoot: boolean;
  close: () => void;
  build: (activeFile?: string) => void;
}) {
  const [discovery, setDiscovery] = useState<Discovery>();
  const [tools, setTools] = useState<BuildTools>();
  const [verifyingTools, setVerifyingTools] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] =
    useState<ReturnType<typeof projectErrorDescription>>();
  const [toolError, setToolError] =
    useState<ReturnType<typeof projectErrorDescription>>();
  const [manifest, setManifest] = useState(state.project?.manifest.path ?? "");
  const [setupHere, setSetupHere] = useState(setupWorkspaceRoot);
  const [entry, setEntry] = useState("");
  const [includes, setIncludes] = useState<string[]>([]);
  const [preview, setPreview] = useState<{ key: string; text: string }>();
  const root = state.root;
  const project = state.project;
  const configuration = project
    ? buildConfiguration(project, state.selectedBuild)
    : undefined;
  const canSetUpRoot =
    discovery && root && !rootManifest(discovery.manifests, root);
  const firstSetup =
    !!discovery &&
    (!discovery.manifests.length || Boolean(canSetUpRoot && setupHere));
  const title = firstSetup ? t("project.setup") : t("project.title");

  const displayPath = (path: string) =>
    (root && relativePath(path, root)) || path;
  const key = JSON.stringify([entry, includes]);
  const setupBuildFile = firstSetup
    ? workbench.activePawnFile(root) || entry
    : "";
  const includeErrorIndex = error?.field?.match(
    /^pawnkit\.includePaths\[(\d+)\]$/
  )?.[1];
  const inlineIncludeError =
    firstSetup &&
    includeErrorIndex !== undefined &&
    Number(includeErrorIndex) < includes.length;

  const execute = (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    void operation()
      .catch((failure) => setError(projectErrorDescription(failure)))
      .finally(() => setBusy(false));
  };

  const verifyTools = async () => {
    setVerifyingTools(true);
    setTools(undefined);
    setToolError(undefined);
    try {
      setTools(await workbench.buildTools());
    } catch (failure) {
      setToolError(projectErrorDescription(failure));
    } finally {
      setVerifyingTools(false);
    }
  };

  const inspect = async (path: string) => {
    setManifest(path);
    if (path) await workbench.selectProject(parentPath(path));
  };

  const refresh = async () => {
    const result = await workbench.discoverProjects();
    if (root !== workbench.getSnapshot().root) return;
    setDiscovery(result);
    setEntry((current) =>
      result.entries.includes(current) ? current : suggestedEntry(result, root)
    );
    await Promise.all([
      inspect(
        setupHere && root && !rootManifest(result.manifests, root)
          ? ""
          : result.manifests.includes(manifest)
            ? manifest
            : (defaultManifest(result.manifests, root) ?? "")
      ),
      verifyTools(),
    ]);
  };

  useEffect(() => {
    let live = true;
    void workbench
      .discoverProjects()
      .then(async (result) => {
        if (!live || root !== workbench.getSnapshot().root) return;
        setDiscovery(result);
        setEntry(suggestedEntry(result, root));
        const selected =
          setupWorkspaceRoot && root
            ? rootManifest(result.manifests, root)
            : defaultManifest(result.manifests, root);
        if (selected && !workbench.getSnapshot().project) {
          setManifest(selected);
          await workbench.selectProject(parentPath(selected));
        }
      })
      .catch((failure) => {
        if (live) setError(projectErrorDescription(failure));
      });
    void workbench
      .buildTools()
      .then((value) => {
        if (live) setTools(value);
      })
      .catch((failure) => {
        if (live) setToolError(projectErrorDescription(failure));
      })
      .finally(() => {
        if (live) setVerifyingTools(false);
      });
    return () => {
      live = false;
    };
  }, [root, setupWorkspaceRoot]);

  const updateIncludes = (values: string[]) => {
    setIncludes(values);
    setError(undefined);
  };

  const chooseIncludeFolder = async (index?: number) => {
    const folder = await workbench.chooseIncludeFolder();
    if (folder === null || root !== workbench.getSnapshot().root) return;

    const identity = (path: string) => pathKey(`${root}/${path.trim()}`);
    setIncludes((current) => {
      if (
        current.some(
          (path, row) => row !== index && identity(path) === identity(folder)
        )
      ) {
        return current;
      }
      return index === undefined
        ? [...current, folder]
        : current.map((path, row) => (row === index ? folder : path));
    });
  };

  const previewSetup = () =>
    workbench.previewProject(
      entry,
      "openmp",
      includes.map((path) => path.trim())
    );

  const saveSetup = async (buildFile?: string) => {
    const text = await previewSetup();
    if (root !== workbench.getSnapshot().root) return;
    await workbench.createProject(text);
    close();
    if (buildFile) build(buildFile);
  };

  const editManifest = (path: string) =>
    execute(async () => {
      await workbench.openPath(path);
      close();
    });

  const compilerName = state.settings.compilerPath
    ? fileName(state.settings.compilerPath)
    : t("project.bundledCompiler");

  return (
    <Modal label={title} onCancel={close}>
      <div className="project-dialog">
        <h2>{title}</h2>
        {[inlineIncludeError ? undefined : error, toolError].map(
          (failure, index) =>
            failure ? (
              <div
                key={index}
                role="alert"
                className="problem-error project-error"
              >
                <p>{failure.message}</p>
                {failure.manifest && (
                  <p>
                    {t("project.errorManifest", { path: failure.manifest })}
                  </p>
                )}
                {failure.detail && <pre>{failure.detail}</pre>}
              </div>
            ) : null
        )}
        {!discovery && !error && <p role="status">{t("project.scanning")}</p>}
        {discovery?.truncated && <p>{t("project.truncated")}</p>}
        {!firstSetup && discovery && discovery.manifests.length > 0 && (
          <label>
            {t("project.manifest")}
            <select
              value={manifest}
              disabled={busy}
              onChange={(event) => {
                const path = event.target.value;
                execute(() => inspect(path));
              }}
            >
              {!manifest && <option value="">{t("project.choose")}</option>}
              {discovery.manifests.map((path) => (
                <option value={path} key={path}>
                  {displayPath(path)}
                </option>
              ))}
            </select>
          </label>
        )}
        {firstSetup && (
          <section className="project-setup">
            <label>
              {t("project.mainScript")}
              <select
                value={entry}
                disabled={busy}
                onChange={(event) => {
                  setEntry(event.target.value);
                  setError(undefined);
                }}
              >
                <option value="">{t("project.chooseEntry")}</option>
                {discovery.entries.map((path) => (
                  <option key={path} value={path}>
                    {displayPath(path)}
                  </option>
                ))}
              </select>
            </label>
            {!discovery.entries.length && (
              <>
                <p className="muted">{t("project.noScripts")}</p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => execute(refresh)}
                >
                  {t("project.refresh")}
                </button>
              </>
            )}
            <fieldset className="project-includes">
              <legend>{t("project.includes")}</legend>
              <p className="muted">{t("project.includesHint")}</p>
              {includes.map((path, index) => (
                <div key={index}>
                  <div className="project-include-row">
                    <input
                      aria-label={t("project.includeRow", {
                        number: index + 1,
                      })}
                      aria-invalid={
                        inlineIncludeError &&
                        Number(includeErrorIndex) === index
                      }
                      aria-describedby={
                        inlineIncludeError &&
                        Number(includeErrorIndex) === index
                          ? "project-include-error"
                          : undefined
                      }
                      value={path}
                      disabled={busy}
                      onChange={(event) =>
                        updateIncludes(
                          includes.map((value, row) =>
                            row === index ? event.target.value : value
                          )
                        )
                      }
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => execute(() => chooseIncludeFolder(index))}
                    >
                      {t("project.chooseFolder")}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        updateIncludes(
                          includes.filter((_, row) => row !== index)
                        )
                      }
                    >
                      {t("project.removeFolder")}
                    </button>
                  </div>
                  {inlineIncludeError &&
                    Number(includeErrorIndex) === index && (
                      <p
                        id="project-include-error"
                        className="problem-error project-error"
                        role="alert"
                      >
                        {error?.message}
                      </p>
                    )}
                </div>
              ))}
              <div className="settings-tool-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => execute(() => chooseIncludeFolder())}
                >
                  {t("project.browseInclude")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => updateIncludes([...includes, ""])}
                >
                  {t("project.addIncludePath")}
                </button>
              </div>
            </fieldset>
          </section>
        )}
        {project && configuration && !firstSetup && (
          <section className="project-selection">
            {configuration.builds.length > 0 && (
              <label>
                {t("project.namedBuild")}
                <select
                  value={state.selectedBuild}
                  disabled={busy}
                  onChange={(event) =>
                    workbench.selectBuild(event.target.value)
                  }
                >
                  <option value="">{t("project.defaultBuild")}</option>
                  {configuration.builds.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <dl>
              <dt>{t("project.mainScript")}</dt>
              <dd data-testid="build-entry">
                {displayPath(configuration.entry)}
              </dd>
              <dt>{t("project.output")}</dt>
              <dd>{displayPath(configuration.output)}</dd>
              <dt>{t("project.includes")}</dt>
              <dd>{configuration.includes.join("\n") || t("project.none")}</dd>
            </dl>
          </section>
        )}
        {(manifest || project) && !firstSetup && (
          <button
            type="button"
            disabled={busy}
            onClick={() => editManifest(manifest || project!.manifest.path)}
          >
            {t("project.editManifest")}
          </button>
        )}
        <dl className="project-compiler-summary">
          <dt>{t("project.compiler")}</dt>
          <dd>{compilerName}</dd>
        </dl>
        <details
          className="project-advanced"
          open={toolError ? true : undefined}
        >
          <summary>{t("project.advanced")}</summary>
          <p className="tool-path">
            {tools?.compiler
              ? tools.compiler.version + " — " + tools.compiler.path
              : t(
                  verifyingTools
                    ? "project.verifyingTools"
                    : "project.toolUnavailable"
                )}
          </p>
          <div className="settings-tool-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                execute(async () => {
                  await workbench.configureBuildTool();
                  await verifyTools();
                })
              }
            >
              {t("settings.chooseLanguageServer")}
            </button>
            <button
              type="button"
              disabled={busy || !state.settings.compilerPath}
              onClick={() =>
                execute(async () => {
                  await workbench.configureBuildTool(true);
                  await verifyTools();
                })
              }
            >
              {t("settings.useBundled")}
            </button>
          </div>
          {project && configuration && (
            <dl>
              <dt>{t("project.profile")}</dt>
              <dd>{project.project.profile}</dd>
              {configuration.args.length > 0 && (
                <>
                  <dt>{t("project.arguments")}</dt>
                  <dd>{configuration.args.join(" ")}</dd>
                </>
              )}
            </dl>
          )}
          {firstSetup && (
            <button
              type="button"
              disabled={!entry || busy || includes.some((path) => !path.trim())}
              onClick={() =>
                execute(async () =>
                  setPreview({ key, text: await previewSetup() })
                )
              }
            >
              {t("project.preview")}
            </button>
          )}
          {preview?.key === key && (
            <pre className="manifest-preview">{preview.text}</pre>
          )}
          {!firstSetup && canSetUpRoot && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setError(undefined);
                setSetupHere(true);
              }}
            >
              {t("project.setupWorkspaceRoot")}
            </button>
          )}
        </details>
        <p className="muted">{t("project.activeBuildHint")}</p>
        <footer>
          {firstSetup ? (
            <>
              <span className="muted project-save-location">
                {t("project.saveLocation")}
              </span>
              <button type="button" onClick={close}>
                {t("command.dismiss")}
              </button>
              <button
                type="button"
                disabled={
                  busy || !entry || includes.some((path) => !path.trim())
                }
                onClick={() => execute(() => saveSetup())}
              >
                {t("project.saveSetup")}
              </button>
              <button
                type="button"
                className="primary"
                disabled={
                  busy ||
                  !entry ||
                  !tools ||
                  includes.some((path) => !path.trim())
                }
                onClick={() => execute(() => saveSetup(setupBuildFile))}
              >
                {setupBuildFile
                  ? t("project.saveAndBuild", {
                      file: fileName(setupBuildFile),
                    })
                  : t("project.saveAndBuildDefault")}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => execute(refresh)}
              >
                {t("project.refresh")}
              </button>
              <button
                type="button"
                disabled={
                  busy ||
                  !!error ||
                  !!toolError ||
                  !manifest ||
                  !project ||
                  !tools
                }
                className="primary"
                onClick={() => {
                  close();
                  build();
                }}
              >
                {t("build.command")}
              </button>
              <button type="button" onClick={close}>
                {t("command.dismiss")}
              </button>
            </>
          )}
        </footer>
      </div>
    </Modal>
  );
}
