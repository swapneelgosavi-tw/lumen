#!/usr/bin/env bash

set -euo pipefail

DOCKER_IMAGE="${DOCKER_IMAGE:-lumen}"
REPO="${REPO:-}"
ARGS="${ARGS:-}"
GATEWAY_REPO="${GATEWAY_REPO:-}"
OUTPUT_PATH="${OUTPUT_PATH:-$(pwd)/output}"

if [ -z "${REPO}" ]; then
  echo "Usage: REPO=/path/to/repo [ARGS='--provider anthropic --model claude-sonnet-4-6'] ./scripts/lumen-docker-security-audit.sh"
  exit 1
fi

mkdir -p "${OUTPUT_PATH}"

docker_args=(
  run --rm
  --add-host=host.docker.internal:host-gateway
  -v "${REPO}:/repo"
  -v "${OUTPUT_PATH}:/workspace/output"
)

# GATEWAY_REPO: comma- or space-separated host paths of IBM DataPower gateway repos, mounted read-only.
gateway_args=()
gateway_index=0
for gateway_path in ${GATEWAY_REPO//,/ }; do
  gateway_index=$((gateway_index + 1))
  docker_args+=( -v "${gateway_path}:/gateway/${gateway_index}:ro" )
  gateway_args+=( --gateway-repo "/gateway/${gateway_index}" )
done

if [ -t 0 ]; then
  docker_args+=( -i )
fi
if [ -t 1 ]; then
  docker_args+=( -t )
fi

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  docker_args+=( -e "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}" )
fi
if [ -n "${OPENAI_API_KEY:-}" ]; then
  docker_args+=( -e "OPENAI_API_KEY=${OPENAI_API_KEY}" )
fi
for var in COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN; do
  if [ -n "${!var:-}" ]; then
    docker_args+=( -e "${var}=${!var}" )
  fi
done
if [ -n "${CMG_JS_HEAP_MB:-}" ]; then
  docker_args+=( -e "CMG_JS_HEAP_MB=${CMG_JS_HEAP_MB}" )
fi

cmd=( "${DOCKER_IMAGE}" security-audit /repo --repo-name "$(basename "${REPO}")" --output-dir /workspace/output "${gateway_args[@]+"${gateway_args[@]}"}" )
if [ -n "${ARGS}" ]; then
  # shellcheck disable=SC2206
  extra_args=( ${ARGS} )
  cmd+=( "${extra_args[@]}" )
fi

docker "${docker_args[@]}" "${cmd[@]}"
