#!/bin/bash
set -euo pipefail

# Both images are Debian-based and install curl and gpg before running this.
export DEBIAN_FRONTEND=noninteractive
install_tmp="$(mktemp -d)"
trap 'rm -rf "$install_tmp"' EXIT
export GNUPGHOME="$install_tmp/gnupg"
install -d -m 0700 "$GNUPGHOME"
install -d -m 0755 /etc/apt/keyrings

verify_key() {
    local key_file="$1" expected="$2" actual
    actual="$(gpg --batch --with-colons --show-keys "$key_file" \
        | awk -F: '$1 == "fpr" && !seen++ { print $10 }')"
    if [[ "$actual" != "$expected" ]]; then
        printf 'Unexpected signing key fingerprint for %s: %s\n' "$key_file" "$actual" >&2
        exit 1
    fi
}

# Vendor-documented signing keys, scoped to their respective APT repositories.
curl -fsSL https://downloads.1password.com/linux/keys/1password.asc \
    -o /etc/apt/keyrings/1password.asc
verify_key /etc/apt/keyrings/1password.asc 3FEF9748469ADBE15DA7CA80AC2D62742012EA22
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/1password.asc] https://downloads.1password.com/linux/debian/%s stable main\n' \
    "$(dpkg --print-architecture)" "$(dpkg --print-architecture)" \
    > /etc/apt/sources.list.d/1password.list
install -d -m 0755 /etc/debsig/policies/AC2D62742012EA22 /usr/share/debsig/keyrings/AC2D62742012EA22
curl -fsSL https://downloads.1password.com/linux/debian/debsig/1password.pol \
    -o /etc/debsig/policies/AC2D62742012EA22/1password.pol
gpg --batch --yes --dearmor \
    --output /usr/share/debsig/keyrings/AC2D62742012EA22/debsig.gpg /etc/apt/keyrings/1password.asc

curl -fsSL https://downloads.claude.ai/keys/claude-code.asc \
    -o /etc/apt/keyrings/claude-code.asc
verify_key /etc/apt/keyrings/claude-code.asc 31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/claude-code.asc] https://downloads.claude.ai/claude-code/apt/latest latest main\n' \
    "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/claude-code.list

apt-get update -o APT::Update::Error-Mode=any
apt-get install -y --no-install-recommends 1password-cli claude-code
op --version
claude --version
rm -rf /var/lib/apt/lists/*
