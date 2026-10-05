import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PythonTracer } from '../tracing/PythonTracer';
import { JavaScriptTracer } from '../tracing/JavaScriptTracer';
import { TypeScriptTracer } from '../tracing/TypeScriptTracer';
import { TraceLensError } from '../models/TraceTypes';
import { flatten } from '../tracing/TraceSession';
import { EXAMPLES, ROOT, options, pythonAvailable, request, toolchain } from './helpers';

const py = new PythonTracer(ROOT, toolchain);
const js = new JavaScriptTracer(ROOT, toolchain);
const ts = new TypeScriptTracer(ROOT, toolchain);
const names = (s: { root: Parameters<typeof flatten>[0] }): string[] => flatten(s.root).map((n) => n.functionName);
const PY = path.join(EXAMPLES, 'python', 'order.py');
const JS = path.join(EXAMPLES, 'javascript', 'order.js');
const TS = path.join(EXAMPLES, 'typescript', 'order.ts');
const order = '[{"id":1,"items":{"a":1,"b":2}}]';
const bad = '[{"id":2,"items":{"a":1},"card":"declined"}]';
const skipPy = pythonAvailable() ? false : 'python3 not available';

test('python: real call tree, timings, arguments, return values and console output', { skip: skipPy }, async () => {
  const s = await py.trace(request({ languageId: 'python', filePath: PY, functionName: 'process_order', argsJson: order }), options);
  assert.equal(s.status, 'success');
  assert.deepEqual(names(s), ['process_order', 'validate_order', 'check_inventory', 'calculate_price', 'charge_card', 'send_confirmation']);
  const byName = Object.fromEntries(flatten(s.root).map((n) => [n.functionName, n]));
  assert.ok(byName.check_inventory.duration >= 13, 'sleep(15ms) must be measured');
  assert.ok(byName.charge_card.duration >= 55 && byName.charge_card.duration < 400);
  assert.ok(s.root!.duration >= byName.check_inventory.duration + byName.charge_card.duration);
  assert.equal(byName.calculate_price.returnValue, '3');
  assert.equal(byName.process_order.children.length, 5);
  assert.equal(byName.charge_card.arguments?.[1].value, '3');
  assert.match(s.console.chunks.map((c) => c.text).join(''), /Processing order 1/);
  assert.ok(s.files.includes(PY));
});

test('python: exception is reported at the raising call and propagated to callers', { skip: skipPy }, async () => {
  const s = await py.trace(request({ languageId: 'python', filePath: PY, functionName: 'process_order', argsJson: bad }), options);
  assert.equal(s.status, 'error');
  assert.equal(s.error?.type, 'PaymentError');
  assert.equal(s.error?.message, 'card declined');
  assert.ok(s.error?.line && s.error.filePath === PY);
  const charge = flatten(s.root).find((n) => n.functionName === 'charge_card')!;
  assert.equal(charge.status, 'error');
  assert.equal(charge.propagated, false);
  assert.equal(s.root!.propagated, true);
});

