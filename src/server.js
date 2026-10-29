import pg from 'pg';
import { loadConfig, databaseOptions } from './config.js';
import { createMailer } from './mailer.js';
import { createApp } from './app.js';
import { applyMigrations } from './migrate.js';
import { bootstrapAdmin, bootstrapInput } from './bootstrap-admin.js';

let pool;
try {
  const config = loadConfig();
  pool = new pg.Pool(databaseOptions());
  await applyMigrations(pool);
  if (process.env.BOOTSTRAP_ADMIN_EMAIL) {
    const created = await bootstrapAdmin(pool, bootstrapInput(), { skipIfExists: true });
    if (created) console.log('Đã tạo quản trị viên đầu tiên. Xóa các biến BOOTSTRAP_ADMIN_* sau lần khởi động này.');
  }
  const app = createApp({ pool, config, mailer: createMailer(config), autoStartNotifications: true });
  const server = app.listen(config.port, '0.0.0.0', () => console.log(`Attendance API listening on port ${config.port}.`));
  app.locals.notifications.start();
  pool.on('error', () => console.error('Kết nối nền PostgreSQL bị gián đoạn.'));
  let shuttingDown = false;
  const close = () => {
    if (shuttingDown) return; shuttingDown = true;
    const pushStopped = app.locals.notifications.stop();
    server.close(async () => { await pushStopped; await pool.end(); process.exitCode = 0; });
    setTimeout(() => process.exit(1), 25000).unref();
  };
  process.on('SIGTERM', close); process.on('SIGINT', close);
} catch {
  console.error('API chưa khởi động. Kiểm tra DATABASE_URL/TLS, JWT_SECRET, OTP_SECRET, EMAIL_PROVIDER và cấu hình email/bootstrap/FCM. Không có chế độ bỏ qua xác thực.');
  await pool?.end(); process.exitCode = 1;
}
