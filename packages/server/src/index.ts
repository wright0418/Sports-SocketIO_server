import { createPlatformServer } from './app.js';

const server = createPlatformServer();

server
  .start()
  .then((port) => {
    console.log(
      `[EduSports Competition Server] listening on http://0.0.0.0:${port}`,
    );
    console.log(
      `[EduSports Test Client] open http://localhost:${port}/test-client/`,
    );
  })
  .catch((err) => {
    console.error('[EduSports Server] Failed to start:', err);
    process.exit(1);
  });

const shutdown = async (signal: string) => {
  console.log(`[EduSports Server] Received ${signal}, shutting down...`);
  await server.stop();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
