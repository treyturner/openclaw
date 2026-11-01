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
  - gh
  - git
  - imagemagick
  - jq
  - openssh-client
  - python3-venv
  - rsync
  - vim
  - wget
  - yq
- Network debugging:
  - dnsutils
  - iputils-ping
  - iproute2
  - mtr-tiny
  - net-tools
  - netcat-openbsd
  - tcpdump
  - telnet
  - traceroute

The sandbox runs as `sandbox` (UID/GID 1000), with `HOME=/home/sandbox` and
`/workspace` as its working directory. Additional package installation runs from
`/app` during the build. Its default command is `sleep infinity`; OpenClaw manages tool
execution inside the running container. The OpenClaw CLI belongs to the gateway.

The gateway's Docker CLI is copied from the official `docker:29.9.2-cli` image,
pinned by digest in `Dockerfile.gateway`. The outer Compose stack runs a dedicated
`openclaw-dind` Docker daemon and two small controller services. The inner stack
in `compose.inner.yaml` runs `openclaw-gateway` and the administration CLI through
that daemon; OpenClaw creates sandbox containers there as needed.

**The gateway and its sandboxes must use the daemon that created the gateway.**
OpenClaw inspects its own container and verifies its identity before translating
workspace bind sources. An outer gateway connected to a separate DinD daemon
fails that check even when the workspace paths match. See the
[upstream identity check](https://github.com/openclaw/openclaw/blob/fe06181/src/agents/sandbox/docker-mount-source.ts).

The gateway uses DinD's mounted Unix socket. The outer host's Docker socket is
not mounted into the stack. Update the CLI, controller, and DinD image tags and
digests together when upgrading Docker.

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

`compose.yaml` is the outer stack. `compose.inner.yaml` defines the services
created inside DinD. Keep both files and `scripts/compose-inner.sh` together when
copying this deployment into another Compose project. The outer file's two
`configs` entries point to those files; adjust their paths if you move them.
Run Compose on a Linux Docker host that supports privileged DinD containers.

1. Copy `.env.example` to `.env`. Set `OPENCLAW_USER_BASE` to an absolute host
   directory and generate `OPENCLAW_GATEWAY_TOKEN` with `openssl rand -hex 32`.
   Add the model credentials you plan to use. Set `OPENCLAW_CONTROL_UI_ORIGIN`
   to the browser URL when using a reverse proxy.
2. Create the data directories with ownership matching UID/GID 1000. For the
   default path, run:

   ```sh
   sudo install -d -m 0700 -o 1000 -g 1000 \
     /mnt/cache/appdata/openclaw \
     /mnt/cache/appdata/openclaw/config \
     /mnt/cache/appdata/openclaw/workspace \
     /mnt/cache/appdata/openclaw/tmp
   ```

3. For a fresh deployment, copy `config/openclaw.example.json` to
   `<OPENCLAW_USER_BASE>/config/openclaw.json`, owned by UID/GID 1000 with mode
   0600. For an existing deployment, merge its settings into your existing
   config. Model and channel setup remain yours to configure.
4. Start DinD, pull both application images into its store, then deploy the
   inner gateway:

   ```sh
   docker compose config --quiet
   docker compose pull openclaw-dind openclaw-deploy
   docker compose up -d --wait openclaw-dind
   docker compose run --rm openclaw-deploy pull
   docker compose run --rm openclaw-deploy up --detach --wait
   docker compose run --rm openclaw-cli config validate
   docker compose run --rm openclaw-cli sandbox explain
   ```

The controller uses the image references from `.env` for both pulls. A plain
`docker pull` on the outer host does not populate DinD's image store. On a fresh
store, the deployment controller also pulls a missing sandbox image automatically.
For later updates, repeat the controller's `pull` and `up` commands.

`docker compose up -d` starts DinD and the deployment controller together. The
controller exits successfully once the inner gateway is healthy; an exited
`openclaw-deploy` container with status 0 is expected. It holds no long-running
OpenClaw process. Both controllers run without network access and use only the
shared socket. Model credentials pass to the inner services through their
controller's environment; DinD itself receives no model credentials.

Manage the inner stack through the controller:

```sh
docker compose run --rm openclaw-deploy ps
docker compose run --rm openclaw-deploy logs --tail 100 openclaw-gateway
docker compose run --rm openclaw-deploy exec openclaw-gateway \
  curl -i http://127.0.0.1:18789/healthz
docker compose run --rm openclaw-cli sandbox recreate --all
```

The inner CLI shares the gateway's network and PID namespaces so loopback
reaches the gateway and shared-state ownership checks can identify its process.
The controller preserves interactive input for commands such as onboarding.

The gateway uses `--bind lan`, which listens on `0.0.0.0` inside its container.
The inner stack publishes gateway port 18789 on **DinD's interfaces**. The outer
stack then publishes that port on
`${OPENCLAW_PUBLISH_HOST}:${OPENCLAW_GATEWAY_PORT}`, defaulting to
`127.0.0.1:18789` on the physical host. These are two separate port mappings.
The Docker API continues to listen only on its Unix socket.

For an HTTPS reverse proxy, terminate TLS at the proxy and forward plain HTTP to
the gateway port unless you separately configure gateway TLS. Set
`OPENCLAW_CONTROL_UI_ORIGIN` to the HTTPS browser origin. That setting controls
the allowed origin, rather than a listening interface. Configure OpenClaw's
`gateway.trustedProxies` for the proxy's actual source IP, as described in the
[upstream proxy guidance](https://docs.openclaw.ai/gateway/security/network-exposure#reverse-proxy-configuration).

For your own macvlan/VLAN Compose stack, attach **`openclaw-dind`** to the VLAN.
For example, a DinD IP of `192.168.20.50` gives HAProxy the backend
`http://192.168.20.50:18789`. The inner gateway is reached through DinD's port
mapping; it needs no separate VLAN address. The two outer controller services
use Unix sockets and can keep `network_mode: none`. No host port mapping is
needed for direct macvlan access, so remove `openclaw-dind.ports` from the outer
file in that deployment. `OPENCLAW_PUBLISH_HOST` then has no effect. Keep the
inner gateway's port mapping: it is what forwards DinD port 18789 to OpenClaw.

To check proxy reachability, request `http://<dind-ip>:18789/healthz` from the
proxy host; expect HTTP 200. Macvlan normally isolates containers from the outer
Docker host, so test the container IP from the proxy or another LAN machine.

DinD creates `/run/dind/docker.sock` with group `DOCKER_GID` (default 2375).
The controllers, gateway, and CLI receive that supplementary group while running
as UID/GID 1000. The inner services bind-mount `/run/dind` from DinD's filesystem;
using a new inner named volume there would select a different, empty directory.
Sandboxes receive their workspace and configured environment, without the socket
or gateway/provider credentials.

`OPENCLAW_USER_BASE` has the same absolute path on the outer host, inside DinD,
and inside the gateway. Add matching mounts to DinD and the inner gateway for
workspaces outside that directory. State and XDG data persist under that base;
workspaces are writable by UID/GID 1000. Sandboxes use DinD's `bridge` network
for outbound access. Their root filesystem is read-only, with temporary
writable directories and resource limits. OpenClaw's separate browser sidecar is
disabled because Playwright runs in the sandbox image.

The inner gateway and CLI set `TMPDIR` to `<OPENCLAW_USER_BASE>/tmp`. OpenClaw's
agent setup runs an inference check in a temporary workspace, which must also
be backed by a host bind mount. Leaving that workspace under the gateway's
`/tmp` tmpfs causes an unsupported-mount error. For existing deployments, create
the `tmp` directory with UID/GID 1000 and mode 0700, update `compose.inner.yaml`,
then run `docker compose run --rm openclaw-deploy up --detach --wait` to recreate
the gateway. These temporary files use disk space and can survive a restart;
remove abandoned files only while OpenClaw is stopped.

For custom DNS, configure `services.openclaw-dind.dns` in the outer stack for
registry access, and `services.openclaw-gateway.dns` in the inner stack for the
gateway. Sandbox DNS is configured through
`agents.defaults.sandbox.docker.dns` in OpenClaw's deployed config. Set the
sandbox network to `none` there if you want offline tools.

DinD remains privileged and shares the host kernel. Its `dind-data` volume
persists inner images, gateway containers, and sandboxes across service
recreation and outer `docker compose down`. Removing that volume, including with
`docker compose down --volumes`, deletes the inner daemon's images and containers.
To stop the inner gateway alone, run the controller with `down`; the outer
DinD service and its stored images remain.

When migrating the previous sibling-gateway layout, stop and remove the old
**outer** gateway and CLI containers first. Stop the old DinD container too
before starting its renamed replacement; only one daemon may use its data
directory at a time. Retain the application data and DinD storage. Replace the
old outer gateway service with `openclaw-deploy`, add the
new config file mounts, and deploy the inner stack using the commands above.
Retain your existing DinD data and socket volume names or bind mounts when
merging the renamed `openclaw-dind` service into a larger stack. Update a macvlan
proxy backend from the old gateway IP to the DinD IP after deployment succeeds.
`DOCKER_SOCKET` is unused; `DOCKER_GID` controls the shared DinD socket group.

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

The publishing workflow rebuilds and tests a gateway and sandbox image pair daily,
on pushes to `main`, and on manual dispatch. README/Funding-only pushes are
ignored. An unchanged base digest does not imply unchanged Debian packages or npm
dependencies.

Pull requests targeting `main` build and smoke-test both images in separate matrix
jobs, using the same base resolution, dependency refresh policy, and smoke tests.
An additional Compose integration job tests the deployment against the published
image pair. Publishing runs test the deployment with their actual candidates.
These checks run for every PR update, including documentation changes, with read
access to the repository and no registry logins, secrets, cache exports, or image
pushes. New commits cancel older runs for the same PR without interrupting the
publishing workflow.

Publishing workflow:

1. Require registry credentials and log in to GHCR and Forgejo before building; resolve each image's upstream base digest independently
2. Build `Dockerfile.gateway` and `Dockerfile.sandbox` with their resolved bases and separate registry caches, loading both candidates locally
3. Bypass the layer cache for the `gateway` and `sandbox` stages so APT, npm, and optional Python installation steps run again; reuse the sandbox's locked mise tool stage
4. Test runtime tools and MCP configuration, then deploy both candidates inside DinD and run a sandboxed agent tool through a local model fixture
5. Publish both candidates to GHCR after both builds and tests pass, then publish both to Forgejo

Schedule: daily at 08:00 UTC + manual dispatch.

Both registries are required. GHCR uses the workflow's `GITHUB_TOKEN` with package
write permission. Set the repository secret `FORGEJO_REGISTRY_TOKEN` to a token
that can write both Forgejo packages as the repository owner. A missing token or
failed login stops the workflow before any builds or release tag pushes.

A Forgejo push failure fails the workflow after both GHCR images have been
published. Pushes across tags and repositories are separate operations, so a
later failure can leave only some tags updated. Rerun the workflow to retry the
pair; the rebuild may include newer upstream images or dependencies. New runs
wait for the active run instead of automatically cancelling publication midway.

The shared `.dockerignore` allows only the two mcporter configuration files and
the sandbox mise manifest and lockfile into the build context. Git history,
deployment files, tests, and local files are excluded. Add an explicit exception
when a Dockerfile needs to copy a new local input. Docker sends the selected
Dockerfile separately, as described in its [build context documentation](https://docs.docker.com/build/concepts/context/#dockerignore-files).

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

Exercise the complete nested deployment locally with:

```sh
python3 tests/compose-smoke.py <gateway-image> <sandbox-image>
```

This test creates its own Compose project and volumes, transfers the supplied
images into DinD, and validates gateway HTTP and the administration CLI. It
reproduces the container identity failure with an outer gateway, then uses a
local model fixture to make the nested gateway create a real sandbox and execute
a tool against the workspace. It also runs OpenClaw's real setup inference check,
first reproducing the tmpfs failure and then verifying the bind-backed `TMPDIR`.
It repeats the tool turn after recreating DinD to
verify persistence and socket reconnection. No provider credentials are used;
test containers and volumes are removed afterward. The test needs Docker,
Compose, Python 3, and support for privileged DinD containers.

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
