"""Deterministic `current-state/external-integrations.md` rendering from outbound-call graph data."""

from __future__ import annotations

import re

from codedoc.gateway_routing import route_target
from codedoc.kg_tools.toolkit import ReverseEngineerToolkit
from codedoc.kg_tools.utils import format_chain, short_node_name

ARTIFACT_PATH = "current-state/external-integrations.md"
_MAX_HOSTS_IN_DIAGRAM = 20
_MAX_ENDPOINTS_PER_HOST = 25


def _mermaid_label(text: str) -> str:
    return re.sub(r'["\n\r]', "'", text)[:60]


def _cell(text: object) -> str:
    return str(text if text is not None else "").replace("|", "\\|").replace("\n", " ")


_MAX_MAP_APIS = 30
_MAX_MAP_FLOWS_PER_API = 2


def _node_label(text: str) -> str:
    return re.sub(r'["\n\r<>]', "'", text)[:70]


def _api_path(api: dict) -> str:
    url, host = api["url"], api["host"]
    idx = url.find(host)
    rest = url[idx + len(host):] if idx >= 0 else url
    return rest or "/"


def _host_label(host: str) -> str:
    return f"Runtime-resolved: {host.strip('{}')}" if _is_unresolved_host(host) else host


_MAX_GATEWAY_TARGETS = 4
_MAX_GATEWAY_RULES = 40


def _gateway_title(gateway: dict) -> str:
    return "IBM DataPower: " + ", ".join(gateway["gateways"])


_route_target = route_target


def _route_targets(gateway: dict) -> list[dict]:
    """Distinct final targets of the matched routes, in order."""
    seen: set[str] = set()
    out: list[dict] = []
    for route in gateway["routes"]:
        key = _route_target(route)
        if key not in seen:
            seen.add(key)
            out.append(route)
    return out


def _route_condition(route: dict) -> str:
    return (route.get("match_condition") or "").strip()


def render_integration_flow_map(repo_name: str, apis: list[dict]) -> list[str]:
    """Mermaid flowchart: inbound endpoint -> call chain -> outbound API, grouped by remote host."""
    ids: dict[str, str] = {}
    declared: set[str] = set()
    edges: set[tuple[str, str, str]] = set()
    node_lines: list[str] = []
    edge_lines: list[str] = []

    def node(key: str, label: str, shape: str = "[{}]", css: str = "") -> str:
        if key not in ids:
            ids[key] = f"n{len(ids)}"
        nid = ids[key]
        if nid not in declared:
            declared.add(nid)
            node_lines.append(f'    {nid}{shape.format(chr(34) + _node_label(label) + chr(34))}{css}')
        return nid

    def edge(a: str, b: str, label: str = "") -> None:
        if (a, b, label) not in edges:
            edges.add((a, b, label))
            edge_lines.append(f'    {a} -->|"{_node_label(label)}"| {b}' if label else f"    {a} --> {b}")

    by_host: dict[str, list[dict]] = {}
    for api in apis[:_MAX_MAP_APIS]:
        by_host.setdefault(api["host"], []).append(api)

    group_lines: list[str] = []
    for hindex, (host, items) in enumerate(sorted(by_host.items(), key=lambda kv: (-len(kv[1]), kv[0]))):
        group_lines.append(f'    subgraph g{hindex}["{_node_label(_host_label(host))}"]')
        for api in items:
            aid = node(f"api:{api['method']} {api['url']}", f"{api['method']} {_api_path(api)}", "([{}])", ":::ext")
            ids_in_group = ids[f"api:{api['method']} {api['url']}"]
            group_lines.append(f"        {ids_in_group}")
            client = api.get("client") or ""
            gateway = api.get("gateway")
            if gateway:
                gw = node(f"gw:{','.join(gateway['gateways'])}", _gateway_title(gateway), "{{{{{}}}}}", ":::gw")
                edge(aid, gw, "routes via")
                for route in _route_targets(gateway)[:_MAX_GATEWAY_TARGETS]:
                    target = node(f"final:{_route_target(route)}", _route_target(route), "([{}])", ":::ext")
                    edge(gw, target, _route_condition(route)[:40])
            flows = api.get("flows", [])[:_MAX_MAP_FLOWS_PER_API]
            if flows:
                for flow in flows:
                    entry = node(f"entry:{flow['entry']}", flow["entry"], "[/{}/]", ":::entry")
                    prev = entry
                    for node_id in flow["chain"]:
                        cur = node(f"fn:{node_id}", short_node_name(node_id))
                        edge(prev, cur)
                        prev = cur
                    edge(prev, aid, client)
            else:
                for caller in api["callers"][:2]:
                    name = short_node_name(re.sub(r"\(.*\)$", "", caller["caller"]))
                    cur = node(f"fn:{caller['caller']}", name, "[{}]", ":::bg")
                    edge(cur, aid, client)
        group_lines.append("    end")

    return [
        "```mermaid",
        "flowchart LR",
        *node_lines,
        *group_lines,
        *edge_lines,
        "    classDef entry fill:#e8f1ff,stroke:#3b6fd4",
        "    classDef ext fill:#fff4e0,stroke:#d98a00",
        "    classDef gw fill:#e9f7ef,stroke:#2e8b57",
        "    classDef bg stroke-dasharray: 4 2",
        "```",
        "",
        "_Blue = inbound HTTP endpoint, boxes = the code path that reaches the call, orange = outbound API. "
        "Dashed boxes have no known inbound endpoint (listeners, startup hooks, scheduled jobs or unresolved dispatch). "
        "Green hexagons are IBM DataPower gateways that route the call on to its final target._\n",
    ]


