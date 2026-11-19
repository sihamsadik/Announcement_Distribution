import { loadConfig } from './config/env';
import { createBot, sanitizeError } from './bot/bot';
import { checkDatabaseConnection, disconnectPrisma } from './db/prisma';
import { retryService } from './services/retry.service';
import { distributionService } from './services/distribution.service';
import { albumService } from './services/album.service';
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

    // Setup global unhandled error handlers
    process.on('unhandledRejection', (reason) => {
      const safeReason = logger.sanitize(reason instanceof Error ? reason.message : String(reason));
      logger.error('Unhandled Promise Rejection detected', {
        event: 'app.unhandled_rejection',
        error: safeReason,
      });
    });

    process.on('uncaughtException', (err) => {
      const safeErr = logger.sanitize(err.message);
      logger.error('Uncaught Exception detected', {
        event: 'app.uncaught_exception',
        error: safeErr,
      });
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
    let isShuttingDown = false;
    const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '10000', 10);

    const shutdown = async (signal: string) => {
      if (isShuttingDown) {
        logger.warn(`Shutdown already in progress, ignoring duplicate ${signal}`, {
          event: 'app.shutdown_duplicate',
          signal,
        });
        return;
      }
      isShuttingDown = true;

      // Fail-safe force exit timer to prevent indefinite hanging
      const forceExitTimer = setTimeout(() => {
        logger.error(`Graceful shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms. Forcing process exit.`, {
          event: 'app.shutdown_timeout',
          timeoutMs: SHUTDOWN_TIMEOUT_MS,
        });
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      forceExitTimer.unref();

      healthService.markShuttingDown();
      logger.info(`Received ${signal}. Gracefully stopping application...`, {
        event: 'app.shutdown',
        signal,
      });

      try {
        // Step 1: Reject new incoming messages/updates
        distributionService.markShuttingDown();

        // Step 2: Stop accepting new Telegram updates
        try {
          bot.stop(signal);
        } catch (botErr) {
          logger.warn('Error stopping bot polling', { error: botErr });
        }

        // Step 3: Stop scheduling background retries
        retryService.stopPolling();

        // Step 4: Flush any pending media albums buffered in memory
        try {
          const flushedAlbums = await albumService.flushAll(bot.telegram, token);
          if (flushedAlbums.length > 0) {
            logger.info(`Flushed ${flushedAlbums.length} active media album(s) during shutdown.`, {
              event: 'app.albums_flushed',
              count: flushedAlbums.length,
            });
          }
        } catch (albumErr) {
          logger.warn('Error flushing albums during shutdown', { error: albumErr });
        }

        // Step 5: Allow in-progress distributions a reasonable window to finish
        const drainTimeout = Math.min(5000, Math.max(1000, SHUTDOWN_TIMEOUT_MS - 3000));
        const drained = await distributionService.drainActiveOperations(drainTimeout);
        if (!drained) {
          logger.warn('Some distribution operations were still in-flight when drain timeout elapsed.', {
            activeRemaining: distributionService.getActiveOperationsCount(),
          });
        }

        // Step 6: Stop HTTP health check server
        await healthServer.stop().catch(() => {});

        // Step 7: Disconnect PostgreSQL database cleanly
        await disconnectPrisma();

        clearTimeout(forceExitTimer);
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

    // 6. Startup Recovery: recover any stale PENDING deliveries from prior run/crash
    logger.info('Running startup recovery for pending or interrupted deliveries...', {
      event: 'startup.recovery_checking',
    });
    try {
      const recoveredCount = await retryService.recoverStalePendingDeliveries();
      if (recoveredCount > 0) {
        logger.info(`Startup recovery complete: recovered ${recoveredCount} stale delivery record(s) for retry.`, {
          event: 'startup.recovery_completed',
          recoveredCount,
        });
      }
    } catch (recErr) {
      logger.warn('Error during startup recovery check', { error: recErr });
    }

    // 7. Start background retry polling
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
