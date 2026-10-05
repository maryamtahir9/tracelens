import * as vscode from 'vscode';
import { normalizeSettings, TraceLensSettings } from '../models/Settings';

export function readSettings(scope?: vscode.Uri): TraceLensSettings {
  const c = vscode.workspace.getConfiguration('traceLens', scope);
  const keys: (keyof TraceLensSettings)[] = [
    'executionTimeout', 'maxTraceEvents', 'slowThresholdMs', 'moderateThresholdMs', 'criticalThresholdMs', 'historyLimit',
    'showArguments', 'showReturnValues', 'captureConsole', 'autoOpenTrace', 'pythonPath', 'nodePath'
  ];
  const raw: Partial<Record<keyof TraceLensSettings, unknown>> = {};
  for (const k of keys) raw[k] = c.get<unknown>(k);
  return normalizeSettings(raw);
}
