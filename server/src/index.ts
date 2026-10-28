import { loadConfig } from './config';
import { startServer } from './server';

const config = loadConfig();
const server = startServer(config);
const port = await server.listen();
console.log(JSON.stringify({ msg: 'listening', port }));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    console.log(JSON.stringify({ msg: 'shutting down', signal }));
    await server.close();
    process.exit(0);
  });
}
