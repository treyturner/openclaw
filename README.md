# treyturner/openclaw

Custom OpenClaw gateway and sandbox images. The gateway extends
`ghcr.io/openclaw/openclaw`; the sandbox extends the official
`docker.io/library/node:26-bookworm-slim` image. Together they provide:

- MCPs installed and configured for use:
    - Playwright ([`@playwright/mcp`](https://github.com/microsoft/playwright-mcp))
    - TickTick ([`dev-mirzabicer/ticktick`](https://github.com/dev-mirzabicer/ticktick-sdk))
- Chromium browser
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
`/workspace` as its working directory. Tool installation and patching run from
`/app` during the build. Its default command is `sleep infinity`; OpenClaw manages tool
execution inside the running container. The OpenClaw CLI belongs to the gateway.

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

# TickTick
## All vars mandatory, see https://github.com/dev-mirzabicer/ticktick-sdk#the-two-api-problem
## see https://developer.ticktick.com/manage to create your client ID/secret. Set an OAuth
## redirect URL of http://127.0.0.1:8080/callback
## Access token is retrieved via `ticktick-sdk auth` and is good for 180 days
TICKTICK_ACCESS_TOKEN=
TICKTICK_CLIENT_ID=
TICKTICK_CLIENT_SECRET=
TICKTICK_PASSWORD=
TICKTICK_USERNAME=

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
  TICKTICK_ACCESS_TOKEN: ${TICKTICK_ACCESS_TOKEN}
  TICKTICK_CLIENT_ID: ${TICKTICK_CLIENT_ID}
  TICKTICK_CLIENT_SECRET: ${TICKTICK_CLIENT_SECRET}
  TICKTICK_PASSWORD: ${TICKTICK_PASSWORD}
  TICKTICK_USERNAME: ${TICKTICK_USERNAME}

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

## Notes

- This repository contains packaging/build customization.
- Upstream OpenClaw licensing still applies to upstream components included in the final image.
