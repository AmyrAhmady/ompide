import { useEffect, useState } from "react";
import { workbench, type WorkbenchState } from "../app/workbench";
import { Modal } from "../components/Modal";
import { t } from "../lib/i18n";
import { projectErrorDescription } from "./errors";
import { buildConfiguration } from "./configuration";
import type { Discovery, BuildTools } from "./types";

export function ProjectDialog({
  state,
  close,
  build,
}: {
  state: WorkbenchState;
  close: () => void;
  build: () => void;
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
  const [entry, setEntry] = useState("");
  const profile = "openmp";
  const [includes, setIncludes] = useState(".");
  const [preview, setPreview] = useState<{ key: string; text: string }>();
  const key = JSON.stringify([entry, profile, includes]);

  const execute = (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    void operation()
      .catch((error) => setError(projectErrorDescription(error)))
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    let live = true;
    void workbench
      .discoverProjects()
      .then(async (result) => {
        if (!live) return;
        setDiscovery(result);
        if (result.entries.length === 1) setEntry(result.entries[0]);
        if (result.manifests.length === 1 && !workbench.getSnapshot().project) {
          setManifest(result.manifests[0]);
          await workbench.selectProject(
            result.manifests[0].replace(/[/\\][^/\\]+$/, "")
          );
        }
      })
      .catch((error) => {
        if (live) setError(projectErrorDescription(error));
      });
    void workbench
      .buildTools()
      .then((tools) => {
        if (live) setTools(tools);
      })
      .catch((error) => {
        if (live) setToolError(projectErrorDescription(error));
      })
      .finally(() => {
        if (live) setVerifyingTools(false);
      });
    return () => {
      live = false;
    };
  }, []);
  const project = state.project;
  const configuration = project
    ? buildConfiguration(project, state.selectedBuild)
    : undefined;

  const refresh = async () => {
    const result = await workbench.discoverProjects();
    setDiscovery(result);
    setTools(undefined);
    setToolError(undefined);
    try {
      setTools(await workbench.buildTools());
    } catch (failure) {
      setToolError(projectErrorDescription(failure));
    }
    const selected = result.manifests.includes(manifest)
      ? manifest
      : result.manifests.length === 1
        ? result.manifests[0]
        : "";
    setManifest(selected);
    if (selected)
      await workbench.selectProject(selected.replace(/[/\\][^/\\]+$/, ""));
  };
  const hasRootManifest = discovery?.manifests.some(
    (path) =>
      path.replace(/[/\\][^/\\]+$/, "").toLowerCase() ===
      state.root?.toLowerCase()
  );
  return (
    <Modal label={t("project.title")} onCancel={close}>
      <div className="project-dialog">
        <h2>{t("project.title")}</h2>
        {[error, toolError].map((failure, index) =>
          failure ? (
            <div
              key={index}
              role="alert"
              className="problem-error project-error"
            >
              <p>{failure.message}</p>
              {failure.manifest && (
                <p>{t("project.errorManifest", { path: failure.manifest })}</p>
              )}
              {failure.detail && <pre>{failure.detail}</pre>}
            </div>
          ) : null
        )}
        {!discovery ? (
          <p role="status">{t("project.scanning")}</p>
        ) : (
          <>
            {discovery.truncated && <p>{t("project.truncated")}</p>}
            {discovery.manifests.length > 0 && (
              <label>
                {t("project.manifest")}
                <select
                  aria-label={t("project.manifest")}
                  value={manifest}
                  disabled={busy}
                  onChange={(event) => {
                    setManifest(event.target.value);
                    execute(() =>
                      workbench.selectProject(
                        event.target.value.replace(/[/\\][^/\\]+$/, "")
                      )
                    );
                  }}
                >
                  <option value="">{t("project.choose")}</option>
                  {discovery.manifests.map((path) => (
                    <option value={path} key={path}>
                      {path}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {manifest && (!project || error) && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  execute(async () => {
                    await workbench.openPath(manifest);
                    close();
                  })
                }
              >
                {t("project.editManifest")}
              </button>
            )}
            {!hasRootManifest && (
              <details
                className="project-setup"
                open={!discovery.manifests.length}
              >
                <summary>{t("project.setup")}</summary>
                <p>{t("project.noManifest")}</p>
                <label>
                  {t("project.entry")}
                  <select
                    aria-label={t("project.entry")}
                    value={entry}
                    disabled={busy}
                    onChange={(event) => setEntry(event.target.value)}
                  >
                    <option value="">{t("project.chooseEntry")}</option>
                    {discovery.entries.map((path) => (
                      <option key={path} value={path}>
                        {path}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("project.profile")}
                  <span>open.mp</span>
                </label>
                <label>
                  {t("project.includes")}
                  <textarea
                    aria-label={t("project.includes")}
                    value={includes}
                    onChange={(event) => setIncludes(event.target.value)}
                    rows={3}
                    disabled={busy}
                  />
                </label>
                <div className="settings-tool-actions">
                  <button
                    type="button"
                    disabled={!entry || busy}
                    onClick={() =>
                      execute(async () =>
                        setPreview({
                          key,
                          text: await workbench.previewProject(
                            entry,
                            profile,
                            includes
                              .split(/\r?\n/)
                              .map((value) => value.trim())
                              .filter(Boolean)
                          ),
                        })
                      )
                    }
                  >
                    {t("project.preview")}
                  </button>
                  <button
                    type="button"
                    disabled={busy || !preview || preview.key !== key}
                    onClick={() =>
                      execute(async () => {
                        await workbench.createProject(preview!.text);
                        await refresh();
                        setPreview(undefined);
                      })
                    }
                  >
                    {t("project.create")}
                  </button>
                </div>
                {preview && preview.key === key && (
                  <pre className="manifest-preview">{preview.text}</pre>
                )}
              </details>
            )}
          </>
        )}
        {project && configuration && (
          <section className="project-selection">
            <h3>{t("project.selection")}</h3>
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
              <dt>{t("project.entry")}</dt>
              <dd data-testid="build-entry">{configuration.entry}</dd>
              <dt>{t("project.profile")}</dt>
              <dd>{project.project.profile}</dd>
              <dt>{t("project.output")}</dt>
              <dd>{configuration.output}</dd>
              <dt>{t("project.declaredIncludes")}</dt>
              <dd>{configuration.includes.join("\n") || t("project.none")}</dd>
              {configuration.args.length > 0 && (
                <>
                  <dt>{t("project.arguments")}</dt>
                  <dd>{configuration.args.join(" ")}</dd>
                </>
              )}
            </dl>
            <p className="muted">{t("project.editHint")}</p>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                execute(async () => {
                  await workbench.openPath(project.manifest.path);
                  close();
                })
              }
            >
              {t("project.editManifest")}
            </button>
          </section>
        )}
        <fieldset>
          <legend>{t("project.tools")}</legend>
          <p className="muted">{t("project.toolsHint")}</p>
          <div className="project-tool">
            <strong>{t("project.compiler")}</strong>
            <p className="tool-path">
              {tools?.compiler
                ? tools.compiler.version + " — " + tools.compiler.path
                : state.settings.compilerPath ||
                  t(
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
                    setTools(undefined);
                    await workbench.configureBuildTool();
                    setTools(await workbench.buildTools());
                    setToolError(undefined);
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
                    setTools(undefined);
                    await workbench.configureBuildTool(true);
                    setTools(await workbench.buildTools());
                    setToolError(undefined);
                  })
                }
              >
                {t("settings.useBundled")}
              </button>
            </div>
          </div>
        </fieldset>
        <p className="muted">{t("project.buildHint")}</p>
        <footer>
          <button
            type="button"
            disabled={busy}
            onClick={() => execute(refresh)}
          >
            {t("project.refresh")}
          </button>
          <button
            type="button"
            disabled={busy || !!error || !!toolError || !project || !tools}
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
        </footer>
      </div>
    </Modal>
  );
}