test('python: caught exceptions do not make the catching function fail', { skip: skipPy }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
  const f = path.join(dir, 'm.py');
  fs.writeFileSync(f, 'def boom():\n    raise KeyError("x")\n\ndef safe():\n    try:\n        boom()\n    except KeyError:\n        pass\n    return 1\n');
  const s = await py.trace(request({ languageId: 'python', filePath: f, functionName: 'safe', workspaceRoot: dir }), options);
  assert.equal(s.status, 'success');
  assert.equal(s.root!.status, 'success');
  assert.equal(s.root!.children[0].status, 'error');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('python: class method, block selection and keyword arguments', { skip: skipPy }, async () => {
  const m = await py.trace(request({ languageId: 'python', filePath: PY, functionName: 'OrderService.total', argsJson: '[[1,2,3]]' }), options);
  assert.equal(m.root!.returnValue, '6');
  const kw = await py.trace(request({ languageId: 'python', filePath: PY, functionName: 'OrderService.total', argsJson: '{"items":[4,5]}' }), options);
  assert.equal(kw.root!.returnValue, '9');
  const b = await py.trace(request({ languageId: 'python', filePath: PY, mode: 'block', startLine: 1, endLine: 2, selectionText: 'x = fib(6)\nprint(x)', label: 'sel' }), options);
  assert.equal(b.status, 'success');
  assert.equal(b.root!.functionName, 'sel');
  assert.ok(flatten(b.root).filter((n) => n.functionName === 'fib').length >= 13);
  assert.match(b.console.chunks[0].text, /8/);
});

test('python: maxTraceEvents bounds the trace and sets the truncated flag', { skip: skipPy }, async () => {
  const s = await py.trace(request({ languageId: 'python', filePath: PY, functionName: 'fib', argsJson: '[18]' }), { ...options, maxEvents: 50 });
  assert.equal(s.truncated, true);
  assert.equal(flatten(s.root).length, 50);
  assert.equal(s.status, 'success');
  assert.equal(s.root!.returnValue, '2584');
});

test('python: infinite loop is terminated by the timeout and the partial trace is kept', { skip: skipPy }, async () => {
  const t0 = Date.now();
  const s = await py.trace(request({ languageId: 'python', filePath: PY, functionName: 'spin_forever' }), { ...options, timeoutMs: 1200 });
  assert.equal(s.status, 'timeout');
  assert.ok(Date.now() - t0 < 6000);
  assert.equal(s.root!.functionName, 'spin_forever');
  assert.equal(s.root!.status, 'incomplete');
});

test('python: cancellation really kills the process', { skip: skipPy }, async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 600);
  const t0 = Date.now();
  const s = await py.trace(request({ languageId: 'python', filePath: PY, functionName: 'spin_forever' }), { ...options, timeoutMs: 30000 }, ac.signal);
  assert.equal(s.status, 'cancelled');
  assert.ok(Date.now() - t0 < 5000);
});

