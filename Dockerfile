# syntax=docker/dockerfile:1.7
ARG BASE_REGISTRY=ghcr.io \
    BASE_OWNER=openclaw \
    BASE_REPO=openclaw \
    BASE_TAG=latest
ARG BASE_REF=${BASE_REGISTRY}/${BASE_OWNER}/${BASE_REPO}:${BASE_TAG}

FROM ${BASE_REF}

ARG EXTRA_APT_PKGS="" \
    EXTRA_NPM_LOCAL_PKGS="" \
    EXTRA_NPM_GLOBAL_PKGS="" \
    EXTRA_PIP_PKGS=""

SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

USER root

ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright \
    TERM=xterm-256color

# apt install
RUN --mount=type=cache,target=/var/lib/apt,id=apt-lib \
    --mount=type=cache,target=/var/cache/apt,id=apt-cache \
    apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        curl \
        docker.io \
        ffmpeg \
        git \
        imagemagick \
        jq \
        openssh-client \
        python3-venv \
        rsync \
        vim \
        yq \
        ${EXTRA_APT_PKGS} \
    && rm -rf /var/lib/apt/lists/*

# npm install
RUN --mount=type=cache,target=/root/.npm,id=npm-cache \
    npm i -g mcporter @playwright/mcp@0.0.68 ${EXTRA_NPM_GLOBAL_PKGS} \
    && if [[ -n "${EXTRA_NPM_LOCAL_PKGS}" ]]; then \
        npm i ${EXTRA_NPM_LOCAL_PKGS}; \
    fi

# install uv
RUN --mount=type=cache,target=/root/.cache/uv,id=uv-cache,sharing=locked \
    curl -LsSf https://astral.sh/uv/install.sh | sh \
    && ln -sf /root/.local/bin/uv /usr/local/bin/uv

# install python deps via uv
COPY ticktick-mcp/pyproject.toml ticktick-mcp/uv.lock /app/ticktick-mcp/
RUN --mount=type=cache,target=/root/.cache/uv,id=uv-cache,sharing=locked \
    cd /app/ticktick-mcp \
    && uv sync --frozen --no-dev \
    && if [[ -n "${EXTRA_PIP_PKGS}" ]]; then \
        uv pip install --python .venv/bin/python ${EXTRA_PIP_PKGS}; \
    fi

# patch ticktick-sdk issue 7, fix pending in pr 29
COPY patches/ticktick-repeat-from.patch /tmp/ticktick-repeat-from.patch
RUN patch -p1 < /tmp/ticktick-repeat-from.patch

# playwright-core browser install
RUN --mount=type=cache,target=/pw-cache,id=pw-browsers \
    PLAYWRIGHT_BROWSERS_PATH=/pw-cache \
    /app/node_modules/.bin/playwright-core install --with-deps chromium \
    && mkdir -p "$PLAYWRIGHT_BROWSERS_PATH" \
    && rsync -a --delete /pw-cache/ "$PLAYWRIGHT_BROWSERS_PATH/" \
    && chown -R node:node "$PLAYWRIGHT_BROWSERS_PATH" \
    && find "$PLAYWRIGHT_BROWSERS_PATH" -type f -name chrome -print -quit > /tmp/chrome_binary_path

# mcporter install & configuration
RUN mkdir -p /app/config /home/node/.openclaw/config \
    && ln -sf /home/node/.openclaw/config/mcporter.json /app/config/mcporter.json \
    && chown -R node:node /home/node/.openclaw /app/config \
    && mcporter config add playwright \
        --command /usr/local/bin/playwright-mcp \
        --arg --executable-path \
        --arg "$(cat /tmp/chrome_binary_path && rm -f /tmp/chrome_binary_path >/dev/null 2>&1)" \
        --arg --headless \
        --scope project \
    && mcporter config add ticktick \
        --command /app/ticktick-mcp/.venv/bin/ticktick-sdk \
        --arg server \
        --scope project

# switch to runtime user
USER node

ENV HOME=/home/node

RUN openclaw completion --write-state \
    && openclaw completion -i -s bash
