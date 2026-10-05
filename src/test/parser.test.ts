import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTrace } from '../tracing/TraceParser';
import { classifyDuration, flatten, search, slowest, summarize } from '../tracing/TraceSession';
import { TraceSession, TraceLensError } from '../models/TraceTypes';

const ev = (o: object): string => JSON.stringify(o);
const stream = [
  ev({ t: 'begin', ts: 0 }),
  ev({ t: 'call', id: 1, parent: 0, name: 'processPayment', file: '/p/pay.ts', line: 10, ts: 1, args: [['orderId', '1042']] }),
  ev({ t: 'call', id: 2, parent: 1, name: 'validateOrder', file: '/p/pay.ts', line: 20, ts: 2 }),
  ev({ t: 'ret', id: 2, ts: 4, value: 'true', endLine: 25 }),
  ev({ t: 'call', id: 3, parent: 1, name: 'chargeCard', file: '/p/pay.ts', line: 30, ts: 4 }),
  ev({ t: 'call', id: 4, parent: 3, name: 'fetchUser', file: '/p/db.ts', line: 5, ts: 5 }),
  ev({ t: 'err', id: 4, ts: 305, type: 'ConnectionError', message: 'Failed to connect', file: '/p/db.ts', line: 87, origin: true }),
  ev({ t: 'err', id: 3, ts: 306, type: 'ConnectionError', message: 'Failed to connect', origin: false }),
  ev({ t: 'ret', id: 1, ts: 307 }),
  ev({ t: 'end', ts: 308, status: 'success' })
].join('\n');

function session(root: TraceSession['root']): TraceSession {
  return { id: 'x', label: 'x', language: 'typescript', filePath: '/p/pay.ts', mode: 'function', startLine: 1, endLine: 2, startedAt: new Date().toISOString(),
    duration: root ? root.duration : 0, status: 'success', root, console: { chunks: [], truncated: false }, truncated: false, warnings: [], eventCount: 0, files: [] };
}

test('builds the call tree with parents, depth and children', () => {
  const r = parseTrace(stream);
  assert.ok(r.root);
  assert.equal(r.root.functionName, 'processPayment');
  assert.deepEqual(r.root.children.map((c) => c.functionName), ['validateOrder', 'chargeCard']);
  assert.equal(r.root.children[1].children[0].depth, 2);
  assert.equal(r.root.children[1].children[0].parentId, 3);
  assert.deepEqual(r.root.arguments, [{ name: 'orderId', value: '1042' }]);
});

test('computes durations and self time from event timestamps', () => {
  const root = parseTrace(stream).root!;
  assert.equal(root.duration, 306);
  assert.equal(root.children[0].duration, 2);
  assert.equal(root.children[1].duration, 302);
  assert.equal(root.selfTime, 306 - 2 - 302);
});

test('distinguishes origin errors from propagated ones', () => {
  const root = parseTrace(stream).root!;
  const charge = root.children[1];
  assert.equal(charge.status, 'error');
  assert.equal(charge.propagated, true);
  assert.equal(charge.children[0].propagated, false);
  assert.equal(charge.children[0].error?.line, 87);
});

test('marks calls that never returned as incomplete (timeouts)', () => {
  const partial = [ev({ t: 'call', id: 1, parent: 0, name: 'a', file: '/f', line: 1, ts: 0 }), ev({ t: 'call', id: 2, parent: 1, name: 'b', file: '/f', line: 2, ts: 5 }), ev({ t: 'ret', id: 2, ts: 9 })].join('\n');
  const r = parseTrace(partial);
  assert.equal(r.root!.status, 'incomplete');
  assert.equal(r.root!.endTime, 9);
  assert.equal(r.root!.children[0].status, 'success');
});

test('ignores malformed lines but rejects a fully malformed stream', () => {
  const r = parseTrace(stream + '\n{not json}\n{"t":"call"}');
  assert.equal(r.malformedLines, 2);
  assert.ok(r.warnings.some((w) => w.includes('malformed')));
  assert.throws(() => parseTrace('garbage\nmore garbage'), (e: unknown) => e instanceof TraceLensError && e.code === 'MALFORMED_TRACE');
});

test('groups several top-level calls under a synthetic root', () => {
  const s = [ev({ t: 'call', id: 1, parent: 0, name: 'a', file: '/f', line: 1, ts: 0 }), ev({ t: 'ret', id: 1, ts: 2 }),
    ev({ t: 'call', id: 2, parent: 0, name: 'b', file: '/f', line: 5, ts: 3 }), ev({ t: 'ret', id: 2, ts: 8 })].join('\n');
  const r = parseTrace(s, { syntheticRootName: 'run' });
  assert.equal(r.root!.id, 0);
  assert.equal(r.root!.functionName, 'run');
  assert.equal(r.root!.duration, 8);
  const sum = summarize(session(r.root), { moderateMs: 50, slowMs: 250, criticalMs: 1000 });
  assert.equal(sum.functionCount, 2);
  assert.equal(sum.maxDepth, 1);
});

test('does not overflow the stack on very deep recursion', () => {
  const lines: string[] = [];
  const N = 20000;
  for (let i = 1; i <= N; i++) lines.push(ev({ t: 'call', id: i, parent: i - 1, name: 'f', file: '/f', line: 1, ts: i }));
  for (let i = N; i >= 1; i--) lines.push(ev({ t: 'ret', id: i, ts: N + (N - i) + 1 }));
  const r = parseTrace(lines.join('\n'));
  assert.equal(flatten(r.root).length, N);
  assert.equal(summarize(session(r.root), { moderateMs: 50, slowMs: 250, criticalMs: 1000 }).maxDepth, N);
});

test('summary, slowest, severity and search use the real data', () => {
  const root = parseTrace(stream).root!;
  const s = session(root);
  const t = { moderateMs: 50, slowMs: 250, criticalMs: 1000 };
  const sum = summarize(s, t);
  assert.deepEqual({ f: sum.functionCount, e: sum.errorCount, slow: sum.slowCount, d: sum.maxDepth }, { f: 4, e: 1, slow: 3, d: 3 });
  assert.deepEqual(slowest(s, 2).map((n) => n.functionName), ['processPayment', 'chargeCard']);
  assert.equal(classifyDuration(49.9, t), 'normal');
  assert.equal(classifyDuration(50, t), 'moderate');
  assert.equal(classifyDuration(250, t), 'slow');
  assert.equal(classifyDuration(1000, t), 'critical');
  assert.deepEqual(search(s, 'charge').map((n) => n.functionName), ['chargeCard']);
  assert.deepEqual(search(s, 'db.ts').map((n) => n.functionName), ['fetchUser']);
  assert.deepEqual(search(s, 'failed to connect').map((n) => n.functionName), ['chargeCard', 'fetchUser']);
});
