import { useState } from "react";
import { workbench } from "../app/workbench";
import { Modal } from "../components/Modal";
import { describeError, t, type TranslationKey } from "../lib/i18n";
import type { ProjectInfo } from "./types";
import { compilerTargets } from "./configuration";
import {
  compilerOptions,
  compilerValues,
  editCompilerManifest,
  updateCompilerArgs,
  validCompilerValue,
  type CompilerOption,
  type CompilerValues,
} from "./compilerSettings";

const choiceLabels: Partial<
  Record<CompilerOption["id"], readonly TranslationKey[]>
> = {
  debug: [
    "compiler.debug0",
    "compiler.debug1",
    "compiler.debug2",
    "compiler.debug3",
  ],
  optimization: [
    "compiler.optimization0",
    "compiler.optimization1",
    "compiler.optimization2",
  ],
  verbosity: [
    "compiler.verbosity0",
    "compiler.verbosity1",
    "compiler.verbosity2",
  ],
};

export function CompilerSettingsDialog({
  project,
  selectedBuild,
  close,
  configure,
}: {
  project?: ProjectInfo;
  selectedBuild: string;
  close: () => void;
  configure: () => void;
}) {
  const targets = project ? compilerTargets(project) : [];
  const [name, setName] = useState(selectedBuild);
  const target = targets.find((item) => item.name === name) ?? targets[0];
  const [draft, setDraft] = useState<CompilerValues>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const label = t("compiler.title");
  const values = { ...compilerValues(target?.args ?? []), ...draft };
  const invalid = compilerOptions.find(
    (option) => !validCompilerValue(option, draft[option.id]?.trim() ?? "")
  );
  const args = target ? updateCompilerArgs(target.args, draft) : [];
  const changed = Boolean(
    target && JSON.stringify(args) !== JSON.stringify(target.args)
  );
  const fallsBack = Boolean(
    target?.name && !args.length && targets[0].args.length
  );

  const save = async (nextArgs: string[]) => {
    if (!project || !target) return;
    setBusy(true);
    setError("");
    try {
      const { path, text } = project.manifest;
      await workbench.saveCompilerSettings(
        project,
        editCompilerManifest(path, text, target.field, nextArgs)
      );
      close();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  const control = (option: CompilerOption) => {
    const value = values[option.id] ?? "";
    const optionLabel = t(`compiler.${option.id}`);

    const change = (next: string) => {
      setDraft((current) => ({ ...current, [option.id]: next }));
      setError("");
    };
    return (
      <label key={option.id}>
        <span>
          {optionLabel}{" "}
          <code>{option.id === "escape" ? "-\\ / -^" : option.flag}</code>
        </span>
        {"choices" in option ? (
          <select
            aria-label={optionLabel}
            value={value}
            onChange={(event) => change(event.target.value)}
          >
            <option value="">{t("compiler.default")}</option>
            {option.choices.map((choice, index) => {
              const translated = choiceLabels[option.id]?.[index];
              return (
                <option key={choice} value={choice}>
                  {choice === "+"
                    ? t("compiler.enabled")
                    : choice === "-"
                      ? t("compiler.disabled")
                      : choice === "toggle"
                        ? t("compiler.toggle")
                        : translated
                          ? t(translated)
                          : choice}
                </option>
              );
            })}
          </select>
        ) : (
          <input
            aria-label={optionLabel}
            value={value}
            placeholder={t("compiler.default")}
            aria-invalid={invalid?.id === option.id}
            inputMode={
              option.id === "codepage" || option.id === "warnings"
                ? "text"
                : "numeric"
            }
            onChange={(event) => change(event.target.value)}
          />
        )}
      </label>
    );
  };

  return (
    <Modal
      label={label}
      onCancel={() => {
        if (!busy) close();
      }}
    >
      <div className="project-dialog compiler-settings">
        <h2>{label}</h2>
        {!target ? (
          <p>{t("error.projectRequired")}</p>
        ) : (
          <fieldset disabled={busy} className="compiler-fields">
            <label>
              {t("compiler.target")}
              <select
                value={target.name}
                onChange={(event) => {
                  setName(event.target.value);
                  setDraft({});
                  setError("");
                }}
              >
                {targets.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name || t("compiler.shared")}
                  </option>
                ))}
              </select>
            </label>
            {target.name && (
              <p className="muted">
                {t(
                  target.inherited ? "compiler.inherited" : "compiler.override"
                )}
              </p>
            )}
            <div className="compiler-grid">
              {compilerOptions.slice(0, 6).map(control)}
            </div>
            <p className="muted">{t("compiler.debugHint")}</p>
            <details>
              <summary>{t("project.advanced")}</summary>
              <div className="compiler-grid">
                {compilerOptions.slice(6).map(control)}
              </div>
            </details>
            {invalid && (
              <p role="alert" className="problem-error">
                {t("compiler.invalid", { option: t(`compiler.${invalid.id}`) })}
              </p>
            )}
            {fallsBack && (
              <p className="muted">{t("compiler.emptyOverride")}</p>
            )}
          </fieldset>
        )}
        {error && (
          <p role="alert" className="problem-error project-error">
            {error}
          </p>
        )}
        <footer>
          {target ? (
            <>
              {target.name && !target.inherited && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void save([])}
                >
                  {t("compiler.useShared")}
                </button>
              )}
              <button
                type="button"
                className="primary"
                disabled={busy || !changed || !!invalid || fallsBack}
                onClick={() => void save(args)}
              >
                {t("compiler.save")}
              </button>
            </>
          ) : (
            <button type="button" className="primary" onClick={configure}>
              {t("project.title")}
            </button>
          )}
          <button type="button" disabled={busy} onClick={close}>
            {t("command.dismiss")}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
