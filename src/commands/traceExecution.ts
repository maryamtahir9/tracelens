import * as path from 'path';
import * as vscode from 'vscode';
import { TraceLensError, TraceRequest, isSupportedLanguage, SupportedLanguage } from '../models/TraceTypes';
import { TraceService } from '../services/TraceService';
import { detectFunctions, requiredParamText, resolveTarget } from '../utils/functionDetection';

const lastArgs = new Map<string, string>(); // in-memory only; argument text is never persisted

function fail(message: string): void {
  void vscode.window.showWarningMessage(`TraceLens: ${message}`);
}

async function promptForArguments(language: SupportedLanguage, name: string, params: string, key: string): Promise<string | undefined | null> {
  const allowObject = language === 'python';
  const value = await vscode.window.showInputBox({
    title: `TraceLens: arguments for ${name}(${params})`,
    prompt: allowObject
      ? 'JSON array for positional arguments, e.g. [1, "a"], or a JSON object for keyword arguments. Leave empty to call with no arguments.'
      : 'JSON array of arguments, e.g. [1, "a"]. Leave empty to call with no arguments.',
    placeHolder: '[]',
    value: lastArgs.get(key) ?? '',
    ignoreFocusOut: true,
    validateInput: (text) => {
      if (!text.trim()) return undefined;
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) return undefined;
        if (allowObject && typeof parsed === 'object' && parsed !== null) return undefined;
        return allowObject ? 'Enter a JSON array or object.' : 'Enter a JSON array.';
      } catch {
        return 'Not valid JSON.';
      }
    }
  });
  if (value === undefined) return null; // user pressed Escape
  const trimmed = value.trim();
  if (trimmed) lastArgs.set(key, trimmed);
  return trimmed || undefined;
}

export interface TraceCommandOptions {
  /** Ignore the selection and trace the function containing the cursor. */
  currentFunctionOnly: boolean;
}

/** Shared implementation of "Trace Execution" and "Trace Current Function". */
export async function traceFromEditor(service: TraceService, opts: TraceCommandOptions): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return fail('open a Python, JavaScript or TypeScript file first.');
  const doc = editor.document;
  if (!isSupportedLanguage(doc.languageId)) {
    return fail(`${doc.languageId} files are not supported yet. TraceLens supports Python, JavaScript and TypeScript.`);
  }
  if (doc.isUntitled) return fail('save the file first so that it can be executed.');
  if (doc.isDirty && !(await doc.save())) return fail('the file could not be saved, so it cannot be traced.');

  const language = doc.languageId;
  const lines = doc.getText().split(/\r?\n/);
  const sel = editor.selection;
  const selection = opts.currentFunctionOnly
    ? { startLine: sel.active.line + 1, endLine: sel.active.line + 1, isEmpty: true }
    : { startLine: sel.start.line + 1, endLine: sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1, isEmpty: sel.isEmpty };

  const target = resolveTarget(language, lines, selection);
  const workspaceRoot = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath;
  const base = path.basename(doc.fileName);
  let request: TraceRequest;

  if (target.mode === 'function') {
    const fn = target.fn;
    const params = requiredParamText(language, fn);
    let argsJson: string | undefined;
    if (params) {
      const answer = await promptForArguments(language, fn.name, params, `${doc.fileName}:${fn.name}`);
      if (answer === null) return;
      argsJson = answer;
    }
    request = {
      languageId: language, filePath: doc.fileName, mode: 'function', functionName: fn.name, startLine: fn.startLine, endLine: fn.endLine,
      argsJson, workspaceRoot, label: `${fn.name}()`, params
    };
  } else if (target.mode === 'block') {
    const text = lines.slice(selection.startLine - 1, selection.endLine).join('\n');
    const notes = target.insideFunction
      ? [`The selection is inside ${target.insideFunction.name}(); it was executed in module scope, so local variables of that function are not available. Select the whole function to trace it.`]
      : [];
    request = {
      languageId: language, filePath: doc.fileName, mode: 'block', startLine: selection.startLine, endLine: selection.endLine,
      selectionText: text, workspaceRoot, label: `Selection, lines ${selection.startLine}–${selection.endLine} of ${base}`, notes
    };
  } else {
    if (opts.currentFunctionOnly) {
      const any = detectFunctions(language, lines).length;
      return fail(any
        ? 'no traceable function was found around the cursor. Place the cursor inside a top-level function or a method of a top-level class.'
        : 'no functions were found in this file.');
    }
    const choice = await vscode.window.showInformationMessage('TraceLens: there is no function at the cursor. Trace the entire file instead?', 'Trace Entire File');
    if (choice !== 'Trace Entire File') return;
    request = {
      languageId: language, filePath: doc.fileName, mode: 'file', startLine: 1, endLine: lines.length, workspaceRoot, label: base
    };
  }

  try {
    await service.run(request);
  } catch (e) {
    const msg = e instanceof TraceLensError ? e.message : (e as Error).message;
    void vscode.window.showErrorMessage(`TraceLens: ${msg}`);
  }
}
