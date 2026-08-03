import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import type { FastifyInstance } from 'fastify';
import type { FactoryApplication } from '../application/factory-application.js';
import { buildWebServer } from './server.js';

export interface StartWebConsoleOptions {
  application: FactoryApplication;
  port?: number;
  openBrowser?: boolean;
  publicDir?: string;
  bootstrapToken?: string;
  handleSignals?: boolean;
  listen?: (
    server: FastifyInstance,
    options: { host: '127.0.0.1'; port: number },
  ) => Promise<string>;
}

export async function startWebConsole(options: StartWebConsoleOptions) {
  const bootstrapToken = options.bootstrapToken ?? randomBytes(32).toString('base64url');
  const publicDir =
    options.publicDir ?? path.dirname(fileURLToPath(new URL('./index.html', import.meta.url)));
  const server = buildWebServer({
    application: options.application,
    bootstrapToken,
    publicDir,
  });
  if (options.handleSignals) {
    const shutdown = () => {
      void server.close();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    server.addHook('onClose', async () => {
      process.removeListener('SIGINT', shutdown);
      process.removeListener('SIGTERM', shutdown);
    });
  }
  const listenOptions = { host: '127.0.0.1' as const, port: options.port ?? 0 };
  const origin = options.listen
    ? await options.listen(server, listenOptions)
    : await server.listen(listenOptions);
  const url = `${origin}/#session=${encodeURIComponent(bootstrapToken)}`;
  if (options.openBrowser !== false) {
    void execa('open', [url], { shell: false, reject: false }).catch(() => undefined);
  }
  return { server, origin, url };
}
