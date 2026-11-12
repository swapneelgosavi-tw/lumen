"""Match outbound HTTP calls to IBM DataPower gateway routing rules.

The indexer stores each routing rule found in GatewayScript / XSLT / config exports / API Connect YAML as a
``GatewayRoute`` node (with its final target). This module is pure (no graph access besides
``fetch_gateway_routes``) so the matching heuristics are easy to test:

* alias  - the call's host/URL matches a user-configured alias (``[datapower.aliases]`` in .codedoc.toml)
* name   - the gateway name appears in the call's URL, host, client or calling code
* path   - the call's URL path matches the rule's incoming path pattern (only when no aliases are configured)
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

SIDECAR_NAME = ".datapower.json"

_GENERIC_NAMES = frozenset(
    "gateway datapower dp src main config scripts script js ts xsl xslt local default routes routing "
    "backend proxy api apis service services app root".split()
)
_ROUTE_COLUMNS = (
    "g.id AS id, g.gateway AS gateway, g.name AS name, g.mechanism AS mechanism, g.matchMethod AS match_method, "
    "g.matchPath AS match_path, g.matchCondition AS match_condition, g.targetUrl AS target_url, "
    "g.targetMethod AS target_method, g.targetHost AS target_host, g.filePath AS file, g.lineNumber AS line, "
    "g.confidence AS confidence, g.reason AS reason"
)


def load_datapower_config(db_path: str) -> dict[str, Any]:
    """Read the aliases sidecar the indexer stage writes next to the Kuzu DB (empty when absent)."""
    if not db_path:
        return {}
    sidecar = Path(db_path).resolve().parent / SIDECAR_NAME
    try:
        return json.loads(sidecar.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def fetch_gateway_routes(backend: Any) -> list[dict]:
    """All GatewayRoute rows; [] for indexes built without DataPower support or without gateway rules."""
    try:
        rows = backend.execute(f"MATCH (g:GatewayRoute) RETURN {_ROUTE_COLUMNS} ORDER BY g.gateway, g.filePath, g.lineNumber LIMIT 2000")
    except Exception:
        return []
    routes = []
    for r in rows or []:
        routes.append(
            {
                "gateway": r.get("gateway") or "",
                "mechanism": r.get("mechanism") or "",
                "match_method": (r.get("match_method") or "").upper(),
                "match_path": r.get("match_path") or "",
                "match_condition": r.get("match_condition") or "",
                "target_url": r.get("target_url") or "",
                "target_method": (r.get("target_method") or "").upper(),
                "target_host": r.get("target_host") or "",
                "file": r.get("file") or "",
                "line": r.get("line"),
                "confidence": r.get("confidence"),
                "reason": r.get("reason") or "",
            }
        )
    return routes


def route_target(route: dict) -> str:
    """`METHOD url` for a rule's final target; the method falls back to the incoming rule's and is omitted when unknown."""
    method = route.get("target_method") or route.get("match_method") or ""
    url = route.get("target_url") or "(unknown)"
    return url if not method or method == "ANY" else f"{method} {url}"


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def url_path(url: str) -> str:
    """Path part of a URL, tolerating a leading scheme://host or a leading `${BASE_URL}` / `{base}` placeholder."""
    text = re.sub(r"^[a-zA-Z][\w+.-]*://[^/?#]*", "", url or "")
    text = re.sub(r"^(\$\{[^}]*\}|\{[^}]*\})", "", text)
    return text.split("?", 1)[0].split("#", 1)[0]


def _pattern_regex(pattern: str) -> re.Pattern | None:
    """Regex for a route path pattern: `*` is a wildcard, `{x}` / `:x` one segment."""
    pattern = (pattern or "").strip()
    if not pattern:
        return None
    out = []
    for token in re.split(r"(\*|\$\{[^}]*\}|\{[^}]*\}|:[A-Za-z_]\w*)", pattern):
        if token == "*":
            out.append(".*")
        elif token and (token.startswith("{") or token.startswith("${") or re.fullmatch(r":[A-Za-z_]\w*", token)):
            out.append("[^/]+")
        else:
            out.append(re.escape(token))
    return re.compile("".join(out).rstrip("/") + "/?", re.IGNORECASE)


def _literal_segments(pattern: str) -> int:
    return sum(1 for seg in (pattern or "").split("/") if seg and not re.search(r"[*{}:$]", seg))


def is_trivial_pattern(pattern: str) -> bool:
    """A pattern like '', '/', '/*' routes everything, so it says nothing about which calls hit the gateway."""
    return _literal_segments(pattern) == 0


def path_matches(pattern: str, path: str) -> bool:
    rx = _pattern_regex(pattern)
    if rx is None or not path:
        return False
    path = re.sub(r"\$\{[^}]*\}|\{[^}]*\}", "x", path)
    return bool(rx.fullmatch(path.rstrip("/") or "/")) or bool(rx.fullmatch(path))