_MAX_CONTRACTS = 40
_PARAM_LABELS = {"path": "Path param", "query": "Query param", "form": "Form field"}


_JSON_SCALARS: dict[str, tuple[str, str | None]] = {
    **dict.fromkeys(("string", "str", "char", "character"), ("string", None)),
    "uuid": ("string", "uuid"),
    **dict.fromkeys(("date", "localdatetime", "offsetdatetime", "zoneddatetime", "instant"), ("string", "date-time")),
    "localdate": ("string", "date"),
    "localtime": ("string", "time"),
    "duration": ("string", "duration"),
    **dict.fromkeys(("url", "uri"), ("string", "uri")),
    **dict.fromkeys(("bytes", "byte[]"), ("string", "byte")),
    **dict.fromkeys(("int", "integer", "long", "short", "byte", "biginteger"), ("integer", None)),
    **dict.fromkeys(("double", "float", "number", "bigdecimal"), ("number", None)),
    **dict.fromkeys(("boolean", "bool"), ("boolean", None)),
    **dict.fromkeys(("map", "hashmap", "object", "jsonnode"), ("object", None)),
}


def _type_schema(type_text: str) -> dict:
    """Schema for a declared type with no resolved fields (scalar, collection of scalars, or unresolved class)."""
    base, is_list = ReverseEngineerToolkit._peel_type(type_text)
    if not base or base.lower() in {"any", "unknown", "void"}:
        item: dict = {}
    elif base.lower() in _JSON_SCALARS:
        kind, fmt = _JSON_SCALARS[base.lower()]
        item = {"type": kind, **({"format": fmt} if fmt else {})}
    else:
        item = {"type": "object", "description": f"{base} (fields not resolved)"}
    return {"type": "array", "items": item} if is_list else item


def _inline_schema(names: list[str]) -> dict:
    """Object schema from usage-inferred dotted field names (`items.id` -> items: {id})."""
    tree: dict = {}
    for name in names:
        node = tree
        for part in name.split("."):
            node = node.setdefault(part.removesuffix("[]"), {})

    def build(node: dict) -> dict:
        if not node:
            return {}
        return {"type": "object", "properties": {k: build(v) for k, v in node.items()}}

    return build(tree) or {"type": "object"}


