'use strict';
// Run with: node --test test/
// Reference implementations (dev dependencies only): js-yaml, yaml, ajv.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const jsyaml = require('js-yaml');
const YAML = require('yaml');
const Ajv2020 = require('ajv/dist/2020').default;
const AjvDraft7 = require('ajv').default;
const J = require('../src/jsonyaml.js');

const ch = (...cps) => String.fromCodePoint(...cps);
const cu = (...units) => String.fromCharCode(...units); // raw UTF-16 code units (lone surrogates)

// ---------- deterministic PRNG ----------
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- nasty strings ----------
const NASTY = [
  '', ' ', '  ', 'yes', 'Yes', 'YES', 'no', 'No', 'y', 'Y', 'n', 'N', 'on', 'On', 'off', 'OFF', 'true', 'True', 'false',
  'FALSE', 'null', 'Null', 'NULL', '~', '0', '1', '-1', '+1', '007', '1.0', '.5', '5.', '-.5', '1e3', '1E-3', '1_000',
  '0x1F', '0o17', '0b101', '12:30', '12:30:45', '190:20:30', '2024-01-01', '2024-1-1', '2024-01-01T10:00:00Z',
  '2024-01-01 10:00', '.inf', '-.Inf', '+.INF', '.NaN', '.nan', '<<', '=', '-', '--', '---', '--- a', '...', '- a', '-a',
  '--flag', '?', '? a', '?a', ':', ':a', 'a:', 'a::', 'a: b', 'a:b', 'http://x.y/z?q=1#f', 'a #b', 'a#b', '#a', '# a', '&a',
  '*a', '!a', '!!str', '|', '|-', '>', '>-', '%a', '%YAML 1.2', '@a', '`a', '"a"', "'a'", "a'b", 'a"b', "''", '""', '[a]',
  '[', ']', '{a}', '{', '}', 'a,b', ',', 'a]', 'a}', 'a[0]', '\t', 'a\tb', '\ta', 'a\t', ' a', 'a ', 'a\n', '\na', 'a\n\n',
  'a\n\n\n', '\n', '\n\n', 'a\r\nb', 'a\rb', '\r', ch(0), ch(7), ch(8), ch(0x1b), ch(0x7f), ch(0x85), ch(0xa0), ch(0x2028),
  ch(0x2029), ch(0xfeff), 'a' + ch(0xfeff), ch(0xfffe), ch(0xffff), cu(0xd800), cu(0xdc00), 'x' + cu(0xd83d), cu(0xde00) + 'x',
  ch(0x1f600), '\u65e5\u672c\u8a9e', 'caf\u00e9', '  indented\nline', 'line\n  indented', 'a\n \nb', 'a \nb', 'a\n\tb',
  '\tx\ny', '#\n#', '- x\n- y', 'key: v\nk2: v2', '---\n...', 'multi\nline\n', 'x'.repeat(1100), 'y\n'.repeat(5), '\\',
  '\\n', 'a\\b', 'C:\\path\\to', '$ref', '__proto__', 'constructor', 'toString', '0.0.0.0', '1.2.3', 'v1.0', '1,000',
  '1/2', '+', '+-', '-0', '0.', '00', 'ñ', '\u00bfqu\u00e9?', 'a\u0300', ch(0x10ffff), ' # comment', 'a\n# not comment',
];

function randomString(r) {
  const roll = r();
  if (roll < 0.45) return NASTY[Math.floor(r() * NASTY.length)];
  if (roll < 0.6) return NASTY[Math.floor(r() * NASTY.length)] + NASTY[Math.floor(r() * NASTY.length)];
  const len = Math.floor(r() * 12);
  let s = '';
  const alphabet = 'ab-:#?!&*|>\'"%@`,[]{} \t\n\r\\~.019eExyz';
  for (let k = 0; k < len; k++) {
    const p = r();
    if (p < 0.7) s += alphabet[Math.floor(r() * alphabet.length)];
    else if (p < 0.85) s += String.fromCharCode(Math.floor(r() * 0x10000)); // any code unit, incl. surrogates
    else s += String.fromCodePoint(Math.floor(r() * 0x110000));
  }
  return s;
}

