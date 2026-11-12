/**
 * Shared helpers for the DataPower routing extractors.
 *
 * Every extractor produces rules of the same shape:
 *   { gateway, mechanism, file, line, matchMethod, matchPath, matchCondition, targetUrl, confidence, reason }
 * `matchPath` is a glob (`/payments/*`, exact `/charge`, or `*` anywhere); `targetUrl` may hold `{placeholders}`
 * for parts that are only known at runtime.
 */

const VERB_LIST = 'GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS';
const VERB_LITERAL = new RegExp(`['"](${VERB_LIST})['"]`);
const NEGATED_VERB = new RegExp(`!==?\\s*['"](${VERB_LIST})['"]`);

/** Turn a regular expression body such as `^\/pay(ments)?\/` into a path glob (`/pay*`), or null. */
function regexToGlob(source) {
    let s = String(source || '');
    const anchoredStart = s.startsWith('^');
    if (anchoredStart) s = s.slice(1);
    const anchoredEnd = s.endsWith('$');
    if (anchoredEnd) s = s.slice(0, -1);
    s = s
        .replace(/\\\//g, '/')
        .replace(/\\\./g, '\u0000')
        .replace(/\((?:\?:)?[^)]*\)[?*+]?/g, '*')
        .replace(/\\[dws][+*]?|\[[^\]]*\][+*]?|\.[*+]/g, '*')
        .replace(/\u0000/g, '.')
        .replace(/\*+/g, '*');
    if (!s.includes('/')) return null;
    if (!s.startsWith('/') && !s.startsWith('*')) s = `*${s}`;
    if (!anchoredStart && !s.startsWith('*')) s = `*${s}`;
    if (!anchoredEnd && !s.endsWith('*')) s += '*';
    return s;
}

/**
 * Read the request path / HTTP method a condition checks, from its source text.
 * Understands JS (`startsWith`, `indexOf(..) === 0`, `===`, regex `.test`) and XPath (`starts-with`, `=`, `contains`).
 */
function deriveFromText(text) {
    const t = String(text || '');
    let matchPath = null;
    let m;
    if ((m = t.match(/(?:starts-with\(.*?,\s*|startsWith\(\s*)['"]([^'"]*)['"]\s*\)/))) {
        matchPath = m[1].startsWith('/') ? `${m[1]}*` : null;
    } else if ((m = t.match(/indexOf\(\s*['"](\/[^'"]*)['"]\s*\)\s*={2,3}\s*0\b/))) {
        matchPath = `${m[1]}*`;
    } else if ((m = t.match(/indexOf\(\s*['"](\/[^'"]*)['"]\s*\)\s*(?:>=\s*0|>\s*-1|!==?\s*-1)/))) {
        matchPath = `*${m[1]}*`;
    } else if ((m = t.match(/(?:contains\(.*?,\s*|includes\(\s*)['"](\/[^'"]*)['"]\s*\)/))) {
        matchPath = `*${m[1]}*`;
    } else if ((m = t.match(/\/((?:\\\/|[^\/\n])+)\/[a-z]*\s*\.(?:test|exec)\(/)) ||
               (m = t.match(/\.match\(\s*\/((?:\\\/|[^\/\n])+)\/[a-z]*/)) ||
               (m = t.match(/matches\(\s*[^,]+,\s*['"]([^'"]+)['"]/))) {
        matchPath = regexToGlob(m[1]);
    } else if ((m = t.match(/={1,3}\s*['"](\/[^'"]*)['"]/)) || (m = t.match(/['"](\/[^'"]*)['"]\s*={1,3}/))) {
        matchPath = m[1];
    }

    let matchMethod = null;
    const verb = t.match(VERB_LITERAL);
    const verbEquality = new RegExp(`={1,3}\\s*['"](?:${VERB_LIST})['"]|['"](?:${VERB_LIST})['"]\\s*={1,3}`).test(t);
    if (verb && (verbEquality || /method|verb/i.test(t)) && !NEGATED_VERB.test(t) && !/!=/.test(t)) matchMethod = verb[1];
    return { matchPath, matchMethod };
}

/** Innermost-first condition list -> the most specific path/method plus a readable condition string. */
function summarizeConditions(conditions) {
    let matchPath = null;
    let matchMethod = null;
    for (const c of conditions) {
        if (c.neg) continue;
        const d = deriveFromText(c.text);
        if (!matchPath && d.matchPath) matchPath = d.matchPath;
        if (!matchMethod && d.matchMethod) matchMethod = d.matchMethod;
    }
    const text = [...conditions].reverse()
        .filter(c => !/^!?[\w$.]+$/.test(c.text.trim()))
        .map(c => (c.neg ? `not (${c.text})` : c.text).replace(/\s+/g, ' ').trim())
        .join(' && ');
    return { matchPath, matchMethod, matchCondition: text.length > 240 ? `${text.slice(0, 237)}...` : text };
}

/** True for http(s) URLs and for `{placeholder}/path` style targets. */
function isRoutableTarget(url) {
    return /^https?:\/\//i.test(url || '') || /^\{[^}]+\}(?:\/|$)/.test(url || '');
}

function makeRule(fields) {
    return {
        gateway: '',
        mechanism: '',
        file: '',
        line: 0,
        matchMethod: '',
        matchPath: '',
        matchCondition: '',
        targetUrl: '',
        targetMethod: '',
        confidence: 0.7,
        reason: '',
        ...fields,
    };
}

/** Confidence from how much of the rule could be resolved statically. */
function scoreRule({ targetUrl, matchPath, matchCondition, base = 0.75 }) {
    let score = base;
    if (!/^https?:\/\//i.test(targetUrl || '')) score -= 0.3;
    else if ((targetUrl.match(/\{/g) || []).length) score -= 0.15;
    if (matchCondition && !matchPath) score -= 0.1;
    if (matchPath) score += 0.1;
    return Math.max(0.2, Math.min(0.95, Math.round(score * 100) / 100));
}

module.exports = { regexToGlob, deriveFromText, summarizeConditions, isRoutableTarget, makeRule, scoreRule };
