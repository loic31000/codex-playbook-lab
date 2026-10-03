FROM node:20-bookworm-slim

ARG CODEX_VERSION=0.160.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git procps \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@openai/codex@${CODEX_VERSION}"

WORKDIR /opt/codex-lab
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY docker/entrypoint.sh /usr/local/bin/codex-lab-entrypoint
RUN chmod +x /usr/local/bin/codex-lab-entrypoint

ENV CODEX_LAB_REPO_DIR=/workspace/test-repo \
    CODEX_LAB_PLAYBOOK_DIR=/workspace/playbook \
    CODEX_LAB_RESULTS_DIR=/workspace/results

ENTRYPOINT ["codex-lab-entrypoint"]
CMD []