def _method_ok(route_method: str, api_method: str) -> bool:
    return not route_method or route_method == "ANY" or api_method in ("", "UNKNOWN", "ANY") or route_method == api_method.upper()


def _alias_gateways(api: dict, aliases: dict[str, list[str]]) -> set[str]:
    haystack = f"{api.get('url', '')} {api.get('host', '')}".lower()
    found = set()
    for gateway, values in aliases.items():
        if any(v and v.lower() in haystack for v in values):
            found.add(gateway)
    return found


def _name_gateways(api: dict, gateways: list[str]) -> set[str]:
    haystack = _norm(f"{api.get('url', '')} {api.get('host', '')} {api.get('client', '')}")
    callers = _norm(" ".join(str(c.get("caller", "")) for c in api.get("callers", [])))
    found = set()
    for gateway in gateways:
        token = _norm(gateway)
        if len(token) < 3 or token in _GENERIC_NAMES:
            continue
        if token in haystack or token in callers:
            found.add(gateway)
    return found


def match_gateway(api: dict, routes: list[dict], aliases: dict[str, list[str]] | None = None) -> dict | None:
    """Gateway routing that an outbound call goes through, or None.

    Returns ``{"basis": "alias"|"name"|"path", "gateways": [...], "routes": [...]}``. When a gateway is identified by
    alias or name, the routes whose incoming path matches the call are returned (falling back to the gateway's
    catch-all rules; ``routes`` is empty when none match); otherwise only a non-trivial path match counts, and only when no aliases are configured.
    """
    if not routes:
        return None
    aliases = aliases or {}
    method = str(api.get("method") or "")
    path = url_path(str(api.get("url") or ""))
    host = str(api.get("host") or "").lower()
    by_gateway: dict[str, list[dict]] = {}
    for route in routes:
        by_gateway.setdefault(route["gateway"], []).append(route)

    basis = ""
    gateways: set[str] = set()
    if aliases:
        gateways = _alias_gateways(api, aliases) & set(by_gateway)
        basis = "alias"
    if not gateways:
        gateways = _name_gateways(api, list(by_gateway))
        basis = "name"
    # A call straight to a route's final host is a direct call, not a hop through the gateway.
    if gateways:
        selected: list[dict] = []
        for gateway in sorted(gateways):
            candidates = [r for r in by_gateway[gateway] if _method_ok(r["match_method"], method)]
            by_path = [r for r in candidates if not is_trivial_pattern(r["match_path"]) and path_matches(r["match_path"], path)]
            selected.extend(by_path or [r for r in candidates if is_trivial_pattern(r["match_path"])])
        selected = [r for r in selected if not (host and r["target_host"].lower() == host)]
        return {"basis": basis, "gateways": sorted(gateways), "routes": selected}

    if aliases:
        return None
    selected = [
        r
        for r in routes
        if _method_ok(r["match_method"], method)
        and not is_trivial_pattern(r["match_path"])
        and path_matches(r["match_path"], path)
        and not (host and r["target_host"].lower() == host)
    ]
    if not selected:
        return None
    return {"basis": "path", "gateways": sorted({r["gateway"] for r in selected}), "routes": selected}


_NON_SERVICE_DIRS = frozenset("src app lib main test tests java kotlin python js ts".split())


def service_of(path: str, default: str) -> str:
    """Service name for a source path: its top-level directory when the repo holds several services."""
    parts = [p for p in (path or "").replace("\\", "/").split("/") if p]
    return parts[0] if len(parts) > 1 and parts[0].lower() not in _NON_SERVICE_DIRS else default


def link_internal_calls(apis: list[dict], entries: dict[str, str], entry_service: dict[str, str]) -> None:
    """Annotate calls that hit an inbound endpoint of another indexed service (``api["internal_target"]``).

    A call is linked when its method and URL path match an inbound HTTP endpoint by pattern. Calls routed through a
    DataPower gateway are skipped (they leave the system), as are endpoints that already lead to the call itself,
    and a single-segment path on a dotted (public-looking) host, which is far too weak a signal.
    """
    parsed = []
    for entry_id, label in entries.items():
        verb, _, pattern = label.partition(" ")
        if not pattern:
            verb, pattern = "", verb
        parsed.append((entry_id, label, verb.upper(), pattern))
    for api in apis:
        api["internal_target"] = None
        if api.get("gateway"):
            continue
        path = url_path(str(api.get("url") or ""))
        if not path or is_trivial_pattern(path):
            continue
        own_entries = {f["entry_id"] for f in api.get("flows", [])}
        dotted_host = "." in str(api.get("host") or "")
        for entry_id, label, verb, pattern in parsed:
            if entry_id in own_entries or is_trivial_pattern(pattern) or not _method_ok(verb, str(api.get("method") or "")):
                continue
            if _literal_segments(pattern) < 2 and dotted_host:
                continue
            if path_matches(pattern, path):
                api["internal_target"] = {
                    "entry": label,
                    "entry_id": entry_id,
                    "service": entry_service.get(entry_id, ""),
                }
                break