test('python: errors before the target runs (syntax error) are reported, not faked', { skip: skipPy }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
  const f = path.join(dir, 'bad.py');
  fs.writeFileSync(f, 'def f(:\n    pass\n');
  const s = await py.trace(request({ languageId: 'python', filePath: f, functionName: 'f', workspaceRoot: dir }), options);
  assert.equal(s.status, 'error');
  assert.equal(s.root, null);
  assert.equal(s.error?.type, 'SyntaxError');
  assert.match(s.console.chunks.map((c) => c.text).join(''), /SyntaxError/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('javascript: async calls are attributed to their real parents with real timings', async () => {
  const s = await js.trace(request({ languageId: 'javascript', filePath: JS, functionName: 'processOrder', argsJson: order }), options);
  assert.equal(s.status, 'success');
  const flat = flatten(s.root);
  const get = (n: string) => flat.find((x) => x.functionName === n)!;
  assert.equal(s.root!.functionName, 'processOrder');
  assert.equal(get('checkInventory').parentId, s.root!.id);
  assert.ok(flat.some((n) => n.functionName === 'sleep' && n.parentId === get('checkInventory').id));
  assert.ok(get('checkInventory').duration >= 13);
  assert.ok(get('chargeCard').duration >= 55);
  assert.equal(get('calculatePrice').returnValue, '3');
  assert.deepEqual(get('chargeCard').arguments?.map((a) => a.name), ['order', 'total']);
  assert.match(s.console.chunks.map((c) => c.text).join(''), /Sending confirmation/);
});

test('javascript: async rejection, recursion arrow functions, classes, block mode', async () => {
  const e = await js.trace(request({ languageId: 'javascript', filePath: JS, functionName: 'processOrder', argsJson: bad }), options);
  assert.equal(e.status, 'error');
  assert.equal(e.error?.message, 'card declined');
  assert.equal(flatten(e.root).find((n) => n.functionName === 'chargeCard')!.propagated, false);
  const f = await js.trace(request({ languageId: 'javascript', filePath: JS, functionName: 'fib', argsJson: '[10]' }), options);
  assert.equal(f.root!.returnValue, '55');
  assert.equal(flatten(f.root).length, 177);
  const c = await js.trace(request({ languageId: 'javascript', filePath: JS, functionName: 'OrderService.total', argsJson: '[[1,2,3]]' }), options);
  assert.equal(c.root!.returnValue, '6');
  assert.equal(c.root!.functionName, 'OrderService.total');
  const b = await js.trace(request({ languageId: 'javascript', filePath: JS, mode: 'block', startLine: 1, endLine: 1, selectionText: 'fib(5)', label: 'blk' }), options);
  assert.equal(b.root!.functionName, 'blk');
  assert.equal(flatten(b.root).filter((n) => n.functionName === 'fib').length, 15);
});

test('javascript: synchronous infinite loop times out; truncation bounds events', async () => {
  const s = await js.trace(request({ languageId: 'javascript', filePath: JS, functionName: 'spinForever' }), { ...options, timeoutMs: 1000 });
  assert.equal(s.status, 'timeout');
  assert.equal(s.root!.status, 'incomplete');
  const t = await js.trace(request({ languageId: 'javascript', filePath: JS, functionName: 'fib', argsJson: '[20]' }), { ...options, maxEvents: 100 });
  assert.equal(t.truncated, true);
  assert.equal(flatten(t.root).length, 100);
  assert.equal(t.root!.returnValue, '6765');
});

test('javascript: privacy options omit arguments and return values', async () => {
  const s = await js.trace(request({ languageId: 'javascript', filePath: JS, functionName: 'fib', argsJson: '[3]' }), { ...options, captureArgs: false, captureReturn: false, captureConsole: false });
  assert.equal(s.root!.arguments, undefined);
  assert.equal(s.root!.returnValue, undefined);
  assert.equal(s.console.chunks.length, 0);
});

test('typescript: traces .ts files and maps locations back to TypeScript source lines', async () => {
  const s = await ts.trace(request({ languageId: 'typescript', filePath: TS, functionName: 'processOrder', argsJson: bad }), options);
  assert.equal(s.status, 'error');
  const lines = fs.readFileSync(TS, 'utf8').split('\n');
  const charge = flatten(s.root).find((n) => n.functionName === 'chargeCard')!;
  assert.match(lines[charge.startLine - 1], /export async function chargeCard/);
  assert.equal(charge.filePath, TS);
  assert.match(lines[s.error!.line! - 1], /throw new Error\('card declined'\)/);
  const ok = await ts.trace(request({ languageId: 'typescript', filePath: TS, functionName: 'processOrder', argsJson: order }), options);
  assert.equal(ok.status, 'success');
  assert.equal(ok.root!.returnValue, '3');
});

test('typescript: clear error when the project has no typescript package', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
  const f = path.join(dir, 'a.ts');
  fs.writeFileSync(f, 'export function a(): number { return 1; }\n');
  await assert.rejects(ts.trace(request({ languageId: 'typescript', filePath: f, functionName: 'a', workspaceRoot: dir }), options),
    (e: unknown) => e instanceof TraceLensError && e.code === 'TYPESCRIPT_MISSING' && /npm install/.test(e.message));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('request validation: missing file, empty selection, missing function name', async () => {
  await assert.rejects(js.trace(request({ languageId: 'javascript', filePath: '/nope/x.js', functionName: 'a' }), options), (e: unknown) => e instanceof TraceLensError && e.code === 'FILE_NOT_FOUND');
  await assert.rejects(js.trace(request({ languageId: 'javascript', filePath: JS, mode: 'block', selectionText: '  ' }), options), (e: unknown) => e instanceof TraceLensError && e.code === 'INVALID_SELECTION');
  await assert.rejects(js.trace(request({ languageId: 'javascript', filePath: JS, functionName: undefined }), options), (e: unknown) => e instanceof TraceLensError && e.code === 'NO_FUNCTION');
});

test('missing interpreter produces a friendly error', async () => {
  const broken = new PythonTracer(ROOT, { ...toolchain, resolvePython: async () => ({ command: '/definitely/not/python', args: [] }) });
  await assert.rejects(broken.trace(request({ languageId: 'python', filePath: PY, functionName: 'fib', argsJson: '[1]' }), options),
    (e: unknown) => e instanceof TraceLensError && e.code === 'NO_INTERPRETER');
});
