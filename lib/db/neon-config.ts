import { neonConfig } from '@neondatabase/serverless';

/**
 * Driver configuration shared by the application (lib/db/pool.ts) and the
 * database scripts.
 *
 * Neon's driver speaks WebSocket. Node 22+ and Workers expose a global
 * constructor, so no `ws` dependency is needed at runtime.
 *
 * Local PostgreSQL instead of Neon (development and CI only): the driver needs
 * a WebSocket-to-TCP proxy in front of a plain server. Set
 * NEON_LOCAL_WSPROXY=host:port (scripts/dev/wsproxy.mjs provides one); never
 * set it in a deployment.
 */
if (typeof globalThis.WebSocket !== 'undefined') {
  neonConfig.webSocketConstructor = globalThis.WebSocket;
}

const localProxy = process.env.NEON_LOCAL_WSPROXY?.trim();
if (localProxy) {
  neonConfig.wsProxy = (host, port) => `${localProxy}/v1?address=${host}:${port}`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
}

export { neonConfig };
