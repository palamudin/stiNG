// Tuning as data (GDD 13, T1-22). The tuning tables live in a versioned plain-text file, tuning/sting.tune, read by
// this parser here and by its port in the C# core (Tune.cs). Own code only: no JSON, INI or TOML library.
//
// Format, one item per line:
//   # comment                      (anywhere outside a string)
//   [section.sub]                  keys below are relative to this path; [] goes back to the top
//   key = value                    value: a number, true, false, "a string", or a [list, of, values] (lists nest)
// Numbers are written the way JS prints them (shortest round-trip), so both languages read back the same doubles.
// A path segment that is a number indexes an array of tables (alloc.0, alloc.1, ...).

// ---------------------------------------------------------------- reading

function parseValue(s, at) {
  let i = 0;
  const ws = () => { while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++; };
  const fail = (why) => { throw new Error(`tuning ${at}: ${why}`); };
  const value = () => {
    ws();
    if (s[i] === '[') {
      i++; const out = []; ws();
      if (s[i] === ']') { i++; return out; }
      for (;;) {
        out.push(value()); ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; return out; }
        fail('expected , or ]');
      }
    }
    if (s[i] === '"') {
      const j = s.indexOf('"', i + 1);
      if (j < 0) fail('unterminated string');
      const str = s.slice(i + 1, j); i = j + 1; return str;
    }
    let j = i;
    while (j < s.length && /[A-Za-z0-9+\-.]/.test(s[j])) j++;
    const tok = s.slice(i, j); i = j;
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(tok)) fail(`not a value: "${tok}"`);
    return Number(tok);
  };
  const v = value(); ws();
  if (i !== s.length) fail('trailing text');
  return v;
}

// text -> [[path, value], ...] in file order
export function parseTuning(text) {
  const out = [];
  let section = '';
  text.replace(/\r/g, '').split('\n').forEach((raw, n) => {
    const at = `line ${n + 1}`;
    // strip a comment that is not inside a string
    let line = '', inStr = false;
    for (const ch of raw) { if (ch === '"') inStr = !inStr; if (ch === '#' && !inStr) break; line += ch; }
    line = line.trim();
    if (!line) return;
    if (line[0] === '[' && line[line.length - 1] === ']' && !line.includes('=')) { section = line.slice(1, -1).trim(); return; }
    const eq = line.indexOf('=');
    if (eq < 0) throw new Error(`tuning ${at}: expected key = value`);
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z0-9_]+$/.test(key)) throw new Error(`tuning ${at}: bad key "${key}"`);
    out.push([section ? section + '.' + key : key, parseValue(line.slice(eq + 1).trim(), at)]);
  });
  return out;
}

// ---------------------------------------------------------------- the leaves of a tuning object

const isLeafList = (a) => Array.isArray(a) && a.every((x) => typeof x !== 'object' || Array.isArray(x));
// [[path, value], ...] for every tunable value of T, in declaration order
export function tuningLeaves(T) {
  const out = [];
  const walk = (o, p) => {
    if (isLeafList(o) || o === null || typeof o !== 'object') { out.push([p, o]); return; }
    if (Array.isArray(o)) { o.forEach((x, i) => walk(x, p + '.' + i)); return; }
    for (const k of Object.keys(o)) walk(o[k], p ? p + '.' + k : k);
  };
  walk(T, '');
  return out;
}

// The tuning the sim runs with: the hash of the applied file, carried by saves and by the peers' rules hash
export const TUNE = { hash: 'built-in' };
// Keys the world format fixes: the chunk grid is baked into every world and captured when the modules load
const FIXED = new Set(['chunk.size']);

// Apply a tuning file to T in place. Every value must land on an existing key of the same kind; returns the keys of
// the file that T has no place for, and the keys of T the file does not set, so callers can insist on an exact match.
export function applyTuning(T, text) {
  const unknown = [], set = new Set();
  const kind = (v) => (Array.isArray(v) ? 'list' : typeof v);
  for (const [path, v] of parseTuning(text)) {
    if (path === 'version') continue;
    const segs = path.split('.');
    let o = T;
    for (let i = 0; i < segs.length - 1 && o !== undefined; i++) o = o[segs[i]];
    const last = segs[segs.length - 1];
    if (o === undefined || o === null || typeof o !== 'object' || !(last in o) || kind(o[last]) !== kind(v)) { unknown.push(path); continue; }
    if (FIXED.has(path) && o[last] !== v) throw new Error(`tuning ${path}: fixed by the world format (${o[last]})`);
    o[last] = v;
    set.add(path);
  }
  const missing = tuningLeaves(T).map(([p]) => p).filter((p) => !set.has(p));
  TUNE.hash = tuningHash(text);
  return { unknown, missing };
}

// ---------------------------------------------------------------- writing (to make the first file, and to check it)

const fmt = (v) => (Array.isArray(v) ? '[' + v.map(fmt).join(', ') + ']' : typeof v === 'string' ? '"' + v + '"' : String(v));
export function writeTuning(T, header = '') {
  const lines = header ? header.split('\n').map((l) => (l ? '# ' + l : '#')) : [];
  lines.push('version = 1', '');
  const sec = (o, p) => {
    const scalars = [], subs = [];
    if (Array.isArray(o)) o.forEach((x, i) => subs.push([String(i), x]));
    else for (const k of Object.keys(o)) (isLeafList(o[k]) || o[k] === null || typeof o[k] !== 'object' ? scalars : subs).push([k, o[k]]);
    if (scalars.length) { if (p) lines.push(`[${p}]`); else lines.push('[]'); for (const [k, v] of scalars) lines.push(`${k} = ${fmt(v)}`); lines.push(''); }
    for (const [k, v] of subs) sec(v, p ? p + '.' + k : k);
  };
  sec(T, '');
  return lines.join('\n');
}

// FNV-1a over the UTF-8 bytes of the file with carriage returns dropped: the same number in JS and C#
export function tuningHash(text) {
  const bytes = new TextEncoder().encode(text.replace(/\r/g, ''));
  let h = 0x811c9dc5;
  for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
