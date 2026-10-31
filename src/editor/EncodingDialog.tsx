import { useState } from "react";
import { Modal } from "../components/Modal";
import { workbench, type Tab } from "../app/workbench";
import { describeError, t } from "../lib/i18n";
import { encodingChoices } from "./text-files";

export function EncodingDialog({
  document,
  close,
}: {
  document?: Tab;
  close: () => void;
}) {
  const initial =
    encodingChoices.find(
      (choice) =>
        choice.encoding === document?.encoding && choice.bom === document?.bom
    ) ??
    encodingChoices.find((choice) => choice.encoding === document?.encoding);
  const [selection, setSelection] = useState(initial?.id ?? "utf-8");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const choice = encodingChoices.find((entry) => entry.id === selection)!;

  const apply = async (reopen: boolean) => {
    setBusy(true);
    setError("");
    try {
      if (!document) {
        if (await workbench.openFile(choice.encoding)) close();
        return;
      }
      if (workbench.getSnapshot().active !== document.uri)
        throw { code: "conflict" };
      const completed = reopen
        ? await workbench.reload(choice.encoding)
        : await workbench.save(document.uri, false, choice);
      if (completed) close();
    } catch (error) {
      setError(describeError(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      className="encoding-dialog"
      label={t("encoding.title")}
      onCancel={() => {
        if (!busy) close();
      }}
    >
      <h2>{t("encoding.title")}</h2>
      {document && <p>{document.name}</p>}
      <label>
        {t("encoding.select")}
        <select
          aria-label={t("encoding.select")}
          value={selection}
          disabled={busy}
          onChange={(event) => setSelection(event.target.value)}
        >
          {encodingChoices.map((encoding) => (
            <option key={encoding.id} value={encoding.id}>
              {encoding.label}
            </option>
          ))}
        </select>
      </label>
      <p>{t("encoding.detail")}</p>
      {error && <p role="alert">{error}</p>}
      <footer>
        <button
          type="button"
          disabled={busy || !document?.uri.startsWith("file:")}
          onClick={() => void apply(true)}
        >
          {t("encoding.reopen")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void apply(false)}
        >
          {t(document ? "encoding.save" : "encoding.open")}
        </button>
        <button type="button" disabled={busy} onClick={close}>
          {t("prompt.cancel")}
        </button>
      </footer>
    </Modal>
  );
}