class _SchemaSet:
    """Named object schemas (OpenAPI `components.schemas`) collected for one call; nested types become `$ref`s."""

    def __init__(self) -> None:
        self.defs: dict[str, dict] = {}

    @staticmethod
    def _ref(name: str) -> dict:
        return {"$ref": f"#/components/schemas/{name}"}

    def _define(self, name: str, fields: list[dict]) -> dict:
        if name not in self.defs:
            self.defs[name] = {}  # reserved first so a self-referencing type resolves to its own $ref
            self.defs[name] = {"type": "object", "properties": {f["name"]: self.field(f) for f in fields}}
        return self._ref(name)

    def field(self, field: dict) -> dict:
        text = field.get("type") or ""
        base, is_list = ReverseEngineerToolkit._peel_type(text)
        if field.get("fields"):
            node = self._define(base or "Object", field["fields"])
            is_list = bool(field.get("list"))
        elif base in self.defs and base.lower() not in _JSON_SCALARS:
            node = self._ref(base)
        else:
            return _type_schema(text)
        return {"type": "array", "items": node} if is_list else node

    def body(self, shape: dict) -> dict:
        if shape.get("inline"):
            node: dict = _inline_schema([f["name"] for f in shape["fields"]])
        elif shape.get("fields"):
            node = self._define(shape["type"], shape["fields"])
        else:
            return _type_schema(f"List<{shape['type']}>" if shape.get("list") else shape["type"])
        return {"type": "array", "items": node} if shape.get("list") else node


_PLAIN_YAML = re.compile(r"^[\w./-]+$")


def _yaml_scalar(value: object) -> str:
    text = str(value)
    return text if _PLAIN_YAML.match(text) else "'" + text.replace("'", "''") + "'"


def _yaml_flow(node: dict) -> str:
    return "{ " + ", ".join(f"{k}: {_yaml_scalar(v)}" for k, v in node.items()) + " }" if node else "{}"


def _yaml_lines(node: dict, indent: int = 0) -> list[str]:
    """OpenAPI-style YAML: scalar-only schemas collapse to `{ type: string }`, nested ones stay in block form."""
    pad = " " * indent
    out: list[str] = []
    for key, value in node.items():
        name = _yaml_scalar(key)
        if not isinstance(value, dict):
            out.append(f"{pad}{name}: {_yaml_scalar(value)}")
        elif not value or all(not isinstance(v, dict) for v in value.values()):
            out.append(f"{pad}{name}: {_yaml_flow(value)}")
        else:
            out.append(f"{pad}{name}:")
            out.extend(_yaml_lines(value, indent + 2))
    return out


def _body_yaml(contract: dict) -> list[str]:
    """YAML block with the request/response bodies and every named schema they use."""
    schemas = _SchemaSet()
    doc: dict = {}
    if contract.get("request"):
        doc["request"] = schemas.body(contract["request"])
    if contract.get("response"):
        doc["response"] = schemas.body(contract["response"])
    if schemas.defs:
        doc["components"] = {"schemas": schemas.defs}
    lines = _yaml_lines(doc)
    if not contract.get("response"):
        lines.append("# response type not detected")
    return ["```yaml", *lines, "```", ""]


def _has_contract(api: dict) -> bool:
    c = api.get("contract") or {}
    return bool(c.get("request") or c.get("response") or c.get("params") or c.get("headers"))


