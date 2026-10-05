import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { HistoryEntry } from '../history/TraceHistory';
import { TraceRequest } from '../models/TraceTypes';
import { TraceService } from '../services/TraceService';

/** Reopens a history entry: from memory if the trace is still cached, otherwise by offering to run it again. */
export async function openHistoryEntry(service: TraceService, id: string): Promise<void> {
  const cached = service.cachedSession(id);
  if (cached) {
    service.showSession(cached, true);
    return;
  }
  const entry = service.history.get(id);
  if (!entry) {
    void vscode.window.showWarningMessage('TraceLens: that history entry no longer exists.');
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `TraceLens stores only metadata, not trace contents. "${entry.label}" is no longer in memory. Run it again?`, 'Run Again'
  );
  if (choice !== 'Run Again') return;
  const request = await requestFromEntry(entry);
  if (request) await service.run(request);
}

async function requestFromEntry(entry: HistoryEntry): Promise<TraceRequest | undefined> {
  if (!fs.existsSync(entry.filePath)) {
    void vscode.window.showWarningMessage(`TraceLens: ${entry.filePath} no longer exists.`);
    return undefined;
  }
  const workspaceRoot = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(entry.filePath))?.uri.fsPath;
  let argsJson: string | undefined;
  if (entry.mode === 'function' && entry.params) {
    const value = await vscode.window.showInputBox({
      title: `TraceLens: arguments for ${entry.functionName}(${entry.params})`, prompt: 'JSON array of arguments (leave empty for none).', ignoreFocusOut: true
    });
    if (value === undefined) return undefined;
    argsJson = value.trim() || undefined;
  }
  let selectionText: string | undefined;
  if (entry.mode === 'block') {
    const lines = (await fs.promises.readFile(entry.filePath, 'utf8')).split(/\r?\n/);
    selectionText = lines.slice(entry.startLine - 1, entry.endLine).join('\n');
  }
  return {
    languageId: entry.language, filePath: entry.filePath, mode: entry.mode, functionName: entry.functionName,
    startLine: entry.startLine, endLine: entry.endLine, selectionText, argsJson, workspaceRoot, label: entry.label || path.basename(entry.filePath), params: entry.params
  };
}