function randomNumberRaw(r) {
  const forms = [
    () => String(Math.floor(r() * 1000) - 500),
    () => (r() * 1e6 - 5e5).toString(),
    () => (r() < 0.5 ? '-' : '') + Math.floor(r() * 9 + 1) + 'e' + (r() < 0.5 ? '-' : '+') + Math.floor(r() * 30),
    () => '0', () => '-0', () => '0.0', () => '1.50', () => '1E400', () => '-1e-400',
    () => '12345678901234567890123', () => '3.141592653589793238462643',
  ];
  return forms[Math.floor(r() * forms.length)]();
}

// Generates a random AST directly (so number text and key order are exercised).
function randomAst(r, depth = 0) {
  const p = r();
  const leafOnly = depth >= 5;
  if (!leafOnly && p < 0.2) {
    const n = Math.floor(r() * 5);
    return { t: 'arr', items: Array.from({ length: n }, () => randomAst(r, depth + 1)) };
  }
  if (!leafOnly && p < 0.42) {
    const n = Math.floor(r() * 5);
    const seen = new Set();
    const entries = [];
    for (let k = 0; k < n; k++) {
      const key = randomString(r);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ key, value: randomAst(r, depth + 1) });
    }
    return { t: 'obj', entries };
  }
  const q = r();
  if (q < 0.5) return { t: 'str', v: randomString(r) };
  if (q < 0.75) { const raw = randomNumberRaw(r); return { t: 'num', raw, v: Number(raw) }; }
  if (q < 0.88) return { t: 'bool', v: r() < 0.5 };
  return { t: 'null' };
}

const OPTION_SETS = [
  {},
  { indent: 4 },
  { indent: 1, indentSequences: false },
  { indentSequences: false, quoteStyle: 'double' },
  { sortKeys: true, documentStart: true },
  { flowLevel: 0 },
  { flowLevel: 2, indent: 3 },
  { blockScalars: false, quoteStyle: 'double' },
];

// Parse YAML with three parsers/modes and check each yields exactly the expected JS value.
function assertRoundTrip(yamlText, expected, label) {
  const parsers = {
    'js-yaml': () => jsyaml.load(yamlText),
    'yaml 1.2 core': () => YAML.parse(yamlText, { version: '1.2', schema: 'core', uniqueKeys: true, maxAliasCount: -1 }),
    'yaml 1.1': () => YAML.parse(yamlText, { version: '1.1', uniqueKeys: true, merge: true, maxAliasCount: -1 }),
  };
  for (const [name, fn] of Object.entries(parsers)) {
    let got;
    try { got = fn(); } catch (e) {
      assert.fail(`${label}: ${name} failed to parse:\n${yamlText}\n${e.message}`);
    }
    if (!J.deepEqual(got, expected)) {
      assert.fail(`${label}: ${name} round-trip mismatch\nYAML:\n${yamlText}\nexpected: ${JSON.stringify(expected)}\ngot:      ${JSON.stringify(got)}`);
    }
  }
}

// ======================================================================
// JSON parser
// ======================================================================

test('parser matches JSON.parse on valid documents', () => {
  const samples = [
    '0', '-0', '1.5e+10', '"a"', 'true', 'false', 'null', '[]', '{}', ' [1, [2, [3]]] ', '{"a":{"b":{"c":[]}}}',
    '"\\u00e9\\ud83d\\ude00\\n\\t\\"\\\\\\/"', '{"__proto__": 1, "a": 2}', '{"a":1,"a":2}', '[1e400, -1e-400]',
    '\n\t\r {"1":1,"0":0} \n',
  ];
  for (const s of samples) assert.ok(J.deepEqual(J.toJS(J.parse(s)), JSON.parse(s)), s);
});

test('parser preserves key order (including integer-like keys) and number text', () => {
  const ast = J.parse('{"b":1,"2":2,"a":3,"1":4,"n":12345678901234567890,"f":1.10}');
  assert.deepEqual(ast.entries.map((e) => e.key), ['b', '2', 'a', '1', 'n', 'f']);
  assert.equal(ast.entries[4].value.raw, '12345678901234567890');
  assert.equal(J.convert('{"n":12345678901234567890,"f":1.10}'), "'n': 12345678901234567890\nf: 1.10\n");
});

