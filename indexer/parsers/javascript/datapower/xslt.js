/**
 * XSLT (DataPower stylesheet) routing extractor.
 *
 * Finds
 *   <dp:set-variable name="'var://service/routing-url'" value="..."/>
 *   <dp:url-open target="..."> ... </dp:url-open>
 * and evaluates the XPath value statically (string literals, concat(), $variables, dp:variable()).
 * Enclosing xsl:when / xsl:if tests become the rule's match conditions.
 */

const { DOMParser } = require('@xmldom/xmldom');
const { summarizeConditions, isRoutableTarget, makeRule, scoreRule } = require('./common');

const MAX_VARIANTS = 24;
const GETVAR_ALIASES = {
    'var://service/uri': '{request.path}',
    'var://service/url-in': '{request.path}',
    'var://service/protocol-method': '{request.method}',
};
const PASSTHROUGH_FUNCS = new Set(['string', 'normalize-space', 'substring-after', 'substring-before', 'substring', 'translate', 'lower-case', 'upper-case']);

function elementChildren(el) {
    const out = [];
    for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c);
    return out;
}

const local = (el) => el.localName || String(el.nodeName).split(':').pop();

function splitTopLevel(text, sep) {
    const parts = [];
    let depth = 0;
    let quote = null;
    let cur = '';
    for (const ch of text) {
        if (quote) {
            cur += ch;
            if (ch === quote) quote = null;
        } else if (ch === '\'' || ch === '"') {
            quote = ch;
            cur += ch;
        } else if (ch === '(') {
            depth++;
            cur += ch;
        } else if (ch === ')') {
            depth--;
            cur += ch;
        } else if (ch === sep && depth === 0) {
            parts.push(cur);
            cur = '';
        } else {
            cur += ch;
        }
    }
    parts.push(cur);
    return parts.map(p => p.trim());
}

function cross(left, right) {
    const out = [];
    for (const a of left) {
        for (const b of right) {
            out.push({ text: a.text + b.text, conds: [...(a.conds || []), ...(b.conds || [])] });
            if (out.length >= MAX_VARIANTS) return out;
        }
    }
    return out;
}

function placeholder(expr) {
    const t = expr.trim();
    const clean = /^[\w$:.\/@*-]{1,40}$/.test(t) ? t.replace(/^\$/, '') : 'expr';
    return [{ text: `{${clean}}`, ph: true, conds: [] }];
}

