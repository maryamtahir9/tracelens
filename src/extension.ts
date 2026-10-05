import * as vscode from 'vscode';
import { openHistoryEntry } from './commands/traceHistory';
import { traceCurrentFunction } from './commands/traceCurrentFunction';
import { traceFromEditor } from './commands/traceExecution';
import { TraceHistory } from './history/TraceHistory';
import { TraceLensViewProvider } from './providers/TraceLensViewProvider';
import { TraceService } from './services/TraceService';
import { createTracers } from './tracing';
import { readSettings } from './utils/config';
import { VsCodeToolchain } from './utils/toolchain';

export function activate(context: vscode.ExtensionContext): void {
  const history = new TraceHistory(context.globalState, readSettings().historyLimit);
  void history.enforceLimit();
  const tracers = createTracers(context.extensionPath, new VsCodeToolchain());
  const service = new TraceService(context.extensionUri, tracers, history, () => readSettings());
  const view = new TraceLensViewProvider(service);
  void vscode.commands.executeCommand('setContext', 'tracelens.tracing', false);

  context.subscriptions.push(
    service,
    vscode.window.registerTreeDataProvider('tracelens.sidebar', view),
    vscode.commands.registerCommand('tracelens.traceExecution', () => traceFromEditor(service, { currentFunctionOnly: false })),
    vscode.commands.registerCommand('tracelens.traceCurrentFunction', () => traceCurrentFunction(service)),
    vscode.commands.registerCommand('tracelens.openLastTrace', () => service.openLast()),
    vscode.commands.registerCommand('tracelens.clearHistory', async () => {
      await service.clearHistory();
      void vscode.window.showInformationMessage('TraceLens: trace history cleared.');
    }),
    vscode.commands.registerCommand('tracelens.show', () => service.showPanel()),
    vscode.commands.registerCommand('tracelens.cancelTrace', () => service.cancel()),
    vscode.commands.registerCommand('tracelens.openHistoryEntry', (id: unknown) => {
      if (typeof id === 'string') return openHistoryEntry(service, id);
      return undefined;
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('traceLens')) return;
      history.setLimit(readSettings().historyLimit);
      void history.enforceLimit();
      service.refresh();
    })
  );
}

export function deactivate(): void {
  /* subscriptions (including running traces and the status bar item) are disposed by VS Code */
}