test('parser rejects invalid JSON with accurate positions', () => {
  const cases = [
    ['', 'Empty input'], ['{', 'Unterminated object'], ['[1,]', 'Trailing comma'], ['{"a":1,}', 'Trailing comma'],
    ["{'a':1}", 'double quotes'], ['{a:1}', 'property name'], ['[01]', 'leading zeros'], ['[1.]', 'decimal point'],
    ['[1e]', 'exponent'], ['[-]', "after '-'"], ['NaN', 'not valid JSON'], ['[Infinity]', 'not valid JSON'],
    ['"abc', 'Unterminated string'], ['"a\nb"', 'line break'], ['"\\x41"', 'Invalid escape'], ['"\\u12"', 'unicode escape'],
    ['[1 2]', "Expected ','"], ['{"a" 1}', "Expected ':'"], ['tru', 'Unexpected token'], ['truex', 'Unexpected token'],
    ['1 2', 'after the end'], ['[,1]', 'Unexpected comma'], ['{"a":1}}', 'after the end'], ['undefined', 'not valid JSON'],
  ];
  for (const [src, msg] of cases) {
    assert.throws(() => J.parse(src), (e) => e instanceof J.JSONParseError && e.message.includes(msg), `${JSON.stringify(src)} → ${msg}`);
    assert.throws(() => JSON.parse(src));
  }
  try { J.parse('{\n  "a": 1,\n  "b": [1, 2,, 3]\n}'); assert.fail('should throw'); } catch (e) {
    assert.equal(e.line, 3);
    assert.equal(e.column, 14);
    assert.match(J.codeFrame('{\n  "a": 1,\n  "b": [1, 2,, 3]\n}', e.line, e.column), />\s*3 \|.*\n\s*\| {14}\^/);
  }
});

test('lenient mode: comments, trailing commas; strict duplicate keys; depth limit', () => {
  const src = '// header\n{\n  "a": [1, 2, /* two */ ],\n  "b": {"c": 1,},\n}\n';
  assert.throws(() => J.parse(src));
  assert.deepEqual(J.toJS(J.parse(src, { allowComments: true, allowTrailingCommas: true })), { a: [1, 2], b: { c: 1 } });
  assert.throws(() => J.parse('{"a":1,"a":2}', { duplicateKeys: 'error' }), /Duplicate key "a"/);
  assert.equal(J.toJS(J.parse('{"a":1,"a":2}')).a, 2);
  assert.throws(() => J.parse('['.repeat(1002) + ']'.repeat(1002)), /nesting depth/);
  assert.doesNotThrow(() => J.parse('['.repeat(900) + ']'.repeat(900)));
  assert.deepEqual(J.toJS(J.parse('\ufeff[1]')), [1]);
});

test('parseMulti handles NDJSON and concatenated JSON', () => {
  const docs = J.parseMulti('{"a":1}\n{"a":2}\n\n[3]{"b":4} "x" 5');
  assert.deepEqual(docs.map(J.toJS), [{ a: 1 }, { a: 2 }, [3], { b: 4 }, 'x', 5]);
  assert.deepEqual(J.parseMulti('  \n'), []);
  assert.equal(J.convert('{"a":1}\n{"a":2}', { multi: true }), '---\na: 1\n---\na: 2\n');
});

test('differential fuzz: parser accepts/rejects exactly like JSON.parse', () => {
  const r = rng(42);
  const pieces = '{}[]",:0123456789eE.+- \n\ttrufalsnx\\/u'.split('');
  for (let iter = 0; iter < 20000; iter++) {
    const base = JSON.stringify(J.toJS(randomAst(r)));
    let s = base;
    const muts = Math.floor(r() * 3);
    for (let m = 0; m < muts; m++) {
      const pos = Math.floor(r() * (s.length + 1));
      const op = r();
      const c = pieces[Math.floor(r() * pieces.length)];
      if (op < 0.4) s = s.slice(0, pos) + c + s.slice(pos);
      else if (op < 0.7) s = s.slice(0, pos) + s.slice(pos + 1);
      else s = s.slice(0, pos) + c + s.slice(pos + 1);
    }
    if (s.charCodeAt(0) === 0xfeff) continue; // we deliberately accept a leading BOM; JSON.parse does not
    let ref, refErr = false, mine, myErr = false;
    try { ref = JSON.parse(s); } catch (_) { refErr = true; }
    try { mine = J.toJS(J.parse(s)); } catch (e) {
      if (!(e instanceof J.JSONParseError)) throw e;
      myErr = true;
    }
    assert.equal(myErr, refErr, `accept/reject mismatch for ${JSON.stringify(s)}`);
    if (!refErr) assert.ok(J.deepEqual(mine, ref), `value mismatch for ${JSON.stringify(s)}`);
  }
});

