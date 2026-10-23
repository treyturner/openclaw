#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 \
    || ( "$1" != gateway && "$1" != sandbox ) \
    || ( $# == 3 && "$3" != --npm-extras ) ]]; then
    echo "Usage: bash tests/image-smoke.sh <gateway|sandbox> <image> [--npm-extras]" >&2
    exit 2
fi

test_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
role="$1"
image="$2"
case "$role" in
    gateway) runtime_home=/home/node ;;
    sandbox) runtime_home=/home/sandbox ;;
esac

docker run --rm --init --interactive --read-only --network none \
    --cap-drop ALL --security-opt no-new-privileges \
    --tmpfs /tmp:rw,nosuid,nodev,size=512m \
    --tmpfs /workspace:rw,nosuid,nodev,uid=1000,gid=1000,size=128m \
    --tmpfs "$runtime_home:rw,nosuid,nodev,uid=1000,gid=1000,size=32m" \
    --env "TEST_IMAGE_ROLE=$role" \
    --env "TEST_NPM_EXTRAS=${3:-}" \
    --workdir /tmp --entrypoint node "$image" \
    --input-type=module < "$test_dir/image-smoke.mjs"
