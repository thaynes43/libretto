import { serve } from '@hono/node-server';
import type { Hono } from 'hono';

/**
 * Boot a Hono app on an ephemeral port for fixture-backed HTTP tests (the repo
 * idiom: hand-rolled stub servers with recorded JSON shapes, no live creds).
 */
export function startStubServer(app: Hono): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      resolve({
        url: `http://127.0.0.1:${info.port}`,
        close: () =>
          new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
}
