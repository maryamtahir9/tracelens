import * as fs from 'fs';
import * as vscode from 'vscode';
import { SourceLocation, toZeroBased } from './locations';

/** Opens a file and reveals the given 1-based location. Resolves to false (after telling the user) on failure. */
export async function openSource(loc: SourceLocation): Promise<boolean> {
  if (!fs.existsSync(loc.filePath)) {
    void vscode.window.showWarningMessage(`TraceLens: the file ${loc.filePath} no longer exists.`);
    return false;
  }
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(loc.filePath));
    const pos = toZeroBased(loc, doc.lineCount);
    const position = new vscode.Position(pos.line, Math.min(pos.character, doc.lineAt(pos.line).text.length));
    const range = new vscode.Range(position, position);
    await vscode.window.showTextDocument(doc, { selection: range, preview: false, viewColumn: vscode.ViewColumn.One });
    const editor = vscode.window.activeTextEditor;
    editor?.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return true;
  } catch (e) {
    void vscode.window.showErrorMessage(`TraceLens: could not open ${loc.filePath}: ${(e as Error).message}`);
    return false;
  }
}
