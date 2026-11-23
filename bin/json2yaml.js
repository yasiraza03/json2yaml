#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const J = require('../src/jsonyaml.js');

const HELP = `json2yaml ${J.VERSION} — convert JSON to YAML, infer and validate JSON Schema

Usage:
  json2yaml [options] [input.json]        read a file (or stdin when omitted or "-")

Output:
  -o, --output FILE        write to FILE instead of stdout
      --indent N           spaces per indentation level, 1-8 (default 2)
      --no-indent-seq      put sequence dashes at the parent key's column
      --sort-keys          sort mapping keys alphabetically
      --flow-level N       render collections nested N levels deep in {flow} style
      --quote STYLE        quote style for strings that need quotes: single | double
      --no-block           never use | literal blocks for multi-line strings
      --doc-start          begin the document with ---

Input:
  -m, --multi              input is JSON Lines / NDJSON / concatenated JSON;
                           emits a multi-document YAML stream
  -l, --lenient            allow // and /* */ comments and trailing commas
      --strict-keys        fail on duplicate object keys

Schema:
  -s, --schema             output a JSON Schema inferred from the input instead of the data
      --draft D            schema draft: 2020-12 (default), 2019-09, 07, 06, 04
      --title TEXT         title for the inferred schema
      --closed             set additionalProperties: false on inferred objects
      --no-required        do not mark properties as required
      --no-formats         do not detect string formats (date, email, uri, ...)
      --schema-json        print the inferred schema as JSON instead of YAML
  -V, --validate FILE      validate the input against a JSON Schema file before
                           converting; exits with status 1 if it does not match
      --no-validate-formats  ignore "format" keywords while validating

  -h, --help               show this help
  -v, --version            print the version

Exit status: 0 success, 1 invalid input or schema mismatch, 2 usage error.

Examples:
  json2yaml package.json
  curl -s https://api.example.com/items | json2yaml --sort-keys -o items.yaml
  json2yaml --schema --title Order order.json > order.schema.yaml
  json2yaml --validate order.schema.json order.json
  json2yaml --multi events.ndjson`;

