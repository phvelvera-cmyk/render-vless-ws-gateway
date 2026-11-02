# Render VLESS WebSocket Gateway

This repository contains a small Node.js gateway that forwards a WebSocket
upgrade to a local Xray VLESS inbound. Render terminates public TLS; Xray
listens only on loopback inside the container.

## Deployment

Create a Render **Web Service** from this public repository with the Docker
runtime and the `main` branch. Keep the service on the Free compute plan and
do not add a payment method.

Set these environment variables in Render. Do not commit them to this
repository or print them in build/runtime logs:

- `VLESS_UUID`: a newly generated canonical UUID.
- `WS_PATH`: a private ASCII path beginning with `/`, for example a long
  random path. Do not use `/`.

Render supplies `PORT`; `XRAY_BIN` is baked into the image. The Docker build
downloads Xray-core `v26.10.31` from the official Xray-core GitHub release and
checks its published SHA-256 before installing it. The image is pinned to the
Linux x86_64 release asset.

After the first successful deploy, the Render hostname is the public endpoint:

- `GET /healthz` should return HTTP 200 only after the local Xray listener is
  ready and its process is still alive.
- The VLESS WebSocket endpoint is the configured `WS_PATH` over `wss://`.

The health response does not reveal the UUID, path, or hostname. A 200 health
response does not prove that a real VLESS client can connect or reach the
internet; test that separately with a real Xray client.

## Client configuration

After deployment, run `client-config.js` locally with the actual Render host,
UUID, and path. It writes a local Xray SOCKS configuration and a Shadowrocket
VLESS URL. Keep those files private and do not commit them:

```sh
node client-config.js \
  --host your-service.onrender.com \
  --uuid "$VLESS_UUID" \
  --ws-path "$WS_PATH" \
  --out-dir ./client-output
```

Use the resulting client configuration to make a real HTTPS request through
the SOCKS listener. `/healthz`, a direct HTTP 204, or a successful TLS
handshake alone is not a client connectivity test.

## Free-plan behavior

Render Free Web Services sleep after 15 minutes without inbound traffic and
take about a minute to wake. They have monthly usage limits, ephemeral storage,
and may be suspended for unusually high service-initiated public traffic. If
no payment method is present, reaching included bandwidth or build limits
disables the service rather than charging an overage. Follow Render's current
terms and acceptable-use policy; do not use the service to bypass network or
access restrictions.

## Source

The repository contains no account email, UUID, hostname, access token,
subscription URL, QR code, or client output. Official Xray release:

`https://github.com/XTLS/Xray-core/releases/tag/v26.10.31`
