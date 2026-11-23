#!/usr/bin/env node
'use strict';
// Inlines src/jsonyaml.js into web/template.html → web/index.html (one self-contained file).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const lib = fs.readFileSync(path.join(root, 'src', 'jsonyaml.js'), 'utf8');
const tpl = fs.readFileSync(path.join(root, 'web', 'template.html'), 'utf8');

if (/<\/script/i.test(lib)) throw new Error('library source contains "</script" and cannot be inlined');
if (!tpl.includes('/*__JSONYAML__*/')) throw new Error('template is missing the /*__JSONYAML__*/ placeholder');

const out = tpl.replace('/*__JSONYAML__*/', () => lib);
fs.writeFileSync(path.join(root, 'web', 'index.html'), out);
console.log(`web/index.html written (${(Buffer.byteLength(out) / 1024).toFixed(1)} KB)`);
