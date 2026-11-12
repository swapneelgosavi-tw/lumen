/**
 * GatewayScript (JavaScript/TypeScript running on IBM DataPower) routing extractor.
 *
 * Finds the places where a script decides where a request goes:
 *   serviceMetadata.setVar('var://service/routing-url', <expr>)
 *   urlopen.open({ target: <expr>, method: 'POST' }, cb)
 * and resolves <expr> statically (literals, templates, `+`, consts, assignments, route tables,
 * arrays of route objects). Each static route variant becomes one rule together with the enclosing
 * `if` / `switch` / ternary conditions, from which the request path and method it applies to are derived.
 */

const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const { summarizeConditions, isRoutableTarget, makeRule, scoreRule } = require('./common');

const MAX_DEPTH = 8;
const MAX_VARIANTS = 24;
const PASSTHROUGH_METHODS = new Set([
    'replace', 'substring', 'substr', 'slice', 'trim', 'toLowerCase', 'toUpperCase', 'concat',
    'toString', 'split', 'join', 'encodeURI', 'encodeURIComponent', 'String',
]);
const KEY_PROPS = ['prefix', 'path', 'match', 'pattern', 'route', 'context', 'name', 'uri', 'url'];
const GETVAR_ALIASES = {
    'var://service/uri': '{request.path}',
    'var://service/url-in': '{request.path}',
    'var://service/protocol-method': '{request.method}',
    'var://service/routing-url': '{routing-url}',
};

function parseScript(code) {
    const base = { sourceType: 'module', allowReturnOutsideFunction: true, errorRecovery: true };
    const attempts = [
        ['typescript', 'decorators-legacy'],
        ['decorators-legacy'],
    ];
    let lastError = null;
    for (const plugins of attempts) {
        try {
            return parser.parse(code, { ...base, plugins });
        } catch (e) {
            lastError = e;
        }
    }
    try {
        return parser.parse(code, { ...base, sourceType: 'script', plugins: [] });
    } catch (e) {
        throw lastError || e;
    }
}

function unwrap(node) {
    while (node && ['TSAsExpression', 'TSNonNullExpression', 'ParenthesizedExpression', 'AwaitExpression',
        'TSTypeAssertion', 'TSSatisfiesExpression'].includes(node.type)) {
        node = node.expression;
    }
    return node;
}

function propName(prop) {
    if (!prop || !prop.key) return null;
    if (prop.key.type === 'Identifier') return prop.computed ? null : prop.key.name;
    if (prop.key.type === 'StringLiteral') return prop.key.value;
    return null;
}

