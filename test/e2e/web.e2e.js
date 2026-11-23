// Browser end-to-end test for web/index.html. Requires Playwright (npm i -D playwright, or a global install).
// Optional: CHROME_PATH=/path/to/chrome to use an existing browser.
let playwright;
try { playwright = require('playwright'); } catch (_) {
  playwright = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
}
const { chromium } = playwright;
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const jsyamlSrc = fs.readFileSync(path.join(ROOT, 'node_modules', 'js-yaml', 'dist', 'js-yaml.min.js'), 'utf8');
const assert = require('assert');

(async () => {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const shots = [];
  for (const scheme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, colorScheme: scheme });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/fonts|ERR_/.test(m.text())) errors.push(m.text()); });
    await page.route('**/js-yaml.min.js', (r) => r.fulfill({ body: jsyamlSrc, contentType: 'application/javascript' }));
    await page.route('https://fonts.googleapis.com/**', (r) => r.abort());
    await page.goto('file://' + path.join(ROOT, 'web', 'index.html'));
    await page.waitForFunction(() => window.jsyaml && document.querySelector('#st-rt').textContent.includes('verified'));
    const out = () => page.$eval('#out', (e) => e.innerText);
    const status = () => page.$eval('footer', (e) => e.innerText);

    // 1. default convert
    let o = await out();
    assert(o.includes("version: '1.10'") && o.includes('new-cart: \'yes\'') && o.includes('notes: |'), 'convert output');
    assert((await status()).includes('Round-trip verified'));

    // 2. options
    await page.selectOption('[data-opt="indent"]', '4');
    await page.check('[data-opt="sortKeys"]');
    await page.selectOption('[data-opt="flowLevel"]', '2');
    o = await out();
    assert(/^build:/m.test(o) && o.includes('    - {auth: oauth2, methods: [GET, POST], path: /v1/orders'), 'options applied:\n' + o.slice(0, 600));
    await page.selectOption('[data-opt="indent"]', '2');
    await page.uncheck('[data-opt="sortKeys"]');
    await page.selectOption('[data-opt="flowLevel"]', '-1');

    // 3. error handling
    await page.fill('#in', '{\n  "a": 1,\n  "b": [1, 2,, 3]\n}');
    await page.waitForTimeout(150);
    assert((await status()).includes('line 3, col 14'), 'error status: ' + await status());
    assert((await out()).includes('Go to error'));
    await page.click('#btn-jump');
    const sel = await page.$eval('#in', (t) => t.selectionStart);
    assert.equal(sel, 25);

    // 4. lenient
    await page.fill('#in', '// cfg\n{"a": [1, 2,], /* x */ "b": "on",}');
    await page.check('[data-opt="lenient"]');
    o = await out();
    assert(o.includes("b: 'on'"), 'lenient');
    await page.uncheck('[data-opt="lenient"]');

    // 5. multi
    await page.check('[data-opt="multi"]');
    await page.click('#btn-sample');
    o = await out();
    assert((o.match(/^---$/gm) || []).length === 3, 'multi docs');
    assert((await status()).includes('3 documents'));

    // 6. schema mode
    await page.click('[data-mode="schema"]');
    o = await out();
    assert(o.includes('format: date-time') && o.includes('required:'), 'schema yaml');
    await page.fill('[data-sopt="title"]', 'Event');
    await page.selectOption('[data-sopt="as"]', 'json');
    o = await out();
    const schemaJson = JSON.parse(o);
    assert.equal(schemaJson.title, 'Event');
    assert.deepEqual(schemaJson.required, ['event', 'user', 'at', 'plan']);
    await page.selectOption('[data-sopt="as"]', 'yaml');

    // 7. validate mode
    await page.click('[data-mode="validate"]');
    await page.click('#btn-use-inferred');
    o = await out();
    assert(o.includes('All 3 documents match'), 'validate ok: ' + o);
    // break a document
    const v = await page.$eval('#in', (t) => t.value);
    await page.fill('#in', v.replace('"seats":5', '"seats":"five"').replace('"plan":"free"', '"plan":1'));
    await page.waitForTimeout(150);
    o = await out();
    assert(o.includes('expected integer, got string') && o.includes('/seats'), 'validate errors: ' + o);
    await page.click('.issue >> nth=0');
    // YAML schema
    await page.uncheck('[data-opt="multi"]');
    await page.fill('#in', '{"name": "x", "age": -1, "email": "nope"}');
    await page.fill('#schema', 'type: object\nrequired: [name, age, id]\nproperties:\n  age: {type: integer, minimum: 0}\n  email: {type: string, format: email}\nadditionalProperties: false\n');
    await page.waitForTimeout(150);
    o = await out();
    for (const s of ['missing required property "id"', 'must be >= 0', 'must be a valid email', 'property "name" is not allowed']) assert(o.includes(s), 'yaml schema: ' + s + '\n' + o);
    await page.fill('#schema', '{"type": "object",, }');
    await page.waitForTimeout(150);
    assert((await out()).includes('Invalid schema JSON'), 'bad schema');
    await page.fill('#schema', '{"$ref": "#/nope"}');
    await page.waitForTimeout(150);
    assert((await out()).includes('Cannot resolve $ref'), 'schema error');

    // 8. YAML -> JSON
    await page.click('[data-mode="convert"]');
    await page.fill('#in', '{"k": [1, "yes", null], "s": "a\\nb"}');
    await page.waitForTimeout(150);
    await page.click('[data-dir="y2j"]');
    o = await out();
    assert.deepEqual(JSON.parse(o), { k: [1, 'yes', null], s: 'a\nb' }, 'y2j carries output over');
    await page.fill('#in', 'a: [1, 2\nb: 3');
    await page.waitForTimeout(150);
    assert((await out()).includes('Invalid YAML'));
    await page.click('[data-dir="j2y"]');

    // 9. copy button
    await page.click('#btn-sample');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
    await page.click('#btn-copy');
    await page.waitForSelector('#toast.show');

    // 10. persistence
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#out').innerText.length > 0);
    assert((await out()).includes('service: checkout-api'));

    // 11. mobile layout
    await page.setViewportSize({ width: 390, height: 844 });
    await page.setViewportSize({ width: 1400, height: 900 });

    // 12. large input performance
    const big = JSON.stringify(Array.from({ length: 20000 }, (_, i) => ({ id: i, name: 'item ' + i, tags: ['a', 'b'], price: i * 1.5, ok: i % 2 === 0 })));
    const t0 = Date.now();
    await page.$eval('#in', (t, v) => { t.value = v; t.dispatchEvent(new Event('input')); }, big);
    await page.waitForFunction(() => document.querySelector('#out-meta').textContent.includes('lines') && document.querySelector('#st-stats').textContent.includes('100000 keys'), null, { timeout: 30000 }).catch(() => {});
    await page.waitForFunction(() => document.querySelector('#st-rt').textContent.includes('verified'), null, { timeout: 30000 });
    console.log(scheme, 'large input (' + (big.length / 1048576).toFixed(1) + ' MB) converted+verified in', Date.now() - t0, 'ms');

    assert.deepEqual(errors, [], 'page errors: ' + errors.join('\n'));
    console.log(scheme, 'OK');
    await page.close();
  }
  await browser.close();
})().catch((e) => { console.error('E2E FAILED:', e.message); process.exit(1); });
