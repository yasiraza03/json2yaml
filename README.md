# jsonyaml: JSON → YAML converter, schema inference and validation

A JSON → YAML toolkit with no runtime dependencies. It includes:

- **a strict JSON parser.** Errors give the exact line and column, with a code frame. Key order is kept exactly, and the original number text is kept, so `1.10` and `12345678901234567890` survive unchanged.
- **a YAML emitter.** The output reads the same in YAML 1.2 and YAML 1.1 parsers: strings like `yes`, `no`, `on`, `1.0`, `0x1F`, `12:30`, `2024-01-01`, `~` and `null` are quoted automatically, multi-line strings become `|` blocks, and control characters are escaped.
- **JSON Schema inference** from one or many samples (drafts 2020-12, 2019-09, 07, 06 and 04). It detects formats (date-time, date, time, email, uri, uuid, ipv4) and finds which fields are required.
- **a JSON Schema validator.** It supports type, enum, const, the numeric and string limits, pattern, format, `items`/`prefixItems`, contains, `uniqueItems`, properties/`patternProperties`/`additionalProperties`, required, `propertyNames`, `dependentRequired`/`dependentSchemas`/`dependencies`, `allOf`/`anyOf`/`oneOf`/`not`, `if`/`then`/`else` and local `$ref`/`$defs`. Errors are reported as JSON Pointer paths.
- **three ways to use it:** a CLI (`bin/json2yaml.js`), a library (`src/jsonyaml.js`, a UMD module for Node and browsers) and a self-contained web app (`web/index.html`).

## CLI

```bash
node bin/json2yaml.js config.json                 # JSON → YAML on stdout
cat data.json | node bin/json2yaml.js -o out.yaml  # stdin → file
node bin/json2yaml.js --sort-keys --indent 4 --no-indent-seq config.json
node bin/json2yaml.js --multi events.ndjson        # JSON Lines → multi-document YAML
node bin/json2yaml.js --lenient tsconfig.json      # allow comments + trailing commas
node bin/json2yaml.js --schema --title Order order.json > order.schema.yaml
node bin/json2yaml.js --schema-json --closed order.json > order.schema.json
node bin/json2yaml.js --validate order.schema.json order.json   # exit 1 if invalid
```

Run `node bin/json2yaml.js --help` for every option. To install it as a global command, run `npm install -g .`, which installs it as `json2yaml`. Exit codes: `0` ok, `1` invalid input, unreadable file or schema mismatch, `2` usage error.

Error output looks like this:

```
order.json:3:8: error: Unexpected token 'tru', expected a value
  1 | {
  2 |   "a": 1,
> 3 |   "b": tru
    |        ^
```

## Library

```js
const J = require('./src/jsonyaml.js');           // browsers: window.JsonYaml

J.convert('{"a": [1, "yes"]}');                    // "a:\n  - 1\n  - 'yes'\n"
J.convert(text, { indent: 4, sortKeys: true, flowLevel: 2, quoteStyle: 'double',
                  indentSequences: false, blockScalars: true, documentStart: true,
                  allowComments: true, allowTrailingCommas: true, multi: false });
J.stringify({ any: 'JS value' });                  // JS value → YAML

const ast = J.parse(text);                         // ordered AST (throws J.JSONParseError with .line/.column)
J.emit(ast, options);                              // AST → YAML
J.parseMulti(ndjson);                              // → AST[]
J.emitDocuments(asts, options);                    // → multi-document YAML
J.toJS(ast); J.fromJS(value); J.toJSON(ast, 2);

J.inferSchema(value, { draft: '2020-12', title: 'X', required: true,
                       detectFormats: true, additionalProperties: true });
J.inferSchemaFromSamples([v1, v2, v3]);
J.validate(value, schema, { formats: true });      // → { valid, errors: [{ path, keyword, message }], total }
J.nodeAt(ast, '/users/0/email');                   // → { node, pos }: map an error path back to the source text
```

## Web app

Open `web/index.html` in a browser. It is a single file built from `web/template.html` with `npm run build:web`. It has three modes:

- **Convert:** JSON → YAML with every option, or YAML → JSON. A live check confirms the output parses back to identical data.
- **Infer schema:** shows the inferred schema as YAML or JSON.
- **Validate:** paste a schema as JSON or YAML, or infer one from the input. Clicking an error jumps to the matching spot in your input.

The app also handles NDJSON and lenient JSON, opens dropped or picked files, and saves your work in the browser. All processing is local. The YAML → JSON direction and the round-trip badge load js-yaml from cdnjs.

## Tests

```bash
npm install          # dev-only: js-yaml, yaml, ajv (reference implementations for testing)
npm test             # 24 tests, including fuzzing
npm run test:e2e     # browser test of the web app (needs Playwright)
```

The test suite checks the code against independent reference implementations:

- **Parser:** 20,000 randomly mutated JSON texts must be accepted or rejected exactly as `JSON.parse` does, and give the same values.
- **Emitter:** 6,000 random documents built from adversarial strings (YAML keywords, number-like and date-like strings, indicator characters, lone surrogates, U+2028, BOMs, very long keys) are emitted with 8 option sets. Each must parse back to identical data with **js-yaml**, with **yaml** in YAML 1.2 core mode, and with **yaml** in YAML 1.1 mode.
- **Schema:** every inferred schema must accept its own samples, checked by this validator and by **Ajv**. The two must also give the same verdict on random unrelated data. A keyword suite is compared with Ajv's results directly.

## Notes

- A leading UTF-8 BOM is accepted. Duplicate keys follow `JSON.parse` (the last value wins) unless `duplicateKeys: 'error'` / `--strict-keys` is set.
- Numbers too large for a double (`1e400`) are emitted as `.inf`, matching what `JSON.parse` produces.
- The validator resolves only `$ref`s within the same schema (`#/...`, `$defs`, `definitions`, `$anchor`). Unknown `format` values are ignored, as the spec allows.