function extractGatewayScript(code, file, options = {}) {
    let ast;
    try {
        ast = parseScript(code);
    } catch (e) {
        return [];
    }
    const gateway = options.gateway || file;
    const src = (node) => code.slice(node.start, node.end);
    const bindings = new Map(); // name -> [{ node, path, kind }]
    const addBinding = (name, entry) => {
        if (!bindings.has(name)) bindings.set(name, []);
        bindings.get(name).push(entry);
    };
    const sinks = [];

    traverse(ast, {
        VariableDeclarator(p) {
            const { id, init } = p.node;
            if (id.type === 'Identifier') addBinding(id.name, { node: init || null, path: p, kind: 'decl' });
        },
        AssignmentExpression(p) {
            const { left, right, operator } = p.node;
            if (operator === '=' && left.type === 'Identifier') addBinding(left.name, { node: right, path: p, kind: 'assign' });
        },
        ForOfStatement(p) {
            const { left, right } = p.node;
            const decl = left.type === 'VariableDeclaration' ? left.declarations[0] : null;
            if (decl && decl.id.type === 'Identifier') addBinding(decl.id.name, { node: right, path: p, kind: 'iterate' });
        },
        CallExpression(p) {
            const { callee, arguments: args } = p.node;
            if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return;
            const method = callee.property.name;
            if ((method === 'forEach' || method === 'some' || method === 'every') && args[0] &&
                (args[0].type === 'ArrowFunctionExpression' || args[0].type === 'FunctionExpression')) {
                const param = args[0].params[0];
                if (param && param.type === 'Identifier') {
                    addBinding(param.name, { node: callee.object, path: p, kind: 'iterate' });
                }
            }
            if (method === 'setVar' && args.length >= 2) {
                const name = literalString(args[0]);
                if (name && /routing-url/i.test(name)) sinks.push({ kind: 'routing-url', path: p, target: args[1], line: p.node.loc.start.line });
            } else if (method === 'open' && args.length >= 1 && /urlopen/i.test(src(callee.object))) {
                sinks.push({ kind: 'urlopen', path: p, options: args[0], line: p.node.loc.start.line });
            }
        },
    });

    function literalString(node) {
        node = unwrap(node);
        if (!node) return null;
        if (node.type === 'StringLiteral') return node.value;
        if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis.map(q => q.value.cooked).join('');
        if (node.type === 'Identifier') {
            const b = bindings.get(node.name);
            if (b && b.length === 1 && b[0].node) return literalString(b[0].node);
        }
        return null;
    }

    function conditionsOf(path) {
        const conds = [];
        let child = path;
        let p = path.parentPath;
        while (p) {
            const n = p.node;
            if (/Function/.test(n.type) && n.type !== 'CallExpression') break;
            if (n.type === 'IfStatement' || n.type === 'ConditionalExpression') {
                if (child.key === 'consequent') conds.push({ text: src(n.test) });
                else if (child.key === 'alternate') conds.push({ text: src(n.test), neg: true });
            } else if (n.type === 'SwitchCase') {
                const sw = p.parentPath.node;
                if (n.test) {
                    const disc = sw.discriminant;
                    conds.push({ text: disc.type === 'BooleanLiteral' && disc.value ? src(n.test) : `${src(disc)} === ${src(n.test)}` });
                } else {
                    conds.push({ text: 'default', neg: true });
                }
            } else if (n.type === 'LogicalExpression' && n.operator === '&&' && child.key === 'right') {
                conds.push({ text: src(n.left) });
            }
            child = p;
            p = p.parentPath;
        }
        return conds;
    }

    function placeholder(node) {
        const n = unwrap(node);
        if (n && n.type === 'CallExpression' && n.callee.type === 'MemberExpression' &&
            n.callee.property.name === 'getVar' && n.arguments.length) {
            const name = literalString(n.arguments[0]);
            if (name) {
                const alias = GETVAR_ALIASES[name.toLowerCase()];
                return { text: alias || `{${name.replace(/^var:\/\//, '')}}`, ph: true };
            }
        }
        const text = n ? src(n).replace(/\s+/g, ' ') : 'expr';
        const clean = /^[\w$.\[\]'"]{1,40}$/.test(text) ? text.replace(/['"\[\]]/g, '') : 'expr';
        return { text: `{${clean}}`, ph: true };
    }

    function entryKey(obj) {
        for (const name of KEY_PROPS) {
            const prop = obj.properties.find(p => propName(p) === name);
            const v = prop && prop.value && unwrap(prop.value);
            if (v && v.type === 'StringLiteral') return v.value;
        }
        return '';
    }

    function cross(left, right, join) {
        const out = [];
        for (const a of left) {
            for (const b of right) {
                out.push({ ...join(a, b), conds: [...(a.conds || []), ...(b.conds || [])], key: a.key || b.key || '' });
                if (out.length >= MAX_VARIANTS) return out;
            }
        }
        return out;
    }

    const asText = (v, node) => (typeof v.text === 'string' ? v : { ...placeholder(node), conds: v.conds, key: v.key });

    function resolveAll(node, depth = 0, seen = new Set()) {
        node = unwrap(node);
        if (!node) return [placeholder(node)];
        if (depth > MAX_DEPTH) return [placeholder(node)];
        switch (node.type) {
            case 'StringLiteral': return [{ text: node.value }];
            case 'NumericLiteral': return [{ text: String(node.value) }];
            case 'TemplateLiteral': {
                let acc = [{ text: node.quasis[0].value.cooked }];
                node.expressions.forEach((e, i) => {
                    const parts = resolveAll(e, depth + 1, seen).map(v => asText(v, e));
                    acc = cross(acc, parts, (a, b) => ({ text: a.text + b.text }));
                    acc = cross(acc, [{ text: node.quasis[i + 1].value.cooked }], (a, b) => ({ text: a.text + b.text }));
                });
                return acc;
            }
            case 'BinaryExpression': {
                if (node.operator !== '+') return [placeholder(node)];
                const l = resolveAll(node.left, depth + 1, seen).map(v => asText(v, node.left));
                const r = resolveAll(node.right, depth + 1, seen).map(v => asText(v, node.right));
                return cross(l, r, (a, b) => ({ text: a.text + b.text }));
            }
            case 'ObjectExpression': return [{ obj: node }];
            case 'ArrayExpression': return [{ arr: node }];
            case 'Identifier': {
                const list = bindings.get(node.name);
                if (!list || seen.has(node.name)) return [placeholder(node)];
                const multi = list.length > 1;
                const next = new Set(seen).add(node.name);
                const out = [];
                for (const b of list) {
                    if (!b.node) continue;
                    const conds = multi ? conditionsOf(b.path) : [];
                    let variants = resolveAll(b.node, depth + 1, next);
                    if (b.kind === 'iterate') variants = elementsOf(variants);
                    for (const v of variants) out.push({ ...v, conds: [...(v.conds || []), ...conds] });
                }
                return out.length ? out.slice(0, MAX_VARIANTS) : [placeholder(node)];
            }
            case 'MemberExpression': {
                const objSrc = src(node.object);
                if (/^process\.env$/.test(objSrc) && !node.computed && node.property.type === 'Identifier') {
                    return [{ text: `{env.${node.property.name}}`, ph: true }];
                }
                const bases = resolveAll(node.object, depth + 1, seen);
                const out = [];
                for (const base of bases) {
                    if (base.obj) {
                        const lit = node.computed ? literalString(node.property) : node.property.name;
                        const props = base.obj.properties.filter(p => p.value && propName(p) !== null);
                        const chosen = lit !== null && lit !== undefined ? props.filter(p => propName(p) === lit) : props;
                        for (const p of chosen) {
                            const key = lit !== null && lit !== undefined ? base.key : propName(p);
                            for (const v of resolveAll(p.value, depth + 1, seen)) {
                                out.push({ ...v, key: v.key || key || base.key || '', conds: [...(base.conds || []), ...(v.conds || [])] });
                            }
                        }
                    } else if (base.arr && node.computed) {
                        out.push(...elementsOf([base]));
                    }
                }
                return out.length ? out.slice(0, MAX_VARIANTS) : [placeholder(node)];
            }
            case 'CallExpression': {
                const callee = node.callee;
                if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
                    const m = callee.property.name;
                    if (m === 'getVar') return [placeholder(node)];
                    if (m === 'find' || m === 'filter') return elementsOf(resolveAll(callee.object, depth + 1, seen));
                    if (PASSTHROUGH_METHODS.has(m)) {
                        return resolveAll(callee.object, depth + 1, seen).map(v => asText(v, callee.object));
                    }
                }
                return [placeholder(node)];
            }
            case 'ConditionalExpression': {
                const t = resolveAll(node.consequent, depth + 1, seen).map(v => ({ ...v, conds: [{ text: src(node.test) }, ...(v.conds || [])] }));
                const f = resolveAll(node.alternate, depth + 1, seen).map(v => ({ ...v, conds: [{ text: src(node.test), neg: true }, ...(v.conds || [])] }));
                return [...t, ...f].slice(0, MAX_VARIANTS);
            }
            case 'LogicalExpression': {
                const left = resolveAll(node.left, depth + 1, seen);
                if (node.operator === '&&') return resolveAll(node.right, depth + 1, seen);
                const concrete = left.filter(v => !v.ph);
                return concrete.length ? concrete : resolveAll(node.right, depth + 1, seen);
            }
            default: return [placeholder(node)];
        }
    }

    function elementsOf(variants) {
        const out = [];
        for (const v of variants) {
            if (!v.arr) { if (v.obj) out.push(v); continue; }
            for (const el of v.arr.elements) {
                if (!el) continue;
                const e = unwrap(el);
                if (e.type === 'ObjectExpression') out.push({ obj: e, key: entryKey(e) });
                else out.push(...resolveAll(e, MAX_DEPTH - 1));
            }
        }
        return out.slice(0, MAX_VARIANTS);
    }

    const rules = [];
    const seenRules = new Set();

    function emit(sink, variant, mechanism, reason, targetMethod) {
        const v = asText(variant, sink.path.node);
        const targetUrl = v.text.trim();
        if (!isRoutableTarget(targetUrl)) return;
        const conds = [...conditionsOf(sink.path), ...(variant.conds || [])];
        const dedup = new Set();
        const unique = conds.filter(c => {
            const k = `${c.neg ? '!' : ''}${c.text}`;
            if (dedup.has(k)) return false;
            dedup.add(k);
            return true;
        });
        const summary = summarizeConditions(unique);
        let matchPath = summary.matchPath;
        let matchMethod = summary.matchMethod;
        let matchCondition = summary.matchCondition;
        const key = (variant.key || '').trim();
        if (key) {
            const km = key.match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\/\S*)$/i);
            if (km) {
                matchMethod = matchMethod || km[1].toUpperCase();
                matchPath = matchPath || km[2];
            } else if (key.startsWith('/')) {
                matchPath = matchPath || (key.endsWith('*') ? key : `${key}*`);
            }
            matchCondition = matchCondition ? `${matchCondition} && route key = ${key}` : `route key = ${key}`;
        }
        const rule = makeRule({
            gateway,
            mechanism,
            file,
            line: sink.line,
            matchMethod: matchMethod || '',
            matchPath: matchPath || '',
            matchCondition,
            targetUrl,
            targetMethod: targetMethod || '',
            reason,
            confidence: scoreRule({ targetUrl, matchPath, matchCondition: matchCondition }),
        });
        const id = [rule.line, rule.targetUrl, rule.matchPath, rule.matchMethod, rule.matchCondition].join('|');
        if (seenRules.has(id)) return;
        seenRules.add(id);
        rules.push(rule);
    }

    for (const sink of sinks) {
        if (sink.kind === 'routing-url') {
            for (const v of resolveAll(sink.target)) emit(sink, v, 'gatewayscript', 'gatewayscript:routing-url');
        } else {
            const opts = unwrap(sink.options);
            const variants = resolveAll(opts);
            for (const v of variants) {
                if (v.obj) {
                    const targetProp = v.obj.properties.find(p => propName(p) === 'target');
                    const methodProp = v.obj.properties.find(p => propName(p) === 'method');
                    const method = methodProp ? literalString(methodProp.value) : null;
                    if (!targetProp) continue;
                    for (const t of resolveAll(targetProp.value)) {
                        emit(sink, { ...t, conds: [...(v.conds || []), ...(t.conds || [])], key: t.key || v.key }, 'gatewayscript-urlopen',
                            'gatewayscript:urlopen', method ? method.toUpperCase() : '');
                    }
                } else if (typeof v.text === 'string') {
                    emit(sink, v, 'gatewayscript-urlopen', 'gatewayscript:urlopen');
                }
            }
        }
    }
    return rules;
}

module.exports = { extractGatewayScript };
