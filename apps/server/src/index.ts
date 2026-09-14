import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

export async function startServer(): Promise<void> {
  const config = loadConfig();
  const { app } = await buildApp(config);
  const address = await app.listen({ host: config.host, port: config.port });
  app.log.info({ address }, 'Local File Hub 已启动');

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, '正在关闭服务');
    await app.close();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

const isEntryPoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
