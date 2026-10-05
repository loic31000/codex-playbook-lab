FROM node:24.9.0-bookworm-slim

ARG CODEX_VERSION=0.160.0

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates findutils git procps \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /bin/sh codex

COPY fixture/ /opt/fixture/
COPY entrypoint.sh /usr/local/bin/app-exec-entrypoint.sh
RUN chmod 0555 /usr/local/bin/app-exec-entrypoint.sh \
    && chown -R codex:codex /opt/fixture

USER codex
WORKDIR /workspace
EXPOSE 4500

ENTRYPOINT ["/usr/local/bin/app-exec-entrypoint.sh"]
