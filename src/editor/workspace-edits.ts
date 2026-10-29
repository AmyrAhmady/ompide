import {
  getService,
  IBulkEditService,
} from "@codingame/monaco-vscode-api/services";
import {
  ResourceEdit,
  ResourceTextEdit,
} from "@codingame/monaco-vscode-api/vscode/vs/editor/browser/services/bulkEditService";
import { describeError } from "../lib/i18n";

/** Keep every bulk-edit target in the IDE's owned, dirty-tracked models before any mutation. */
export async function installWorkspaceEdits(
  prepare: (uris: string[]) => Promise<void>,
  report: (error: unknown) => void
): Promise<void> {
  const service = await getService(IBulkEditService);
  const apply = service.apply.bind(service);
  service.apply = async (edit, options) => {
    try {
      if (options?.token?.isCancellationRequested)
        return { isApplied: false, ariaSummary: "" };
      const edits = Array.isArray(edit) ? edit : ResourceEdit.convert(edit);
      const uris = new Set<string>();
      for (const edit of edits) {
        if (
          !ResourceTextEdit.is(edit) ||
          edit.textEdit.insertAsSnippet ||
          edit.metadata?.needsConfirmation
        )
          throw { code: "unsupportedEdit" };
        if (
          edit.resource.scheme !== "file" &&
          edit.resource.scheme !== "untitled"
        )
          throw { code: "permissionDenied" };
        uris.add(edit.resource.toString());
      }
      await prepare([...uris]);
      if (options?.token?.isCancellationRequested)
        return { isApplied: false, ariaSummary: "" };
      return await apply(edit, options);
    } catch (error) {
      report(error);
      throw new Error(describeError(error), { cause: error });
    }
  };
}
