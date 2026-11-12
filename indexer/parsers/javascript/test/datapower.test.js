const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PARSER = path.join(__dirname, '..', 'parse.js');
const FIXTURES = path.join(__dirname, 'fixtures', 'datapower');

function scan(dir) {
    const run = spawnSync('node', [PARSER, dir, '--mode', 'datapower', '--backend', 'json'], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    assert.strictEqual(run.status, 0, run.stderr);
    const graph = JSON.parse(run.stdout);
    const prop = (n, key) => (n.properties ? n.properties[key] : n[key]);
    const rules = graph.nodes.filter(n => n.type === 'GATEWAY_ROUTE').map(n => ({
        gateway: prop(n, 'gateway'),
        mechanism: prop(n, 'mechanism'),
        matchMethod: prop(n, 'matchMethod'),
        matchPath: prop(n, 'matchPath'),
        matchCondition: prop(n, 'matchCondition'),
        targetUrl: prop(n, 'targetUrl'),
        targetMethod: prop(n, 'targetMethod'),
        targetHost: prop(n, 'targetHost'),
        line: prop(n, 'lineNumber'),
    }));
    return { graph, rules, stderr: run.stderr };
}

function scanFiles(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-datapower-'));
    try {
        for (const [name, content] of Object.entries(files)) {
            const full = path.join(dir, name);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, content);
        }
        return scan(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const find = (rules, mechanism, urlPart) => rules.find(r => r.mechanism === mechanism && (r.targetUrl || '').includes(urlPart));

test('extracts routing from GatewayScript, XSLT, xcfg and API Connect fixtures', () => {
    const { rules, graph } = scan(FIXTURES);

    const orders = find(rules, 'gatewayscript', 'partner.example.com/orders-api');
    assert.ok(orders, 'GatewayScript setVar routing-url rule');
    assert.strictEqual(orders.matchPath, '/orders*');

    assert.ok(find(rules, 'gatewayscript-urlopen', 'audit.example.com/log'), 'urlopen target');

    const xslt = find(rules, 'xslt-routing-url', 'pay.example.com/api');
    assert.ok(xslt, 'XSLT dp:set-variable routing-url');
    assert.strictEqual(xslt.matchMethod, 'POST');
    assert.strictEqual(xslt.matchPath, '/payments*');
    assert.ok(find(rules, 'xslt-url-open', 'refund.example.com'), 'XSLT dp:url-open');

    assert.ok(find(rules, 'xcfg-backend-url', 'legacy.internal:9090'), 'MultiProtocolGateway/firewall backend');
    assert.ok(find(rules, 'apic-invoke', 'pay.example.com/api/v2/charges'), 'API Connect invoke');

    const finals = graph.nodes.filter(n => n.type === 'EXTERNAL_API');
    assert.ok(finals.length > 0);
    assert.ok(graph.relationships.some(r => r.type === 'ROUTES_TO'));
});

test('XSLT referenced from a config export inherits the gateway name and match rule', () => {
    const { rules } = scan(FIXTURES);

    const routed = rules.find(r => r.gateway === 'PaymentsGW' && (r.targetUrl || '').includes('pay-routed.example.com'));
    assert.ok(routed, 'script rule is attributed to the gateway that references it');
    assert.strictEqual(routed.matchPath, '/payments/*');
});

test('conditions and route tables become one rule per branch', () => {
    const { rules } = scanFiles({
        'gw/router.js': `
const sm = require('service-metadata');
const uri = sm.URI;
const routes = { '/kyc': 'https://kyc.example.com', '/cards': 'https://cards.example.com/v1' };
for (const key of Object.keys(routes)) {
  if (uri.startsWith(key)) { sm.setVar('var://service/routing-url', routes[key] + uri); }
}
if (uri === '/legacy') { sm.setVar('var://service/routing-url', 'http://legacy.internal:8080/x'); }
`,
    });

    const urls = rules.map(r => r.targetUrl).sort();
    assert.ok(urls.some(u => u.startsWith('https://kyc.example.com')), urls.join('\n'));
    assert.ok(urls.some(u => u.startsWith('https://cards.example.com/v1')));
    const legacy = rules.find(r => r.targetUrl === 'http://legacy.internal:8080/x');
    assert.strictEqual(legacy.matchPath, '/legacy');
});

test('files without DataPower markers produce no rules', () => {
    const { rules, stderr } = scanFiles({
        'src/app.js': "const axios = require('axios'); axios.get('https://example.com');",
        'config/app.yaml': 'name: demo\n',
        'view/page.xsl': '<xsl:stylesheet xmlns:xsl="http://www.w3.org/1999/XSL/Transform" version="1.0"/>',
    });

    assert.deepStrictEqual(rules, []);
    assert.match(stderr, /no gateway routing rules found/);
});

test('writes GatewayRoute nodes and ROUTES_TO edges to KuzuDB', () => {
    const db = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-datapower-db-'));
    try {
        const run = spawnSync('node', [PARSER, FIXTURES, '--mode', 'datapower', '--db-path', db, '--repo-name', 'demo'], { encoding: 'utf-8' });
        assert.strictEqual(run.status, 0, run.stderr);
        assert.match(run.stderr, /DataPower: \d+ gateway routing rule/);
        assert.ok(fs.existsSync(path.join(db, 'demo-db')));
    } finally {
        fs.rmSync(db, { recursive: true, force: true });
    }
});
