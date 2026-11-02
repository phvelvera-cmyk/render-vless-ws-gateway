"use strict";

const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MAX_PATH_LENGTH = 256;

function isUuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parsePort(value, name, { allowZero = false } = {}) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`${name} is required`);
  }
  const port = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(port) || port < minimum || port > 65535) {
    throw new Error(`${name} must be an integer from ${minimum} to 65535`);
  }
  return port;
}

function normalizeWsPath(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("WS_PATH is required");
  }
  if (value.length > MAX_PATH_LENGTH || !value.startsWith("/") || value === "/") {
    throw new Error("WS_PATH must be a non-root path beginning with /");
  }
  const segments = value.split("/");
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@\/-]+$/.test(value) || value.includes("..") || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("WS_PATH must use ASCII RFC3986 path characters");
  }
  return value;
}

function validateConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("configuration is required");
  }
  const port = parsePort(config.port, "PORT");
  const uuid = String(config.uuid || "").trim();
  if (!isUuid(uuid)) {
    throw new Error("VLESS_UUID must be a canonical UUID");
  }
  const wsPath = normalizeWsPath(config.wsPath);
  const xrayBin = String(config.xrayBin || "").trim();
  if (!xrayBin) {
    throw new Error("XRAY_BIN is required and must point to an official Xray binary");
  }
  const xrayPort = config.xrayPort === undefined ? 0 : parsePort(config.xrayPort, "XRAY_PORT", { allowZero: true });
  return { port, uuid, wsPath, xrayBin, xrayPort };
}

function parseEnv(env = process.env) {
  return validateConfig({
    port: env.PORT,
    uuid: env.VLESS_UUID,
    wsPath: env.WS_PATH,
    xrayBin: env.XRAY_BIN,
    xrayPort: env.XRAY_PORT === undefined || env.XRAY_PORT === "" ? 0 : env.XRAY_PORT,
  });
}

function buildXrayConfig({ uuid, wsPath, port }) {
  if (!isUuid(uuid)) {
    throw new Error("VLESS_UUID must be a canonical UUID");
  }
  const normalizedPath = normalizeWsPath(wsPath);
  const localPort = parsePort(port, "XRAY_PORT");
  return {
    log: { loglevel: "warning" },
    inbounds: [{
      listen: "127.0.0.1",
      port: localPort,
      protocol: "vless",
      settings: {
        clients: [{ id: uuid, encryption: "none" }],
        decryption: "none",
      },
      streamSettings: {
        network: "ws",
        security: "none",
        wsSettings: { path: normalizedPath },
      },
    }],
    outbounds: [{ protocol: "freedom", settings: {} }],
  };
}

function createHealthPayload(child, ready = true) {
  const alive = Boolean(
    ready &&
    child &&
    child.exitCode === null &&
    child.signalCode === null &&
    !child.killed,
  );
  return { ok: alive, service: "xray-ws-gateway" };
}