// ======================================================================
// YAML emitter
// ======================================================================

test('emits readable YAML for a typical document', () => {
  const json = JSON.stringify({
    name: 'app', version: '1.0', port: 8080, debug: false, owner: null, tags: ['web', 'api'], empty: [], none: {},
    db: { host: 'localhost', replicas: [{ host: 'a', port: 1 }, { host: 'b', port: 2 }] }, matrix: [[1, 2], [3]],
    script: 'echo hi\necho bye\n',
  });
  assert.equal(J.convert(json), [
    'name: app', "version: '1.0'", 'port: 8080', 'debug: false', 'owner: null', 'tags:', '  - web', '  - api', 'empty: []',
    'none: {}', 'db:', '  host: localhost', '  replicas:', '    - host: a', '      port: 1', '    - host: b', '      port: 2',
    'matrix:', '  - - 1', '    - 2', '  - - 3', 'script: |', '  echo hi', '  echo bye', '',
  ].join('\n'));
});

test('option: indentSequences=false, indent=4, sortKeys, flowLevel, quoteStyle, documentStart', () => {
  const json = '{"b":[1,{"x":"y z"}],"a":{"c":"yes"}}';
  assert.equal(J.convert(json, { indentSequences: false }), 'b:\n- 1\n- x: y z\na:\n  c: \'yes\'\n');
  assert.equal(J.convert(json, { indent: 4 }), 'b:\n    - 1\n    -   x: y z\na:\n    c: \'yes\'\n');
  assert.equal(J.convert(json, { sortKeys: true }), "a:\n  c: 'yes'\nb:\n  - 1\n  - x: y z\n");
  assert.equal(J.convert(json, { flowLevel: 1 }), "b: [1, {x: y z}]\na: {c: 'yes'}\n");
  assert.equal(J.convert(json, { flowLevel: 0 }), "{b: [1, {x: y z}], a: {c: 'yes'}}\n");
  assert.equal(J.convert(json, { quoteStyle: 'double', documentStart: true }), '---\nb:\n  - 1\n  - x: y z\na:\n  c: "yes"\n');
  assert.equal(J.convert('"x"', { documentStart: true }), '--- x\n');
});

test('quotes every string a YAML parser would misread', () => {
  for (const s of NASTY) {
    const y = J.stringify({ k: s, [s]: s, list: [s] });
    assertRoundTrip(y, { k: s, [s]: s, list: [s] }, `string ${JSON.stringify(s)}`);
  }
});

test('multi-line strings use literal blocks with correct chomping', () => {
  assert.equal(J.stringify({ a: 'x\ny' }), 'a: |-\n  x\n  y\n');
  assert.equal(J.stringify({ a: 'x\ny\n' }), 'a: |\n  x\n  y\n');
  assert.equal(J.stringify({ a: 'x\ny\n\n' }), 'a: |+\n  x\n  y\n\n');
  assert.equal(J.stringify({ a: 'x\n\n', b: 1 }), 'a: |+\n  x\n\nb: 1\n');
  assert.equal(J.stringify(['x\n\ny']), '- |-\n  x\n\n  y\n');
  // not representable as a literal block → double quotes
  assert.equal(J.stringify({ a: ' lead\nx' }), 'a: " lead\\nx"\n');
  assert.equal(J.stringify({ a: 'trail \nx' }), 'a: "trail \\nx"\n');
  assert.equal(J.stringify({ a: 'x\ny' }, { blockScalars: false }), 'a: "x\\ny"\n');
  for (const s of ['x\ny', 'x\ny\n', 'x\n\n\n', '\nx', '\n\nx\n', 'a\n\n\nb\n\n']) {
    for (const opts of OPTION_SETS) assertRoundTrip(J.stringify({ s, l: [s, [s]] }, opts), { s, l: [s, [s]] }, JSON.stringify(s));
  }
});

test('keys longer than 1024 characters use explicit "? key" syntax', () => {
  const k = 'k'.repeat(1030);
  const y = J.stringify({ [k]: { a: 1 }, b: [k] });
  assert.ok(y.startsWith('? ' + k + '\n:\n  a: 1\n'));
  assertRoundTrip(y, { [k]: { a: 1 }, b: [k] }, 'long key');
});

