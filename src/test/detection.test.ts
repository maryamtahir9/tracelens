import test from 'node:test';
import assert from 'node:assert/strict';
import { detectFunctions, findEnclosingFunction, requiredParamText, resolveTarget } from '../utils/functionDetection';

const py = `import os

def top(a, b=2):
    def inner():
        return 1
    return inner() + a

class Svc:
    def run(self, x):
        return x

    @staticmethod
    def helper():
        pass

async def fetch(url):
    return url
`.split('\n');

test('python: detects top-level functions and class methods, not nested defs', () => {
  const fns = detectFunctions('python', py);
  assert.deepEqual(fns.map((f) => f.name), ['top', 'Svc.run', 'Svc.helper', 'fetch']);
  const top = fns[0];
  assert.deepEqual([top.startLine, top.endLine, top.params], [3, 6, 'a, b=2']);
  assert.equal(fns[3].isAsync, true);
});

test('python: cursor inside a nested function resolves to the outer callable function', () => {
  assert.equal(findEnclosingFunction('python', py, 5)?.name, 'top');
  assert.equal(findEnclosingFunction('python', py, 10)?.name, 'Svc.run');
  assert.equal(findEnclosingFunction('python', py, 1), undefined);
  assert.equal(requiredParamText('python', detectFunctions('python', py)[1]), 'x');
});

const ts = `import x from 'y';
// function ignored() {}
const s = "function fake() {}";

export async function processPayment(order: Order): Promise<number> {
  const inner = () => 1;
  return order.id + inner();
}

const calculate = (a: number, b: number): number => a + b;

const multi = async (
  a: string,
) => {
  return a;
};

class OrderService {
  private count = 0;
  static label(): string { return 'x'; }
  async process(order: { id: number }): Promise<void> {
    if (order.id) { this.count++; }
  }
}
`.split('\n');

test('typescript: detects declarations, arrow functions and methods; ignores comments, strings and nested functions', () => {
  const fns = detectFunctions('typescript', ts);
  assert.deepEqual(fns.map((f) => f.name), ['processPayment', 'calculate', 'multi', 'OrderService.label', 'OrderService.process']);
  const pp = fns[0];
  assert.deepEqual([pp.startLine, pp.endLine, pp.params, pp.isAsync], [5, 8, 'order: Order', true]);
  assert.deepEqual([fns[1].startLine, fns[1].endLine], [10, 10]);
  assert.deepEqual([fns[2].startLine, fns[2].endLine], [12, 16]);
  assert.equal(fns[4].className, 'OrderService');
});

test('typescript: cursor inside body resolves the enclosing function', () => {
  assert.equal(findEnclosingFunction('typescript', ts, 6)?.name, 'processPayment');
  assert.equal(findEnclosingFunction('typescript', ts, 23)?.name, 'OrderService.process');
});

test('javascript: function expressions and single-parameter arrows', () => {
  const js = ['const a = function (x) {', '  return x;', '};', 'const b = y => y * 2;'];
  const fns = detectFunctions('javascript', js);
  assert.deepEqual(fns.map((f) => [f.name, f.params]), [['a', 'x'], ['b', 'y']]);
});

test('resolveTarget: whole function / header selection => function, inner lines => block, cursor outside => none', () => {
  const whole = resolveTarget('typescript', ts, { startLine: 5, endLine: 8, isEmpty: false });
  assert.equal(whole.mode, 'function');
  const header = resolveTarget('typescript', ts, { startLine: 5, endLine: 5, isEmpty: false });
  assert.equal(header.mode, 'function');
  const inner = resolveTarget('typescript', ts, { startLine: 6, endLine: 7, isEmpty: false });
  assert.equal(inner.mode, 'block');
  assert.equal(inner.mode === 'block' && inner.insideFunction?.name, 'processPayment');
  assert.equal(resolveTarget('typescript', ts, { startLine: 1, endLine: 1, isEmpty: true }).mode, 'none');
  assert.equal(resolveTarget('python', py, { startLine: 4, endLine: 4, isEmpty: true }).mode, 'function');
});
