import { loadConfig } from './config/env';
import { createBot, sanitizeError } from './bot/bot';
import { checkDatabaseConnection, disconnectPrisma } from './db/prisma';
import { retryService } from './services/retry.service';

async function main(): Promise<void> {
  let token = '';

  try {
    const config = loadConfig();
    token = config.telegramBotToken;

    // 1. Verify Database Connection
    console.log('[Startup] Verifying PostgreSQL connection via Prisma 7...');
    const dbConnected = await checkDatabaseConnection();
    if (!dbConnected) {
      throw new Error('Database connection failed. Please verify that PostgreSQL is running and DATABASE_URL is valid.');
    }
    console.log('[Database] Connected to PostgreSQL database successfully.');

    // 2. Initialize Telegram Bot
    const bot = createBot(token);

    // 3. Setup graceful shutdown handlers
    const shutdown = async (signal: string) => {
      console.log(`\n[Shutdown] Received ${signal}. Gracefully stopping application...`);
      try {
        retryService.stopPolling();
        bot.stop(signal);
        await disconnectPrisma();
        console.log('[Shutdown] Bot stopped and database disconnected cleanly.');
      } catch (err) {
        console.error('[Shutdown Error] Error during graceful shutdown:', err);
      } finally {
        process.exit(0);
      }
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));

    // 4. Start Telegram Bot Polling
    console.log('[Startup] Connecting to Telegram Bot API...');
    await bot.launch();

    // Verify bot identity
    const botInfo = await bot.telegram.getMe();
    console.log(`[Bot Ready] Telegram Bot started successfully as @${botInfo.username} (ID: ${botInfo.id})`);
    console.log('[Bot Ready] Listening for commands and registered source announcements.');

    // 5. Start background retry polling and run startup recovery
    retryService.startPolling(bot.telegram, token);
  } catch (err) {
    const safeMsg = sanitizeError(err, token);
    console.error(`[Fatal Startup Error] Failed to start application: ${safeMsg}`);
    await disconnectPrisma().catch(() => {});
    process.exit(1);
  }
}

// Execute application
if (require.main === module) {
  main();
}

export { main };
