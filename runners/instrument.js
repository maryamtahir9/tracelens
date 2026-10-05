'use strict';
/**
 * Source instrumenter for TraceLens' Node runner.
 *
 * Every user function gets enter/leave hooks injected *without adding or removing lines*, so line
 * numbers in stack traces and in the trace stay exact. Hooks report real calls, real timings and
 * real thrown errors at runtime; nothing is inferred from the source text.
 *
 * Output contract: the instrumented code references a global `__TL` object with
 *   enter(siteId, args)  – sync functions;  enterA(siteId, args) + run(token, thunk) – async functions
 *   ret(token, value) → value;   fail(token, error);   leave(token)
 */
const acorn = require('acorn');

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function keyName(node, code) {
  if (!node) return '<anonymous>';
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal') return String(node.value);
  if (node.type === 'PrivateIdentifier') return '#' + node.name;
  return code.slice(node.start, node.end);
}

function lastName(node, code) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed) return keyName(node.property, code);
  return '<anonymous>';
}

function paramNames(params) {
  const names = [];
  for (const p of params) {
    if (p.type === 'Identifier') names.push(p.name);
    else if (p.type === 'AssignmentPattern' && p.left.type === 'Identifier') names.push(p.left.name);
    else if (p.type === 'RestElement' && p.argument.type === 'Identifier') names.push(p.argument.name);
  }
  return names;
}

/** Collects `return` statements that belong to `fn` itself (not to nested functions). */
function collectReturns(body) {
  const out = [];
  (function walk(node) {
    if (!node || typeof node.type !== 'string') return;
    if (FUNCTION_TYPES.has(node.type)) return;
    if (node.type === 'ReturnStatement' && node.argument) out.push(node);
    if (node.type === 'ClassBody') return;
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  })(body);
  return out;
}

/**
 * @param {string} code  JavaScript source (CommonJS script)
 * @param {{file:string, mapPosition?:(line:number,col:number)=>({line:number,column:number}|null), registerSite:(site:object)=>number}} opts
 * @returns {{code:string, sites:number}}
 */
function instrument(code, opts) {
  const ast = acorn.parse(code, {
    ecmaVersion: 'latest', sourceType: 'script', locations: true, allowHashBang: true,
    allowReturnOutsideFunction: true, preserveParens: true
  });
  const edits = [];
  let seq = 0;
  const add = (pos, text) => edits.push({ pos, text, seq: seq++ });
  const map = opts.mapPosition || ((line, column) => ({ line, column }));
  let siteCount = 0;

  function makeSite(fnNode, name, posNode) {
    const startLoc = (posNode || fnNode).loc.start;
    const endLoc = fnNode.loc.end;
    const s = map(startLoc.line, startLoc.column) || { line: startLoc.line, column: startLoc.column };
    const e = map(endLoc.line, Math.max(0, endLoc.column - 1)) || { line: endLoc.line, column: endLoc.column };
    siteCount++;
    return opts.registerSite({
      name, file: opts.file, line: s.line, col: s.column + 1,
      endLine: Math.max(e.line, s.line), isAsync: Boolean(fnNode.async)
    });
  }

  function handleFunction(node, name, posNode, visitChildren) {
    if (node.generator) { visitChildren(); return; }
    const siteId = makeSite(node, name, posNode);
    const names = paramNames(node.params);
    const args = names.length ? `__TL.A?[${names.map((n) => `[${JSON.stringify(n)},${n}]`).join(',')}]:null` : 'null';
    const isAsync = Boolean(node.async);
    const begin = isAsync
      ? `const __t=__TL.enterA(${siteId},${args});return __TL.run(__t,async()=>{try{`
      : `const __t=__TL.enter(${siteId},${args});try{`;
    const finish = '}catch(__e){__TL.fail(__t,__e);throw __e}finally{__TL.leave(__t)}' + (isAsync ? '});' : '');

    const returns = node.body.type === 'BlockStatement' ? collectReturns(node.body) : [];
    if (node.body.type === 'BlockStatement') {
      let insertAt = node.body.start + 1;
      for (const stmt of node.body.body) {
        if (stmt.type === 'ExpressionStatement' && typeof stmt.directive === 'string') insertAt = stmt.end; else break;
      }
      add(insertAt, begin);
      for (const r of returns) add(r.argument.start, '__TL.ret(__t,');
    } else {
      add(node.body.start, '{' + begin + 'return __TL.ret(__t,(');
    }
    visitChildren();
    if (node.body.type === 'BlockStatement') {
      for (const r of returns) add(r.argument.end, ')');
      add(node.body.end - 1, finish);
    } else {
      add(node.body.end, '))' + finish + '}');
    }
  }

  function children(node, visit) {
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
      const v = node[key];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') visit(c); }
      else if (v && typeof v.type === 'string') visit(v);
    }
  }

  function visit(node, hint, cls) {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'ClassDeclaration':
      case 'ClassExpression': {
        const name = node.id ? node.id.name : hint || '<class>';
        children(node, (c) => visit(c, null, name));
        return;
      }
      case 'VariableDeclarator':
        visit(node.id, null, cls);
        if (node.init) visit(node.init, node.id.type === 'Identifier' ? node.id.name : null, cls);
        return;
      case 'AssignmentExpression':
        visit(node.left, null, cls);
        visit(node.right, lastName(node.left, opts.codeText), cls);
        return;
      case 'Property':
        if (node.computed) visit(node.key, null, cls);
        visit(node.value, keyName(node.key, opts.codeText), cls);
        return;
      case 'PropertyDefinition':
        if (node.computed) visit(node.key, null, cls);
        if (node.value) visit(node.value, keyName(node.key, opts.codeText), cls);
        return;
      case 'MethodDefinition': {
        const base = keyName(node.key, opts.codeText);
        const name = (cls ? cls + '.' : '') + (node.kind === 'get' || node.kind === 'set' ? node.kind + ' ' : '') + base;
        if (node.computed) visit(node.key, null, cls);
        const fn = node.value;
        handleFunction(fn, name, node.key, () => {
          fn.params.forEach((p) => visit(p, null, cls));
          visit(fn.body, null, cls);
        });
        return;
      }
      default:
        break;
    }
    if (FUNCTION_TYPES.has(node.type)) {
      const name = node.id ? node.id.name : hint || '<anonymous>';
      handleFunction(node, name, null, () => {
        node.params.forEach((p) => visit(p, null, cls));
        visit(node.body, null, cls);
      });
      return;
    }
    children(node, (c) => visit(c, null, cls));
  }

  opts.codeText = code;
  visit(ast, null, null);

  edits.sort((a, b) => a.pos - b.pos || a.seq - b.seq);
  let out = '';
  let last = 0;
  for (const e of edits) {
    out += code.slice(last, e.pos) + e.text;
    last = e.pos;
  }
  out += code.slice(last);
  return { code: out, sites: siteCount };
}

module.exports = { instrument };
