#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 \
    || ( "$1" != gateway && "$1" != sandbox && "$1" != sandbox-browser ) \
    || ( $# == 3 && ( "$3" != --npm-extras || "$1" == sandbox-browser ) ) ]]; then
    echo "Usage: bash tests/image-smoke.sh <gateway|sandbox|sandbox-browser> <image> [--npm-extras]" >&2
    exit 2
fi

test_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
role="$1"
image="$2"
case "$role" in
    sandbox-browser) exec python3 "$test_dir/browser-smoke.py" "$image" ;;
    gateway) runtime_home=/home/node ;;
    sandbox) runtime_home=/home/sandbox ;;
esac

# Match the executable workspace bind used by OpenClaw for compiler smoke checks.
docker run --rm --init --interactive --read-only --network none \
    --cap-drop ALL --security-opt no-new-privileges \
    --tmpfs /tmp:rw,nosuid,nodev,size=512m \
    --tmpfs /workspace:rw,exec,nosuid,nodev,uid=1000,gid=1000,size=128m \
    --tmpfs "$runtime_home:rw,nosuid,nodev,uid=1000,gid=1000,size=32m" \
    --env "TEST_IMAGE_ROLE=$role" \
    --env "TEST_NPM_EXTRAS=${3:-}" \
    --workdir /tmp --entrypoint node "$image" \
    --input-type=module < "$test_dir/image-smoke.mjs"
