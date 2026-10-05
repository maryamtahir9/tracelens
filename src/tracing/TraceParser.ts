import { ArgumentValue, CallNode, RawEvent, TraceError, TraceLensError } from '../models/TraceTypes';

export interface ParseResult {
  root: CallNode | null;
  eventCount: number;
  warnings: string[];
  end?: Extract<RawEvent, { t: 'end' }>;
  /** Highest timestamp seen in the stream (ms). */
  lastTimestamp: number;
  malformedLines: number;
}

export interface ParseOptions {
  /** Label used for the synthetic root created when the stream has several top-level calls. */
  syntheticRootName?: string;
  syntheticRootFile?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/** Validates a decoded JSON value as a RawEvent. Returns undefined when malformed. */
export function toRawEvent(v: unknown): RawEvent | undefined {
  if (!isRecord(v) || !isStr(v.t)) return undefined;
  switch (v.t) {
    case 'begin':
      return isNum(v.ts) ? { t: 'begin', ts: v.ts } : undefined;
    case 'call': {
      if (!isNum(v.id) || !isNum(v.parent) || !isStr(v.name) || !isStr(v.file) || !isNum(v.line) || !isNum(v.ts)) return undefined;
      let args: [string, string][] | undefined;
      if (Array.isArray(v.args)) {
        args = [];
        for (const a of v.args) {
          if (Array.isArray(a) && isStr(a[0]) && isStr(a[1])) args.push([a[0], a[1]]);
        }
      }
      return {
        t: 'call', id: v.id, parent: v.parent, name: v.name, file: v.file, line: v.line, ts: v.ts,
        col: isNum(v.col) ? v.col : undefined, endLine: isNum(v.endLine) ? v.endLine : undefined, args
      };
    }
    case 'ret':
      return isNum(v.id) && isNum(v.ts)
        ? { t: 'ret', id: v.id, ts: v.ts, endLine: isNum(v.endLine) ? v.endLine : undefined, value: isStr(v.value) ? v.value : undefined }
        : undefined;
    case 'err':
      return isNum(v.id) && isNum(v.ts) && isStr(v.type) && isStr(v.message)
        ? {
            t: 'err', id: v.id, ts: v.ts, type: v.type, message: v.message,
            file: isStr(v.file) ? v.file : undefined, line: isNum(v.line) ? v.line : undefined,
            col: isNum(v.col) ? v.col : undefined, origin: v.origin === true, stack: isStr(v.stack) ? v.stack : undefined
          }
        : undefined;
    case 'warn':
      return isStr(v.message) ? { t: 'warn', message: v.message } : undefined;
    case 'end': {
      if (!isNum(v.ts) || (v.status !== 'success' && v.status !== 'error')) return undefined;
      let error: TraceError | undefined;
      if (isRecord(v.error) && isStr(v.error.type) && isStr(v.error.message)) {
        error = {
          type: v.error.type, message: v.error.message,
          filePath: isStr(v.error.filePath) ? v.error.filePath : undefined,
          line: isNum(v.error.line) ? v.error.line : undefined,
          column: isNum(v.error.column) ? v.error.column : undefined,
          stack: isStr(v.error.stack) ? v.error.stack : undefined
        };
      }
      return { t: 'end', ts: v.ts, status: v.status, truncated: v.truncated === true, error };
    }
    default:
      return undefined;
  }
}

/**
 * Builds the execution tree from the JSON-lines event stream written by a runner.
 * Tolerates truncated streams (timeouts / cancellation): calls that never returned are
 * closed at the last timestamp seen and marked `incomplete`.
 */
export function parseTrace(text: string, options: ParseOptions = {}): ParseResult {
  const warnings: string[] = [];
  const nodes = new Map<number, CallNode>();
  const closed = new Set<number>();
  const topLevel: CallNode[] = [];
  let eventCount = 0;
  let malformed = 0;
  let nonEmpty = 0;
  let end: ParseResult['end'];
  let lastTs = 0;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    nonEmpty++;
    let ev: RawEvent | undefined;
    try {
      ev = toRawEvent(JSON.parse(trimmed));
    } catch {
      ev = undefined;
    }
    if (!ev) { malformed++; continue; }
    if ('ts' in ev && ev.ts > lastTs) lastTs = ev.ts;
    eventCount++;

    switch (ev.t) {
      case 'call': {
        const args: ArgumentValue[] | undefined = ev.args?.map(([name, value]) => ({ name, value }));
        const parent = ev.parent ? nodes.get(ev.parent) : undefined;
        const node: CallNode = {
          id: ev.id, functionName: ev.name, filePath: ev.file, startTime: ev.ts, endTime: ev.ts, duration: 0, selfTime: 0,
          startLine: ev.line, endLine: ev.endLine ?? ev.line, column: ev.col ?? 0,
          parentId: parent ? parent.id : null, children: [], depth: parent ? parent.depth + 1 : 0, status: 'incomplete', arguments: args
        };
        nodes.set(node.id, node);
        if (parent) parent.children.push(node); else topLevel.push(node);
        break;
      }
      case 'ret': {
        const n = nodes.get(ev.id);
        if (!n || closed.has(n.id)) break;
        n.endTime = Math.max(ev.ts, n.startTime);
        n.status = 'success';
        if (ev.value !== undefined) n.returnValue = ev.value;
        if (ev.endLine !== undefined) n.endLine = Math.max(ev.endLine, n.startLine);
        closed.add(n.id);
        break;
      }
      case 'err': {
        const n = nodes.get(ev.id);
        if (!n || closed.has(n.id)) break;
        n.endTime = Math.max(ev.ts, n.startTime);
        n.status = 'error';
        n.propagated = ev.origin !== true;
        n.error = { type: ev.type, message: ev.message, filePath: ev.file, line: ev.line, column: ev.col, stack: ev.stack };
        closed.add(n.id);
        break;
      }
      case 'warn':
        warnings.push(ev.message);
        break;
      case 'end':
        end = ev;
        break;
      default:
        break;
    }
  }

