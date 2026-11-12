"""Configuration loader for codedoc.

Reads settings from (in precedence order):
  1. CLI flags
  2. .codedoc.toml in CWD
  3. Built-in defaults
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


_DEFAULTS = {
    "output_dir": "./output",
    "model": "claude-sonnet-4-6",
    "provider": "auto",
    "base_url": "",
    "max_turns": 60,
    "max_context_tokens": 120_000,
    "ollama_num_ctx": 131_072,   # Ollama KV-cache context window; ignored for Claude/OpenAI
    "timeout": 300,
    "repo_size_check": "warn",
    "allow_xlarge": False,
    "indexer_bin_dir": str(Path(__file__).resolve().parent.parent.parent / "indexer" / "bin"),
    "agent_prompt": str(
        Path(__file__).resolve().parent / "prompts" / "re-prompt.md"
    ),
    "build_script": str(
        Path(__file__).resolve().parent.parent / "scripts" / "build-docs-site.sh"
    ),
}


@dataclass
class Config:
    output_dir: str = _DEFAULTS["output_dir"]
    model: str = _DEFAULTS["model"]
    provider: str = _DEFAULTS["provider"]
    base_url: str = _DEFAULTS["base_url"]
    max_turns: int = _DEFAULTS["max_turns"]
    max_context_tokens: int = _DEFAULTS["max_context_tokens"]
    ollama_num_ctx: int = _DEFAULTS["ollama_num_ctx"]
    timeout: int = _DEFAULTS["timeout"]
    repo_size_check: str = _DEFAULTS["repo_size_check"]
    allow_xlarge: bool = _DEFAULTS["allow_xlarge"]
    indexer_bin_dir: str = _DEFAULTS["indexer_bin_dir"]
    agent_prompt: str = _DEFAULTS["agent_prompt"]
    build_script: str = _DEFAULTS["build_script"]
    verbose: bool = False
    timeout_explicit: bool = False
    max_turns_explicit: bool = False
    # IBM DataPower: extra repos holding gateway artifacts, and gateway-name -> host/name aliases
    # (from `[datapower]` / `[datapower.aliases]` in .codedoc.toml) used to match calls to gateway routes.
    gateway_repos: list[str] = field(default_factory=list)
    datapower_aliases: dict[str, list[str]] = field(default_factory=dict)


def load_config(cli_overrides: dict[str, Any] | None = None) -> Config:
    """Build a Config by merging defaults ← toml ← CLI flags."""
    merged: dict[str, Any] = dict(_DEFAULTS)
    explicit_keys: set[str] = set()
    gateway_repos: list[str] = []
    datapower_aliases: dict[str, list[str]] = {}

    # Layer 2: .codedoc.toml
    toml_path = Path.cwd() / ".codedoc.toml"
    if toml_path.exists():
        with open(toml_path, "rb") as f:
            data = tomllib.load(f)
        for section in ("pipeline", "paths"):
            if section in data:
                merged.update(data[section])
                explicit_keys.update(data[section].keys())
        datapower = data.get("datapower", {})
        gateway_repos.extend(str(p) for p in datapower.get("gateway_repos", []))
        for name, values in (datapower.get("aliases", {}) or {}).items():
            datapower_aliases[str(name)] = [str(v) for v in ([values] if isinstance(values, str) else values)]

    # Layer 3: CLI overrides (None values are unset flags — skip them)
    if cli_overrides:
        for k, v in cli_overrides.items():
            if k == "gateway_repos":
                gateway_repos.extend(str(p) for p in (v or []) if str(p) not in gateway_repos)
                continue
            if v is not None:
                merged[k] = v
                explicit_keys.add(k)

    config_kwargs = {k: merged[k] for k in Config.__dataclass_fields__ if k in merged}
    config_kwargs["timeout_explicit"] = "timeout" in explicit_keys
    config_kwargs["max_turns_explicit"] = "max_turns" in explicit_keys
    config_kwargs["gateway_repos"] = gateway_repos
    config_kwargs["datapower_aliases"] = datapower_aliases
    return Config(**config_kwargs)
