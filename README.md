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

The gateway's Docker CLI is copied from the official `docker:29.9.2-cli` image,
pinned by digest in `Dockerfile.gateway`. The Docker daemon and container runtime
run on the host. OpenClaw uses the core CLI to manage sandboxes through the
mounted socket; run Compose and image builds on the host. Update the CLI's image
tag and digest together when upgrading it.

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

The checked-in `compose.yaml`, `.env.example`, and
`config/openclaw.example.json` form the deployment example. Run Compose on the
same Linux Docker host that will create the sandboxes.

1. Copy `.env.example` to `.env`. Set `OPENCLAW_USER_BASE` to an absolute host
   directory, set `DOCKER_GID` to the group ID of `DOCKER_SOCKET`, and generate
   `OPENCLAW_GATEWAY_TOKEN` with `openssl rand -hex 32`. Add the model credentials
   you plan to use. The default image references use `latest`.
2. Create the data directories with ownership matching UID/GID 1000. For the
   default path, run:

   ```sh
   sudo install -d -m 0700 -o 1000 -g 1000 \
     /mnt/cache/appdata/openclaw \
     /mnt/cache/appdata/openclaw/config \
     /mnt/cache/appdata/openclaw/workspace
   ```

3. For a fresh deployment, copy `config/openclaw.example.json` to
   `<OPENCLAW_USER_BASE>/config/openclaw.json`, owned by UID/GID 1000 with mode
   0600. For an existing deployment, merge the example's settings into your
   existing config. It enables sandboxing for every session and selects the
   custom sandbox image; model and channel setup remain yours to configure.
4. Pull the gateway and sandbox images, then start the gateway:

   ```sh
   docker compose config --quiet
   docker compose pull gateway
   docker pull ghcr.io/treyturner/openclaw-sandbox:latest
   docker compose up -d gateway
   docker compose run --rm cli config validate
   docker compose run --rm cli sandbox explain
   ```

   If you override `OPENCLAW_SANDBOX_IMAGE`, pull that reference instead. The
   sandbox image must exist on the daemon used by the gateway. OpenClaw creates
   sandbox containers on demand; there is no permanent Compose sandbox service.

The gateway listens on port 18789 inside its container and publishes to
`http://127.0.0.1:18789` by default. The administration CLI shares the gateway's
network and PID namespaces so loopback reaches the gateway and shared-state
ownership checks can identify its process. For a remote UI, use an SSH tunnel or
HTTPS reverse proxy and set
`OPENCLAW_CONTROL_UI_ORIGIN` to the browser's origin. Change
`OPENCLAW_PUBLISH_HOST` and `OPENCLAW_GATEWAY_PORT` when needed.

The gateway and administration CLI receive the host Docker socket and its
supplementary group. They therefore have control over that Docker daemon.
Sandboxes receive the workspace mount and configured environment; the Docker
socket and gateway/provider credentials are not passed to them.

The data directory has the **same absolute path inside and outside the gateway**.
OpenClaw sends workspace paths to the host Docker daemon when creating sandbox
bind mounts. Mapping the directory only to `/home/node/.openclaw` would leave
those source paths pointing at a different location on the host. State and XDG
data persist under `OPENCLAW_USER_BASE`; workspaces are writable by UID/GID 1000.

The example uses the Docker `bridge` network for sandbox outbound access, which
Playwright and remote MCP services need. Sandboxes have a read-only root
filesystem, temporary directories, resource limits, and no published ports.
They run Playwright MCP from the custom sandbox image; OpenClaw's separate
browser sidecar is disabled. To make sandboxes offline, change
`agents.defaults.sandbox.docker.network` to `none`.

If the host's default Docker DNS servers are unreachable, set
`agents.defaults.sandbox.docker.dns` to reachable resolver addresses. Gateway DNS
can be configured with a Compose override on `services.gateway.dns`.

After changing the sandbox image or settings, recreate the affected sandboxes
with `docker compose run --rm cli sandbox recreate --all`; OpenClaw creates
replacements on the next tool call.

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

Compose passes the optional token to the gateway and CLI. After setting a
nonempty `TICKTICK_API_TOKEN` in `.env`, merge this into your deployed OpenClaw
config to enable TickTick in sandboxes as well. Provider keys stay in the gateway:

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

## Build strategy

This repo rebuilds and tests a gateway and sandbox image pair daily, on pushes to
`main`, and on manual dispatch. README/Funding-only changes are ignored. An
unchanged base digest does not imply unchanged Debian packages or npm dependencies.

