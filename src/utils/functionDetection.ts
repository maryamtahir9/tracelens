import { SupportedLanguage } from '../models/TraceTypes';

/** A function TraceLens can call from module scope: a top-level function or a method of a top-level class. */
export interface DetectedFunction {
  /** Qualified name: `fn` or `Class.method`. */
  name: string;
  /** 1-based inclusive range. */
  startLine: number;
  endLine: number;
  /** Raw parameter list text (without parentheses), whitespace-collapsed. */
  params: string;
  className?: string;
  isAsync: boolean;
}

export interface SelectionRange {
  /** 1-based inclusive lines */
  startLine: number;
  endLine: number;
  isEmpty: boolean;
}

export type TargetResolution =
  | { mode: 'function'; fn: DetectedFunction }
  | { mode: 'block'; insideFunction?: DetectedFunction }
  | { mode: 'none' };

/* ------------------------------------------------------------------ Python */

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n++;
    else if (ch === '\t') n += 4;
    else break;
  }
  return n;
}
const isBlankOrComment = (l: string): boolean => /^\s*(#.*)?$/.test(l);

function pythonParams(lines: string[], idx: number): { params: string; headerEnd: number } {
  let text = '';
  let depth = 0;
  let started = false;
  for (let i = idx; i < Math.min(lines.length, idx + 40); i++) {
    const src = lines[i];
    for (let j = 0; j < src.length; j++) {
      const ch = src[j];
      if (!started) {
        if (ch === '(') { started = true; depth = 1; }
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) return { params: text.replace(/\s+/g, ' ').trim(), headerEnd: i };
      }
      text += ch;
    }
    text += ' ';
  }
  return { params: text.replace(/\s+/g, ' ').trim(), headerEnd: idx };
}

export function detectPythonFunctions(lines: string[]): DetectedFunction[] {
  const result: DetectedFunction[] = [];
  const stack: { indent: number; kind: 'class' | 'def'; name: string }[] = [];
  const re = /^(\s*)(async\s+)?(def|class)\s+([A-Za-z_]\w*)/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const indent = indentOf(m[1]);
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const kind = m[3] === 'class' ? 'class' : 'def';
    const name = m[4];
    const parent = stack[stack.length - 1];
    stack.push({ indent, kind, name });
    if (kind !== 'def') continue;
    const topLevel = stack.length === 1;
    const topLevelMethod = stack.length === 2 && parent?.kind === 'class';
    if (!topLevel && !topLevelMethod) continue;
    const { params, headerEnd } = pythonParams(lines, i);
    let end = headerEnd;
    for (let j = headerEnd + 1; j < lines.length; j++) {
      if (isBlankOrComment(lines[j])) continue;
      if (indentOf(lines[j]) <= indent) break;
      end = j;
    }
    result.push({
      name: topLevelMethod ? `${parent.name}.${name}` : name,
      startLine: i + 1, endLine: end + 1, params,
      className: topLevelMethod ? parent.name : undefined, isAsync: Boolean(m[2])
    });
  }
  return result;
}

/* -------------------------------------------------------- JavaScript / TS */

