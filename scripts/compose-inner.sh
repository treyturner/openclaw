#!/bin/sh
set -eu

# The outer stack's project name and networks belong to a different Docker daemon.
case "${1:-}" in
  cli)
    shift
    if [ -t 0 ] && [ -t 1 ]; then
      set -- run --rm openclaw-cli "$@"
    else
      set -- run --rm -T openclaw-cli "$@"
    fi
    ;;
  pull)
    # Sandbox containers are created on demand, so they are not a Compose service.
    docker pull "${OPENCLAW_SANDBOX_IMAGE:?Set OPENCLAW_SANDBOX_IMAGE}"
    shift
    set -- pull "$@" openclaw-gateway
    ;;
  up)
    # A fresh DinD store needs the sandbox image as well as the gateway image.
    if ! docker image inspect "${OPENCLAW_SANDBOX_IMAGE:?Set OPENCLAW_SANDBOX_IMAGE}" >/dev/null 2>&1; then
      docker pull "$OPENCLAW_SANDBOX_IMAGE"
    fi
    ;;
esac

exec docker compose --project-name openclaw --file /etc/openclaw/compose.yaml "$@"