Workflow:

1. Resolve each image's upstream base digest independently
2. Build `Dockerfile.gateway` and `Dockerfile.sandbox` with their resolved bases and separate registry caches, loading both candidates locally
3. Bypass the layer cache for the `gateway` and `sandbox` stages so APT, npm, and optional Python installation steps run again; reuse the sandbox's locked mise tool stage
4. Test gateway startup and health, sandbox browser operation through the configured Playwright MCP, and both images' runtime tools and MCP configuration
5. Tag + push both candidates only after both builds and tests pass

Schedule: daily at 08:00 UTC + manual dispatch.

The dependency stages refresh APT indexes and upgrade installed Debian packages
before adding tools. Their APT caches are separate and locked. Cache mounts still
reuse npm downloads and browser binaries; bypassing layer reuse ensures
the installation steps actually check their repositories. This follows Docker's
[cache invalidation guidance](https://docs.docker.com/build/cache/invalidation/).

OpenClaw follows upstream `latest`, resolved to a digest for each build. The mise
base, MCP package versions, Docker CLI image, and uv image are pinned. Node and uv
downloads are locked with checksums in `sandbox/mise.lock`. Updating those tools
requires a reviewed version or lockfile change. Keep uv's version in
`sandbox/mise.toml` and the gateway's uv image reference in sync, including the
image digest.

Debian packages and npm transitive dependencies are refreshed within those
constraints. These are rolling development builds, so rebuilding the same Git
commit can produce a different image. Use a published image digest for an exact
deployment or rollback; the Git and base tags are mutable aliases.

For a local build with the same refresh policy:

```sh
docker buildx build --pull --no-cache-filter gateway \
  -f Dockerfile.gateway --load -t openclaw-gateway:local .
docker buildx build --pull --no-cache-filter sandbox \
  -f Dockerfile.sandbox --load -t openclaw-sandbox:local .
```

Run the same smoke tests locally before publishing:

```sh
bash tests/image-smoke.sh gateway <gateway-image>
bash tests/image-smoke.sh sandbox <sandbox-image>
```

Tests run as each image's default user with a read-only root filesystem, empty
mounted home and workspace directories, and no external network, Docker socket,
or account credentials. Local fixtures cover MCP configuration discovery,
explicit overrides, and bearer authentication. The gateway must start and
respond to `/healthz` and negotiate Docker Engine APIs 1.44 and 1.41 against local
fixtures; the sandbox must navigate and save a screenshot through
its configured Playwright MCP. Both must run Node, npm, Python, and uv from a
login shell. A failure in either candidate prevents publication of both images.

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

Global npm extras are installed under `/opt/npm-global`; local npm extras form a
separate project at `/opt/npm-local`. Both install commands run from those
directories, keeping OpenClaw's `/app` manifest and dependency tree separate.
Their CLI directories are appended to `PATH` in normal and login shells, so core
tools take precedence when command names overlap. These directories live outside
mounted homes and workspaces and are readable by UID 1000.

Local libraries can be resolved explicitly from their project, for example in a
Node script using JSON5 installed through `EXTRA_NPM_LOCAL_PKGS`:

```js
import { createRequire } from 'node:module';
const requireExtra = createRequire('/opt/npm-local/package.json');
const JSON5 = requireExtra('json5');
```

The image does not add these libraries to `NODE_PATH`. Workspace projects can
keep their own dependency versions.

Python extras are installed into `/opt/python`, whose `bin` directory is on
`PATH` for the runtime user. The `uv` and `uvx` commands are installed globally.

To exercise optional npm installation, build each image with
`EXTRA_NPM_GLOBAL_PKGS="mcporter@0.15.0 semver@7.7.3"` and
`EXTRA_NPM_LOCAL_PKGS="json5@2.2.3 is-number@7.0.0"`, then run:

```sh
bash tests/image-smoke.sh gateway <gateway-image-with-extras> --npm-extras
bash tests/image-smoke.sh sandbox <sandbox-image-with-extras> --npm-extras
```

The older optional mcporter is a test fixture for command precedence. The checks
cover global and local CLIs, library loading, and core tool priority from multiple
directories and both shell modes, with mounted homes and a read-only root.

## Notes

- This repository contains packaging/build customization.
- Upstream OpenClaw licensing still applies to upstream components included in the final image.
