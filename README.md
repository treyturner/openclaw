# treyturner/openclaw

Custom OpenClaw image built on top of `ghcr.io/openclaw/openclaw` with:

- MCPs installed and configured for use:
    - Playwright ([`@playwright/mcp`](https://github.com/microsoft/playwright-mcp))
    - TickTick ([`dev-mirzabicer/ticktick`](https://github.com/dev-mirzabicer/ticktick-sdk))
- Chromium browser
- Common util packages for OpenClaw workflows
- `openclaw` Bash completion

## Usage

Example `.env`:

```properties
# Host mount paths
OPENCLAW_USER_BASE=/mnt/cache/appdata/openclaw

# Gateway settings
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_BRIDGE_PORT=18790
OPENCLAW_GATEWAY_BIND=lan

# Auth token (generate once with `openssl rand -hex 32`)
OPENCLAW_GATEWAY_TOKEN=

# TickTick
## All vars mandatory, see https://github.com/dev-mirzabicer/ticktick-sdk#the-two-api-problem
## see https://developer.ticktick.com/manage to create your client ID/secret. Set an OAuth
## redirect URL of http://127.0.0.1:8080/callback
## Access token is retrieved via `ticktick-sdk auth` and is good for 180 days
TICKTICK_ACCESS_TOKEN=
TICKTICK_CLIENT_ID=
TICKTICK_CLIENT_SECRET=
TICKTICK_USERNAME=
TICKTICK_PASSWORD=

# Other API keys
BRAVE_API_KEY=
OPENAI_API_KEY=

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
  BRAVE_API_KEY: ${BRAVE_API_KEY}
  OPENAI_API_KEY: ${OPENAI_API_KEY}
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
    image: forgejo.treyturner.info/treyturner/openclaw
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
    image: forgejo.treyturner.info/treyturner/openclaw
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

This repo builds and publishes only when the upstream base image digest changes.

Workflow:
1. Check digest of `ghcr.io/openclaw/openclaw:latest`
2. Skip if image tag `base-<digest-short>` already exists
3. Build candidate image (single build, local load)
4. Run smoke test (`playwright` launches chromium and loads `example.com`)
5. Tag + push if test passes

Schedule: every 6 hours + manual dispatch.

## Published tags

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

## Forgejo Actions requirements

- `FORGEJO_REGISTRY_TOKEN`: a token with push access to the container registry

## Notes

- This repository contains packaging/build customization.
- Upstream OpenClaw licensing still applies to upstream components included in the final image.
