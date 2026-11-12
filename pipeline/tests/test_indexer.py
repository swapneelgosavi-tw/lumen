from __future__ import annotations

from pathlib import Path

import json

from codedoc.state import PipelineState
from codedoc.stages.indexer import DATAPOWER_SIDECAR, _index_datapower, detect_languages


def test_detect_languages_mixed_repo(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "App.java").write_text("class App {}")
    (tmp_path / "src" / "widget.tsx").write_text("export const Widget = () => null;")
    (tmp_path / "src" / "worker.py").write_text("def run():\n    return 1\n")

    detected = detect_languages(str(tmp_path))

    assert detected == {"jvm": 1, "js": 1, "python": 1}


def test_detect_languages_ignores_generated_dirs(tmp_path):
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "ignore.js").write_text("console.log('x')")
    (tmp_path / "service").mkdir()
    (tmp_path / "service" / "app.py").write_text("print('ok')")

    detected = detect_languages(str(tmp_path))

    assert detected == {"python": 1}


def _fake_cmg_js(bin_dir: Path, log: Path) -> None:
    bin_dir.mkdir()
    script = bin_dir / "cmg-js"
    script.write_text(f"#!/bin/sh\necho \"$@\" >> {log}\necho 'DataPower: 3 gateway routing rule(s) from fake' >&2\n")
    script.chmod(0o755)


def test_index_datapower_scans_repo_and_gateway_repos_and_writes_aliases(tmp_path):
    log = tmp_path / "calls.log"
    _fake_cmg_js(tmp_path / "bin", log)
    gateway = tmp_path / "gw"
    gateway.mkdir()
    kuzu_dir = tmp_path / "index.kuzu"
    kuzu_dir.mkdir()
    state = PipelineState(repo_path=str(tmp_path), indexer_bin_dir=str(tmp_path / "bin"), timeout=30)
    state.gateway_repos = [str(gateway)]
    state.datapower_aliases = {"PaymentsGW": ["pay.gw.corp"]}

    _index_datapower(state, tmp_path, kuzu_dir, "svc")

    calls = log.read_text().splitlines()
    assert len(calls) == 2
    assert all("--mode datapower" in c and "--repo-name svc" in c for c in calls)
    assert str(gateway) in calls[1]
    sidecar = json.loads((kuzu_dir / DATAPOWER_SIDECAR).read_text())
    assert sidecar["aliases"] == {"PaymentsGW": ["pay.gw.corp"]} and sidecar["rules"] == 6


def test_index_datapower_is_a_noop_without_binary_or_gateway(tmp_path):
    kuzu_dir = tmp_path / "index.kuzu"
    kuzu_dir.mkdir()
    state = PipelineState(repo_path=str(tmp_path), indexer_bin_dir=str(tmp_path / "missing"), timeout=30)

    _index_datapower(state, tmp_path, kuzu_dir, "svc")

    assert not (kuzu_dir / DATAPOWER_SIDECAR).exists()
