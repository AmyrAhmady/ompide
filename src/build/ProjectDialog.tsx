import { useEffect, useState } from "react";
import { workbench, type WorkbenchState } from "../app/workbench";
import { Modal } from "../components/Modal";
import { t, describeError } from "../lib/i18n";
import { buildConfiguration } from "./configuration";
import type { Discovery, BuildTools } from "./types";
import { DependencySection } from "./DependencySection";

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
  const [error, setError] = useState<string>();
  const [entry, setEntry] = useState("");
  const [profile, setProfile] = useState("openmp");
  const [includes, setIncludes] = useState(".");
  const [preview, setPreview] = useState<{ key: string; text: string }>();
  const key = JSON.stringify([entry, profile, includes]);

  const execute = (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    void operation()
      .catch((error) => setError(describeError(error)))
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
        if (result.manifests.length === 1 && !workbench.getSnapshot().project)
          await workbench.selectProject(
            result.manifests[0].replace(/[/\\][^/\\]+$/, "")
          );
      })
      .catch((error) => {
        if (live) setError(describeError(error));
      });
    void workbench
      .buildTools()
      .then((tools) => {
        if (live) setTools(tools);
      })
      .catch((error) => {
        if (live) setError(describeError(error));
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
    setTools(await workbench.buildTools());
    if (project) await workbench.selectProject(project.project.root);
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
        {error && (
          <p role="alert" className="problem-error">
            {error}
          </p>
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
                  value={project?.manifest.path ?? ""}
                  disabled={busy}
                  onChange={(event) =>
                    execute(() =>
                      workbench.selectProject(
                        event.target.value.replace(/[/\\][^/\\]+$/, "")
                      )
                    )
                  }
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
                  <select
                    value={profile}
                    onChange={(event) => setProfile(event.target.value)}
                    disabled={busy}
                  >
                    <option value="openmp">open.mp</option>
                    <option value="samp">SA-MP</option>
                  </select>
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
        {project && (
          <DependencySection
            key={project.manifest.path}
            state={state}
            openFile={(path) =>
              execute(async () => {
                await workbench.openPath(path);
                close();
              })
            }
          />
        )}
        <fieldset>
          <legend>{t("project.tools")}</legend>
          <p className="muted">{t("project.toolsHint")}</p>
          {(["compiler", "pawn"] as const).map((kind) => (
            <div key={kind} className="project-tool">
              <strong>
                {t(kind === "compiler" ? "project.compiler" : "project.pawn")}
              </strong>
              <p className="tool-path">
                {tools?.[kind]
                  ? `${tools[kind].version} — ${tools[kind].path}`
                  : state.settings[
                      kind === "compiler" ? "compilerPath" : "pawnPath"
                    ] ||
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
                      await workbench.configureBuildTool(kind === "compiler");
                      setTools(await workbench.buildTools());
                    })
                  }
                >
                  {t("settings.chooseLanguageServer")}
                </button>
                <button
                  type="button"
                  disabled={
                    busy ||
                    !state.settings[
                      kind === "compiler" ? "compilerPath" : "pawnPath"
                    ]
                  }
                  onClick={() =>
                    execute(async () => {
                      setTools(undefined);
                      await workbench.configureBuildTool(
                        kind === "compiler",
                        true
                      );
                      setTools(await workbench.buildTools());
                    })
                  }
                >
                  {t("settings.useBundled")}
                </button>
              </div>
            </div>
          ))}
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
            disabled={busy || !project || !tools}
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