function extractXslt(code, file, options = {}) {
    const gateway = options.gateway || file;
    const doc = new DOMParser({ onError: () => {} }).parseFromString(code, 'text/xml');
    const root = doc && doc.documentElement;
    if (!root) return [];

    const variables = new Map(); // name -> [element]
    (function collect(el) {
        for (const c of elementChildren(el)) {
            if (local(c) === 'variable' && c.getAttribute('name')) {
                const name = c.getAttribute('name');
                if (!variables.has(name)) variables.set(name, []);
                variables.get(name).push(c);
            }
            collect(c);
        }
    })(root);

    const dpVar = (expr) => {
        const m = expr.match(/^(?:dp:)?variable\(\s*['"]([^'"]+)['"]\s*\)$/);
        if (!m) return null;
        const name = m[1];
        return [{ text: GETVAR_ALIASES[name.toLowerCase()] || `{${name.replace(/^var:\/\//, '')}}`, ph: true, conds: [] }];
    };

    function conditionsOf(el) {
        const conds = [];
        let child = el;
        let p = el.parentNode;
        while (p && p.nodeType === 1) {
            const name = local(p);
            if (name === 'when') {
                conds.push({ text: p.getAttribute('test') || '' });
                for (let s = p.previousSibling; s; s = s.previousSibling) {
                    if (s.nodeType === 1 && local(s) === 'when') conds.push({ text: s.getAttribute('test') || '', neg: true });
                }
            } else if (name === 'otherwise') {
                for (let s = p.previousSibling; s; s = s.previousSibling) {
                    if (s.nodeType === 1 && local(s) === 'when') conds.push({ text: s.getAttribute('test') || '', neg: true });
                }
            } else if (name === 'if') {
                conds.push({ text: p.getAttribute('test') || '' });
            } else if (name === 'template') {
                break;
            }
            child = p;
            p = p.parentNode;
        }
        return conds;
    }

    function evalXPath(expr, depth = 0, seen = new Set()) {
        const e = String(expr || '').trim();
        if (!e || depth > 8) return placeholder(e || 'expr');
        let m;
        if ((m = e.match(/^'([^']*)'$/)) || (m = e.match(/^"([^"]*)"$/))) return [{ text: m[1], conds: [] }];
        if (/^\d+(\.\d+)?$/.test(e)) return [{ text: e, conds: [] }];
        const pv = dpVar(e);
        if (pv) return pv;
        if ((m = e.match(/^\$([\w.-]+)$/))) return evalVariable(m[1], depth, seen);
        if ((m = e.match(/^concat\((.*)\)$/s))) {
            let acc = [{ text: '', conds: [] }];
            for (const arg of splitTopLevel(m[1], ',')) acc = cross(acc, evalXPath(arg, depth + 1, seen));
            return acc;
        }
        if ((m = e.match(/^([\w-]+)\((.*)\)$/s)) && PASSTHROUGH_FUNCS.has(m[1])) {
            const first = splitTopLevel(m[2], ',')[0];
            return evalXPath(first, depth + 1, seen);
        }
        if ((m = e.match(/^\((.*)\)$/s))) return evalXPath(m[1], depth + 1, seen);
        return placeholder(e);
    }

    function evalVariable(name, depth, seen) {
        const els = variables.get(name);
        if (!els || seen.has(name)) return placeholder(`$${name}`);
        const next = new Set(seen).add(name);
        const out = [];
        for (const el of els) {
            const select = el.getAttribute('select');
            if (select) out.push(...evalXPath(select, depth + 1, next));
            else out.push(...evalBody(el, depth + 1, next, []));
        }
        return out.length ? out.slice(0, MAX_VARIANTS) : placeholder(`$${name}`);
    }

    /** Evaluate sequence-constructor content: text, xsl:value-of, xsl:choose/if. */
    function evalBody(el, depth, seen, conds) {
        let acc = [{ text: '', conds: [] }];
        let hasContent = false;
        for (let c = el.firstChild; c; c = c.nextSibling) {
            let part = null;
            if (c.nodeType === 3 || c.nodeType === 4) {
                const t = c.nodeValue.trim();
                if (t) part = [{ text: t, conds: [] }];
            } else if (c.nodeType === 1) {
                const name = local(c);
                if (name === 'value-of') {
                    part = evalXPath(c.getAttribute('select'), depth + 1, seen);
                } else if (name === 'text') {
                    part = [{ text: c.textContent || '', conds: [] }];
                } else if (name === 'choose') {
                    part = [];
                    const whens = [];
                    for (const branch of elementChildren(c)) {
                        const bn = local(branch);
                        if (bn === 'when') {
                            const test = branch.getAttribute('test') || '';
                            const own = [...whens.map(t => ({ text: t, neg: true })), { text: test }];
                            for (const v of evalBody(branch, depth + 1, seen, [])) part.push({ ...v, conds: [...own, ...(v.conds || [])] });
                            whens.push(test);
                        } else if (bn === 'otherwise') {
                            const own = whens.map(t => ({ text: t, neg: true }));
                            for (const v of evalBody(branch, depth + 1, seen, [])) part.push({ ...v, conds: [...own, ...(v.conds || [])] });
                        }
                    }
                } else if (name === 'if') {
                    const test = c.getAttribute('test') || '';
                    part = evalBody(c, depth + 1, seen, []).map(v => ({ ...v, conds: [{ text: test }, ...(v.conds || [])] }));
                }
            }
            if (part && part.length) {
                hasContent = true;
                acc = cross(acc, part);
            }
        }
        return hasContent ? acc : placeholder('expr');
    }

    const rules = [];
    const seenRules = new Set();

    function emit(el, variants, mechanism, reason, targetMethod) {
        for (const v of variants) {
            const targetUrl = (v.text || '').trim();
            if (!isRoutableTarget(targetUrl)) continue;
            const dedup = new Set();
            const conds = [...conditionsOf(el), ...(v.conds || [])].filter(c => {
                const k = `${c.neg ? '!' : ''}${c.text}`;
                if (dedup.has(k) || !c.text) return false;
                dedup.add(k);
                return true;
            });
            const s = summarizeConditions(conds);
            const rule = makeRule({
                gateway, mechanism, file, line: el.lineNumber || 0,
                matchMethod: s.matchMethod || '', matchPath: s.matchPath || '', matchCondition: s.matchCondition,
                targetUrl, targetMethod: targetMethod || '', reason,
                confidence: scoreRule({ targetUrl, matchPath: s.matchPath, matchCondition: s.matchCondition }),
            });
            const id = [rule.line, rule.targetUrl, rule.matchPath, rule.matchMethod, rule.matchCondition].join('|');
            if (seenRules.has(id)) continue;
            seenRules.add(id);
            rules.push(rule);
        }
    }

    (function walk(el) {
        for (const c of elementChildren(el)) {
            const name = local(c);
            if (name === 'set-variable') {
                const varName = evalXPath(c.getAttribute('name') || '').map(v => v.text).join('');
                if (/routing-url$/i.test(varName)) {
                    const value = c.getAttribute('value');
                    const variants = value ? evalXPath(value) : evalBody(c, 0, new Set(), []);
                    emit(c, variants, 'xslt-routing-url', 'xslt:routing-url');
                }
            } else if (name === 'url-open') {
                const target = c.getAttribute('target');
                let variants = null;
                if (target) variants = evalXPath(target);
                else {
                    const t = elementChildren(c).find(x => local(x) === 'target');
                    if (t) variants = t.getAttribute('select') ? evalXPath(t.getAttribute('select')) : evalBody(t, 0, new Set(), []);
                }
                if (variants) {
                    const methodAttr = c.getAttribute('http-method') || c.getAttribute('method') || '';
                    const method = evalXPath(methodAttr).map(v => v.text).join('').replace(/[{}]/g, '').toUpperCase();
                    emit(c, variants, 'xslt-url-open', 'xslt:url-open', /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(method) ? method : '');
                }
            }
            walk(c);
        }
    })(root);
    return rules;
}

module.exports = { extractXslt };
