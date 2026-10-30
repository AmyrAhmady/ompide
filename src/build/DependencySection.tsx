import { useEffect, useRef, useState } from "react";
import { Uri } from "monaco-editor";
import type { WorkbenchState } from "../app/workbench";
import { native } from "../lib/native";
import { describeError, t } from "../lib/i18n";
import type { DependencyReview } from "./dependencies";

export function DependencySection({
  state,
  openFile,
}: {
  state: WorkbenchState;
  openFile: (path: string) => void;
}) {
  const [review, setReview] = useState<DependencyReview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
    },
    []
  );
  const dirtyInputs =
    review &&
    state.tabs.some(
      (tab) =>
        tab.dirty &&
        (tab.uri === Uri.parse(review.manifest.uri).toString() ||
          (review.lock && tab.uri === Uri.parse(review.lock.uri).toString()))
    );

  const refresh = async () => {
    if (!state.project) return;
    const generation = ++request.current;
    setBusy(true);
    setError(undefined);
    setReview(undefined);
    try {
      const result = await native.reviewDependencies(
        state.project.project.root
      );
      if (request.current === generation) setReview(result);
    } catch (error) {
      if (request.current === generation) setError(describeError(error));
    } finally {
      if (request.current === generation) setBusy(false);
    }
  };

  return (
    <section className="dependency-review" aria-busy={busy}>
      <h3>{t("dependencies.title")}</h3>
      <p className="muted">{t("dependencies.reviewHint")}</p>
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        {t(busy ? "dependencies.reading" : "dependencies.review")}
      </button>
      {error && (
        <p role="alert" className="problem-error">
          {error}
        </p>
      )}
      {review && (
        <div aria-live="polite">
          {dirtyInputs && <p role="status">{t("dependencies.dirtyInputs")}</p>}
          <h4>{t("dependencies.declarations")}</h4>
          {review.declarations.length ? (
            <ul>
              {review.declarations.map((declaration, index) => (
                <li key={index}>
                  <code>{declaration.specification}</code>
                  {declaration.development && (
                    <span> {t("dependencies.development")}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p>{t("dependencies.noDeclarations")}</p>
          )}
          <dl>
            <dt>{t("dependencies.lockfile")}</dt>
            <dd>{review.lockPath}</dd>
          </dl>
          {review.lock ? (
            <>
              <button type="button" onClick={() => openFile(review.lock!.path)}>
                {t("dependencies.openLockfile")}
              </button>
              <h4>
                {t("dependencies.lockedSources", {
                  count: review.packages.length,
                })}
              </h4>
              {review.packages.length === 0 && (
                <p>{t("dependencies.noLockedSources")}</p>
              )}
              {review.packages.map((dependency) => (
                <details key={dependency.name} className="dependency-record">
                  <summary>{dependency.name}</summary>
                  <dl>
                    <dt>
                      {t(
                        dependency.sourceType === "local"
                          ? "dependencies.localSource"
                          : "dependencies.gitSource"
                      )}
                    </dt>
                    <dd>{dependency.source}</dd>
                    {dependency.commit && (
                      <>
                        <dt>{t("dependencies.commit")}</dt>
                        <dd>{dependency.commit}</dd>
                      </>
                    )}
                    {dependency.checksum && (
                      <>
                        <dt>{t("dependencies.checksum")}</dt>
                        <dd>{dependency.checksum}</dd>
                      </>
                    )}
                    <dt>{t("dependencies.destination")}</dt>
                    <dd>{dependency.destination}</dd>
                  </dl>
                </details>
              ))}
              {review.resources.length > 0 && (
                <>
                  <h4>
                    {t("dependencies.lockedResources", {
                      count: review.resources.length,
                    })}
                  </h4>
                  {review.resources.map((resource, index) => (
                    <details key={index} className="dependency-record">
                      <summary>
                        {resource.package} / {resource.name} ({resource.target})
                      </summary>
                      <dl>
                        <dt>{t("dependencies.assetSource")}</dt>
                        <dd>{resource.url}</dd>
                        <dt>{t("dependencies.checksum")}</dt>
                        <dd>{resource.checksum}</dd>
                        <dt>{t("dependencies.destinations")}</dt>
                        <dd>{resource.destinations.join("\n")}</dd>
                      </dl>
                    </details>
                  ))}
                </>
              )}
            </>
          ) : (
            <p role="status">{t("dependencies.missingLockfile")}</p>
          )}
        </div>
      )}
    </section>
  );
}
