# treyturner/openclaw

Custom OpenClaw gateway and sandbox images. The gateway extends
`ghcr.io/openclaw/openclaw`; the sandbox extends
`ghcr.io/jdx/mise:2026.10.17-debian` (Debian 13/Trixie), with Node 26 and uv
installed by mise during the build. Together they provide:

- MCPs installed and configured for use:
    - Playwright in the sandbox ([`@playwright/mcp`](https://github.com/microsoft/playwright-mcp))
    - TickTick via its [official remote MCP service](https://help.ticktick.com/articles/7438129581631995904)
- Chromium in the sandbox, installed by the matching Playwright version
- Commonly needed workflow utilities:
  - bash with `openclaw` completion
  - curl
  - docker cli for sandboxing
  - ffmpeg
  - git
  - imagemagick
  - jq
  - openssh-client
  - python3-venv
  - rsync
  - vim
  - yq

The sandbox runs as `sandbox` (UID/GID 1000), with `HOME=/home/sandbox` and
`/workspace` as its working directory. Additional package installation runs from
`/app` during the build. Its default command is `sleep infinity`; OpenClaw manages tool
execution inside the running container. The OpenClaw CLI belongs to the gateway.

The sandbox's tool versions are declared in `sandbox/mise.toml` and resolved in
`sandbox/mise.lock`, including download checksums for Linux x64 and ARM64. Builds
use `mise install --locked`. Tools live under `/mise`, outside the user's home
and workspace, with direct links in `/usr/local/bin` so commands work without
shell activation or runtime downloads. The gateway keeps upstream OpenClaw's
Node runtime.

To update sandbox tools, edit `sandbox/mise.toml` as needed, then regenerate the
lockfile with mise 2026.10.17 or later and review the resulting versions:

```sh
mise -C sandbox lock --bump --platform linux-x64,linux-arm64
```

Playwright MCP uses `/usr/local/bin/chromium` and runs headless with an isolated
profile. Its default output directory is `/workspace/.playwright-mcp`; explicit
relative filenames resolve from `/workspace`. Browser binaries live outside the
user's home directory and are readable by the sandbox user. Runtime caches use
`/tmp/.cache` so they work with a read-only root filesystem.

TickTick connects to `https://mcp.ticktick.com` over Streamable HTTP. The shipped
configuration reads `TICKTICK_API_TOKEN` at runtime; credentials are not baked
into either image. See the MCP configuration section below for overrides.

## Usage

Example `.env`:

```properties
# Host mount paths
OPENCLAW_USER_BASE=/mnt/cache/appdata/openclaw

# Gateway settings
OPENCLAW_GATEWAY_BIND=lan

# Auth token (generate once with `openssl rand -hex 32`)
OPENCLAW_GATEWAY_TOKEN=

# API keys
ANTHROPIC_API_KEY=
#BRAVE_API_KEY=
#OPENAI_API_KEY=
TAVILY_API_KEY=

# TickTick MCP (optional; needed only when calling TickTick)
TICKTICK_API_TOKEN=

# Optional
OPENCLAW_EXTRA_MOUNTS=
```

Example `docker-compose.yml`:

```
x-hardening: &hardening
  user: "node:node"
  tmpfs:
    - /tmp:rw,nosuid,nodev,size=1g
    - /run:rw,nosuid,nodev,size=64m
  pids_limit: 512

x-environment: &environment
  OPENCLAW_GATEWAY_TOKEN: ${OPENCLAW_GATEWAY_TOKEN}
  ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
  BRAVE_API_KEY: ${BRAVE_API_KEY}
  OPENAI_API_KEY: ${OPENAI_API_KEY}
  TAVILY_API_KEY: ${TAVILY_API_KEY}
  TICKTICK_API_TOKEN: ${TICKTICK_API_TOKEN:-}

x-volumes: &volumes
  - ${OPENCLAW_USER_BASE}/config:/home/node/.openclaw

services:
  gateway:
    <<: *hardening
    image: ghcr.io/treyturner/openclaw
    container_name: openclaw
    environment:
      <<: *environment
    volumes: *volumes
    ports:
      - "${OPENCLAW_GATEWAY_PORT:-18789}:18789"
      - "${OPENCLAW_BRIDGE_PORT:-18790}:18790"
    init: true
    restart: unless-stopped
    command:
      [
        "node", "dist/index.js", "gateway",
        "--bind", "${OPENCLAW_GATEWAY_BIND:-lan}",
        "--port", "18789"
      ]

  cli:
    <<: *hardening
    image: ghcr.io/treyturner/openclaw
    profiles: ["cli"]
    container_name: openclaw_cli
    environment:
      <<: *environment
      BROWSER: echo
    volumes: *volumes
    stdin_open: true
    tty: true
    init: true
    entrypoint: ["node", "dist/index.js"]

networks:
  default:
    name: openclaw
```

## MCP configuration

Each image has its own readable defaults at `/etc/mcporter/mcporter.json`.
`MCPORTER_CONFIG` selects that absolute path, so commands work from any directory
and mounted home directories do not hide the defaults. Gateway defaults contain
TickTick; sandbox defaults contain Playwright and TickTick. Automatic editor
config imports are disabled.

To customize a runtime, bind-mount a complete config over that file, or set
`MCPORTER_CONFIG` to another absolute path inside the container. An explicit
`mcporter --config <file>` takes precedence. These are replacement configs;
mcporter does not merge other home or project configs when a path is explicit.
Edit a read-only mounted config on the host. For `mcporter config add` and other
mutations inside the container, select a config in a writable mounted directory.

For TickTick, create an API token in the TickTick web app under **Settings →
Account & Security → API Token**, as described in the
[official guide](https://help.ticktick.com/articles/7438129581631995904).
Set `TICKTICK_API_TOKEN` in the runtime that calls TickTick. Config inspection
keeps the environment placeholder; the bearer header is resolved when connecting.
Without a token, Playwright and config inspection still work, while TickTick
calls fail with the missing variable's name.

The Compose example passes the token to the gateway and CLI. Sandboxes do not
inherit the gateway's environment; when using TickTick there, merge this into
your OpenClaw configuration:

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "docker": {
          "env": {
            "TICKTICK_API_TOKEN": "${TICKTICK_API_TOKEN}"
          }
        }
      }
    }
  }
}
```

TickTick also requires outbound HTTPS access from the calling container; these
image defaults do not change OpenClaw's sandbox network policy.

For OAuth instead, use a custom TickTick definition with `auth: "oauth"` and no
`Authorization` header. Set `XDG_DATA_HOME` to a mounted directory writable by
UID 1000 so `mcporter/credentials.json` survives container replacement, and use
`mcporter auth ticktick --no-browser` with a reachable OAuth callback. See
[mcporter's configuration guide](https://github.com/openclaw/mcporter/blob/v0.16.0/docs/config.md)
for OAuth setup and persistence. Browser auto-launch is disabled in both images.

Run the focused configuration and authentication checks against local images:

```sh
bash tests/mcporter-config.sh <gateway-image> <sandbox-image>
```

These checks use local fixtures and require no account credentials or external
network. They cover home mounts, working-directory changes, explicit overrides,
bearer headers, and browser navigation and screenshots through mcporter.

## Build strategy

This repo builds and publishes a gateway and sandbox image pair. Scheduled runs
skip the pair when both upstream base digests already have published downstream
images. Pushes to `main` and manual dispatches rebuild the pair regardless.

Workflow:
1. Resolve each image's upstream base digest independently
2. On scheduled runs, rebuild the pair if either downstream `base-<digest-short>` tag is missing
3. Build `Dockerfile.gateway` and `Dockerfile.sandbox` with their resolved bases and separate registry caches, loading both candidates locally
4. Run the existing Playwright/Chromium smoke test against each candidate
5. Tag + push both candidates only after both builds and tests pass

Schedule: daily at 08:00 UTC + manual dispatch.

## Published tags

Both `ghcr.io/treyturner/openclaw` (gateway) and
`ghcr.io/treyturner/openclaw-sandbox` (sandbox), plus their Forgejo mirrors, receive:

- `latest`
- `daily`
- `YYYYMMDD`
- `<short git sha>`
- `base-<upstream-digest-short>`

## Build args

Extra packages can be baked into the image by adding them to space-separated strings set into:

- `EXTRA_APT_PKGS`
- `EXTRA_NPM_GLOBAL_PKGS`
- `EXTRA_NPM_LOCAL_PKGS`
- `EXTRA_PIP_PKGS`

Python extras are installed into `/opt/python`, whose `bin` directory is on
`PATH` for the runtime user. The `uv` and `uvx` commands are installed globally.

## Notes

- This repository contains packaging/build customization.
- Upstream OpenClaw licensing still applies to upstream components included in the final image.
