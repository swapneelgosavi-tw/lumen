/**
 * IBM DataPower gateway routing detection (the `--mode datapower` of the JS parser CLI).
 *
 * Scans a directory for DataPower artifacts (GatewayScript, XSLT, configuration exports, API Connect YAML),
 * extracts the routing rules each one contains, and writes them to the graph as
 *   (GatewayRoute) -[ROUTES_TO]-> (ExternalApi)
 * where the ExternalApi is the final backend the gateway forwards to.
 */

const fs = require('fs');
const path = require('path');
const { extractGatewayScript } = require('./gatewayscript');
const { extractXslt } = require('./xslt');
const { extractXcfg } = require('./xcfg');
const { extractApic, isApiConnect } = require('./apic');
const { hostOf } = require('../outbound');

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'build', 'dist', 'out', 'venv', '.venv', '__pycache__', 'coverage', '.gradle', '.idea']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const GATEWAYSCRIPT_MARKER = /service-metadata|serviceMetadata|var:\/\/service\/|require\(\s*['"]urlopen['"]\s*\)/;
const XSLT_MARKER = /datapower\.com\/extensions|var:\/\/service\//;
const HTTP_VERBS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

/** Classify a file as a DataPower artifact kind (or null) from its extension and content. */
function classify(file, code) {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.xcfg') return 'xcfg';
    if ((ext === '.cfg' || ext === '.xml') && /<datapower-configuration/.test(code)) return 'xcfg';
    if (ext === '.xsl' || ext === '.xslt') return XSLT_MARKER.test(code) ? 'xslt' : null;
    if (['.js', '.ts', '.mjs'].includes(ext)) {
        return GATEWAYSCRIPT_MARKER.test(code) && /routing-url|urlopen/.test(code) ? 'gatewayscript' : null;
    }
    if (ext === '.yaml' || ext === '.yml') return isApiConnect(code) ? 'apic' : null;
    return null;
}

function walk(dir, out = []) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        return out;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            walk(full, out);
        } else if (entry.isFile()) {
            out.push(full);
        }
    }
    return out;
}

function defaultGatewayName(rel) {
    const dir = path.dirname(rel);
    return dir && dir !== '.' ? path.basename(dir) : path.basename(rel, path.extname(rel));
}

/** Scan `root` and return `{ rules, counts }`. Rule `file` paths are relative to `root`. */
function scanDatapower(root) {
    const found = [];
    for (const full of walk(root)) {
        let stat;
        try {
            stat = fs.statSync(full);
        } catch (e) {
            continue;
        }
        if (stat.size > MAX_FILE_BYTES || /\.(min|bundle|chunk)\.js$/.test(full)) continue;
        const ext = path.extname(full).toLowerCase();
        if (!['.xcfg', '.cfg', '.xml', '.xsl', '.xslt', '.js', '.ts', '.mjs', '.yaml', '.yml'].includes(ext)) continue;
        let code;
        try {
            code = fs.readFileSync(full, 'utf-8');
        } catch (e) {
            continue;
        }
        const kind = classify(full, code);
        if (kind) found.push({ full, rel: path.relative(root, full), code, kind });
    }

    const counts = { xcfg: 0, xslt: 0, gatewayscript: 0, apic: 0 };
    const scriptRefs = [];
    const rules = [];
    const scripts = []; // [{ rel, rules }]

    for (const f of found.filter(x => x.kind === 'xcfg')) {
        counts.xcfg++;
        const r = extractXcfg(f.code, f.rel);
        rules.push(...r.rules);
        scriptRefs.push(...r.scriptRefs);
    }
    for (const f of found.filter(x => x.kind === 'apic')) {
        counts.apic++;
        rules.push(...extractApic(f.code, f.rel));
    }
    for (const f of found.filter(x => x.kind === 'xslt' || x.kind === 'gatewayscript')) {
        counts[f.kind]++;
        const extract = f.kind === 'xslt' ? extractXslt : extractGatewayScript;
        scripts.push({ rel: f.rel, rules: extract(f.code, f.rel, { gateway: defaultGatewayName(f.rel) }) });
    }

    const overridden = new Set(); // gateway|matchPath handled by a referenced script
    for (const script of scripts) {
        const contexts = scriptRefs.filter(c => script.rel === c.ref || script.rel.endsWith(`/${c.ref}`) || path.basename(script.rel) === path.basename(c.ref));
        if (!contexts.length) {
            rules.push(...script.rules);
            continue;
        }
        for (const ctx of contexts) {
            for (const rule of script.rules) {
                const inherited = { ...rule, gateway: ctx.gateway };
                if (!rule.matchPath) inherited.matchPath = ctx.matchPath || '';
                if (!rule.matchMethod) inherited.matchMethod = ctx.matchMethod || '';
                if (ctx.matchCondition) {
                    inherited.matchCondition = rule.matchCondition ? `${ctx.matchCondition} && ${rule.matchCondition}` : ctx.matchCondition;
                }
                rules.push(inherited);
                overridden.add(`${ctx.gateway}|${ctx.matchPath}`);
            }
        }
    }

    const final = rules.filter(r => !(r.mechanism === 'xcfg-backend-url' && overridden.has(`${r.gateway}|${r.matchPath}`)));
    final.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    return { rules: final, counts };
}

/** Add GatewayRoute + final ExternalApi nodes and ROUTES_TO edges to a CodeGraphBuilder. */
function addRoutesToGraph(graph, rules) {
    let n = 0;
    for (const rule of rules) {
        const verb = HTTP_VERBS.has(rule.targetMethod) ? rule.targetMethod : (HTTP_VERBS.has(rule.matchMethod) ? rule.matchMethod : 'ANY');
        const targetHost = hostOf(rule.targetUrl);
        const routeId = `gwroute:${rule.gateway}:${rule.file}:${rule.line}:${n++}`;
        const label = [rule.matchMethod, rule.matchPath].filter(Boolean).join(' ') || '(all requests)';
        graph.addNode(routeId, 'GATEWAY_ROUTE', `${rule.gateway} ${label}`, `${rule.gateway}:${rule.file}:${rule.line}`, {
            gateway: rule.gateway,
            mechanism: rule.mechanism,
            matchMethod: rule.matchMethod || '',
            matchPath: rule.matchPath || '',
            matchHost: '',
            matchCondition: rule.matchCondition || '',
            targetUrl: rule.targetUrl,
            targetMethod: rule.targetMethod || '',
            targetHost,
            filePath: rule.file,
            lineNumber: rule.line,
            confidence: rule.confidence,
            reason: rule.reason || '',
            language: 'datapower',
        });
        const apiId = `extapi:${verb} ${rule.targetUrl}`;
        if (!graph.hasNode(apiId)) {
            graph.addNode(apiId, 'EXTERNAL_API', `${verb} ${rule.targetUrl}`, rule.targetUrl, {
                httpMethod: verb,
                url: rule.targetUrl,
                host: targetHost,
                client: 'datapower',
                language: 'datapower',
            });
        }
        graph.addRelationship(routeId, apiId, 'ROUTES_TO', { confidence: rule.confidence, reason: rule.reason || '' });
    }
    return n;
}

module.exports = { scanDatapower, addRoutesToGraph, classify };