def render_api_contracts(apis: list[dict]) -> list[str]:
    """`## API Contracts` section: request params/headers/body and response shape per outbound call."""
    documented = [a for a in apis if _has_contract(a)]
    if not documented:
        return []
    lines = [
        "## API Contracts [Observed]\n",
        "Request and response details for each outbound call, read statically from the code: types come from "
        "declared Java/TypeScript types, annotations and call arguments. Bodies are OpenAPI-style schemas "
        "(`components.schemas` with `$ref`) resolved from the indexed classes at every nesting level. Plain-JavaScript "
        "bodies list only the fields the calling code actually reads, and a type marked \"fields not resolved\" is "
        "external or could not be found.\n",
    ]
    for api in documented[:_MAX_CONTRACTS]:
        contract = api["contract"]
        lines.append(f"### `{_cell(api['method'])} {_cell(api['url'])}`\n")
        if api.get("callers"):
            lines.append(f"Called from `{_cell(api['callers'][0]['caller'])}`"
                         + (f" (+{len(api['callers']) - 1} more)" if len(api["callers"]) > 1 else "") + "\n")

        gateway = api.get("gateway")
        if gateway:
            finals = ", ".join(f"`{_cell(_route_target(r))}`" for r in _route_targets(gateway)[:_MAX_GATEWAY_TARGETS])
            lines.append(f"Routed through {_gateway_title(gateway)} to {finals}\n")

        lines.append("**Request**\n")
        rows: list[str] = []
        for item in contract.get("params") or []:
            kind, _, name = item.partition(":")
            rows.append(f"| {_PARAM_LABELS.get(kind, kind)} | `{_cell(name)}` |")
        for header in contract.get("headers") or []:
            rows.append(f"| Header | `{_cell(header)}` |")
        if rows:
            lines.extend(["| Part | Name |", "|---|---|", *rows, ""])
        else:
            lines.append("_No parameters or headers detected._\n")

        lines.append("**Request / response bodies**\n")
        if contract.get("request") or contract.get("response"):
            lines.extend(_body_yaml(contract))
        else:
            lines.append("_No request or response body type detected._\n")
    if len(documented) > _MAX_CONTRACTS:
        lines.append(f"_{len(documented) - _MAX_CONTRACTS} more call(s) not shown._\n")
    return lines


def render_gateway_routing(apis: list[dict], gateway_routes: list[dict] | None = None) -> list[str]:
    """`## Gateway Routing` section: calls that pass through an IBM DataPower gateway and the rules that route them."""
    routed = [a for a in apis if a.get("gateway")]
    routes = gateway_routes or []
    if not routed and not routes:
        return []
    lines = [
        "## Gateway Routing [Observed]\n",
        "Some calls go to an IBM DataPower gateway, which routes them to the final external API using rules written in "
        "GatewayScript, XSLT, config exports or API Connect definitions. The rules below were read statically from "
        "that code; which call reaches which rule is matched by configured alias, gateway name or URL path (see "
        "'Matched by'), so treat a path-based match as inferred.\n",
    ]
    if routed:
        lines.extend(
            [
                "### Calls routed through a gateway\n",
                "| Call | Gateway | Matched by | Incoming rule | Final target | Source |",
                "|---|---|---|---|---|---|",
            ]
        )
        for api in routed[:_MAX_ENDPOINTS_PER_HOST * 2]:
            gateway = api["gateway"]
            for route in gateway["routes"][:_MAX_GATEWAY_TARGETS * 2]:
                cond = _route_condition(route)
                incoming = f"{route.get('match_method') or 'ANY'} {route.get('match_path') or '(any path)'}" + (f" when `{cond}`" if cond else "")
                lines.append(
                    f"| `{_cell(api['method'])} {_cell(api['url'])}` | {_cell(', '.join(gateway['gateways']))} | {gateway['basis']} | "
                    f"{_cell(incoming)} | `{_cell(_route_target(route))}` | {_cell(route.get('file'))}:{route.get('line')} |"
                )
        lines.append("")
    if routes:
        lines.extend(
            [
                "### Gateway routing rules\n",
                "| Gateway | Mechanism | Incoming | Condition | Final target | Source | Confidence |",
                "|---|---|---|---|---|---|---|",
            ]
        )
        for route in routes[:_MAX_GATEWAY_RULES]:
            confidence = route.get("confidence")
            conf = f"{confidence:.2f}" if isinstance(confidence, (int, float)) else "—"
            lines.append(
                f"| {_cell(route['gateway'])} | {_cell(route.get('mechanism'))} | "
                f"{_cell((route.get('match_method') or 'ANY') + ' ' + (route.get('match_path') or '(any path)'))} | "
                f"{_cell(_route_condition(route) or '—')} | `{_cell(_route_target(route))}` | "
                f"{_cell(route.get('file'))}:{route.get('line')} | {conf} |"
            )
        if len(routes) > _MAX_GATEWAY_RULES:
            lines.append(f"\n_{len(routes) - _MAX_GATEWAY_RULES} more rule(s) not shown._")
        lines.append("")
    return lines