/** Replaces comments and string/template contents with spaces, preserving offsets and newlines. */
export function blankCommentsAndStrings(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
    } else if (ch === '/' && next === '*') {
      const j = src.indexOf('*/', i + 2);
      const stop = j === -1 ? n : j + 2;
      blank(i, stop);
      i = stop;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < n && src[j] !== ch) {
        if (src[j] === '\\') j++;
        else if (ch !== '`' && src[j] === '\n') break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

function matchBracket(clean: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const openCh = clean[open];
  const closeCh = pairs[openCh];
  let depth = 0;
  for (let i = open; i < clean.length; i++) {
    if (clean[i] === openCh) depth++;
    else if (clean[i] === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface JsCandidate {
  name: string;
  start: number;
  paramsOpen: number;
  isAsync: boolean;
  isMethod: boolean;
}

export function detectJsFunctions(source: string): DetectedFunction[] {
  const clean = blankCommentsAndStrings(source);
  const n = clean.length;
  const lineStarts = [0];
  for (let i = 0; i < n; i++) if (clean[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (idx: number): number => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };

  const depthBefore = new Int32Array(n + 1);
  let d = 0;
  for (let i = 0; i < n; i++) {
    depthBefore[i] = d;
    if (clean[i] === '{') d++;
    else if (clean[i] === '}') d = Math.max(0, d - 1);
  }
  depthBefore[n] = d;

  // Class ranges
  const classes: { name: string; open: number; close: number; depth: number }[] = [];
  const classRe = /(?:^|[^\w$.])class\s+([A-Za-z_$][\w$]*)(?:\s*<[^{]*?>)?(?:\s+(?:extends|implements)\s+[^{]+?)?\s*\{/g;
  for (let m = classRe.exec(clean); m; m = classRe.exec(clean)) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(clean, open);
    if (close !== -1) classes.push({ name: m[1], open, close, depth: depthBefore[open] });
  }

  const candidates: JsCandidate[] = [];
  const declRe = /(?:^|[^\w$.])(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(/g;
  for (let m = declRe.exec(clean); m; m = declRe.exec(clean)) {
    if (m[0].includes('*')) continue; // generators are not callable in a meaningful way
    const start = m.index + m[0].search(/(async|function)/);
    candidates.push({ name: m[2], start, paramsOpen: m.index + m[0].length - 1, isAsync: Boolean(m[1]), isMethod: false });
  }
  const varRe = /(?:^|[^\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+?)?=\s*/g;
  for (let m = varRe.exec(clean); m; m = varRe.exec(clean)) {
    let p = m.index + m[0].length;
    const isAsync = /^async\s/.test(clean.slice(p, p + 6));
    if (isAsync) {
      p += 5;
      while (p < n && /\s/.test(clean[p])) p++;
    }
    const rest = clean.slice(p, p + 400);
    let paramsOpen = -1;
    if (/^function\b/.test(rest)) {
      const o = rest.indexOf('(');
      if (o !== -1) paramsOpen = p + o;
    } else if (rest.startsWith('(') || rest.startsWith('<')) {
      const o = rest.indexOf('(');
      if (o !== -1) {
        const c = matchBracket(clean, p + o);
        if (c !== -1 && /^\s*(?::[^=;{]*?)?=>/.test(clean.slice(c + 1, c + 200))) paramsOpen = p + o;
      }
    } else if (/^[A-Za-z_$][\w$]*\s*=>/.test(rest)) {
      paramsOpen = -2 - p; // single identifier parameter
    }
    if (paramsOpen === -1) continue;
    candidates.push({ name: m[1], start: m.index + m[0].search(/(const|let|var)/), paramsOpen, isAsync, isMethod: false });
  }
  const methodRe = /^[ \t]*(?:(?:public|private|protected|static|async|readonly|override)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(/gm;
  const skip = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'constructor', 'super', 'with', 'else', 'do']);
  for (let m = methodRe.exec(clean); m; m = methodRe.exec(clean)) {
    if (skip.has(m[1])) continue;
    candidates.push({
      name: m[1], start: m.index + m[0].search(/\S/), paramsOpen: m.index + m[0].length - 1,
      isAsync: /\basync\b/.test(m[0]), isMethod: true
    });
  }

  const found = new Map<string, DetectedFunction>();
  for (const c of candidates) {
    const depth = depthBefore[c.start];
    let qualified = c.name;
    let className: string | undefined;
    if (c.isMethod) {
      const cls = classes.find((k) => c.start > k.open && c.start < k.close && k.depth === 0 && depth === k.depth + 1);
      if (!cls) continue;
      className = cls.name;
      qualified = `${cls.name}.${c.name}`;
    } else if (depth !== 0) {
      continue;
    }

    let params = '';
    let afterParams: number;
    if (c.paramsOpen <= -2) {
      const p = -(c.paramsOpen + 2);
      const idm = /^[A-Za-z_$][\w$]*/.exec(clean.slice(p));
      params = idm ? idm[0] : '';
      afterParams = p + params.length;
    } else {
      const close = matchBracket(clean, c.paramsOpen);
      if (close === -1) continue;
      params = source.slice(c.paramsOpen + 1, close).replace(/\s+/g, ' ').trim();
      afterParams = close + 1;
    }

    // Find the body.
    const tail = clean.slice(afterParams, afterParams + 2000);
    const arrow = /^\s*(?::[^={;]*?)?=>\s*/.exec(tail);
    let endIdx = -1;
    if (arrow) {
      const bodyStart = afterParams + arrow[0].length;
      if (clean[bodyStart] === '{') {
        endIdx = matchBracket(clean, bodyStart);
      } else {
        let depthP = 0;
        let i = bodyStart;
        for (; i < n; i++) {
          const ch = clean[i];
          if (ch === '(' || ch === '[' || ch === '{') depthP++;
          else if (ch === ')' || ch === ']' || ch === '}') { if (depthP === 0) break; depthP--; }
          else if (depthP === 0 && (ch === ';' || ch === '\n')) break;
        }
        endIdx = i;
      }
    } else {
      const brace = clean.indexOf('{', afterParams);
      if (brace === -1) continue;
      // Reject if a statement terminator appears first (overload signature / declaration only).
      if (/;/.test(clean.slice(afterParams, brace)) && !c.isMethod) continue;
      if (c.isMethod && /;/.test(clean.slice(afterParams, brace))) continue;
      endIdx = matchBracket(clean, brace);
    }
    if (endIdx === -1) continue;
    if (!found.has(`${qualified}@${lineOf(c.start)}`)) {
      found.set(`${qualified}@${lineOf(c.start)}`, {
        name: qualified, startLine: lineOf(c.start), endLine: lineOf(endIdx), params, className, isAsync: c.isAsync
      });
    }
  }
  return [...found.values()].sort((a, b) => a.startLine - b.startLine);
}

/* --------------------------------------------------------------- Public API */

export function detectFunctions(languageId: SupportedLanguage, lines: string[]): DetectedFunction[] {
  if (languageId === 'python') return detectPythonFunctions(lines);
  return detectJsFunctions(lines.join('\n'));
}

/** Callable function containing a 1-based line (undefined if the line is not inside one). */
export function findEnclosingFunction(languageId: SupportedLanguage, lines: string[], line: number): DetectedFunction | undefined {
  const inside = detectFunctions(languageId, lines).filter((f) => f.startLine <= line && line <= f.endLine);
  // Prefer the smallest enclosing range (a method inside a class body, for instance).
  return inside.sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
}

/** Parameters that must be supplied by the user (excludes self/cls). */
export function requiredParamText(languageId: SupportedLanguage, fn: DetectedFunction): string {
  let p = fn.params;
  if (languageId === 'python') {
    p = p.split(',').map((s) => s.trim()).filter((s) => s && s !== 'self' && s !== 'cls' && s !== '*' && s !== '/').join(', ');
  }
  return p;
}

/**
 * Decides what a user selection means:
 *  - a selection that starts on a function header or covers a whole function traces that function,
 *  - an empty selection traces the function around the cursor,
 *  - anything else is run as a block of code in the module's scope.
 */
export function resolveTarget(languageId: SupportedLanguage, lines: string[], sel: SelectionRange): TargetResolution {
  const fns = detectFunctions(languageId, lines);
  if (sel.isEmpty) {
    const fn = findEnclosingFunction(languageId, lines, sel.startLine);
    return fn ? { mode: 'function', fn } : { mode: 'none' };
  }
  const header = fns.find((f) => f.startLine >= sel.startLine && f.startLine <= sel.endLine && (f.startLine === sel.startLine || f.endLine <= sel.endLine));
  if (header) return { mode: 'function', fn: header };
  const inside = fns.find((f) => f.startLine <= sel.startLine && sel.endLine <= f.endLine);
  return { mode: 'block', insideFunction: inside };
}
