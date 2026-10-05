import * as path from 'path';
import { TraceSession } from '../models/TraceTypes';

export interface SourceLocation {
  filePath: string;
  /** 1-based */
  line: number;
  /** 1-based; 0 / undefined means "unknown" */
  column?: number;
}

export interface ZeroBasedPosition {
  line: number;
  character: number;
}

/** Converts a 1-based trace location into a clamped 0-based editor position. */
export function toZeroBased(loc: SourceLocation, lineCount?: number): ZeroBasedPosition {
  let line = Math.max(0, Math.floor(loc.line) - 1);
  if (lineCount !== undefined && lineCount > 0) line = Math.min(line, lineCount - 1);
  return { line, character: Math.max(0, Math.floor(loc.column ?? 0) - 1) };
}

/** Navigation requests from the webview are only honoured for files that appear in the current trace. */
export function isFileInSession(session: TraceSession | undefined, filePath: string): boolean {
  if (!session || !filePath || !path.isAbsolute(filePath)) return false;
  const norm = path.normalize(filePath);
  return session.files.some((f) => path.normalize(f) === norm);
}

export function displayPath(filePath: string, workspaceRoot?: string): string {
  if (workspaceRoot) {
    const rel = path.relative(workspaceRoot, filePath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  }
  return path.basename(filePath);
}
