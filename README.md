# treyturner/openclaw

Custom OpenClaw image built on top of `ghcr.io/openclaw/openclaw` with:

- Playwright (`playwright` + `playwright-core`)
- Chromium browser preinstalled at image build time
- Common utility packages for OpenClaw workflows
- Bash completion installed for `openclaw`

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

## Required Forgejo secret

- `FORGEJO_REGISTRY_TOKEN` (token with push access to container registry)

## Notes

- This repository contains packaging/build customization.
- Upstream OpenClaw licensing still applies to upstream components included in the final image.
