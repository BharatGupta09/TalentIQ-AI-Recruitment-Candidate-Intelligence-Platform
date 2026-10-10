#!/usr/bin/env node
/**
 * WebSocket-to-TCP proxy for a LOCAL PostgreSQL (development and CI only).
 *
 *   node scripts/dev/wsproxy.mjs            # listens on 127.0.0.1:5488
 *   NEON_LOCAL_WSPROXY=127.0.0.1:5488 npm run test:integration
 *
 * @neondatabase/serverless speaks the PostgreSQL protocol over a WebSocket,
 * which Neon terminates in production. A plain PostgreSQL has no such endpoint,
 * so this forwards each WebSocket to the TCP address the driver asks for
 * (`/v1?address=host:port`). With NEON_LOCAL_WSPROXY set, lib/db/pool.ts and
 * the scripts point the driver here instead of at Neon.
 *
 * Only loopback targets are forwarded, and it binds to 127.0.0.1, so it cannot
 * be used to reach anything but a database on this machine. Never deploy it.
 */
import net from 'node:net';
import { WebSocketServer } from 'ws';

const port = Number(process.env.WSPROXY_PORT ?? 5488);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

const wss = new WebSocketServer({ host: '127.0.0.1', port });
wss.on('connection', (ws, req) => {
  const address = new URL(req.url ?? '/', 'http://proxy').searchParams.get('address') ?? '';
  const i = address.lastIndexOf(':');
  const host = address.slice(0, i);
  const target = Number(address.slice(i + 1));
  if (!LOOPBACK.has(host) || !Number.isInteger(target)) {
    ws.close(1008, 'only loopback targets are allowed');
    return;
  }
  const socket = net.connect(target, host);
  socket.on('data', (chunk) => ws.readyState === ws.OPEN && ws.send(chunk));
  ws.on('message', (data) => socket.write(data));
  socket.on('close', () => ws.close());
  socket.on('error', () => ws.close());
  ws.on('close', () => socket.destroy());
  ws.on('error', () => socket.destroy());
});
wss.on('listening', () => console.log(`wsproxy listening on 127.0.0.1:${port}`));
