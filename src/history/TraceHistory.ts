import { SessionStatus, SupportedLanguage, TraceMode, TraceRequest, TraceSession } from '../models/TraceTypes';
import { isSupportedLanguage } from '../models/TraceTypes';

/** Minimal subset of vscode.Memento so the history can be unit-tested. */
export interface MementoLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

/**
 * Metadata only: no source code, argument values, return values or console output is persisted.
 */
export interface HistoryEntry {
  id: string;
  label: string;
  language: SupportedLanguage;
  filePath: string;
  mode: TraceMode;
  functionName?: string;
  startLine: number;
  endLine: number;
  params?: string;
  startedAt: string;
  duration: number;
  status: SessionStatus;
  functionCount: number;
}

export interface HistoryGroup {
  title: 'Today' | 'Yesterday' | 'Earlier';
  entries: HistoryEntry[];
}

const KEY = 'tracelens.history.v1';

function isEntry(v: unknown): v is HistoryEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.id === 'string' && typeof e.label === 'string' && typeof e.language === 'string' && isSupportedLanguage(e.language)
    && typeof e.filePath === 'string' && (e.mode === 'function' || e.mode === 'block' || e.mode === 'file')
    && typeof e.startLine === 'number' && typeof e.endLine === 'number' && typeof e.startedAt === 'string'
    && !Number.isNaN(Date.parse(e.startedAt)) && typeof e.duration === 'number' && typeof e.status === 'string'
    && typeof e.functionCount === 'number';
}

export class TraceHistory {
  constructor(private readonly store: MementoLike, private limit: number) {}

  setLimit(limit: number): void {
    this.limit = Math.max(0, Math.floor(limit));
  }

  list(): HistoryEntry[] {
    const raw = this.store.get<unknown[]>(KEY, []);
    return Array.isArray(raw) ? raw.filter(isEntry) : [];
  }

  get(id: string): HistoryEntry | undefined {
    return this.list().find((e) => e.id === id);
  }

  async add(session: TraceSession, request: TraceRequest, functionCount: number): Promise<void> {
    if (this.limit === 0) { await this.clear(); return; }
    const entry: HistoryEntry = {
      id: session.id, label: session.label, language: session.language, filePath: session.filePath, mode: session.mode,
      functionName: session.functionName, startLine: request.startLine, endLine: request.endLine, params: request.params,
      startedAt: session.startedAt, duration: session.duration, status: session.status, functionCount
    };
    // Re-tracing the same target replaces the older entry instead of piling up duplicates.
    const others = this.list().filter((e) => !(e.filePath === entry.filePath && e.mode === entry.mode && e.functionName === entry.functionName
      && e.startLine === entry.startLine && e.endLine === entry.endLine));
    await this.store.update(KEY, [entry, ...others].slice(0, this.limit));
  }

  async clear(): Promise<void> {
    await this.store.update(KEY, []);
  }

  /** Applies the (possibly lowered) limit to stored data. */
  async enforceLimit(): Promise<void> {
    const list = this.list();
    if (list.length > this.limit) await this.store.update(KEY, list.slice(0, this.limit));
  }

  grouped(now: Date = new Date()): HistoryGroup[] {
    const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const today = startOfDay(now);
    const yesterday = today - 86_400_000;
    const groups: HistoryGroup[] = [
      { title: 'Today', entries: [] }, { title: 'Yesterday', entries: [] }, { title: 'Earlier', entries: [] }
    ];
    for (const e of this.list()) {
      const t = Date.parse(e.startedAt);
      if (t >= today) groups[0].entries.push(e);
      else if (t >= yesterday) groups[1].entries.push(e);
      else groups[2].entries.push(e);
    }
    return groups.filter((g) => g.entries.length > 0);
  }
}
