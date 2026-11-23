/*!
 * jsonyaml v1.0.0 — zero-dependency JSON → YAML converter with
 * JSON Schema inference and validation. Works in Node.js and browsers.
 * MIT License.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JsonYaml = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '1.0.0';
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  /* ======================================================================
   * Errors & diagnostics
   * ==================================================================== */

  class JSONParseError extends Error {
    constructor(reason, pos, line, column) {
      super(`${reason} (line ${line}, column ${column})`);
      this.name = 'JSONParseError';
      this.reason = reason;
      this.pos = pos;
      this.line = line;
      this.column = column;
    }
  }

  class SchemaError extends Error {
    constructor(message) {
      super(message);
      this.name = 'SchemaError';
    }
  }

  function locate(text, pos) {
    let line = 1, lineStart = 0;
    const end = Math.min(pos, text.length);
    for (let k = 0; k < end; k++) {
      if (text.charCodeAt(k) === 10) { line++; lineStart = k + 1; }
    }
    return { line, column: pos - lineStart + 1 };
  }

  /** Render a code frame pointing at line/column (1-based). */
  function codeFrame(text, line, column, context = 2) {
    const lines = String(text).split('\n').map((l) => l.replace(/\r$/, ''));
    const from = Math.max(1, line - context);
    const to = Math.min(lines.length, line + context);
    const width = String(to).length;
    const out = [];
    for (let ln = from; ln <= to; ln++) {
      const src = lines[ln - 1] ?? '';
      const mark = ln === line ? '>' : ' ';
      out.push(`${mark} ${String(ln).padStart(width)} | ${src}`);
      if (ln === line) {
        const lead = src.slice(0, Math.max(0, column - 1)).replace(/[^\t]/g, ' ');
        out.push(`  ${' '.repeat(width)} | ${lead}^`);
      }
    }
    return out.join('\n');
  }

  /* ======================================================================
   * JSON parser → ordered AST
   *   { t: 'obj', entries: [{ key, value }] }
   *   { t: 'arr', items: [] }
   *   { t: 'str', v } | { t: 'num', raw, v } | { t: 'bool', v } | { t: 'null' }
   * Key order is preserved exactly (including integer-like keys) and
   * numbers keep their original text so no precision is lost.
   * ==================================================================== */

  const DEFAULT_PARSE_OPTIONS = {
    allowComments: false,      // permit // and /* */ comments
    allowTrailingCommas: false, // permit [1,2,] and {"a":1,}
    duplicateKeys: 'last',      // 'last' (like JSON.parse) | 'error'
    maxDepth: 1000,
  };

  function createParser(text, options) {
    const o = Object.assign({}, DEFAULT_PARSE_OPTIONS, options);
    text = String(text);
    const n = text.length;
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

    const fail = (reason, pos = i) => {
      const { line, column } = locate(text, pos);
      throw new JSONParseError(reason, pos, line, column);
    };
    const show = (p = i) => {
      if (p >= n) return 'end of input';
      const cp = text.codePointAt(p);
      const ch = String.fromCodePoint(cp);
      return cp < 0x20 ? `control character U+${cp.toString(16).toUpperCase().padStart(4, '0')}` : `'${ch}'`;
    };
    const isDigit = (c) => c >= 48 && c <= 57;

    function ws() {
      for (;;) {
        const c = text.charCodeAt(i);
        if (c === 32 || c === 9 || c === 10 || c === 13) { i++; continue; }
        if (c === 47 /* / */ && o.allowComments) {
          const d = text.charCodeAt(i + 1);
          if (d === 47) { i += 2; while (i < n && text.charCodeAt(i) !== 10) i++; continue; }
          if (d === 42) {
            const e = text.indexOf('*/', i + 2);
            if (e < 0) fail('Unterminated block comment');
            i = e + 2; continue;
          }
        }
        return;
      }
    }

    function value(depth) {
      if (depth > o.maxDepth) fail(`Maximum nesting depth (${o.maxDepth}) exceeded`);
      ws();
      const start = i;
      const node = valueAt(depth);
      node.pos = start; // source offset, used to map validation errors back to the text
      return node;
    }

    function valueAt(depth) {
      const c = text[i];
      switch (c) {
        case '{': return object(depth);
        case '[': return array(depth);
        case '"': return { t: 'str', v: string() };
        case 't': return literal('true', { t: 'bool', v: true });
        case 'f': return literal('false', { t: 'bool', v: false });
        case 'n': return literal('null', { t: 'null' });
        default:
          if (c === '-' || isDigit(text.charCodeAt(i))) return number();
          if (c === undefined) fail('Unexpected end of input, expected a value');
          if (c === "'") fail('Strings must use double quotes');
          if (/[A-Za-z_$]/.test(c)) {
            const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(i, i + 40));
            const w = m ? m[0] : c;
            if (/^(NaN|Infinity|undefined)$/.test(w)) fail(`'${w}' is not valid JSON`);
            fail(`Unexpected token '${w}', expected a value`);
          }
          fail(`Unexpected ${show()}, expected a value`);
      }
    }

    function literal(word, node) {
      if (text.startsWith(word, i)) {
        const after = text.charCodeAt(i + word.length);
        if (!(after >= 65 && after <= 90) && !(after >= 97 && after <= 122) && !isDigit(after) && after !== 95) {
          i += word.length;
          return node;
        }
      }
      const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(i, i + 40));
      fail(`Unexpected token '${m ? m[0] : text[i]}', expected a value`);
    }

    function number() {
      const start = i;
      if (text[i] === '-') i++;
      if (text[i] === '0') {
        i++;
        if (isDigit(text.charCodeAt(i))) fail('Numbers cannot have leading zeros', start);
      } else if (isDigit(text.charCodeAt(i))) {
        while (isDigit(text.charCodeAt(i))) i++;
      } else {
        fail(text[i] === 'I' ? "'-Infinity' is not valid JSON" : `Invalid number: expected a digit after '-'`);
      }
      if (text[i] === '.') {
        i++;
        if (!isDigit(text.charCodeAt(i))) fail('Invalid number: expected a digit after the decimal point');
        while (isDigit(text.charCodeAt(i))) i++;
      }
      if (text[i] === 'e' || text[i] === 'E') {
        i++;
        if (text[i] === '+' || text[i] === '-') i++;
        if (!isDigit(text.charCodeAt(i))) fail('Invalid number: expected a digit in the exponent');
        while (isDigit(text.charCodeAt(i))) i++;
      }
      const raw = text.slice(start, i);
      return { t: 'num', raw, v: Number(raw) };
    }

    function string() {
      const start = i;
      i++; // opening quote
      let out = '';
      let chunk = i;
      for (;;) {
        if (i >= n) fail('Unterminated string', start);
        const c = text.charCodeAt(i);
        if (c === 34) { out += text.slice(chunk, i); i++; return out; }
        if (c === 92) {
          out += text.slice(chunk, i);
          const e = text[i + 1];
          switch (e) {
            case '"': out += '"'; break;
            case '\\': out += '\\'; break;
            case '/': out += '/'; break;
            case 'b': out += '\b'; break;
            case 'f': out += '\f'; break;
            case 'n': out += '\n'; break;
            case 'r': out += '\r'; break;
            case 't': out += '\t'; break;
            case 'u': {
              const h = text.slice(i + 2, i + 6);
              if (!/^[0-9a-fA-F]{4}$/.test(h)) fail('Invalid unicode escape: expected \\u followed by 4 hex digits');
              out += String.fromCharCode(parseInt(h, 16));
              i += 4;
              break;
            }
            default:
              if (e === undefined) fail('Unterminated string', start);
              fail(`Invalid escape sequence '\\${e}'`);
          }
          i += 2;
          chunk = i;
          continue;
        }
        if (c < 0x20) fail(c === 10 ? 'Unescaped line break in string (use \\n)' : `Unescaped ${show()} in string`);
        i++;
      }
    }

    function object(depth) {
      const open = i;
      i++;
      const entries = [];
      const index = new Map();
      ws();
      if (text[i] === '}') { i++; return { t: 'obj', entries }; }
      for (;;) {
        ws();
        if (text[i] !== '"') {
          if (text[i] === '}' && entries.length && o.allowTrailingCommas) { i++; return { t: 'obj', entries }; }
          if (i >= n) fail("Unterminated object, expected '}'", open);
          if (text[i] === '}') fail('Trailing comma is not allowed in JSON');
          if (text[i] === "'") fail('Property names must use double quotes');
          fail(`Expected a property name in double quotes, got ${show()}`);
        }
        const keyPos = i;
        const key = string();
        ws();
        if (text[i] !== ':') fail(`Expected ':' after property name, got ${show()}`);
        i++;
        const val = value(depth + 1);
        if (index.has(key)) {
          if (o.duplicateKeys === 'error') fail(`Duplicate key "${key}"`, keyPos);
          entries[index.get(key)].value = val; // last wins, first position kept (JSON.parse semantics)
        } else {
          index.set(key, entries.length);
          entries.push({ key, value: val, keyPos });
        }
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return { t: 'obj', entries }; }
        if (i >= n) fail("Unterminated object, expected '}'", open);
        fail(`Expected ',' or '}' after property value, got ${show()}`);
      }
    }

    function array(depth) {
      const open = i;
      i++;
      const items = [];
      ws();
      if (text[i] === ']') { i++; return { t: 'arr', items }; }
      for (;;) {
        ws();
        if (text[i] === ']' && items.length) {
          if (o.allowTrailingCommas) { i++; return { t: 'arr', items }; }
          fail('Trailing comma is not allowed in JSON');
        }
        if (text[i] === ',') fail('Unexpected comma, expected a value');
        items.push(value(depth + 1));
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return { t: 'arr', items }; }
        if (i >= n) fail("Unterminated array, expected ']'", open);
        fail(`Expected ',' or ']' after array element, got ${show()}`);
      }
    }

    return {
      one() {
        ws();
        if (i >= n) fail('Empty input, expected a JSON value');
        const v = value(0);
        ws();
        if (i < n) fail(`Unexpected ${show()} after the end of the JSON value`);
        return v;
      },
      many() {
        const docs = [];
        ws();
        while (i < n) {
          docs.push(value(0));
          ws();
          if (text[i] === ',') fail('Unexpected comma between documents');
        }
        return docs;
      },
    };
  }

  /** Parse one JSON document into an ordered AST. */
  function parse(text, options) {
    return createParser(text, options).one();
  }

  /** Parse JSON Lines / NDJSON / concatenated JSON into an array of ASTs. */
  function parseMulti(text, options) {
    return createParser(text, options).many();
  }

  /* ======================================================================
   * AST ⇄ plain JavaScript
   * ==================================================================== */

  function fromJS(value) {
    const seen = new Set();
    const skip = (x) => x === undefined || typeof x === 'function' || typeof x === 'symbol';
    function conv(v) {
      if (v === null || v === undefined) return { t: 'null' };
      switch (typeof v) {
        case 'boolean': return { t: 'bool', v };
        case 'string': return { t: 'str', v };
        case 'bigint': return { t: 'num', raw: v.toString(), v: Number(v) };
        case 'number':
          if (Number.isNaN(v)) return { t: 'num', raw: '.nan', v };
          if (!Number.isFinite(v)) return { t: 'num', raw: v > 0 ? '.inf' : '-.inf', v };
          return { t: 'num', raw: Object.is(v, -0) ? '-0' : String(v), v };
        case 'object': break;
        default: return { t: 'null' };
      }
      if (seen.has(v)) throw new TypeError('Cannot convert a circular structure to YAML');
      if (typeof v.toJSON === 'function') return conv(v.toJSON());
      seen.add(v);
      let node;
      if (Array.isArray(v)) {
        node = { t: 'arr', items: v.map((x) => (skip(x) ? { t: 'null' } : conv(x))) };
      } else if (v instanceof Map) {
        node = { t: 'obj', entries: [] };
        for (const [k, x] of v) if (!skip(x)) node.entries.push({ key: String(k), value: conv(x) });
      } else {
        node = { t: 'obj', entries: [] };
        for (const k of Object.keys(v)) if (!skip(v[k])) node.entries.push({ key: k, value: conv(v[k]) });
      }
      seen.delete(v);
      return node;
    }
    return conv(value);
  }

  function toJS(node) {
    switch (node.t) {
      case 'null': return null;
      case 'bool': case 'str': case 'num': return node.v;
      case 'arr': return node.items.map(toJS);
      case 'obj': {
        const out = {};
        for (const e of node.entries) {
          Object.defineProperty(out, e.key, { value: toJS(e.value), enumerable: true, writable: true, configurable: true });
        }
        return out;
      }
      default: throw new TypeError(`Unknown node type: ${node && node.t}`);
    }
  }

  /** Serialize an AST back to JSON text (preserving key order and number text). */
  function toJSON(node, indent = 2) {
    const pad = typeof indent === 'number' ? ' '.repeat(indent) : String(indent || '');
    function s(n, cur) {
      switch (n.t) {
        case 'null': return 'null';
        case 'bool': return n.v ? 'true' : 'false';
        case 'num': return /^[.+-]?\.?(inf|nan)$/i.test(n.raw) ? 'null' : n.raw;
        case 'str': return JSON.stringify(n.v);
        case 'arr': {
          if (!n.items.length) return '[]';
          if (!pad) return '[' + n.items.map((x) => s(x, '')).join(',') + ']';
          const inner = cur + pad;
          return '[\n' + n.items.map((x) => inner + s(x, inner)).join(',\n') + '\n' + cur + ']';
        }
        case 'obj': {
          if (!n.entries.length) return '{}';
          if (!pad) return '{' + n.entries.map((e) => JSON.stringify(e.key) + ':' + s(e.value, '')).join(',') + '}';
          const inner = cur + pad;
          return '{\n' + n.entries.map((e) => inner + JSON.stringify(e.key) + ': ' + s(e.value, inner)).join(',\n') + '\n' + cur + '}';
        }
      }
    }
    return s(node, '');
  }

  /* ======================================================================
   * YAML emitter (YAML 1.2, safe for YAML 1.1 parsers too)
   * ==================================================================== */

  const DEFAULT_YAML_OPTIONS = {
    indent: 2,               // spaces per level (1–8)
    indentSequences: true,   // "key:\n  - a" (true) vs "key:\n- a" (false)
    sortKeys: false,         // sort mapping keys alphabetically
    flowLevel: -1,           // nesting depth at which to switch to {flow: [style]}; -1 = never
    quoteStyle: 'single',    // 'single' | 'double' for strings that need quoting
    blockScalars: true,      // emit multi-line strings as | literal blocks
    documentStart: false,    // prefix the document with ---
  };

  // Characters a single-quoted (or plain) scalar cannot carry: must be escaped in double quotes.
  const NEEDS_ESCAPE = /[\x00-\x08\x0A-\x1F\x7F-\x9F\u2028\u2029\uFEFF\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  // Strings a YAML 1.1 or 1.2 parser would resolve to a non-string type.
  const RESERVED_WORD = /^(?:~|null|true|false|y|yes|n|no|on|off)$/i;
  const NON_STRING_PATTERNS = [
    /^[-+]?(?:\.[0-9_]+|[0-9][0-9_]*(?:\.[0-9_]*)?)(?:[eE][-+]?[0-9]+)?$/, // ints & floats
    /^[-+]?(?:[0-9][0-9_]*)?\.[0-9._]*(?:[eE][-+][0-9]+)?$/,              // YAML 1.1 floats: ".", "1.2.3"
    /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,              // exponent forms: "E9", ".e5"
    /^[-+]?\.(?:inf|nan)$/i,                                              // .inf .nan
    /^[-+]?0[xX][0-9a-fA-F_]+$/,                                          // hex
    /^[-+]?0[oO][0-7_]+$/,                                                // octal
    /^[-+]?0[bB][01_]+$/,                                                 // binary
    /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?$/,                 // sexagesimal (1.1)
    /^\d{4}-\d\d?-\d\d?(?:$|[Tt ])/,                                      // timestamps
  ];

  function looksLikeNonString(s) {
    if (RESERVED_WORD.test(s) || s === '<<' || s === '=') return true;
    for (const re of NON_STRING_PATTERNS) if (re.test(s)) return true;
    return false;
  }

  function isPlainSafe(s, flow) {
    if (s === '') return false;
    if (/^\s|\s$/.test(s)) return false;
    if (s.includes('\t')) return false;
    if (NEEDS_ESCAPE.test(s)) return false;
    const c = s[0];
    if ('[]{},#&*!|>\'"%@`:?'.includes(c)) return false;
    if (c === '-' && (s.length === 1 || s[1] === ' ' || (flow && ',[]{}'.includes(s[1])))) return false;
    if (s.startsWith('---') || s.startsWith('...')) return false;
    if (s.includes(': ') || s.includes(' #') || s.endsWith(':')) return false;
    if (flow && /[,[\]{}]/.test(s)) return false;
    if (looksLikeNonString(s)) return false;
    return true;
  }

  function doubleQuote(s) {
    let out = '"';
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      switch (cp) {
        case 0x22: out += '\\"'; continue;
        case 0x5c: out += '\\\\'; continue;
        case 0x00: out += '\\0'; continue;
        case 0x07: out += '\\a'; continue;
        case 0x08: out += '\\b'; continue;
        case 0x09: out += '\\t'; continue;
        case 0x0a: out += '\\n'; continue;
        case 0x0b: out += '\\v'; continue;
        case 0x0c: out += '\\f'; continue;
        case 0x0d: out += '\\r'; continue;
        case 0x1b: out += '\\e'; continue;
        case 0x85: out += '\\N'; continue;
        case 0x2028: out += '\\L'; continue;
        case 0x2029: out += '\\P'; continue;
      }
      if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) out += '\\x' + cp.toString(16).toUpperCase().padStart(2, '0');
      else if (cp === 0xfeff || cp === 0xfffe || cp === 0xffff || (cp >= 0xd800 && cp <= 0xdfff)) out += '\\u' + cp.toString(16).toUpperCase().padStart(4, '0');
      else out += ch;
    }
    return out + '"';
  }

  const singleQuote = (s) => "'" + s.replace(/'/g, "''") + "'";

  function scalarString(s, o, flow) {
    if (NEEDS_ESCAPE.test(s)) return doubleQuote(s);
    if (isPlainSafe(s, flow)) return s;
    return o.quoteStyle === 'double' ? doubleQuote(s) : singleQuote(s);
  }

  // Literal block scalar (|, |-, |+) for multi-line strings, or null if not representable safely.
  function literalBlock(s) {
    if (NEEDS_ESCAPE.test(s.replace(/\n/g, ''))) return null;
    if (/[ \t]\n|[ \t]$/.test(s)) return null; // trailing whitespace would be fragile
    let m = s.length;
    while (m > 0 && s[m - 1] === '\n') m--;
    const core = s.slice(0, m);
    const trailing = s.length - m;
    if (core === '') return null;
    const lines = core.split('\n');
    const first = lines.find((l) => l !== '');
    if (/^[ \t]/.test(first)) return null; // would need an indentation indicator
    for (let k = 1; k < trailing; k++) lines.push('');
    return { header: '|' + (trailing === 0 ? '-' : trailing === 1 ? '' : '+'), body: lines };
  }

  // JSON numbers are valid YAML 1.2 floats/ints. Numbers that overflow (1e400)
  // become .inf so every YAML parser reads the same value JSON.parse produces.
  function yamlNumber(node) {
    if (Number.isFinite(node.v) || /^[-+]?\.(inf|nan)$/i.test(node.raw)) return node.raw;
    if (Number.isNaN(node.v)) return '.nan';
    return node.v > 0 ? '.inf' : '-.inf';
  }

  function normalizeYamlOptions(options) {
    const o = Object.assign({}, DEFAULT_YAML_OPTIONS, options);
    o.indent = Math.max(1, Math.min(8, parseInt(o.indent, 10) || 2));
    o.flowLevel = Number.isInteger(+o.flowLevel) ? +o.flowLevel : -1;
    o.quoteStyle = o.quoteStyle === 'double' ? 'double' : 'single';
    return o;
  }

  function orderedEntries(node, o) {
    if (!o.sortKeys) return node.entries;
    return node.entries.slice().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  function renderKey(k, o, flow) {
    return scalarString(k, o, flow);
  }

  function renderFlow(node, o) {
    switch (node.t) {
      case 'null': return 'null';
      case 'bool': return node.v ? 'true' : 'false';
      case 'num': return yamlNumber(node);
      case 'str': return scalarString(node.v, o, true);
      case 'arr': return '[' + node.items.map((x) => renderFlow(x, o)).join(', ') + ']';
      case 'obj':
        return '{' + orderedEntries(node, o).map((e) => renderKey(e.key, o, true) + ': ' + renderFlow(e.value, o)).join(', ') + '}';
    }
  }

  // Returns { inline } | { header, body } | { kind, lines }
  function renderNode(node, depth, o) {
    switch (node.t) {
      case 'null': return { inline: 'null' };
      case 'bool': return { inline: node.v ? 'true' : 'false' };
      case 'num': return { inline: yamlNumber(node) };
      case 'str': {
        if (o.blockScalars && node.v.includes('\n')) {
          const b = literalBlock(node.v);
          if (b) return b;
        }
        return { inline: scalarString(node.v, o, false) };
      }
      case 'arr':
        if (!node.items.length) return { inline: '[]' };
        if (o.flowLevel >= 0 && depth >= o.flowLevel) return { inline: renderFlow(node, o) };
        return { kind: 'seq', lines: renderSeq(node, depth, o) };
      case 'obj':
        if (!node.entries.length) return { inline: '{}' };
        if (o.flowLevel >= 0 && depth >= o.flowLevel) return { inline: renderFlow(node, o) };
        return { kind: 'map', lines: renderMap(node, depth, o) };
      default:
        throw new TypeError(`Unknown node type: ${node && node.t}`);
    }
  }

  const indentLine = (prefix, l) => (l === '' ? '' : prefix + l);

  function renderSeq(node, depth, o) {
    const lines = [];
    const w = Math.max(2, o.indent);
    const dash = '-' + ' '.repeat(w - 1);
    const cont = ' '.repeat(w);
    for (const item of node.items) {
      const r = renderNode(item, depth + 1, o);
      if (r.inline !== undefined) {
        lines.push('- ' + r.inline);
      } else if (r.header !== undefined) {
        lines.push('- ' + r.header);
        for (const l of r.body) lines.push(indentLine(cont, l));
      } else {
        r.lines.forEach((l, k) => lines.push(k === 0 ? dash + l : indentLine(cont, l)));
      }
    }
    return lines;
  }

  function renderMap(node, depth, o) {
    const lines = [];
    const pad = ' '.repeat(o.indent);
    for (const e of orderedEntries(node, o)) {
      const k = renderKey(e.key, o, false);
      const explicit = k.length > 1024; // implicit keys are limited to 1024 chars
      const r = renderNode(e.value, depth + 1, o);
      let prefix;
      if (explicit) { lines.push('? ' + k); prefix = ':'; } else prefix = k + ':';
      if (r.inline !== undefined) {
        lines.push(prefix + ' ' + r.inline);
      } else if (r.header !== undefined) {
        lines.push(prefix + ' ' + r.header);
        for (const l of r.body) lines.push(indentLine(pad, l));
      } else if (r.kind === 'seq' && !o.indentSequences && !explicit) {
        lines.push(prefix);
        for (const l of r.lines) lines.push(l);
      } else {
        lines.push(prefix);
        for (const l of r.lines) lines.push(indentLine(pad, l));
      }
    }
    return lines;
  }

  function emitDocument(node, o) {
    const r = renderNode(node, 0, o);
    const start = o.documentStart ? '---' : '';
    if (r.inline !== undefined) return (start ? start + ' ' : '') + r.inline + '\n';
    if (r.header !== undefined) {
      const pad = ' '.repeat(o.indent);
      return [(start ? start + ' ' : '') + r.header, ...r.body.map((l) => indentLine(pad, l))].join('\n') + '\n';
    }
    return (start ? start + '\n' : '') + r.lines.join('\n') + '\n';
  }

  /** Emit YAML from an AST node (from parse()). */
  function emit(node, options) {
    return emitDocument(node, normalizeYamlOptions(options));
  }

  /** Emit a multi-document YAML stream from an array of AST nodes. */
  function emitDocuments(nodes, options) {
    const o = normalizeYamlOptions(Object.assign({}, options, { documentStart: true }));
    return nodes.map((n) => emitDocument(n, o)).join('');
  }

  /** Convert a plain JavaScript value to YAML. */
  function stringify(value, options) {
    return emit(fromJS(value), options);
  }

  /** Convert JSON text to YAML text. options = parse options + YAML options + { multi }. */
  function convert(jsonText, options = {}) {
    if (options.multi) return emitDocuments(parseMulti(jsonText, options), options);
    return emit(parse(jsonText, options), options);
  }

  /* ======================================================================
   * String formats (shared by inference and validation)
   * ==================================================================== */

  function validDate(y, m, d) {
    if (m < 1 || m > 12 || d < 1) return false;
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
    return d <= days;
  }
  const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d|60)(\.\d+)?(z|[+-]([01]\d|2[0-3]):[0-5]\d)$/i;
  const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';

  const FORMATS = {
    'date-time': (s) => {
      const k = s.search(/[Tt]/);
      return k === 10 && FORMATS.date(s.slice(0, 10)) && FORMATS.time(s.slice(11));
    },
    date: (s) => {
      const m = DATE_RE.exec(s);
      return !!m && validDate(+m[1], +m[2], +m[3]);
    },
    time: (s) => TIME_RE.test(s),
    uuid: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
    email: (s) => new RegExp(`^[^\\s@"(),:;<>[\\]\\\\]+@${LABEL}(?:\\.${LABEL})+$`).test(s),
    uri: (s) => /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/?#]+[^\s]*$/.test(s) || /^(?:mailto|urn|tel|data):[^\s]+$/i.test(s),
    ipv4: (s) => /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(s),
  };
  const FORMAT_DETECT_ORDER = ['date-time', 'date', 'time', 'uuid', 'email', 'uri', 'ipv4'];

  function detectFormat(s) {
    for (const f of FORMAT_DETECT_ORDER) if (FORMATS[f](s)) return f;
    return null;
  }

  /* ======================================================================
   * JSON Schema inference
   * ==================================================================== */

  const DEFAULT_SCHEMA_OPTIONS = {
    draft: '2020-12',            // '2020-12' | '2019-09' | '07' | '06' | '04'
    required: true,              // list properties present in every sample as required
    additionalProperties: true,  // false → closed objects
    detectFormats: true,         // add "format" when every string sample matches one
    title: '',                   // optional title for the root schema
  };

  const DRAFT_URIS = {
    '2020-12': 'https://json-schema.org/draft/2020-12/schema',
    '2019-09': 'https://json-schema.org/draft/2019-09/schema',
    '07': 'http://json-schema.org/draft-07/schema#',
    '06': 'http://json-schema.org/draft-06/schema#',
    '04': 'http://json-schema.org/draft-04/schema#',
  };

  const newShape = () => ({ count: 0, kinds: {} });

  function observe(shape, node, o) {
    shape.count++;
    const k = shape.kinds;
    switch (node.t) {
      case 'null': k.null = true; break;
      case 'bool': k.boolean = true; break;
      case 'num':
        if (/^-?\d+$/.test(node.raw)) k.integer = true; else k.number = true;
        break;
      case 'str': {
        const s = k.string || (k.string = { count: 0, formats: new Map() });
        s.count++;
        if (o.detectFormats) {
          const f = detectFormat(node.v);
          s.formats.set(f, (s.formats.get(f) || 0) + 1);
        }
        break;
      }
      case 'arr': {
        const a = k.array || (k.array = { items: newShape() });
        for (const it of node.items) observe(a.items, it, o);
        break;
      }
      case 'obj': {
        const ob = k.object || (k.object = { count: 0, props: new Map() });
        ob.count++;
        for (const e of node.entries) {
          let p = ob.props.get(e.key);
          if (!p) { p = newShape(); ob.props.set(e.key, p); }
          observe(p, e.value, o);
        }
        break;
      }
    }
  }

  const S = (v) => ({ t: 'str', v });
  const B = (v) => ({ t: 'bool', v });
  const A = (items) => ({ t: 'arr', items });
  const O = (pairs) => ({ t: 'obj', entries: pairs.map(([key, value]) => ({ key, value })) });

  function renderShape(shape, o) {
    if (!shape.count) return O([]);
    const k = shape.kinds;
    const types = [];
    if (k.object) types.push('object');
    if (k.array) types.push('array');
    if (k.string) types.push('string');
    if (k.number) types.push('number');
    else if (k.integer) types.push('integer');
    if (k.boolean) types.push('boolean');
    if (k.null) types.push('null');

    const pairs = [['type', types.length === 1 ? S(types[0]) : A(types.map(S))]];
    if (k.string && o.detectFormats && k.string.formats.size === 1) {
      const [f] = k.string.formats.keys();
      if (f) pairs.push(['format', S(f)]);
    }
    if (k.object) {
      const props = [];
      const req = [];
      for (const [name, p] of k.object.props) {
        props.push([name, renderShape(p, o)]);
        if (p.count === k.object.count) req.push(S(name));
      }
      if (props.length) pairs.push(['properties', O(props)]);
      if (o.required && req.length) pairs.push(['required', A(req)]);
      if (o.additionalProperties === false) pairs.push(['additionalProperties', B(false)]);
    }
    if (k.array && k.array.items.count) pairs.push(['items', renderShape(k.array.items, o)]);
    return O(pairs);
  }

  function normalizeSchemaOptions(options) {
    const o = Object.assign({}, DEFAULT_SCHEMA_OPTIONS, options);
    o.draft = String(o.draft).replace(/^draft-?0?/, '').replace(/^(\d)$/, '0$1');
    if (!DRAFT_URIS[o.draft]) o.draft = '2020-12';
    o.additionalProperties = o.additionalProperties !== false;
    o.required = o.required !== false;
    o.detectFormats = o.detectFormats !== false;
    return o;
  }

  /** Infer a JSON Schema (as an AST) from one or more AST samples. */
  function inferSchemaAST(samples, options) {
    const o = normalizeSchemaOptions(options);
    const list = Array.isArray(samples) ? samples : [samples];
    const shape = newShape();
    for (const s of list) observe(shape, s, o);
    const body = renderShape(shape, o);
    const head = [['$schema', S(DRAFT_URIS[o.draft])]];
    if (o.title) head.push(['title', S(String(o.title))]);
    return O(head.concat(body.entries.map((e) => [e.key, e.value])));
  }

  /** Infer a JSON Schema (plain object) from a JavaScript value. */
  function inferSchema(value, options) {
    return toJS(inferSchemaAST(fromJS(value), options));
  }

  /** Infer a JSON Schema from a list of JavaScript sample values. */
  function inferSchemaFromSamples(values, options) {
    return toJS(inferSchemaAST(values.map(fromJS), options));
  }

  /* ======================================================================
   * JSON Schema validator (drafts 04 → 2020-12, local $ref)
   * ==================================================================== */

  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

  function typeName(x) {
    if (x === null) return 'null';
    if (Array.isArray(x)) return 'array';
    if (typeof x === 'number') return isType(x, 'integer') ? 'integer' : 'number';
    return typeof x;
  }

  function isType(x, t) {
    switch (t) {
      case 'null': return x === null;
      case 'boolean': return typeof x === 'boolean';
      case 'string': return typeof x === 'string';
      // JSON numbers that overflow a double (1e400) parse to ±Infinity; they are still numbers (and integers).
      case 'number': return typeof x === 'number' && !Number.isNaN(x);
      case 'integer': return typeof x === 'number' && (Number.isInteger(x) || x === Infinity || x === -Infinity);
      case 'array': return Array.isArray(x);
      case 'object': return isObj(x);
      default: return false;
    }
  }

  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null) return false;
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
      return true;
    }
    if (typeof a === 'object') {
      if (Array.isArray(b)) return false;
      const ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      for (const k of ka) if (!hasOwn(b, k) || !deepEqual(a[k], b[k])) return false;
      return true;
    }
    return false;
  }

  function canonical(x) {
    if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']';
    if (isObj(x)) return '{' + Object.keys(x).sort().map((k) => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}';
    return JSON.stringify(x);
  }

  const short = (x) => {
    const s = JSON.stringify(x);
    return s && s.length > 60 ? s.slice(0, 57) + '...' : s;
  };
  const ptr = (path, k) => path + '/' + String(k).replace(/~/g, '~0').replace(/\//g, '~1');

  /**
   * Validate a JavaScript value against a JSON Schema.
   * @returns {{ valid: boolean, errors: { path, keyword, message }[] }}
   */
  function validate(data, schema, options = {}) {
    const checkFormats = options.formats !== false;
    const maxErrors = options.maxErrors || 200;
    const regexCache = new Map();
    const anchors = new Map();

    (function collect(s) {
      if (Array.isArray(s)) { s.forEach(collect); return; }
      if (!isObj(s)) return;
      if (typeof s.$anchor === 'string') anchors.set(s.$anchor, s);
      if (typeof s.$id === 'string' && s.$id.startsWith('#')) anchors.set(s.$id.slice(1), s);
      for (const k of Object.keys(s)) if (k !== 'enum' && k !== 'const') collect(s[k]);
    })(schema);

    function resolve(ref) {
      let r = ref;
      const rootId = isObj(schema) && typeof schema.$id === 'string' ? schema.$id.replace(/#$/, '') : null;
      if (rootId && r.startsWith(rootId)) r = r.slice(rootId.length);
      if (r === '' || r === '#') return schema;
      if (r.startsWith('#/')) {
        let cur = schema;
        for (const raw of r.slice(2).split('/')) {
          const p = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
          if ((isObj(cur) || Array.isArray(cur)) && hasOwn(cur, p)) cur = cur[p];
          else throw new SchemaError(`Cannot resolve $ref "${ref}"`);
        }
        return cur;
      }
      if (r.startsWith('#') && anchors.has(r.slice(1))) return anchors.get(r.slice(1));
      throw new SchemaError(`Cannot resolve $ref "${ref}" (only references within the same schema are supported)`);
    }

    function regex(p) {
      if (regexCache.has(p)) return regexCache.get(p);
      let re;
      try { re = new RegExp(p, 'u'); } catch (_) {
        try { re = new RegExp(p); } catch (e) { throw new SchemaError(`Invalid regular expression in schema: ${p}`); }
      }
      regexCache.set(p, re);
      return re;
    }

    const E = (errs, path, keyword, message) => { errs.push({ path: path || '/', keyword, message }); };

    function v(x, s, path, errs, depth) {
      if (s === true || s === undefined) return true;
      if (s === false) { E(errs, path, 'false', 'no value is allowed here'); return false; }
      if (!isObj(s)) return true;
      if (depth > 400) throw new SchemaError('Schema recursion is too deep (circular $ref?)');
      const start = errs.length;
      const d = depth + 1;

      if (typeof s.$ref === 'string') v(x, resolve(s.$ref), path, errs, d);
      if (typeof s.$dynamicRef === 'string') v(x, resolve(s.$dynamicRef), path, errs, d);

      if (s.type !== undefined) {
        const types = Array.isArray(s.type) ? s.type : [s.type];
        if (!types.some((t) => isType(x, t))) E(errs, path, 'type', `expected ${types.join(' or ')}, got ${typeName(x)}`);
      }
      if (Array.isArray(s.enum) && !s.enum.some((e) => deepEqual(e, x))) {
        E(errs, path, 'enum', `must be one of: ${s.enum.map(short).join(', ')}`);
      }
      if (hasOwn(s, 'const') && !deepEqual(s.const, x)) E(errs, path, 'const', `must be equal to ${short(s.const)}`);

      if (typeof x === 'number') {
        if (typeof s.minimum === 'number') {
          if (s.exclusiveMinimum === true ? x <= s.minimum : x < s.minimum) {
            E(errs, path, 'minimum', `must be ${s.exclusiveMinimum === true ? '>' : '>='} ${s.minimum}`);
          }
        }
        if (typeof s.maximum === 'number') {
          if (s.exclusiveMaximum === true ? x >= s.maximum : x > s.maximum) {
            E(errs, path, 'maximum', `must be ${s.exclusiveMaximum === true ? '<' : '<='} ${s.maximum}`);
          }
        }
        if (typeof s.exclusiveMinimum === 'number' && x <= s.exclusiveMinimum) E(errs, path, 'exclusiveMinimum', `must be > ${s.exclusiveMinimum}`);
        if (typeof s.exclusiveMaximum === 'number' && x >= s.exclusiveMaximum) E(errs, path, 'exclusiveMaximum', `must be < ${s.exclusiveMaximum}`);
        if (typeof s.multipleOf === 'number' && s.multipleOf > 0) {
          const q = x / s.multipleOf;
          if (!Number.isFinite(q) || Math.abs(q - Math.round(q)) > 1e-9 * Math.max(1, Math.abs(q))) {
            E(errs, path, 'multipleOf', `must be a multiple of ${s.multipleOf}`);
          }
        }
      }

      if (typeof x === 'string') {
        const len = Array.from(x).length;
        if (typeof s.minLength === 'number' && len < s.minLength) E(errs, path, 'minLength', `must be at least ${s.minLength} characters long`);
        if (typeof s.maxLength === 'number' && len > s.maxLength) E(errs, path, 'maxLength', `must be at most ${s.maxLength} characters long`);
        if (typeof s.pattern === 'string' && !regex(s.pattern).test(x)) E(errs, path, 'pattern', `must match pattern ${s.pattern}`);
        if (checkFormats && typeof s.format === 'string' && FORMATS[s.format] && !FORMATS[s.format](x)) {
          E(errs, path, 'format', `must be a valid ${s.format}`);
        }
      }

      if (Array.isArray(x)) {
        let prefix = null, rest;
        if (Array.isArray(s.prefixItems)) { prefix = s.prefixItems; rest = s.items; }
        else if (Array.isArray(s.items)) { prefix = s.items; rest = s.additionalItems; }
        else rest = s.items;
        x.forEach((it, i) => {
          const sub = prefix && i < prefix.length ? prefix[i] : rest;
          if (sub !== undefined) {
            if (sub === false && prefix && i >= prefix.length) E(errs, ptr(path, i), 'items', `array must have at most ${prefix.length} items`);
            else v(it, sub, ptr(path, i), errs, d);
          }
        });
        if (typeof s.minItems === 'number' && x.length < s.minItems) E(errs, path, 'minItems', `must have at least ${s.minItems} items`);
        if (typeof s.maxItems === 'number' && x.length > s.maxItems) E(errs, path, 'maxItems', `must have at most ${s.maxItems} items`);
        if (s.uniqueItems === true) {
          const seen = new Map();
          x.forEach((it, i) => {
            const c = canonical(it);
            if (seen.has(c)) E(errs, ptr(path, i), 'uniqueItems', `duplicate of item ${seen.get(c)}`);
            else seen.set(c, i);
          });
        }
        if (s.contains !== undefined) {
          let count = 0;
          for (const it of x) if (v(it, s.contains, path, [], d)) count++;
          const min = typeof s.minContains === 'number' ? s.minContains : 1;
          if (count < min) E(errs, path, 'contains', `must contain at least ${min} matching item${min === 1 ? '' : 's'}`);
          if (typeof s.maxContains === 'number' && count > s.maxContains) E(errs, path, 'maxContains', `must contain at most ${s.maxContains} matching items`);
        }
      }

      if (isObj(x)) {
        const keys = Object.keys(x);
        if (Array.isArray(s.required)) {
          for (const r of s.required) if (!hasOwn(x, r)) E(errs, path, 'required', `missing required property "${r}"`);
        }
        if (typeof s.minProperties === 'number' && keys.length < s.minProperties) E(errs, path, 'minProperties', `must have at least ${s.minProperties} properties`);
        if (typeof s.maxProperties === 'number' && keys.length > s.maxProperties) E(errs, path, 'maxProperties', `must have at most ${s.maxProperties} properties`);
        const props = isObj(s.properties) ? s.properties : null;
        const pats = isObj(s.patternProperties) ? Object.keys(s.patternProperties).map((p) => [regex(p), s.patternProperties[p]]) : [];
        for (const k of keys) {
          let matched = false;
          if (props && hasOwn(props, k)) { matched = true; v(x[k], props[k], ptr(path, k), errs, d); }
          for (const [re, sub] of pats) if (re.test(k)) { matched = true; v(x[k], sub, ptr(path, k), errs, d); }
          if (!matched && s.additionalProperties !== undefined) {
            if (s.additionalProperties === false) E(errs, ptr(path, k), 'additionalProperties', `property "${k}" is not allowed`);
            else v(x[k], s.additionalProperties, ptr(path, k), errs, d);
          }
        }
        if (s.propertyNames !== undefined) {
          for (const k of keys) if (!v(k, s.propertyNames, path, [], d)) E(errs, path, 'propertyNames', `property name "${k}" is invalid`);
        }
        const depReq = isObj(s.dependentRequired) ? s.dependentRequired : null;
        const deps = isObj(s.dependencies) ? s.dependencies : null;
        const check = (k, dep) => {
          if (!hasOwn(x, k)) return;
          if (Array.isArray(dep)) {
            for (const r of dep) if (!hasOwn(x, r)) E(errs, path, 'dependentRequired', `property "${r}" is required when "${k}" is present`);
          } else v(x, dep, path, errs, d);
        };
        if (depReq) for (const k of Object.keys(depReq)) check(k, depReq[k]);
        if (deps) for (const k of Object.keys(deps)) check(k, deps[k]);
        if (isObj(s.dependentSchemas)) for (const k of Object.keys(s.dependentSchemas)) if (hasOwn(x, k)) v(x, s.dependentSchemas[k], path, errs, d);
      }

      if (Array.isArray(s.allOf)) for (const sub of s.allOf) v(x, sub, path, errs, d);
      if (Array.isArray(s.anyOf) && !s.anyOf.some((sub) => v(x, sub, path, [], d))) {
        E(errs, path, 'anyOf', 'must match at least one of the anyOf schemas');
      }
      if (Array.isArray(s.oneOf)) {
        const n = s.oneOf.filter((sub) => v(x, sub, path, [], d)).length;
        if (n !== 1) E(errs, path, 'oneOf', n === 0 ? 'must match exactly one of the oneOf schemas (matched none)' : `must match exactly one of the oneOf schemas (matched ${n})`);
      }
      if (s.not !== undefined && v(x, s.not, path, [], d)) E(errs, path, 'not', 'must not match the "not" schema');
      if (s.if !== undefined) {
        const ok = v(x, s.if, path, [], d);
        if (ok && s.then !== undefined) v(x, s.then, path, errs, d);
        if (!ok && s.else !== undefined) v(x, s.else, path, errs, d);
      }
      return errs.length === start;
    }

    if (schema !== true && schema !== false && !isObj(schema)) throw new SchemaError('A JSON Schema must be an object or a boolean');
    const errors = [];
    v(data, schema, '', errors, 0);
    return { valid: errors.length === 0, errors: errors.slice(0, maxErrors), total: errors.length };
  }

  /**
   * Find the AST node at a JSON Pointer ("/users/0/email"). Returns
   * { node, pos } where pos is the source offset of the key (or value), or
   * the deepest existing ancestor when the path does not exist.
   */
  function nodeAt(ast, pointer) {
    let cur = ast;
    let pos = ast.pos;
    const parts = !pointer || pointer === '/' ? [] : pointer.replace(/^\//, '').split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    for (const p of parts) {
      if (cur.t === 'obj') {
        const e = cur.entries.find((x) => x.key === p);
        if (!e) break;
        pos = e.keyPos !== undefined ? e.keyPos : e.value.pos;
        cur = e.value;
      } else if (cur.t === 'arr' && /^\d+$/.test(p) && +p < cur.items.length) {
        cur = cur.items[+p];
        pos = cur.pos;
      } else break;
    }
    return { node: cur, pos };
  }

  /* ======================================================================
   * Stats helper (used by the CLI/web UI)
   * ==================================================================== */

  function stats(node) {
    const st = { objects: 0, arrays: 0, strings: 0, numbers: 0, booleans: 0, nulls: 0, keys: 0, maxDepth: 0 };
    (function walk(n, d) {
      if (d > st.maxDepth) st.maxDepth = d;
      switch (n.t) {
        case 'obj': st.objects++; st.keys += n.entries.length; for (const e of n.entries) walk(e.value, d + 1); break;
        case 'arr': st.arrays++; for (const x of n.items) walk(x, d + 1); break;
        case 'str': st.strings++; break;
        case 'num': st.numbers++; break;
        case 'bool': st.booleans++; break;
        case 'null': st.nulls++; break;
      }
    })(node, 0);
    return st;
  }

  return {
    VERSION,
    // parsing
    parse, parseMulti, JSONParseError, codeFrame,
    // conversion
    convert, emit, emitDocuments, stringify, fromJS, toJS, toJSON,
    // schema
    inferSchema, inferSchemaAST, inferSchemaFromSamples, validate, SchemaError, FORMATS, detectFormat,
    // misc
    stats, deepEqual, nodeAt,
    defaults: { parse: DEFAULT_PARSE_OPTIONS, yaml: DEFAULT_YAML_OPTIONS, schema: DEFAULT_SCHEMA_OPTIONS },
  };
});