def render_external_integrations(repo_name: str, apis: list[dict], gateway_routes: list[dict] | None = None) -> str | None:
    """Render the artifact markdown, or None when no outbound calls were detected."""
    if not apis:
        return None

    by_host: dict[str, list[dict]] = {}
    for api in apis:
        by_host.setdefault(api["host"], []).append(api)
    hosts = sorted(by_host.items(), key=lambda kv: (-len(kv[1]), kv[0]))

    lines = [
        "# External Integrations\n",
        "## Overview [Observed]\n",
        f"`{repo_name}` makes **{len(apis)}** distinct outbound HTTP call target(s) to "
        f"**{len(hosts)}** remote host(s). The list below is generated directly from the knowledge graph "
        "(`ExternalApi` nodes and `CALLS_EXTERNAL` edges), not written by a model.\n",
        "Placeholders such as `{id}` are values computed at runtime; `${NAME}` is an environment or "
        "configuration value the indexer could not resolve to a literal.\n",
        "## Integration Map [Observed]\n",
    ]
    lines.extend(render_integration_flow_map(repo_name, apis))
    if len(apis) > _MAX_MAP_APIS:
        lines.append(f"_Diagram shows {_MAX_MAP_APIS} of {len(apis)} endpoints; see the tables below for the full list._\n")

    lines.append("## Remote Hosts [Observed]\n")
    for host, items in hosts:
        clients = sorted({api["client"] for api in items if api.get("client")})
        languages = sorted({api["language"] for api in items if api.get("language")})
        lines.append(f"### `{host}`\n")
        lines.append(f"Clients: {', '.join(clients) or 'n/a'} · Languages: {', '.join(languages) or 'n/a'}\n")
        lines.append("| Method | URL | Called from | Inbound flow |")
        lines.append("|---|---|---|---|")
        for api in items[:_MAX_ENDPOINTS_PER_HOST]:
            callers = []
            for caller in api["callers"][:3]:
                where = f" ({caller['path']}:{caller['line']})" if caller.get("path") and caller.get("line") else ""
                callers.append(f"`{caller['caller']}`{where}")
            if len(api["callers"]) > 3:
                callers.append(f"+{len(api['callers']) - 3} more")
            flows = [f"`{f['entry']}`: {format_chain(f['chain'])}" for f in api.get("flows", [])[:3]]
            entry_points = "<br>".join(flows) or "—"
            url_cell = f"`{_cell(api['url'])}`"
            if api.get("gateway"):
                url_cell += f"<br>↳ via {_cell(_gateway_title(api['gateway']))} → " + ", ".join(
                    f"`{_cell(_route_target(r))}`" for r in _route_targets(api["gateway"])[:_MAX_GATEWAY_TARGETS]
                )
            lines.append(
                f"| {_cell(api['method'])} | {url_cell} | {_cell('<br>'.join(callers))} | {_cell(entry_points)} |"
            )
        if len(items) > _MAX_ENDPOINTS_PER_HOST:
            lines.append(f"\n_{len(items) - _MAX_ENDPOINTS_PER_HOST} more endpoint(s) not shown._")
        lines.append("")

    lines.extend(render_gateway_routing(apis, gateway_routes))
    lines.extend(render_service_chains(apis, level=2))
    lines.extend(render_api_contracts(apis))

    lines.extend(
        [
            "## Interpretation [Inferred]\n",
            "- Each host above is a runtime dependency: an outage or contract change there affects the calling code listed.",
            "- The 'Inbound flow' column is best-effort: it follows resolved call edges back to HTTP entry points "
            "and may be empty when the call is made from a scheduler, listener, or through dynamic dispatch.",
            "- Calls whose URL is built entirely at runtime or read from an unresolved config key are shown with placeholders "
            "and carry lower confidence.",
            *(
                [
                    "- Calls through an IBM DataPower gateway depend on the gateway's routing rules as well as the host "
                    "shown: changing a rule re-points the call without any change to the calling code."
                ]
                if any(a.get("gateway") for a in apis) or gateway_routes
                else []
            ),
            "",
        ]
    )
    return "\n".join(lines)


