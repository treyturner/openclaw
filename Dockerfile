ARG OPENCLAW_BASE=ghcr.io/openclaw/openclaw:latest
FROM ${OPENCLAW_BASE}
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

USER root

ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright \
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
        vim \
        yq \
    && rm -rf /var/lib/apt/lists/*

RUN --mount=type=cache,target=/root/.npm,id=npm-cache \
    npm i -g mcporter @playwright/mcp@0.0.68

RUN --mount=type=cache,target=/var/cache/ms-playwright,id=ms-playwright-cache \
    cd /app \
    && PLAYWRIGHT_BROWSERS_PATH=/var/cache/ms-playwright \
    /app/node_modules/.bin/playwright-core install --with-deps chromium \
    && mkdir -p "$PLAYWRIGHT_BROWSERS_PATH" \
    && cp -a /var/cache/ms-playwright/. "$PLAYWRIGHT_BROWSERS_PATH/" \
    && chown -R node:node "$PLAYWRIGHT_BROWSERS_PATH" \
    && find "$PLAYWRIGHT_BROWSERS_PATH" -type f -name chrome -print -quit > /tmp/chrome_binary_path

RUN mkdir -p /app/config /home/node/.openclaw/config \
    && ln -sf /home/node/.openclaw/config/mcporter.json /app/config/mcporter.json \
    && chown -R node:node /home/node/.openclaw /app/config \
    && mcporter config add playwright \
        --command /usr/local/bin/playwright-mcp \
        --arg --executable-path \
        --arg "$(cat /tmp/chrome_binary_path)" \
        --arg --headless \
        --scope project \
    && rm -f /tmp/chrome_binary_path

USER node

ENV HOME=/home/node

RUN openclaw completion --write-state \
    && openclaw completion -i -s bash