test('fromJS handles Dates, Maps, undefined, BigInt, -0 and circular references', () => {
  assert.equal(J.stringify({ d: new Date('2020-01-02T03:04:05Z'), u: undefined, f() {}, n: 10n, z: -0, a: [undefined] }),
    "d: '2020-01-02T03:04:05.000Z'\n'n': 10\nz: -0\na:\n  - null\n");
  assert.equal(J.stringify(new Map([['x', 1]])), 'x: 1\n');
  const c = { a: 1 }; c.self = c;
  assert.throws(() => J.stringify(c), /circular/);
  assert.equal(J.stringify(NaN), '.nan\n');
});

test('toJSON preserves order and number text', () => {
  const src = '{"b":1.50,"1":[true,null,"x"],"e":{}}';
  assert.equal(J.toJSON(J.parse(src), 0), src);
  assert.equal(J.toJSON(J.parse(src)), '{\n  "b": 1.50,\n  "1": [\n    true,\n    null,\n    "x"\n  ],\n  "e": {}\n}');
});

test('fuzz: 6000 random documents round-trip through js-yaml, yaml 1.2 and yaml 1.1 with every option set', () => {
  const r = rng(7);
  for (let iter = 0; iter < 6000; iter++) {
    const ast = randomAst(r);
    const expected = J.toJS(ast);
    const opts = OPTION_SETS[iter % OPTION_SETS.length];
    assertRoundTrip(J.emit(ast, opts), expected, `iter ${iter} opts ${JSON.stringify(opts)}`);
  }
});

test('fuzz: multi-document streams round-trip', () => {
  const r = rng(99);
  for (let iter = 0; iter < 500; iter++) {
    const docs = Array.from({ length: 1 + Math.floor(r() * 4) }, () => randomAst(r));
    const y = J.emitDocuments(docs, OPTION_SETS[iter % OPTION_SETS.length]);
    const expected = docs.map(J.toJS);
    assert.ok(J.deepEqual(jsyaml.loadAll(y), expected), `js-yaml loadAll mismatch:\n${y}`);
    assert.ok(J.deepEqual(YAML.parseAllDocuments(y).map((d) => d.toJS({ maxAliasCount: -1 })), expected), `yaml mismatch:\n${y}`);
  }
});

// ======================================================================
// Schema inference
// ======================================================================

test('infers a sensible schema', () => {
  const schema = J.inferSchemaFromSamples([
    { id: 1, email: 'a@b.co', at: '2024-01-01T00:00:00Z', tags: ['x'], meta: null },
    { id: 2, email: 'c@d.io', at: '2024-02-01T10:00:00+05:00', tags: [], score: 1.5, meta: { k: true } },
  ], { title: 'User' });
  assert.deepEqual(schema, {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'User',
    type: 'object',
    properties: {
      id: { type: 'integer' },
      email: { type: 'string', format: 'email' },
      at: { type: 'string', format: 'date-time' },
      tags: { type: 'array', items: { type: 'string' } },
      meta: { type: ['object', 'null'], properties: { k: { type: 'boolean' } }, required: ['k'] },
      score: { type: 'number' },
    },
    required: ['id', 'email', 'at', 'tags', 'meta'],
  });
});

test('schema options: draft, closed objects, no required, no formats', () => {
  const s = J.inferSchema({ a: 'https://x.dev', b: [{ c: 1 }] }, { draft: '07', additionalProperties: false, required: false, detectFormats: false });
  assert.deepEqual(s, {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      a: { type: 'string' },
      b: { type: 'array', items: { type: 'object', properties: { c: { type: 'integer' } }, additionalProperties: false } },
    },
    additionalProperties: false,
  });
  assert.equal(J.inferSchema([1, 2.5]).items.type, 'number');
  assert.deepEqual(J.inferSchema([]), { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'array' });
  assert.deepEqual(J.inferSchema([1, 'a', null]).items.type, ['string', 'integer', 'null']);
});

test('inferred schema emitted as YAML is valid YAML that Ajv compiles', () => {
  const ast = J.parse(require('node:fs').readFileSync(path.join(__dirname, '..', 'examples', 'order.json'), 'utf8'));
  const y = J.emit(J.inferSchemaAST([ast]));
  const schema = jsyaml.load(y);
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  assert.equal(ajv.validate(schema, J.toJS(ast)), true);
});