function buildRawUpgradeRequest(request) {
  const method = request.method || "GET";
  const target = request.url || "/";
  const version = request.httpVersion || "1.1";
  const lines = [`${method} ${target} HTTP/${version}`];
  if (Array.isArray(request.rawHeaders)) {
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
    }
  } else {
    for (const [name, value] of Object.entries(request.headers || {})) {
      if (Array.isArray(value)) {
        for (const item of value) lines.push(`${name}: ${item}`);
      } else if (value !== undefined) {
        lines.push(`${name}: ${value}`);
      }
    }
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function isWebSocketUpgrade(request) {
  const connection = String(request.headers?.connection || "");
  const upgrade = String(request.headers?.upgrade || "");
  return /(^|,)\s*upgrade\s*(,|$)/i.test(connection) && upgrade.toLowerCase() === "websocket";
}

function sendUpgradeError(socket, status, message) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function createGateway({ wsPath, xrayPort, health = () => ({ ok: false }), connect = net.connect }) {
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    let pathname;
    try {
      pathname = new URL(request.url || "/", "http://gateway.invalid").pathname;
    } catch {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("bad request\n");
      return;
    }
    if (request.method === "GET" && pathname === "/healthz") {
      const healthValue = health() || { ok: false };
      const payload = JSON.stringify(healthValue);
      const healthStatus = healthValue.ok === true ? 200 : 503;
      response.writeHead(healthStatus, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(`${payload}\n`);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found\n");
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  server.on("upgrade", (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url || "/", "http://gateway.invalid").pathname;
    } catch {
      sendUpgradeError(socket, 400, "Bad Request");
      return;
    }
    if (request.method !== "GET" || pathname !== wsPath || !isWebSocketUpgrade(request)) {
      sendUpgradeError(socket, 404, "Not Found");
      return;
    }

    const upstream = connect({ host: "127.0.0.1", port: xrayPort });
    let connected = false;
    const fail = () => {
      if (!socket.destroyed) socket.destroy();
      if (!upstream.destroyed) upstream.destroy();
    };
    upstream.once("connect", () => {
      connected = true;
      upstream.write(buildRawUpgradeRequest(request));
      if (head && head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.once("error", fail);
    upstream.once("close", () => {
      if (!connected && !socket.destroyed) socket.destroy();
      else if (!socket.destroyed) socket.end();
    });
    socket.once("error", () => upstream.destroy());
    socket.once("close", () => upstream.destroy());
  });

  return {
    server,
    closeSockets() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = address && typeof address === "object" ? address.port : 0;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForXrayReady(child, port, {
  connectImpl = net.connect,
  timeoutMs = 10000,
  retryMs = 100,
} = {}) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let timer;
    const activeSockets = new Set();
    const deadline = Date.now() + timeoutMs;
    const timeoutTimer = setTimeout(() => {
      finish(new Error("timed out waiting for Xray local listener"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(timeoutTimer);
      for (const socket of activeSockets) socket.destroy();
      activeSockets.clear();
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
    };
    const finish = (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => finish(new Error("Xray exited before its local listener became ready"));
    const onError = () => finish(new Error("Xray failed before its local listener became ready"));
    const attempt = () => {
      if (finished) return;
      if (child.exitCode !== null || child.signalCode !== null || child.killed) {
        finish(new Error("Xray exited before its local listener became ready"));
        return;
      }
      if (Date.now() >= deadline) {
        finish(new Error("timed out waiting for Xray local listener"));
        return;
      }
      let socket;
      try {
        socket = connectImpl({ host: "127.0.0.1", port });
      } catch {
        timer = setTimeout(attempt, retryMs);
        return;
      }
      activeSockets.add(socket);
      let settled = false;
      const settleSocket = () => {
        if (settled) return false;
        settled = true;
        activeSockets.delete(socket);
        return true;
      };
      const retry = () => {
        if (!settleSocket() || finished) return;
        socket.destroy();
        timer = setTimeout(attempt, retryMs);
      };
      socket.once("connect", () => {
        if (!settleSocket() || finished) return;
        socket.destroy();
        finish();
      });
      socket.once("error", retry);
      socket.once("close", () => {
        if (!settled && !finished) retry();
      });
    };
    child.once("exit", onExit);
    child.once("error", onError);
    attempt();
  });
}

function launchXray(config, xrayPort, { spawnImpl = spawn } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xray-node-"));
  const configPath = path.join(tempDir, "config.json");
  try {
    fs.chmodSync(tempDir, 0o700);
    fs.writeFileSync(configPath, `${JSON.stringify(buildXrayConfig({ uuid: config.uuid, wsPath: config.wsPath, port: xrayPort }), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(configPath, 0o600);
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
  let child;
  try {
    child = spawnImpl(config.xrayBin, ["run", "-config", configPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
  let stderr = "";
  if (child.stderr) {
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4096);
    });
  }
  // Keep an error listener attached even if startup has already resolved.
  child.on("error", () => {});
  const spawned = new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const ready = spawned.then(() => waitForXrayReady(child, xrayPort));
  return {
    child,
    tempDir,
    configPath,
    ready,
    stderr: () => stderr,
  };
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

async function startApp(env = process.env, { spawnImpl = spawn, installSignalHandlers = true } = {}) {
  const config = parseEnv(env);
  const xrayPort = config.xrayPort || await allocatePort();
  const launch = launchXray(config, xrayPort, { spawnImpl });
  try {
    await launch.ready;
  } catch {
    if (launch.child.exitCode === null && !launch.child.killed) launch.child.kill("SIGTERM");
    fs.rmSync(launch.tempDir, { recursive: true, force: true });
    throw new Error("XRAY_BIN could not be started or did not open its local listener; provide a working official Xray binary and valid config");
  }

  let closing = false;
  let closePromise;
  const gateway = createGateway({
    wsPath: config.wsPath,
    xrayPort,
    health: () => createHealthPayload(launch.child, !closing),
  });
  const close = async () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closing = true;
      gateway.closeSockets();
      await closeServer(gateway.server);
      if (launch.child.exitCode === null && !launch.child.killed) {
        launch.child.kill("SIGTERM");
      }
      fs.rmSync(launch.tempDir, { recursive: true, force: true });
    })();
    return closePromise;
  };

  let startupFailed = false;
  let startupFailure;
  const childFailure = () => {
    if (!closing) {
      startupFailed = true;
      startupFailure = new Error("Xray stopped before or during gateway startup");
      process.exitCode = 1;
      void close();
    }
  };
  launch.child.on("error", childFailure);
  launch.child.on("exit", childFailure);

  if (launch.child.exitCode !== null || launch.child.signalCode !== null || launch.child.killed) {
    await close();
    throw new Error("Xray stopped before the gateway could start");
  }

  try {
    await new Promise((resolve, reject) => {
      if (startupFailed) {
        reject(startupFailure);
        return;
      }
      gateway.server.once("error", reject);
      gateway.server.listen(config.port, "0.0.0.0", () => {
        if (startupFailed || launch.child.exitCode !== null || launch.child.signalCode !== null) {
          reject(startupFailure || new Error("Xray stopped during gateway startup"));
        } else {
          resolve();
        }
      });
    });
  } catch (error) {
    await close();
    throw error;
  }

  const signalHandlers = [];
  if (installSignalHandlers) {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => { void close(); };
      process.once(signal, handler);
      signalHandlers.push([signal, handler]);
    }
  }

  return {
    config,
    xrayPort,
    child: launch.child,
    server: gateway.server,
    close: async () => {
      for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
      await close();
    },
  };
}

if (require.main === module) {
  startApp().then(({ config, xrayPort }) => {
    console.log(`gateway listening on ${config.port}; Xray is bound to 127.0.0.1:${xrayPort}`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  allocatePort,
  buildRawUpgradeRequest,
  buildXrayConfig,
  createGateway,
  createHealthPayload,
  isUuid,
  isWebSocketUpgrade,
  normalizeWsPath,
  parseEnv,
  parsePort,
  startApp,
  validateConfig,
  waitForXrayReady,
};
