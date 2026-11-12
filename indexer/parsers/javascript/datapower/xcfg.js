/**
 * DataPower configuration export (.xcfg / .cfg XML) extractor.
 *
 * Understands the common objects of an export:
 *   MultiProtocolGateway (BackendUrl), XMLFirewallService (RemoteAddress/RemotePort), WSGateway/WebServiceProxy
 *   (remote endpoint), StylePolicy -> StylePolicyRule -> StylePolicyAction (route-action Destination, xform
 *   Transform, gatewayscript location) and Matching (Url match rules).
 *
 * Element names are matched tolerantly because export schemas differ between firmware versions; rules that
 * depend on guessed structure carry a lower confidence. Script references (xsl/js) are returned so the caller
 * can attribute rules found in those files to the gateway and URL match that triggers them.
 */

const { DOMParser } = require('@xmldom/xmldom');
const { makeRule, scoreRule } = require('./common');

const GATEWAY_CLASSES = new Set([
    'MultiProtocolGateway', 'XMLFirewallService', 'WSGateway', 'WebServiceProxy', 'XMLManager', 'HTTPSourceProtocolHandler',
    'WebAppFW',
]);
const BACKEND_TAGS = ['BackendUrl', 'RemoteAddress', 'RemoteEndpointHost', 'RemoteEndpointURL', 'RemoteURL'];
const SCRIPT_REF = /(?:local|store|dpdir|temporary):\/\/\/?([^\s<>"']*\.(?:xsl|xslt|js|ts))/i;

const local = (el) => el.localName || String(el.nodeName).split(':').pop();

function childElements(el) {
    const out = [];
    for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c);
    return out;
}

const text = (el) => (el && el.textContent ? el.textContent.trim() : '');

function descendants(el, pred, out = []) {
    for (const c of childElements(el)) {
        if (pred(c)) out.push(c);
        descendants(c, pred, out);
    }
    return out;
}

function firstChildText(el, names) {
    for (const c of childElements(el)) {
        if (names.includes(local(c))) return text(c);
    }
    return '';
}

function normalizeBase(url) {
    const u = url.trim();
    if (!u || /^(?:\*|dynamic)$/i.test(u) || /^https?:\/\/(?:0\.0\.0\.0|\*)(?::\d+)?\/?$/i.test(u)) return '';
    return u;
}

function backendOf(gw) {
    let url = '';
    for (const tag of BACKEND_TAGS) {
        const el = childElements(gw).find(c => local(c) === tag);
        if (el && text(el)) {
            url = text(el);
            break;
        }
    }
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return normalizeBase(url);
    const portEl = childElements(gw).find(c => /^(RemotePort|RemoteEndpointPort)$/.test(local(c)));
    const port = portEl ? text(portEl) : '';
    const tls = childElements(gw).some(c => /^(SSLClient|SSLClientConfigType|SSLConfigType)$/.test(local(c)) && text(c) && text(c) !== 'off') || port === '443';
    const scheme = tls ? 'https' : 'http';
    const defaultPort = tls ? '443' : '80';
    return normalizeBase(`${scheme}://${url}${port && port !== defaultPort ? `:${port}` : ''}`);
}

function extractXcfg(code, file) {
    const doc = new DOMParser({ onError: () => {} }).parseFromString(code, 'text/xml');
    const root = doc && doc.documentElement;
    if (!root) return { rules: [], scriptRefs: [] };

    const objects = {}; // class -> name -> element
    const all = descendants(root, el => !!el.getAttribute('name'));
    for (const el of all) {
        const cls = local(el);
        (objects[cls] = objects[cls] || {})[el.getAttribute('name')] = el;
    }
    const lookup = (cls, name) => (objects[cls] && objects[cls][name]) || null;

    const rules = [];
    const scriptRefs = [];

    for (const el of all) {
        const kids = childElements(el).map(local);
        const isGateway = GATEWAY_CLASSES.has(local(el)) || kids.some(k => BACKEND_TAGS.includes(k) || k === 'StylePolicy');
        if (!isGateway || !kids.some(k => BACKEND_TAGS.includes(k) || k === 'StylePolicy')) continue;
        const gateway = el.getAttribute('name');
        const base = backendOf(el);
        const line = el.lineNumber || 0;

        const policyName = firstChildText(el, ['StylePolicy']);
        const policy = policyName ? lookup('StylePolicy', policyName) : null;
        let ruleCount = 0;

        if (policy) {
            const maps = descendants(policy, c => local(c) === 'PolicyMaps');
            for (const map of maps) {
                const matchName = firstChildText(map, ['Match']);
                const ruleName = firstChildText(map, ['Rule']);
                const matching = matchName ? lookup('Matching', matchName) : null;
                const policyRule = ruleName ? lookup('StylePolicyRule', ruleName) : null;
                const urls = matching ? descendants(matching, c => local(c) === 'Url').map(text).filter(Boolean) : [];
                const methodValues = matching
                    ? descendants(matching, c => local(c) === 'HttpValue').map(text).filter(v => /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/i.test(v))
                    : [];
                const matchPaths = urls.length ? urls : [''];
                const actions = policyRule
                    ? descendants(policyRule, c => local(c) === 'Actions').map(text).map(n => lookup('StylePolicyAction', n)).filter(Boolean)
                    : [];
                let destination = '';
                for (const action of actions) {
                    const dest = firstChildText(action, ['Destination']);
                    if (dest && /^https?:\/\//i.test(dest)) destination = dest;
                    for (const c of childElements(action)) {
                        const m = text(c).match(SCRIPT_REF);
                        if (m && /^(Transform|GatewayScriptLocation|Stylesheet|ProcessingControlFile)$/i.test(local(c))) {
                            for (const matchPath of matchPaths) {
                                scriptRefs.push({ ref: m[1], gateway, matchPath, matchMethod: (methodValues[0] || '').toUpperCase(), matchCondition: matchName ? `matching ${matchName}` : '' });
                            }
                        }
                    }
                }
                const targetUrl = destination || base;
                if (!targetUrl) continue;
                for (const matchPath of matchPaths) {
                    const matchMethod = (methodValues[0] || '').toUpperCase();
                    rules.push(makeRule({
                        gateway, mechanism: destination ? 'xcfg-route-action' : 'xcfg-backend-url', file, line: (policyRule && policyRule.lineNumber) || line,
                        matchMethod, matchPath, matchCondition: matchName ? `matching ${matchName}${ruleName ? ` -> rule ${ruleName}` : ''}` : '',
                        targetUrl, reason: destination ? 'xcfg:route-action' : 'xcfg:backend-url',
                        confidence: scoreRule({ targetUrl, matchPath, matchCondition: '', base: 0.7 }),
                    }));
                    ruleCount++;
                }
            }
        }
        if (base && ruleCount === 0) {
            rules.push(makeRule({
                gateway, mechanism: 'xcfg-backend-url', file, line, targetUrl: base, reason: 'xcfg:backend-url',
                confidence: scoreRule({ targetUrl: base, matchPath: '', matchCondition: '', base: 0.7 }),
            }));
        }
        if (policy && ruleCount === 0 && !base) {
            for (const c of descendants(policy, x => SCRIPT_REF.test(text(x)) && childElements(x).length === 0)) {
                scriptRefs.push({ ref: text(c).match(SCRIPT_REF)[1], gateway, matchPath: '', matchMethod: '', matchCondition: '' });
            }
        }
    }
    return { rules, scriptRefs };
}

module.exports = { extractXcfg };
