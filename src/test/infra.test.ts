import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import * as path from 'path';
import { DEFAULT_SETTINGS, normalizeSettings, toThresholds, toTraceOptions } from '../models/Settings';
import { MementoLike, TraceHistory } from '../history/TraceHistory';
import { TraceRequest, TraceSession } from '../models/TraceTypes';
import { displayPath, isFileInSession, toZeroBased } from '../utils/locations';
import { ROOT } from './helpers';

class MemoryMemento implements MementoLike {
  data = new Map<string, unknown>();
  get<T>(k: string, d: T): T { return (this.data.has(k) ? this.data.get(k) : d) as T; }
  async update(k: string, v: unknown): Promise<void> { this.data.set(k, v); }
}
function sess(id: string, startedAt: string, fn = 'f'): { s: TraceSession; r: TraceRequest } {
  const s: TraceSession = { id, label: fn + '()', language: 'python', filePath: '/p/a.py', mode: 'function', functionName: fn, startLine: 1, endLine: 3, startedAt,
    duration: 12, status: 'success', root: null, console: { chunks: [], truncated: false }, truncated: false, warnings: [], eventCount: 0, files: ['/p/a.py'] };
  const r: TraceRequest = { languageId: 'python', filePath: '/p/a.py', mode: 'function', functionName: fn, startLine: 1, endLine: 3, label: s.label, argsJson: '["secret"]' };
  return { s, r };
}

test('settings: defaults, clamping, invalid values and threshold ordering', () => {
  assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS);
  const n = normalizeSettings({ executionTimeout: 1, maxTraceEvents: 1e9, historyLimit: -4, slowThresholdMs: 10, moderateThresholdMs: 80, criticalThresholdMs: 20, showArguments: 'yes' });
  assert.equal(n.executionTimeout, 500);
  assert.equal(n.maxTraceEvents, 1_000_000);
  assert.equal(n.historyLimit, 0);
  assert.equal(n.showArguments, true);
  assert.deepEqual(toThresholds(n), { moderateMs: 80, slowMs: 80, criticalMs: 80 });
  assert.equal(toTraceOptions(normalizeSettings({ captureConsole: false })).captureConsole, false);
});

test('history: newest first, de-duplicates same target, enforces limit, groups by day, never stores arguments', async () => {
  const store = new MemoryMemento();
  const h = new TraceHistory(store, 3);
  const now = new Date(2026, 5, 15, 12, 0, 0);
  const iso = (daysAgo: number): string => new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
  for (const [i, fn] of ['a', 'b', 'c', 'd'].entries()) { const { s, r } = sess('id' + i, iso(i === 3 ? 3 : 0), fn); await h.add(s, r, 4); }
  assert.deepEqual(h.list().map((e) => e.functionName), ['d', 'c', 'b']);
  const again = sess('id9', iso(0), 'c');
  await h.add(again.s, again.r, 2);
  assert.deepEqual(h.list().map((e) => e.functionName), ['c', 'd', 'b']);
  assert.ok(!JSON.stringify(store.data).includes('secret'));
  const groups = h.grouped(now);
  assert.equal(groups[0].title, 'Today');
  h.setLimit(1); await h.enforceLimit();
  assert.equal(h.list().length, 1);
  await h.clear();
  assert.equal(h.list().length, 0);
  store.data.set('tracelens.history.v1', [{ bogus: true }, 5]);
  assert.equal(h.list().length, 0);
});

test('history: limit 0 stores nothing', async () => {
  const h = new TraceHistory(new MemoryMemento(), 0);
  const { s, r } = sess('z', new Date().toISOString());
  await h.add(s, r, 1);
  assert.equal(h.list().length, 0);
});

test('locations: 1-based to 0-based conversion, clamping, display paths and navigation allow-list', () => {
  assert.deepEqual(toZeroBased({ filePath: 'x', line: 184, column: 5 }), { line: 183, character: 4 });
  assert.deepEqual(toZeroBased({ filePath: 'x', line: 0 }), { line: 0, character: 0 });
  assert.deepEqual(toZeroBased({ filePath: 'x', line: 999 }, 10), { line: 9, character: 0 });
  assert.equal(displayPath(path.join(ROOT, 'src', 'a.ts'), ROOT), 'src/a.ts');
  assert.equal(displayPath('/elsewhere/b.ts', ROOT), 'b.ts');
  const { s } = sess('q', new Date().toISOString());
  assert.equal(isFileInSession(s, '/p/a.py'), true);
  assert.equal(isFileInSession(s, '/etc/passwd'), false);
  assert.equal(isFileInSession(s, '../p/a.py'), false);
  assert.equal(isFileInSession(undefined, '/p/a.py'), false);
});

test('source maps: VLQ decoding maps generated positions back to the original', () => {
  const req = createRequire(__filename);
  const { createMapper } = req(path.join(ROOT, 'runners', 'sourcemap.js')) as { createMapper: (m: unknown) => (l: number, c: number) => { line: number; column: number } | null };
  // generated line1 col0 -> src line 3 col 2 ; line2 col4 -> src line 4 col 0
  const map = { version: 3, sources: ['a.ts'], names: [], mappings: 'AAEE;IACA' };
  const m = createMapper(map);
  assert.deepEqual(m(1, 0), { line: 3, column: 2 });
  assert.deepEqual(m(2, 6), { line: 4, column: 2 });
  assert.equal(m(9, 0), null);
});
