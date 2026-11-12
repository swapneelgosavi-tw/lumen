/**
 * API Connect (DataPower API Gateway) API definition extractor.
 *
 * Walks `x-ibm-configuration.assembly.execute`, following `operation-switch` / `switch` / `if` branches, and turns
 * every `invoke` / `proxy` action into a routing rule. `$(property)` references resolve through
 * `x-ibm-configuration.properties`; `$(request.path)` and friends stay as `{request.path}` placeholders.
 * Inline `gatewayscript` actions are analysed with the GatewayScript extractor.
 */

const YAML = require('yaml');
const { summarizeConditions, isRoutableTarget, makeRule, scoreRule } = require('./common');
const { extractGatewayScript } = require('./gatewayscript');

const VERBS = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/i;

function isApiConnect(code) {
    return /x-ibm-configuration\s*:/.test(code) && /assembly\s*:/.test(code);
}

function extractApic(code, file, options = {}) {
    const lineCounter = new YAML.LineCounter();
    let doc;
    try {
        doc = YAML.parseDocument(code, { lineCounter });
    } catch (e) {
        return [];
    }
    const data = doc.toJS({ maxAliasCount: 100 }) || {};
    const cfg = data['x-ibm-configuration'];
    if (!cfg || !cfg.assembly || !cfg.assembly.execute) return [];

    const gateway = options.gateway || cfg['x-ibm-name'] || (data.info && (data.info['x-ibm-name'] || data.info.title)) || file;
    let basePath = typeof data.basePath === 'string' ? data.basePath : '';
    if (!basePath && Array.isArray(data.servers) && data.servers[0] && data.servers[0].url) {
        const m = String(data.servers[0].url).match(/^(?:https?:\/\/[^/]+)?(\/.*)?$/);
        basePath = (m && m[1]) || '';
    }
    basePath = basePath.replace(/\/+$/, '');
    const props = {};
    for (const [name, value] of Object.entries(cfg.properties || {})) {
        const v = value && typeof value === 'object' ? (value.value !== undefined ? value.value : value.default) : value;
        if (typeof v === 'string' || typeof v === 'number') props[name] = String(v);
    }

    const lineOf = (node) => (node && node.range ? lineCounter.linePos(node.range[0]).line : 0);
    const getNode = (map, key) => (YAML.isMap(map) ? map.get(key, true) : null);

    function resolve(str) {
        const resolved = String(str).replace(/\$\(([^)]+)\)/g, (_, name) => {
            if (Object.prototype.hasOwnProperty.call(props, name)) return props[name];
            return `{${name}}`;
        });
        return resolved.includes('$(') ? resolved : resolved.replace(/\{\{([^}]+)\}\}/g, '{$1}');
    }

    const rules = [];
    const seen = new Set();

    function addRule(line, mechanism, reason, targetUrl, conds, targetMethod, extra = {}) {
        if (!isRoutableTarget(targetUrl)) return;
        const s = summarizeConditions(conds.filter(c => c.text));
        let matchPath = extra.matchPath || s.matchPath || '';
        const matchMethod = extra.matchMethod || s.matchMethod || '';
        if (matchPath && basePath && matchPath.startsWith('/') && !matchPath.startsWith(`${basePath}/`) && matchPath !== basePath) {
            matchPath = `${basePath}${matchPath}`;
        }
        if (!matchPath && basePath) matchPath = `${basePath}/*`;
        const rule = makeRule({
            gateway, mechanism, file, line, matchMethod, matchPath, matchCondition: s.matchCondition,
            targetUrl, targetMethod: targetMethod || '', reason,
            confidence: scoreRule({ targetUrl, matchPath: s.matchPath || extra.matchPath, matchCondition: s.matchCondition, base: 0.85 }),
        });
        const id = [line, rule.targetUrl, rule.matchPath, rule.matchMethod, rule.matchCondition].join('|');
        if (seen.has(id)) return;
        seen.add(id);
        rules.push(rule);
    }

    function walkSeq(seq, conds, extra) {
        if (!YAML.isSeq(seq)) return;
        for (const item of seq.items) walkAction(item, conds, extra);
    }

    function walkAction(item, conds, extra) {
        if (!YAML.isMap(item)) return;
        for (const pair of item.items) {
            const kind = String(pair.key && pair.key.value !== undefined ? pair.key.value : pair.key);
            const body = pair.value;
            if (kind === 'invoke' || kind === 'proxy') {
                const url = getNode(body, 'target-url');
                const verb = getNode(body, 'verb');
                if (url && url.value !== undefined) {
                    const v = verb && verb.value ? String(verb.value) : '';
                    addRule(lineOf(url), `apic-${kind}`, `apic:${kind}`, resolve(url.value), conds, VERBS.test(v) ? v.toUpperCase() : '', extra);
                }
            } else if (kind === 'gatewayscript') {
                const source = getNode(body, 'source');
                if (source && typeof source.value === 'string') {
                    const startLine = lineOf(source) + (/^[|>]/.test(String(source.source || '')) || source.type === 'BLOCK_LITERAL' || source.type === 'BLOCK_FOLDED' ? 1 : 0);
                    const inner = extractGatewayScript(source.value, file, { gateway });
                    const outer = summarizeConditions(conds.filter(c => c.text));
                    for (const r of inner) {
                        r.line = startLine + r.line - 1;
                        r.mechanism = 'apic-gatewayscript';
                        r.reason = `apic:${r.reason}`;
                        if (!r.matchPath && (extra.matchPath || outer.matchPath)) r.matchPath = extra.matchPath || outer.matchPath;
                        if (!r.matchMethod && (extra.matchMethod || outer.matchMethod)) r.matchMethod = extra.matchMethod || outer.matchMethod;
                        if (!r.matchPath && basePath) r.matchPath = `${basePath}/*`;
                        if (outer.matchCondition) r.matchCondition = r.matchCondition ? `${outer.matchCondition} && ${r.matchCondition}` : outer.matchCondition;
                        rules.push(r);
                    }
                }
            } else if (kind === 'operation-switch') {
                const cases = getNode(body, 'case');
                if (YAML.isSeq(cases)) {
                    for (const c of cases.items) {
                        const ops = getNode(c, 'operations');
                        const opList = YAML.isSeq(ops) ? ops.items.map(o => o.toJS(doc)) : [];
                        const first = opList.find(o => o && o.path) || {};
                        const verb = first.verb && VERBS.test(first.verb) ? String(first.verb).toUpperCase() : '';
                        const text = opList.map(o => `${String(o.verb || '').toUpperCase()} ${o.path || ''}`.trim()).join(', ');
                        walkSeq(getNode(c, 'execute'), [{ text }, ...conds], { matchPath: first.path || '', matchMethod: verb });
                    }
                }
            } else if (kind === 'switch') {
                const cases = getNode(body, 'case');
                const earlier = [];
                if (YAML.isSeq(cases)) {
                    for (const c of cases.items) {
                        const condition = getNode(c, 'condition');
                        const text = condition && condition.value !== undefined ? String(condition.value) : '';
                        const negs = earlier.map(t => ({ text: t, neg: true }));
                        walkSeq(getNode(c, 'execute'), [{ text }, ...negs, ...conds], extra);
                        earlier.push(text);
                    }
                }
                walkSeq(getNode(body, 'otherwise'), [...earlier.map(t => ({ text: t, neg: true })), ...conds], extra);
            } else if (kind === 'if') {
                const condition = getNode(body, 'condition');
                const text = condition && condition.value !== undefined ? String(condition.value) : '';
                walkSeq(getNode(body, 'execute'), [{ text }, ...conds], extra);
                walkSeq(getNode(body, 'else'), [{ text, neg: true }, ...conds], extra);
            } else if (YAML.isMap(body)) {
                for (const sub of ['execute', 'catch', 'default', 'otherwise']) walkSeq(getNode(body, sub), conds, extra);
            } else if (YAML.isSeq(body)) {
                walkSeq(body, conds, extra);
            }
        }
    }

    const executeNode = YAML.isMap(doc.contents) ? doc.getIn(['x-ibm-configuration', 'assembly', 'execute'], true) : null;
    walkSeq(executeNode, [], {});
    return rules;
}

module.exports = { extractApic, isApiConnect };
