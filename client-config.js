"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { isUuid, normalizeWsPath, parsePort } = require("./server.js");

const PLACEHOLDER_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "example.com",
  "example.org",
  "example.net",
]);

function normalizeHost(value) {
  const host = String(value || "").trim().replace(/^\[(.*)\]$/, "$1");
  if (!host || /[\s/?#]/.test(host)) {
    throw new Error("--host must be a public hostname or IP address");
  }
  const lower = host.toLowerCase();
  if (PLACEHOLDER_HOSTS.has(lower) || lower.endsWith(".invalid") || lower.endsWith(".example") || lower.endsWith(".test")) {
    throw new Error("--host must be the real deployed hostname, not a placeholder");
  }
  if (net.isIP(host) === 0 && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)) {
    throw new Error("--host contains unsupported characters");
  }
  return host;
}

function validateClientInputs({ host, uuid, wsPath, port = 443, socksPort = 10808 }) {
  const normalizedHost = normalizeHost(host);
  const normalizedUuid = String(uuid || "").trim();
  if (!isUuid(normalizedUuid)) {
    throw new Error("--uuid must be a canonical UUID");
  }
  const normalizedPath = normalizeWsPath(wsPath);
  return {
    host: normalizedHost,
    uuid: normalizedUuid,
    wsPath: normalizedPath,
    port: parsePort(port, "--port"),
    socksPort: parsePort(socksPort, "--socks-port"),
  };
}

function buildClientXrayConfig({ host, uuid, wsPath, port = 443, socksPort = 10808, tls = true }) {
  const values = validateClientInputs({ host, uuid, wsPath, port, socksPort });
  const security = tls ? "tls" : "none";
  const streamSettings = {
    network: "ws",
    security,
    wsSettings: { path: values.wsPath },
  };
  if (tls) streamSettings.tlsSettings = { serverName: values.host };
  return {
    log: { loglevel: "warning" },
    inbounds: [{
      listen: "127.0.0.1",
      port: values.socksPort,
      protocol: "socks",
      settings: { auth: "noauth", udp: true },
    }],
    outbounds: [{
      protocol: "vless",
      settings: {
        vnext: [{
          address: values.host,
          port: values.port,
          users: [{ id: values.uuid, encryption: "none" }],
        }],
      },
      streamSettings,
    }],
  };
}

function authorityHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function buildShadowrocketUrl({ host, uuid, wsPath, port = 443, name = "xray-ws", tls = true }) {
  const values = validateClientInputs({ host, uuid, wsPath, port });
  const query = [
    ["encryption", "none"],
    ["security", tls ? "tls" : "none"],
    ["type", "ws"],
    ["host", values.host],
    ["path", values.wsPath],
    ...(tls ? [["sni", values.host]] : []),
  ].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
  return `vless://${values.uuid}@${authorityHost(values.host)}:${values.port}?${query}#${encodeURIComponent(String(name || "xray-ws"))}`;
}

function parseArgs(argv) {
  const options = {
    port: 443,
    socksPort: 10808,
    name: "xray-ws",
    tls: true,
    qr: false,
    outDir: path.resolve(process.cwd(), "client-output"),
  };
  const valueOptions = new Map([
    ["--host", "host"],
    ["--uuid", "uuid"],
    ["--ws-path", "wsPath"],
    ["--port", "port"],
    ["--socks-port", "socksPort"],
    ["--name", "name"],
    ["--out-dir", "outDir"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--qr") {
      options.qr = true;
      continue;
    }
    if (arg === "--no-tls") {
      options.tls = false;
      continue;
    }
    const key = valueOptions.get(arg);
    if (!key || index + 1 >= argv.length) {
      throw new Error(`unknown or incomplete option: ${arg}`);
    }
    options[key] = argv[++index];
  }
  if (!options.host || !options.uuid || !options.wsPath) {
    throw new Error("--host, --uuid and --ws-path are required after a real deployment");
  }
  return options;
}

function loadQrCode() {
  try {
    return require("qrcode");
  } catch {
    throw new Error("--qr requested, but optional module qrcode is not installed; no QR file was generated");
  }
}

async function writeArtifacts(options) {
  const values = validateClientInputs(options);
  const link = buildShadowrocketUrl(options);
  const xrayConfig = buildClientXrayConfig(options);
  const qrCode = options.qr ? loadQrCode() : null;
  fs.mkdirSync(options.outDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(options.outDir, 0o700);
  const configPath = path.join(options.outDir, "xray-client.json");
  const linkPath = path.join(options.outDir, "shadowrocket-vless.txt");
  fs.writeFileSync(configPath, `${JSON.stringify(xrayConfig, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(linkPath, `${link}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  fs.chmodSync(linkPath, 0o600);
  if (qrCode) {
    const qrPath = path.join(options.outDir, "shadowrocket-vless.png");
    await new Promise((resolve, reject) => {
      qrCode.toFile(qrPath, link, { errorCorrectionLevel: "M" }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    fs.chmodSync(qrPath, 0o600);
  }
  return { values, link, xrayConfig };
}

if (require.main === module) {
  writeArtifacts(parseArgs(process.argv.slice(2))).then(({ values }) => {
    console.log(`wrote client artifacts for ${values.host}:${values.port}`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  buildClientXrayConfig,
  buildShadowrocketUrl,
  normalizeHost,
  parseArgs,
  validateClientInputs,
  writeArtifacts,
};
