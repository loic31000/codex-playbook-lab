FROM node:24.9.0-bookworm-slim

ARG CODEX_VERSION=0.160.0

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates findutils git procps \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /bin/sh codex

COPY strict-runner-entrypoint.sh /usr/local/bin/strict-runner-entrypoint.sh
RUN chmod 0555 /usr/local/bin/strict-runner-entrypoint.sh

USER codex
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/strict-runner-entrypoint.sh"]