# ── C4 context: guarantee every outbound host is a node ──────────────────────

_MAX_C4_HOSTS = 15
_PLACEHOLDER_HOST = re.compile(r"^\$\{(.+)\}$")


def _host_display_name(host: str) -> str:
    match = _PLACEHOLDER_HOST.match(host)
    return f"Configured service ({match.group(1)})" if match else host


def _squash(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def _is_unresolved_host(host: str) -> bool:
    """Hosts computed at runtime (e.g. `{getUri()}`) are not meaningful C4 nodes."""
    return "(" in host or host.startswith("{")


def _covered(host: str, names: str, described: str) -> bool:
    """True if the model already drew this host (by name/id, or by mentioning it)."""
    if _squash(host) in described:
        return True
    if "." in host or _PLACEHOLDER_HOST.match(host):
        return False
    # Internal service names like `customers-service` are usually drawn as "Customers Service".
    base = _squash(re.sub(r"[-_]?(service|svc|server|api)$", "", host, flags=re.I))
    return len(base) >= 3 and base in names


def merge_outbound_into_c4_spec(spec: dict, apis: list[dict]) -> dict:
    """Add a System_Ext + HTTP/REST relation for every outbound host the model did not already cover."""
    systems = spec.get("systems") or []
    if not apis or not systems:
        return spec
    primary = systems[0].get("id") or systems[0].get("name")
    externals = list(spec.get("external_systems") or [])
    relations = list(spec.get("relations") or [])
    nodes = [*(spec.get("people") or []), *systems, *externals]
    names = _squash(" ".join(f"{n.get('id', '')} {n.get('name', '')}" for n in nodes))
    described = _squash(" ".join(f"{n.get('description', '')}" for n in nodes)) + names
    used_ids = {re.sub(r"[^A-Za-z0-9_]+", "_", str(e.get("id") or e.get("name") or "")) for e in externals}

    def add_external(node_id: str, name: str, description: str) -> bool:
        if node_id in used_ids:
            return False
        used_ids.add(node_id)
        externals.append({"id": node_id, "name": name.replace('"', "'"), "description": description, "kind": "system"})
        return True

    def gateway_node(name: str) -> str:
        node_id = "out_dp_" + re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_")
        if add_external(node_id, f"IBM DataPower: {name}", "API gateway routing calls to external APIs"):
            relations.append({"from": primary, "to": node_id, "label": "Calls", "technology": "HTTP/REST"})
        return node_id

    by_host: dict[str, list[dict]] = {}
    for api in apis:
        by_host.setdefault(api["host"], []).append(api)
    for host, items in sorted(by_host.items(), key=lambda kv: (-len(kv[1]), kv[0]))[:_MAX_C4_HOSTS]:
        gateway_items = [a for a in items if a.get("gateway")]
        for api in gateway_items:
            for name in api["gateway"]["gateways"]:
                gw_id = gateway_node(name)
                for route in _route_targets(api["gateway"]):
                    target_host = route.get("target_host") or ""
                    if not target_host or _is_unresolved_host(target_host) or _covered(target_host, names, described):
                        continue
                    target_id = "out_" + re.sub(r"[^A-Za-z0-9]+", "_", target_host).strip("_")
                    if add_external(target_id, _host_display_name(target_host), "External API reached through IBM DataPower"):
                        relations.append({"from": gw_id, "to": target_id, "label": "Routes to", "technology": "HTTP/REST"})
        # The gateway is the node the service really talks to, so skip the gateway's own host entry.
        if len(gateway_items) == len(items) or _is_unresolved_host(host) or _covered(host, names, described):
            continue
        node_id = "out_" + re.sub(r"[^A-Za-z0-9]+", "_", host).strip("_")
        count = len(items)
        if add_external(node_id, _host_display_name(host), f"Outbound HTTP, {count} endpoint{'s' if count != 1 else ''}"):
            relations.append({"from": primary, "to": node_id, "label": "Calls", "technology": "HTTP/REST"})
    return {**spec, "external_systems": externals, "relations": relations}


# ── Business journeys: deterministic per-endpoint outbound sequence diagrams ──

JOURNEYS_MARKER = "## External Calls By Endpoint"
_MAX_JOURNEY_DIAGRAMS = 8


def _mm(text: str) -> str:
    return re.sub(r"[;#\n\r]", " ", str(text))


def _path_of(url: str, host: str) -> str:
    idx = url.find(host)
    rest = url[idx + len(host):] if idx >= 0 else url
    return rest or "/"


def render_outbound_journeys(apis: list[dict]) -> str | None:
    """Mermaid sequence diagrams: inbound endpoint -> call chain -> remote host. None if no flow is known."""
    flows: dict[str, list[tuple[list[str], dict]]] = {}
    for api in apis:
        for flow in api.get("flows", []):
            flows.setdefault(flow["entry"], []).append((flow["chain"], api))
    if not flows:
        return None

    lines = [
        JOURNEYS_MARKER + " [Observed]\n",
        "Generated from the knowledge graph: each diagram follows resolved call edges from an HTTP endpoint "
        "to the outbound HTTP call it can trigger.\n",
    ]
    for entry, items in list(flows.items())[:_MAX_JOURNEY_DIAGRAMS]:
        participants: dict[str, str] = {}

        def pid(label: str) -> str:
            if label not in participants:
                participants[label] = f"p{len(participants)}"
            return participants[label]

        body: list[str] = []
        seen: set[tuple[str, str, str]] = set()
        pid("Client")
        for chain, api in items:
            names = [short_node_name(n) for n in chain]
            classes = [n.rsplit(".", 1)[0] if "." in n else n for n in names]
            methods = [n.rsplit(".", 1)[-1] for n in names]
            prev = "Client"
            for index, (cls, method) in enumerate(zip(classes, methods)):
                message = f"{entry} ({method})" if index == 0 else method
                edge = (prev, cls, message)
                if edge not in seen:
                    seen.add(edge)
                    body.append(f"    {pid(prev)}->>{pid(cls)}: {_mm(message)}")
                prev = cls
            gateway = api.get("gateway")
            remote = _gateway_title(gateway) if gateway else api["host"]
            edge = (prev, remote, f"{api['method']} {api['url']}")
            if edge not in seen:
                seen.add(edge)
                body.append(
                    f"    {pid(prev)}->>{pid(remote)}: {_mm(api['method'] + ' ' + _path_of(api['url'], api['host']))}"
                )
            for route in _route_targets(gateway)[:_MAX_GATEWAY_TARGETS] if gateway else []:
                target_host = route.get("target_host") or route.get("target_url") or "external API"
                target_path = _path_of(route.get("target_url") or "", target_host)
                cond = _route_condition(route)
                message = f"{route.get('target_method') or route.get('match_method') or 'ANY'} {target_path}" + (
                    f" (when {cond[:40]})" if cond else ""
                )
                hop = (remote, target_host, message)
                if hop not in seen:
                    seen.add(hop)
                    body.append(f"    {pid(remote)}->>{pid(target_host)}: {_mm(message)}")
        lines.append(f"### `{entry}`\n")
        lines.append("```mermaid\nsequenceDiagram")
        lines.extend(f'    participant {p} as {_mm(label).replace(chr(34), chr(39))}' for label, p in participants.items())
        lines.extend(body)
        lines.append("```\n")
    lines.extend(render_service_chains(apis))
    return "\n".join(lines)


# ── Cross-service chains: A -> B -> C -> (DataPower) -> external API ──────────

_MAX_CHAINS = 6
_MAX_CHAIN_DEPTH = 5


def _service_chains(apis: list[dict]) -> list[tuple[str, list[str]]]:
    """Sequence diagrams (heading, body lines) for call chains that cross at least one service boundary."""
    outgoing: dict[str, list[dict]] = {}
    for api in apis:
        for flow in api.get("flows", []):
            outgoing.setdefault(flow["entry_id"], []).append(api)
    targets = {a["internal_target"]["entry_id"] for a in apis if a.get("internal_target")}
    chains: list[tuple[str, list[str]]] = []
    for root_id, root_apis in outgoing.items():
        if root_id in targets:
            continue
        participants: dict[str, str] = {}
        body: list[str] = []
        linked = False

        def pid(label: str) -> str:
            participants.setdefault(label, f"p{len(participants)}")
            return participants[label]

        def send(src: str, dst: str, message: str) -> None:
            line = f"    {pid(src)}->>{pid(dst)}: {_mm(message)}"
            if line not in body:
                body.append(line)

        def walk(entry_id: str, service: str, depth: int, seen: frozenset) -> None:
            nonlocal linked
            for api in outgoing.get(entry_id, [])[:_MAX_JOURNEY_DIAGRAMS]:
                call = f"{api['method']} {_path_of(api['url'], api['host'])}"
                gateway = api.get("gateway")
                internal = api.get("internal_target")
                if internal and internal["entry_id"] not in seen and depth < _MAX_CHAIN_DEPTH:
                    linked = True
                    target_service = internal.get("service") or internal["entry"]
                    send(service, target_service, call)
                    walk(internal["entry_id"], target_service, depth + 1, seen | {internal["entry_id"]})
                elif gateway:
                    title = _gateway_title(gateway)
                    send(service, title, call)
                    for route in _route_targets(gateway)[:_MAX_GATEWAY_TARGETS]:
                        host = route.get("target_host") or route.get("target_url") or "external API"
                        send(title, host, f"{route.get('target_method') or route.get('match_method') or 'ANY'} {_path_of(route.get('target_url') or '', host)}")
                else:
                    send(service, api["host"], call)

        first = root_apis[0]
        root_service = first.get("service") or "service"
        pid("Client")
        send("Client", root_service, next((f["entry"] for f in first["flows"] if f["entry_id"] == root_id), root_id))
        walk(root_id, root_service, 0, frozenset({root_id}))
        if linked:
            lines = [f"    participant {p} as {_mm(label).replace(chr(34), chr(39))}" for label, p in participants.items()]
            chains.append((next(f["entry"] for f in first["flows"] if f["entry_id"] == root_id), [*lines, *body]))
    return chains[:_MAX_CHAINS]


def render_service_chains(apis: list[dict], level: int = 3) -> list[str]:
    """End-to-end chains markdown (mermaid sequence diagrams); [] when no call crosses a service boundary."""
    chains = _service_chains(apis)
    if not chains:
        return []
    lines = [
        f"{'#' * level} End-to-end service chains [Inferred]\n",
        "Calls whose method and URL path match an inbound endpoint of another service in the same index are joined "
        "into one chain, and calls that go through an IBM DataPower gateway continue to the final external API. "
        "The links are matched by path, so verify them against the service configuration.\n",
    ]
    for entry, body in chains:
        lines.extend([f"{'#' * (level + 1)} `{entry}`\n", "```mermaid\nsequenceDiagram", *body, "```\n"])
    return lines
