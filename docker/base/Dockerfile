FROM node:22-bookworm

ARG CODEX_CLI_VERSION=0.125.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bubblewrap \
    ca-certificates \
    curl \
    git \
    gnupg \
    jq \
    openssh-client \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && apt-get purge -y --auto-remove gnupg \
  && npm install -g "@openai/codex@${CODEX_CLI_VERSION}" \
  && npm cache clean --force \
  && groupadd --gid 10001 agent \
  && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash agent \
  && mkdir -p /workspace \
  && chown agent:agent /workspace \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
USER agent
