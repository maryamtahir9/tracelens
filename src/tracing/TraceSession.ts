import { CallNode, Severity, Thresholds, TraceSession, TraceSummary } from '../models/TraceTypes';

/** Depth-first flattening without recursion. */
export function flatten(root: CallNode | null): CallNode[] {
  if (!root) return [];
  const out: CallNode[] = [];
  const stack: CallNode[] = [root];
  while (stack.length) {
    const n = stack.pop() as CallNode;
    out.push(n);
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return out;
}

export function classifyDuration(ms: number, t: Thresholds): Severity {
  if (ms >= t.criticalMs) return 'critical';
  if (ms >= t.slowMs) return 'slow';
  if (ms >= t.moderateMs) return 'moderate';
  return 'normal';
}

function realNodes(session: TraceSession): CallNode[] {
  const nodes = flatten(session.root);
  return session.root && session.root.id === 0 ? nodes.slice(1) : nodes; // skip synthetic root
}

export function summarize(session: TraceSession, t: Thresholds): TraceSummary {
  const real = realNodes(session);
  return {
    totalDuration: session.duration,
    functionCount: real.length,
    errorCount: real.filter((n) => n.status === 'error' && !n.propagated).length,
    slowCount: real.filter((n) => n.duration >= t.slowMs).length,
    maxDepth: real.reduce((m, n) => Math.max(m, n.depth - (session.root && session.root.id === 0 ? 0 : -1)), 0)
  };
}

/** Slowest calls by duration (not self time), excluding the synthetic root. */
export function slowest(session: TraceSession, limit = 5): CallNode[] {
  return realNodes(session)
    .sort((a, b) => b.duration - a.duration || a.startTime - b.startTime)
    .slice(0, limit);
}

/** Case-insensitive search over function names, file names and error text. */
export function search(session: TraceSession, query: string): CallNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return flatten(session.root).filter((n) => {
    const hay = [n.functionName, n.filePath.split(/[\\/]/).pop() ?? '', n.filePath, n.error?.type ?? '', n.error?.message ?? ''];
    return hay.some((h) => h.toLowerCase().includes(q));
  });
}

export function collectFiles(root: CallNode | null, extra: string[] = []): string[] {
  const set = new Set<string>(extra.filter(Boolean));
  for (const n of flatten(root)) {
    if (n.filePath) set.add(n.filePath);
    if (n.error?.filePath) set.add(n.error.filePath);
  }
  return [...set];
}

export function formatDuration(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(3)} s`;
}
