import { loadConfig } from './config/env';
import { createBot, sanitizeError } from './bot/bot';
import { checkDatabaseConnection, disconnectPrisma } from './db/prisma';
import { retryService } from './services/retry.service';
import { healthService } from './services/health.service';
import { healthServer } from './server/health.server';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  let token = '';

  try {
    const config = loadConfig();
    token = config.telegramBotToken;

    logger.setLevel(config.logLevel);
    logger.setFormat(config.logFormat);

    logger.info('Starting Telegram Announcement Distribution System...', {
      event: 'app.startup',
      nodeEnv: config.nodeEnv,
      logLevel: config.logLevel,
      healthPort: config.healthPort,
    });

    // 1. Verify Database Connection
    logger.info('Verifying PostgreSQL connection via Prisma 7...', { event: 'db.connecting' });
    const dbConnected = await checkDatabaseConnection();
    if (!dbConnected) {
      throw new Error('Database connection failed. Please verify that PostgreSQL is running and DATABASE_URL is valid.');
    }
    logger.info('Connected to PostgreSQL database successfully.', { event: 'db.connected' });

    // 2. Initialize Telegram Bot
    const bot = createBot(token);
    healthServer.setBot(bot);

    // 3. Start Lightweight Health Server
    try {
      await healthServer.start(config.healthPort);
    } catch (err) {
      logger.warn('Failed to start HTTP health check server, continuing bot startup', {
        event: 'health.server_bind_failed',
        error: err,
        port: config.healthPort,
      });
    }

    // 4. Setup graceful shutdown handlers
    const shutdown = async (signal: string) => {
      healthService.markShuttingDown();
      logger.info(`Received ${signal}. Gracefully stopping application...`, {
        event: 'app.shutdown',
        signal,
      });

      try {
        await healthServer.stop();
        retryService.stopPolling();
        bot.stop(signal);
        await disconnectPrisma();
        logger.info('Bot stopped, health server closed, and database disconnected cleanly.', {
          event: 'app.stopped',
        });
      } catch (err) {
        logger.error('Error during graceful shutdown', { event: 'app.shutdown_error', error: err });
      } finally {
        process.exit(0);
      }
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));

    // 5. Start Telegram Bot Polling
    logger.info('Connecting to Telegram Bot API...', { event: 'bot.connecting' });
    await bot.launch();

    // Verify bot identity
    const botInfo = await bot.telegram.getMe();
    logger.info(`Telegram Bot started successfully as @${botInfo.username} (ID: ${botInfo.id})`, {
      event: 'bot.ready',
      botId: botInfo.id,
      username: botInfo.username,
    });
    logger.info('Listening for commands and registered source announcements.', {
      event: 'bot.listening',
    });

    // 6. Start background retry polling and run startup recovery
    retryService.startPolling(bot.telegram, token);
    logger.info('Retry worker polling active', { event: 'retry.worker_started' });

    // Mark system as fully initialized and ready
    healthService.markInitialized();
  } catch (err) {
    const safeMsg = sanitizeError(err, token);
    logger.error(`Failed to start application: ${safeMsg}`, {
      event: 'app.fatal_error',
      error: safeMsg,
    });
    await disconnectPrisma().catch(() => {});
    process.exit(1);
  }
}

// Execute application
if (require.main === module) {
  main();
}

export { main };
