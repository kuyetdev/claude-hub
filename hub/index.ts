import { createServer } from 'node:http';
import { loadConfig } from './config.ts';
import { openDatabase } from './db.ts';
import { createHandler } from './app.ts';
import { redact } from '../server/redact.ts';

try {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  if (!config.telegramToken || !config.telegramChatId) console.info('Telegram chưa cấu hình, bỏ qua cảnh báo.');
  const server = createServer(createHandler(db, config));
  server.listen(config.port, config.host, () => console.info(redact(`Claude Hub đang nghe tại http://${config.host}:${config.port}`)));
  const stop = () => server.close(() => { db.close(); process.exit(0); });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (error) {
  console.error(redact(`Không thể khởi động hub: ${error instanceof Error ? error.message : String(error)}`));
  process.exitCode = 1;
}
