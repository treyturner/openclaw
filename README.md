# treyturner/openclaw

Custom OpenClaw image built on top of `ghcr.io/openclaw/openclaw` with:

- MCPs installed and configured for use:
    - Playwright ([`@playwright/mcp`](https://github.com/microsoft/playwright-mcp))
    - TickTick ([`dev-mirzabicer/ticktick`](https://github.com/dev-mirzabicer/ticktick-sdk))
- Chromium browser
- Common util packages for OpenClaw workflows
- `openclaw` Bash completion

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

## Environment variables

- TickTick
    - `TICKTICK_CLIENT_ID`
    - `TICKTICK_CLIENT_SECRET`
    - `TICKTICK_USERNAME`
    - `TICKTICK_PASSWORD`

## Build args

Extra packages can be baked into the image by adding them to a space-separated string set into the appropriate build-arg:

- `EXTRA_APT_PKGS`
- `EXTRA_NPM_GLOBAL_PKGS`
- `EXTRA_NPM_LOCAL_PKGS`
- `EXTRA_PIP_PKGS`

## Required Forgejo secret

- `FORGEJO_REGISTRY_TOKEN` (token with push access to container registry)

## Notes

- This repository contains packaging/build customization.
- Upstream OpenClaw licensing still applies to upstream components included in the final image.