// ======================================================================
// Validator
// ======================================================================

function ajvFor(schema) {
  const draft7 = typeof schema.$schema === 'string' && schema.$schema.includes('draft-07');
  const ajv = draft7 ? new AjvDraft7({ strict: false, validateFormats: false, allErrors: true, multipleOfPrecision: 9 })
    : new Ajv2020({ strict: false, validateFormats: false, allErrors: true, multipleOfPrecision: 9 });
  return ajv.compile(schema);
}

const VALIDATION_SUITE = [
  [{ type: 'integer' }, [1, 1.0, 1.5, '1', null]],
  [{ type: ['string', 'null'] }, ['a', null, 0]],
  [{ enum: [1, 'a', { b: [1] }] }, [1, 'a', { b: [1] }, { b: [2] }, 2]],
  [{ const: { a: [1, { b: null }] } }, [{ a: [1, { b: null }] }, { a: [1] }]],
  [{ minimum: 1, maximum: 3 }, [0, 1, 3, 4, 'x']],
  [{ exclusiveMinimum: 1, exclusiveMaximum: 3 }, [1, 2, 3]],
  [{ multipleOf: 0.1 }, [0.3, 0.35, 10, 1e10]],
  [{ multipleOf: 3 }, [9, 10, -3]],
  [{ minLength: 2, maxLength: 3 }, ['a', 'ab', 'abcd', ch(0x1f600, 0x1f600), ch(0x1f600)]],
  [{ pattern: '^[a-z]+\\d$' }, ['abc1', 'Abc1', 'x']],
  [{ pattern: '\\p{L}' }, ['\u00e9', '1']],
  [{ items: { type: 'number' }, minItems: 1, maxItems: 2 }, [[], [1], [1, 2, 3], [1, 'x']]],
  [{ prefixItems: [{ type: 'string' }, { type: 'number' }], items: false }, [['a', 1], ['a', 1, 2], [1, 'a'], ['a']]],
  [{ uniqueItems: true }, [[1, 2], [1, 1], [{ a: 1, b: 2 }, { b: 2, a: 1 }], [[1], [1]]]],
  [{ contains: { type: 'string' }, minContains: 2, maxContains: 3 }, [['a'], ['a', 'b'], ['a', 'b', 'c', 'd'], [1, 2]]],
  [{ contains: { const: 1 }, minContains: 0 }, [[], [2]]],
  [{ required: ['a', 'b'], properties: { a: { type: 'string' } } }, [{ a: 'x', b: 1 }, { a: 1, b: 1 }, { a: 'x' }, []]],
  [{ properties: { a: true }, patternProperties: { '^x-': { type: 'string' } }, additionalProperties: false },
    [{ a: 1 }, { 'x-y': 'z' }, { 'x-y': 1 }, { b: 1 }]],
  [{ additionalProperties: { type: 'integer' } }, [{ a: 1 }, { a: 'x' }]],
  [{ propertyNames: { maxLength: 3 }, minProperties: 1, maxProperties: 2 }, [{}, { abc: 1 }, { abcd: 1 }, { a: 1, b: 2, c: 3 }]],
  [{ dependentRequired: { card: ['cvv'] } }, [{ card: 1, cvv: 2 }, { card: 1 }, {}]],
  [{ dependentSchemas: { a: { required: ['b'] } } }, [{ a: 1, b: 2 }, { a: 1 }]],
  [{ allOf: [{ type: 'number' }, { minimum: 5 }] }, [6, 4, 'x']],
  [{ anyOf: [{ type: 'string' }, { minimum: 5 }] }, ['x', 6, 4]],
  [{ oneOf: [{ type: 'integer' }, { minimum: 5 }] }, [1, 5.5, 6]],
  [{ not: { type: 'string' } }, [1, 'x']],
  [{ if: { properties: { kind: { const: 'a' } } }, then: { required: ['x'] }, else: { required: ['y'] } },
    [{ kind: 'a', x: 1 }, { kind: 'a' }, { kind: 'b', y: 1 }, { kind: 'b', x: 1 }]],
  [{ $defs: { pos: { type: 'integer', minimum: 1 } }, type: 'array', items: { $ref: '#/$defs/pos' } }, [[1, 2], [0], [1.5]]],
  [{ $defs: { node: { type: 'object', properties: { v: { type: 'number' }, next: { $ref: '#/$defs/node' } }, required: ['v'] } }, $ref: '#/$defs/node' },
    [{ v: 1, next: { v: 2, next: { v: 3 } } }, { v: 1, next: { next: {} } }]],
  [{ $schema: 'http://json-schema.org/draft-07/schema#', items: [{ type: 'string' }], additionalItems: { type: 'number' } }, [['a', 1, 2], ['a', 'b'], [1]]],
  [{ $schema: 'http://json-schema.org/draft-07/schema#', definitions: { s: { type: 'string' } }, properties: { a: { $ref: '#/definitions/s' } }, dependencies: { a: ['b'], c: { required: ['d'] } } },
    [{ a: 'x', b: 1 }, { a: 1, b: 1 }, { a: 'x' }, { c: 1 }, { c: 1, d: 1 }]],
  [true, [1, null]],
  [false, [1]],
  [{ properties: { 'a/b': { type: 'string' }, 'c~d': { type: 'string' } } }, [{ 'a/b': 1, 'c~d': 2 }]],
];

