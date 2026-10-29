import { useWorkerFactory, Worker } from "monaco-languageclient/workerFactory";
import editorWorkerUrl from "monaco-editor/esm/vs/editor/editor.worker.js?worker&url";
import textmateWorkerUrl from "@codingame/monaco-vscode-textmate-service-override/worker?worker&url";

// First-party Vite worker imports avoid unresolved bare URLs inside optimized dependency code.
export function configureWorkers(): void {
  useWorkerFactory({
    workerLoaders: {
      editorWorkerService: () =>
        new Worker(editorWorkerUrl, { type: "module" }),
      TextMateWorker: () => new Worker(textmateWorkerUrl, { type: "module" }),
    },
  });
}