  if (nonEmpty > 0 && malformed === nonEmpty) {
    throw new TraceLensError('MALFORMED_TRACE', 'The trace output could not be read (every line was malformed). Try running the trace again.');
  }
  if (malformed > 0) warnings.push(`${malformed} malformed trace line(s) were ignored.`);

  // Close any calls that never returned.
  for (const n of nodes.values()) {
    if (!closed.has(n.id)) {
      n.endTime = Math.max(lastTs, n.startTime);
      n.status = 'incomplete';
    }
  }

  let root: CallNode | null = null;
  if (topLevel.length === 1) {
    root = topLevel[0];
  } else if (topLevel.length > 1) {
    const first = topLevel[0];
    const start = Math.min(...topLevel.map((n) => n.startTime));
    const finish = Math.max(...topLevel.map((n) => n.endTime));
    root = {
      id: 0, functionName: options.syntheticRootName ?? '<trace>', filePath: options.syntheticRootFile ?? first.filePath,
      startTime: start, endTime: finish, duration: 0, selfTime: 0, startLine: first.startLine, endLine: first.endLine, column: 0,
      parentId: null, children: topLevel, depth: 0,
      status: topLevel.some((n) => n.status === 'incomplete') ? 'incomplete' : 'success'
    };
    warnings.push('The run produced several top-level calls (for example asynchronous callbacks); they are grouped under a synthetic root.');
  }
  if (root) finalize(root, 0);

  return { root, eventCount, warnings, end, lastTimestamp: lastTs, malformedLines: malformed };
}

/** Computes durations, self times and depths (iteratively, so deep recursion cannot overflow the stack). */
export function finalize(root: CallNode, baseDepth: number): void {
  const stack: CallNode[] = [root];
  root.depth = baseDepth;
  const order: CallNode[] = [];
  while (stack.length) {
    const n = stack.pop() as CallNode;
    order.push(n);
    for (const c of n.children) {
      c.depth = n.depth + 1;
      c.parentId = n.id;
      stack.push(c);
    }
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    n.duration = Math.max(0, n.endTime - n.startTime);
    const childTotal = n.children.reduce((sum, c) => sum + c.duration, 0);
    n.selfTime = Math.max(0, n.duration - childTotal);
  }
}
