'use strict';
/**
 * TraceLens Node runner (JavaScript and TypeScript).
 *
 * Loads the target module through a require hook that instruments user code (see instrument.js),
 * runs the requested function / block / file and writes one JSON event per line to cfg.outFile.
 * Timings come from performance.now(); errors are the errors the program actually threw.
 */
const fs = require('fs');
const path = require('path');
const util = require('util');
const Module = require('module');
const { performance } = require('perf_hooks');
const { AsyncLocalStorage } = require('async_hooks');
const { instrument } = require('./instrument');
const { createMapper } = require('./sourcemap');

const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const outFd = fs.openSync(cfg.outFile, 'w');
const T0 = performance.now();
const now = () => performance.now() - T0;
const emit = (o) => fs.writeSync(outFd, JSON.stringify(o) + '\n');

const ENTRY = path.resolve(cfg.file);
const ROOT = path.resolve(cfg.workspaceRoot || path.dirname(ENTRY));
const als = new AsyncLocalStorage();
const sites = [];
const maps = Object.create(null);
const reported = new WeakSet();
const SKIP = { skip: true };
let nextId = 0;
let truncated = false;
let tsModule;
let projectOptionsCache = Object.create(null);

function short(v, limit = 160) {
  let text;
  try {
    if (v && typeof v.then === 'function') text = 'Promise';
    else if (v && v.constructor && v.constructor.name === 'Timeout') text = 'Timeout';
    else if (typeof v === 'function') text = `[Function ${v.name || 'anonymous'}]`;
    else text = util.inspect(v, { depth: 1, breakLength: Infinity, maxArrayLength: 5, maxStringLength: 120, compact: true });
  } catch (_e) {
    text = '<unrepresentable>';
  }
  text = text.replace(/\n/g, ' ');
  return text.length <= limit ? text : text.slice(0, limit - 1) + '\u2026';
}

function isUserFile(file) {
  if (!path.isAbsolute(file)) return false;
  const norm = path.normalize(file);
  if (norm.split(path.sep).includes('node_modules')) return false;
  return norm === ENTRY || norm.startsWith(ROOT + path.sep);
}

/** Finds the first stack frame inside user code and maps it back through source maps. */
function locate(err) {
  const stack = err && typeof err.stack === 'string' ? err.stack : '';
  for (const line of stack.split('\n')) {
    const m = /\bat (?:.+? \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!m) continue;
    let file = m[1];
    if (file.startsWith('file://')) file = file.slice(7);
    if (!isUserFile(file)) continue;
    let ln = Number(m[2]);
    let col = Number(m[3]);
    const mapper = maps[path.normalize(file)];
    if (mapper) {
      const o = mapper(ln, col - 1);
      if (o) { ln = o.line; col = o.column + 1; }
    }
    return { file, line: ln, col };
  }
  return null;
}

function errorFields(err) {
  const isObj = err !== null && (typeof err === 'object' || typeof err === 'function');
  const type = isObj && err.constructor && err.constructor.name ? (err.name && err.name !== 'Error' ? err.name : err.constructor.name) : 'thrown value';
  const message = isObj && 'message' in err ? String(err.message) : short(err, 400);
  return { type: type || 'Error', message, loc: locate(err), isObj };
}

/* ------------------------------------------------------------- hook runtime */

const TL = {
  A: Boolean(cfg.captureArgs),
  enabled: false,
  begin(siteId, args, sync) {
    if (!TL.enabled) return SKIP;
    if (nextId >= cfg.maxEvents) { truncated = true; return SKIP; }
    const site = sites[siteId];
    const id = ++nextId;
    const prev = als.getStore();
    emit({
      t: 'call', id, parent: prev || 0, name: site.name, file: site.file, line: site.line, col: site.col,
      endLine: site.endLine, ts: now(), args: args ? args.map((a) => [a[0], short(a[1])]) : undefined
    });
    const tok = { id, site, sync, prev, failed: false, value: undefined };
    if (sync) als.enterWith(id);
    return tok;
  },
  enter(siteId, args) { return TL.begin(siteId, args, true); },
  enterA(siteId, args) { return TL.begin(siteId, args, false); },
  run(tok, thunk) { return tok.skip ? thunk() : als.run(tok.id, thunk); },
  ret(tok, value) {
    if (!tok.skip && cfg.captureReturn) tok.value = short(value);
    return value;
  },
  fail(tok, err) {
    if (tok.skip) return;
    tok.failed = true;
    const f = errorFields(err);
    let origin = true;
    if (f.isObj) { origin = !reported.has(err); reported.add(err); }
    emit({
      t: 'err', id: tok.id, ts: now(), type: f.type, message: f.message, origin,
      file: f.loc ? f.loc.file : tok.site.file, line: f.loc ? f.loc.line : tok.site.line, col: f.loc ? f.loc.col : undefined
    });
  },
  leave(tok) {
    if (tok.skip) return;
    if (tok.sync) als.enterWith(tok.prev);
    if (tok.failed) return;
    emit({ t: 'ret', id: tok.id, ts: now(), endLine: tok.site.endLine, value: tok.value });
  }
};
globalThis.__TL = TL;

/* ----------------------------------------------------- TypeScript transpile */

function loadTs() {
  if (tsModule) return tsModule;
  if (!cfg.tsPath) throw new Error("The 'typescript' package was not found for this project.");
  tsModule = require(cfg.tsPath);
  return tsModule;
}

function projectOptions(ts, dir) {
  if (projectOptionsCache[dir]) return projectOptionsCache[dir];
  let options = {};
  try {
    const cfgPath = ts.findConfigFile(dir, ts.sys.fileExists, 'tsconfig.json');
    if (cfgPath) {
      const read = ts.readConfigFile(cfgPath, ts.sys.readFile);
      if (!read.error) options = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(cfgPath)).options;
    }
  } catch (_e) { options = {}; }
  projectOptionsCache[dir] = options;
  return options;
}

