/** Shared data model for TraceLens. Free of any `vscode` imports so it can be unit-tested. */

export type SupportedLanguage = 'python' | 'javascript' | 'typescript';
export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = ['python', 'javascript', 'typescript'];

export function isSupportedLanguage(id: string): id is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(id);
}

/** What the user asked to trace. */
export type TraceMode = 'function' | 'block' | 'file';

export interface TraceRequest {
  languageId: SupportedLanguage;
  filePath: string;
  mode: TraceMode;
  /** Qualified function name for `function` mode, e.g. `OrderService.process`. */
  functionName?: string;
  /** 1-based inclusive line range of the function / selected block. */
  startLine: number;
  endLine: number;
  /** Text of the full lines that make up a selected block (`block` mode). */
  selectionText?: string;
  /** JSON text with the arguments to call the function with. */
  argsJson?: string;
  workspaceRoot?: string;
  /** Human readable label shown in the UI. */
  label: string;
  /** Raw parameter list of the function (only used for UI prompts and history). */
  params?: string;
  /** Notes to show with the finished trace (for example "selection runs in module scope"). */
  notes?: string[];
}

export interface TraceOptions {
  timeoutMs: number;
  maxEvents: number;
  captureConsole: boolean;
  captureArgs: boolean;
  captureReturn: boolean;
}

export type CallStatus = 'success' | 'error' | 'incomplete';
export type SessionStatus = 'success' | 'error' | 'timeout' | 'cancelled';
export type Severity = 'normal' | 'moderate' | 'slow' | 'critical';

export interface TraceError {
  type: string;
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
  stack?: string;
}

export interface ArgumentValue {
  name: string;
  value: string;
}

export interface CallNode {
  id: number;
  functionName: string;
  filePath: string;
  /** Milliseconds relative to the start of the traced run. */
  startTime: number;
  endTime: number;
  duration: number;
  /** Duration minus time spent in children (never negative). */
  selfTime: number;
  startLine: number;
  endLine: number;
  /** 1-based column of the function definition (0 if unknown). */
  column: number;
  parentId: number | null;
  children: CallNode[];
  depth: number;
  status: CallStatus;
  arguments?: ArgumentValue[];
  returnValue?: string;
  error?: TraceError;
  /** True when `error` was raised in a descendant and merely propagated through this call. */
  propagated?: boolean;
}

export interface ConsoleChunk {
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface ConsoleOutput {
  chunks: ConsoleChunk[];
  truncated: boolean;
}

export interface TraceSession {
  id: string;
  label: string;
  language: SupportedLanguage;
  filePath: string;
  mode: TraceMode;
  functionName?: string;
  startLine: number;
  endLine: number;
  startedAt: string;
  /** Total wall-clock duration of the traced run in ms. */
  duration: number;
  status: SessionStatus;
  error?: TraceError;
  root: CallNode | null;
  console: ConsoleOutput;
  /** True when maxTraceEvents was hit and later calls were not recorded. */
  truncated: boolean;
  warnings: string[];
  eventCount: number;
  /** Every file path that appears in the trace (used to validate navigation requests). */
  files: string[];
}

export interface TraceSummary {
  totalDuration: number;
  functionCount: number;
  errorCount: number;
  slowCount: number;
  maxDepth: number;
}

export interface Thresholds {
  moderateMs: number;
  slowMs: number;
  criticalMs: number;
}

/** Raw events emitted by the language runners (JSON lines). */
export type RawEvent =
  | { t: 'begin'; ts: number }
  | { t: 'call'; id: number; parent: number; name: string; file: string; line: number; col?: number; endLine?: number; ts: number; args?: [string, string][] }
  | { t: 'ret'; id: number; ts: number; endLine?: number; value?: string }
  | { t: 'err'; id: number; ts: number; type: string; message: string; file?: string; line?: number; col?: number; origin?: boolean; stack?: string }
  | { t: 'warn'; message: string }
  | { t: 'end'; ts: number; status: 'success' | 'error'; truncated?: boolean; error?: TraceError };

export type TraceLensErrorCode =
  | 'NO_INTERPRETER' | 'NO_NODE' | 'TYPESCRIPT_MISSING' | 'UNSUPPORTED_LANGUAGE' | 'INVALID_SELECTION'
  | 'NO_FUNCTION' | 'MALFORMED_TRACE' | 'SPAWN_FAILED' | 'FILE_NOT_FOUND' | 'PERMISSION' | 'BUSY' | 'INVALID_ARGUMENTS';

export class TraceLensError extends Error {
  constructor(
    public readonly code: TraceLensErrorCode,
    message: string,
    public readonly actionHint?: 'openSettings'
  ) {
    super(message);
    this.name = 'TraceLensError';
  }
}
