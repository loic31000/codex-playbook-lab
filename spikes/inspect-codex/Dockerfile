FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates findutils git procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
CMD ["tail", "-f", "/dev/null"]
