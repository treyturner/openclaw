ARG OPENCLAW_BASE=ghcr.io/openclaw/openclaw:latest
FROM ${OPENCLAW_BASE}

ARG PLAYWRIGHT_VERSION=1.58

USER root

ENV HOME=/home/node \
    PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright \
    TERM=xterm-256color

RUN --mount=type=cache,target=/var/lib/apt,id=apt-lib \
    --mount=type=cache,target=/var/cache/apt,id=apt-cache \
    apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        curl \
        ffmpeg \
        git \
        imagemagick \
        jq \
        openssh-client \
        python3-venv \
        rsync \
        yq \
    && rm -rf /var/lib/apt/lists/*

RUN --mount=type=cache,target=/root/.npm,id=npm-cache \
    npm i -g playwright@${PLAYWRIGHT_VERSION} playwright-core@${PLAYWRIGHT_VERSION}

RUN --mount=type=cache,target=/var/cache/ms-playwright,id=ms-playwright-cache \
    PLAYWRIGHT_BROWSERS_PATH=/var/cache/ms-playwright \
    playwright install --with-deps chromium \
    && mkdir -p "$PLAYWRIGHT_BROWSERS_PATH" \
    && cp -a /var/cache/ms-playwright/. "$PLAYWRIGHT_BROWSERS_PATH/" \
    && chown -R node:node "$PLAYWRIGHT_BROWSERS_PATH"

USER node

RUN openclaw completion -i -s bash