test('validator agrees with Ajv on a keyword suite', () => {
  for (const [schema, instances] of VALIDATION_SUITE) {
    const check = typeof schema === 'boolean' ? (x) => schema : ajvFor(schema);
    for (const x of instances) {
      const mine = J.validate(x, schema, { formats: false });
      assert.equal(mine.valid, check(x), `schema ${JSON.stringify(schema)} instance ${JSON.stringify(x)}: ${JSON.stringify(mine.errors)}`);
      if (!mine.valid) assert.ok(mine.errors.length > 0);
    }
  }
});

test('validator reports JSON-pointer paths and messages', () => {
  const schema = { type: 'object', properties: { users: { type: 'array', items: { type: 'object', properties: { age: { type: 'integer' }, 'a/b': { type: 'string' } }, required: ['name'] } } } };
  const res = J.validate({ users: [{ name: 'x', age: 1 }, { age: 'old', 'a/b': 3 }] }, schema);
  assert.equal(res.valid, false);
  assert.deepEqual(res.errors.map((e) => `${e.path} ${e.keyword}`).sort(), ['/users/1 required', '/users/1/a~1b type', '/users/1/age type'].sort());
  assert.match(res.errors.find((e) => e.keyword === 'type' && e.path.endsWith('age')).message, /expected integer, got string/);
});

test('validator checks formats and raises SchemaError for bad schemas', () => {
  const s = { type: 'object', properties: { d: { format: 'date' }, e: { format: 'email' }, t: { format: 'date-time' }, u: { format: 'uuid' }, i: { format: 'ipv4' }, x: { format: 'unknown-format' } } };
  assert.equal(J.validate({ d: '2024-02-29', e: 'a@b.co', t: '2024-01-01T23:59:60.5Z', u: '8f14e45f-ceea-467a-9b7e-1f3e8a2c1d00', i: '10.0.0.255', x: 'anything' }, s).valid, true);
  const bad = J.validate({ d: '2023-02-29', e: 'a@b', t: '2024-01-01 10:00', u: 'nope', i: '256.1.1.1' }, s);
  assert.deepEqual(bad.errors.map((e) => e.path), ['/d', '/e', '/t', '/u', '/i']);
  assert.equal(J.validate({ d: 'nope' }, s, { formats: false }).valid, true);
  assert.throws(() => J.validate(1, { $ref: '#/nope' }), J.SchemaError);
  assert.throws(() => J.validate(1, { $ref: 'https://example.com/s.json' }), J.SchemaError);
  assert.throws(() => J.validate('a', { pattern: '(' }), J.SchemaError);
  assert.throws(() => J.validate(1, { $ref: '#' }), J.SchemaError); // infinite recursion guarded
  assert.throws(() => J.validate(1, 'nope'), J.SchemaError);
});

