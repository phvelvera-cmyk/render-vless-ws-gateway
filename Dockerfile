FROM node:22-bookworm-slim

ARG XRAY_VERSION=26.10.31
ARG XRAY_SHA256=e4bd9119f50ae7c41658b1abd0679ae06f98bd864a2907ff33f2f2cf7081b214

ENV NODE_ENV=production \
    XRAY_BIN=/usr/local/bin/xray

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && url="https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}/Xray-linux-64.zip" \
    && curl --fail --silent --show-error --location "$url" --output /tmp/xray.zip \
    && echo "${XRAY_SHA256}  /tmp/xray.zip" | sha256sum --check --status \
    && mkdir -p /tmp/xray \
    && unzip -q /tmp/xray.zip xray -d /tmp/xray \
    && install -m 0755 /tmp/xray/xray /usr/local/bin/xray \
    && rm -rf /tmp/xray /tmp/xray.zip \
    && apt-get purge -y --auto-remove curl unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json server.js client-config.js ./

EXPOSE 10000
CMD ["node", "server.js"]