function transpile(source, filename) {
  const ts = loadTs();
  const base = projectOptions(ts, path.dirname(filename));
  const compilerOptions = Object.assign({}, base, {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, sourceMap: true, inlineSourceMap: false,
    inlineSources: false, declaration: false, composite: false, incremental: false, noEmit: false, esModuleInterop: true
  });
  delete compilerOptions.outDir; delete compilerOptions.rootDir; delete compilerOptions.tsBuildInfoFile;
  const res = ts.transpileModule(source, { compilerOptions, fileName: filename, reportDiagnostics: false });
  if (res.sourceMapText) maps[path.normalize(filename)] = createMapper(res.sourceMapText);
  return res.outputText.replace(/\n\/\/# sourceMappingURL=.*$/m, '');
}

/* ---------------------------------------------------------- require hooks */

const RESOLVER = '\n;globalThis.__TL_RESOLVE__=function(__src){return eval(__src)};';
const origCompile = Module.prototype._compile;
Module.prototype._compile = function compile(content, filename) {
  const norm = path.normalize(filename);
  if (isUserFile(norm) && /\.(js|cjs|ts)$/.test(norm)) {
    try {
      content = instrument(content, {
        file: norm, mapPosition: maps[norm],
        registerSite: (s) => { sites.push(s); return sites.length - 1; }
      }).code;
    } catch (e) {
      emit({ t: 'warn', message: `Could not instrument ${path.basename(norm)} (${e.message}); calls inside it are not traced.` });
    }
  }
  if (norm === ENTRY) content += RESOLVER;
  return origCompile.call(this, content, filename);
};
require.extensions['.ts'] = function tsLoader(module, filename) {
  module._compile(transpile(fs.readFileSync(filename, 'utf8'), filename), filename);
};

/* -------------------------------------------------------------- execution */

function resolveTarget(resolve, dotted) {
  const parts = dotted.split('.');
  let base;
  try { base = resolve(parts[0]); } catch (_e) { base = undefined; }
  if (base === undefined) throw new ReferenceError(`TraceLens could not find '${parts[0]}' in ${path.basename(ENTRY)}`);
  if (parts.length === 1) {
    if (typeof base !== 'function') throw new TypeError(`'${parts[0]}' is not a function`);
    return { fn: base, thisArg: undefined };
  }
  if (typeof base[parts[1]] === 'function') return { fn: base[parts[1]], thisArg: base };
  const proto = base.prototype && base.prototype[parts[1]];
  if (typeof proto === 'function') {
    let instance;
    try { instance = new base(); } catch (e) {
      throw new Error(`Cannot construct ${parts[0]} without arguments to call ${parts[1]}: ${e.message}`);
    }
    return { fn: proto, thisArg: instance };
  }
  throw new ReferenceError(`TraceLens could not find '${dotted}' in ${path.basename(ENTRY)}`);
}

async function withRoot(fn) {
  sites.push({ name: cfg.label, file: ENTRY, line: cfg.startLine, col: 1, endLine: cfg.endLine, isAsync: true });
  const tok = TL.enterA(sites.length - 1, null);
  try {
    return await TL.run(tok, fn);
  } catch (e) {
    TL.fail(tok, e);
    throw e;
  } finally {
    TL.leave(tok);
  }
}

let status = 'success';
let errorInfo;
let finished = false;

function recordError(e) {
  status = 'error';
  const f = errorFields(e);
  let message = f.message;
  if (/Cannot use import statement|Unexpected token 'export'|require\(\) of ES Module/.test(message)) {
    message += ' (TraceLens traces CommonJS JavaScript and TypeScript; ES module JavaScript files are not supported yet.)';
  }
  errorInfo = {
    type: f.type, message, filePath: f.loc ? f.loc.file : undefined, line: f.loc ? f.loc.line : undefined,
    column: f.loc ? f.loc.col : undefined, stack: f.isObj && typeof e.stack === 'string' ? e.stack.split('\n').slice(0, 8).join('\n') : undefined
  };
}

function finish() {
  if (finished) return;
  finished = true;
  const end = { t: 'end', ts: now(), status, truncated };
  if (errorInfo) end.error = errorInfo;
  emit(end);
  fs.closeSync(outFd);
}

process.on('exit', finish);
process.on('uncaughtException', (e) => {
  if (!errorInfo) recordError(e);
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  if (!errorInfo) recordError(e);
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});

async function main() {
  emit({ t: 'begin', ts: now() });
  try {
    if (/\.mjs$/.test(ENTRY)) throw new Error('ES module (.mjs) files are not supported yet. TraceLens traces CommonJS JavaScript and TypeScript.');
    if (cfg.mode === 'file') {
      TL.enabled = true;
      await withRoot(async () => { require(ENTRY); });
    } else {
      TL.enabled = false;
      require(ENTRY);
      const resolve = globalThis.__TL_RESOLVE__;
      if (typeof resolve !== 'function') throw new Error('The file did not load as a CommonJS module.');
      TL.enabled = true;
      if (cfg.mode === 'block') {
        await withRoot(async () => {
          const r = resolve(cfg.selectionText);
          if (r && typeof r.then === 'function') await r;
        });
      } else {
        const { fn, thisArg } = resolveTarget(resolve, cfg.functionName);
        const args = cfg.argsJson ? JSON.parse(cfg.argsJson) : [];
        await fn.apply(thisArg, Array.isArray(args) ? args : [args]);
      }
    }
  } catch (e) {
    console.error(e && e.stack ? e.stack : String(e));
    recordError(e);
  }
  if (status === 'error') process.exitCode = 1;
}

main();