function usage(msg) {
  process.stderr.write(`json2yaml: ${msg}\nRun "json2yaml --help" for usage.\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const a = {
    yaml: {}, parse: {}, schema: {},
    input: null, output: null, multi: false, inferSchema: false, schemaJson: false,
    validate: null, validateFormats: true,
  };
  const need = (i, flag) => {
    if (i + 1 >= argv.length) usage(`option ${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inline = null;
    if (/^--[^=]+=/.test(arg)) { inline = arg.slice(arg.indexOf('=') + 1); arg = arg.slice(0, arg.indexOf('=')); }
    const val = (flag) => {
      if (inline !== null) return inline;
      need(i, flag);
      return argv[++i];
    };
    switch (arg) {
      case '-h': case '--help': process.stdout.write(HELP + '\n'); process.exit(0); break;
      case '-v': case '--version': process.stdout.write(J.VERSION + '\n'); process.exit(0); break;
      case '-o': case '--output': a.output = val(arg); break;
      case '--indent': {
        const n = Number(val(arg));
        if (!Number.isInteger(n) || n < 1 || n > 8) usage('--indent must be an integer from 1 to 8');
        a.yaml.indent = n; break;
      }
      case '--no-indent-seq': a.yaml.indentSequences = false; break;
      case '--sort-keys': a.yaml.sortKeys = true; break;
      case '--flow-level': {
        const n = Number(val(arg));
        if (!Number.isInteger(n) || n < 0) usage('--flow-level must be a non-negative integer');
        a.yaml.flowLevel = n; break;
      }
      case '--quote': {
        const q = val(arg);
        if (q !== 'single' && q !== 'double') usage('--quote must be "single" or "double"');
        a.yaml.quoteStyle = q; break;
      }
      case '--no-block': a.yaml.blockScalars = false; break;
      case '--doc-start': a.yaml.documentStart = true; break;
      case '-m': case '--multi': a.multi = true; break;
      case '-l': case '--lenient': a.parse.allowComments = true; a.parse.allowTrailingCommas = true; break;
      case '--strict-keys': a.parse.duplicateKeys = 'error'; break;
      case '-s': case '--schema': a.inferSchema = true; break;
      case '--draft': {
        const d = val(arg).replace(/^draft-?/, '');
        if (!['2020-12', '2019-09', '07', '7', '06', '6', '04', '4'].includes(d)) usage('--draft must be one of 2020-12, 2019-09, 07, 06, 04');
        a.schema.draft = d; break;
      }
      case '--title': a.schema.title = val(arg); break;
      case '--closed': a.schema.additionalProperties = false; break;
      case '--no-required': a.schema.required = false; break;
      case '--no-formats': a.schema.detectFormats = false; break;
      case '--schema-json': a.schemaJson = true; a.inferSchema = true; break;
      case '-V': case '--validate': a.validate = val(arg); break;
      case '--no-validate-formats': a.validateFormats = false; break;
      case '-': if (a.input) usage('only one input file may be given'); a.input = '-'; break;
      default:
        if (arg.startsWith('-')) usage(`unknown option ${arg}`);
        if (a.input) usage('only one input file may be given');
        a.input = arg;
    }
  }
  return a;
}

function readInput(file) {
  if (!file || file === '-') {
    if (process.stdin.isTTY) usage('no input: pass a file name or pipe JSON into stdin');
    return { text: fs.readFileSync(0, 'utf8'), name: '<stdin>' };
  }
  try {
    return { text: fs.readFileSync(file, 'utf8'), name: file };
  } catch (e) {
    process.stderr.write(`json2yaml: cannot read ${file}: ${e.code === 'ENOENT' ? 'no such file' : e.message}\n`);
    process.exit(1);
  }
}

function reportParseError(e, src, name) {
  if (e instanceof J.JSONParseError) {
    process.stderr.write(`${name}:${e.line}:${e.column}: error: ${e.reason}\n${J.codeFrame(src, e.line, e.column)}\n`);
    process.exit(1);
  }
  throw e;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const { text, name } = readInput(a.input);

  let docs;
  try {
    docs = a.multi ? J.parseMulti(text, a.parse) : [J.parse(text, a.parse)];
  } catch (e) { reportParseError(e, text, name); }

  if (a.validate) {
    const sch = readInput(a.validate);
    let schemaNode;
    try { schemaNode = J.parse(sch.text, { allowComments: true, allowTrailingCommas: true }); } catch (e) { reportParseError(e, sch.text, sch.name); }
    const schema = J.toJS(schemaNode);
    let failed = 0;
    docs.forEach((d, idx) => {
      let res;
      try { res = J.validate(J.toJS(d), schema, { formats: a.validateFormats }); } catch (e) {
        if (e instanceof J.SchemaError) { process.stderr.write(`${sch.name}: schema error: ${e.message}\n`); process.exit(1); }
        throw e;
      }
      if (!res.valid) {
        failed++;
        const where = a.multi ? `${name} (document ${idx + 1})` : name;
        process.stderr.write(`${where}: does not match ${sch.name} (${res.total} error${res.total === 1 ? '' : 's'}):\n`);
        for (const err of res.errors) process.stderr.write(`  ${err.path}: ${err.message} [${err.keyword}]\n`);
      }
    });
    if (failed) process.exit(1);
    process.stderr.write(`${name}: valid against ${sch.name}\n`);
  }

  let out;
  if (a.inferSchema) {
    const schemaAst = J.inferSchemaAST(docs, a.schema);
    out = a.schemaJson ? J.toJSON(schemaAst, 2) + '\n' : J.emit(schemaAst, a.yaml);
  } else if (a.multi) {
    out = J.emitDocuments(docs, a.yaml);
  } else {
    out = J.emit(docs[0], a.yaml);
  }

  if (a.output) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(a.output)), { recursive: true });
      fs.writeFileSync(a.output, out);
    } catch (e) {
      process.stderr.write(`json2yaml: cannot write ${a.output}: ${e.message}\n`);
      process.exit(1);
    }
  } else {
    process.stdout.write(out);
  }
}

main();
