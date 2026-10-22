#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 2 ]]; then
    echo "Usage: bash tests/mcporter-config.sh <gateway-image> <sandbox-image>" >&2
    exit 2
fi

test_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
images=("$1" "$2")
roles=(gateway sandbox)
homes=(/home/node /home/sandbox)

for index in 0 1; do
    docker run --rm --interactive --read-only --network none \
        --cap-drop ALL --security-opt no-new-privileges \
        --tmpfs /tmp:rw,nosuid,nodev,size=512m \
        --tmpfs /workspace:rw,nosuid,nodev,uid=1000,gid=1000,size=128m \
        --tmpfs "${homes[index]}:rw,nosuid,nodev,uid=1000,gid=1000,size=32m" \
        --env "TEST_IMAGE_ROLE=${roles[index]}" \
        --workdir /tmp --entrypoint node "${images[index]}" \
        --input-type=module < "$test_dir/mcporter-config.mjs"
done
