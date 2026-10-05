'use strict';
/**
 * Minimal source-map (v3) decoder: maps a position in generated code back to the original source.
 * Used so that traces of TypeScript files point at the .ts lines, not at transpiled JavaScript.
 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = Object.create(null);
for (let i = 0; i < B64.length; i++) B64_INDEX[B64[i]] = i;

function decodeVlqLine(segment) {
  const values = [];
  let shift = 0;
  let value = 0;
  for (let i = 0; i < segment.length; i++) {
    const digit = B64_INDEX[segment[i]];
    if (digit === undefined) throw new Error('Invalid VLQ character: ' + segment[i]);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
    } else {
      values.push(value & 1 ? -(value >> 1) : value >> 1);
      value = 0;
      shift = 0;
    }
  }
  return values;
}

/** @returns {(line:number, column:number) => ({line:number, column:number}|null)}  (line 1-based, column 0-based in; same out) */
function createMapper(mapJson) {
  const map = typeof mapJson === 'string' ? JSON.parse(mapJson) : mapJson;
  const lines = [];
  let srcIdx = 0, origLine = 0, origCol = 0;
  for (const lineText of String(map.mappings || '').split(';')) {
    const segs = [];
    let genCol = 0;
    if (lineText) {
      for (const seg of lineText.split(',')) {
        const v = decodeVlqLine(seg);
        genCol += v[0];
        if (v.length >= 4) {
          srcIdx += v[1]; origLine += v[2]; origCol += v[3];
          segs.push({ genCol, srcIdx, origLine, origCol });
        }
      }
    }
    lines.push(segs);
  }
  return function map1(line, column) {
    const segs = lines[line - 1];
    if (!segs || !segs.length) return null;
    let best = segs[0];
    for (const s of segs) {
      if (s.genCol <= column) best = s; else break;
    }
    return { line: best.origLine + 1, column: best.origCol };
  };
}

module.exports = { createMapper, decodeVlqLine };
