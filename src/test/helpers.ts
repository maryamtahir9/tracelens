import * as path from 'path';
import { spawnSync } from 'child_process';
import { TraceOptions, TraceRequest } from '../models/TraceTypes';
import { RunnerCommand, ToolchainResolver } from '../tracing/LanguageTracer';

export const ROOT = path.resolve(__dirname, '..', '..', '..');
export const EXAMPLES = path.join(ROOT, 'examples');

export function pythonAvailable(): boolean {
  const r = spawnSync('python3', ['--version']);
  return r.status === 0;
}

export const toolchain: ToolchainResolver = {
  async resolvePython(): Promise<RunnerCommand> { return { command: 'python3', args: [] }; },
  async resolveNode(): Promise<RunnerCommand> { return { command: process.execPath, args: [] }; }
};

export const options: TraceOptions = { timeoutMs: 15000, maxEvents: 10000, captureConsole: true, captureArgs: true, captureReturn: true };

export function request(over: Partial<TraceRequest> & Pick<TraceRequest, 'languageId' | 'filePath'>): TraceRequest {
  return { mode: 'function', startLine: 1, endLine: 1, workspaceRoot: EXAMPLES, label: over.functionName ?? 'trace', ...over };
}