test('fuzz: every inferred schema accepts its samples (checked by us and by Ajv), and verdicts agree on mutated data', () => {
  const r = rng(2024);
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  let disagreements = 0, rejections = 0, ajvSkipped = 0;
  const iterCount = 1500;
  for (let iter = 0; iter < iterCount; iter++) {
    const samples = Array.from({ length: 1 + Math.floor(r() * 3) }, () => randomAst(r));
    const schema = J.toJS(J.inferSchemaAST(samples, { additionalProperties: iter % 2 === 0 }));
    let check = null;
    // Ajv cannot compile keys with lone surrogates: skip it there.
    // Ajv also treats inherited Object.prototype members (e.g. "constructor") as present properties.
    const protoKeys = Object.getOwnPropertyNames(Object.prototype);
    // ...and it ignores an empty-string name in "required".
    const json = JSON.stringify(schema);
    if (json.includes('""') || protoKeys.some((k) => json.includes(JSON.stringify(k)))) ajvSkipped++;
    else try { check = ajv.compile(schema); } catch (e) { ajvSkipped++; }
    for (const s of samples) {
      const x = J.toJS(s);
      assert.equal(J.validate(x, schema).valid, true, `inferred schema rejects its own sample (with formats): ${JSON.stringify(x)}`);
      if (check) assert.equal(check(x), true, `Ajv rejects sample: ${JSON.stringify(x)}`);
    }
    const other = J.toJS(randomAst(r));
    const mine = J.validate(other, schema, { formats: false }).valid;
    if (!mine) rejections++;
    if (check && mine !== check(other)) {
      disagreements++;
      if (process.env.DEBUG_FUZZ) console.log('DISAGREE', JSON.stringify(schema), JSON.stringify(other), mine);
    }
  }
  assert.equal(disagreements, 0);
  assert.ok(ajvSkipped < iterCount / 2, `Ajv skipped too many schemas (${ajvSkipped})`);
  assert.ok(rejections > 100, 'mutation check should exercise rejections');
});

// ======================================================================
// CLI
// ======================================================================

const CLI = path.join(__dirname, '..', 'bin', 'json2yaml.js');
const EX = path.join(__dirname, '..', 'examples');
const run = (args, input) => spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8' });

test('CLI: convert stdin and files, options, errors, exit codes', () => {
  let r = run([], '{"a":[1,{"b":"yes"}]}');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "a:\n  - 1\n  - b: 'yes'\n");
  r = run(['--sort-keys', '--indent', '4', '--no-indent-seq', '--quote=double', '-'], '{"z":[1],"a":"no"}');
  assert.equal(r.stdout, 'a: "no"\nz:\n- 1\n');
  r = run([], '{"a": 1,}');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /<stdin>:1:9: error: Trailing comma/);
  r = run(['--lenient'], '{"a": 1, /* c */}');
  assert.equal(r.stdout, 'a: 1\n');
  r = run(['--multi', '--flow-level', '1'], '{"a":[1,2]}\n{"b":{}}\n');
  assert.equal(r.stdout, '---\na: [1, 2]\n---\nb: {}\n');
  r = run(['--nope']);
  assert.equal(r.status, 2);
  r = run(['--indent', '9'], '{}');
  assert.equal(r.status, 2);
  r = run([path.join(EX, 'missing.json')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no such file/);
  assert.match(run(['--help']).stdout, /Usage:/);
  assert.equal(run(['--version']).stdout.trim(), J.VERSION);
});

test('CLI: infer schema and validate', () => {
  const order = path.join(EX, 'order.json');
  let r = run(['--schema', '--title', 'Order', order]);
  assert.equal(r.status, 0);
  const schema = jsyaml.load(r.stdout);
  assert.equal(schema.title, 'Order');
  assert.equal(schema.properties.items.items.properties.qty.type, 'integer');
  r = run(['--schema-json', '--draft', '07', order]);
  assert.equal(JSON.parse(r.stdout).$schema, 'http://json-schema.org/draft-07/schema#');

  const tmp = require('node:os').tmpdir();
  const schemaFile = path.join(tmp, `j2y-schema-${process.pid}.json`);
  require('node:fs').writeFileSync(schemaFile, run(['--schema-json', order]).stdout);
  r = run(['--validate', schemaFile, order]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /valid against/);
  assert.match(r.stdout, /^orderId:/);
  r = run(['--validate', schemaFile], '{"orderId": 5}');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\/orderId: expected string, got integer \[type\]/);
  assert.equal(r.stdout, '');
  const outFile = path.join(tmp, `j2y-out-${process.pid}`, 'o.yaml');
  r = run(['-o', outFile, order]);
  assert.equal(r.status, 0);
  assert.match(require('node:fs').readFileSync(outFile, 'utf8'), /^orderId:/);
});
