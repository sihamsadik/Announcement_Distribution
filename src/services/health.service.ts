import { Telegraf } from 'telegraf';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';

export interface ComponentHealth {
  status: 'healthy' | 'unhealthy';
  latencyMs?: number;
  details?: Record<string, unknown>;
  error?: string;
}

export interface AppHealthStatus {
  status: 'healthy' | 'unhealthy';
  uptimeSeconds: number;
  isInitialized: boolean;
  isShuttingDown: boolean;
}

export interface SystemReadiness {
  isReady: boolean;
  statusCode: number;
  timestamp: string;
  uptimeSeconds: number;
  checks: {
    app: AppHealthStatus;
    database: ComponentHealth;
    telegram: ComponentHealth;
  };
}

export class HealthService {
  private startTime: number = Date.now();
  private isInitialized = false;
  private isShuttingDown = false;

  markInitialized(): void {
    this.isInitialized = true;
    logger.info('Application marked as initialized and ready', { event: 'health.initialized' });
  }

  markShuttingDown(): void {
    this.isShuttingDown = true;
    logger.warn('Application marked as shutting down', { event: 'health.shutting_down' });
  }

  getAppHealth(): AppHealthStatus {
    const isHealthy = this.isInitialized && !this.isShuttingDown;
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);

    return {
      status: isHealthy ? 'healthy' : 'unhealthy',
      uptimeSeconds,
      isInitialized: this.isInitialized,
      isShuttingDown: this.isShuttingDown,
    };
  }

  /**
   * Executes a lightweight database ping via Prisma (SELECT 1).
   * Enforces a 3000ms timeout to prevent hanging.
   */
  async getDatabaseHealth(timeoutMs = 3000): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      const pingPromise = prisma.$queryRawUnsafe('SELECT 1');
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Database health check timed out after 3000ms')), timeoutMs)
      );

      await Promise.race([pingPromise, timeoutPromise]);
      const latencyMs = Date.now() - start;

      return {
        status: 'healthy',
        latencyMs,
        details: { reachable: true },
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const rawError = err instanceof Error ? err.message : String(err);
      const safeError = logger.sanitize(rawError);

      logger.warn('Database health check failed', {
        event: 'health.database_failed',
        latencyMs,
        error: safeError,
      });

      return {
        status: 'unhealthy',
        latencyMs,
        error: safeError,
      };
    }
  }

  /**
   * Verifies Telegram Bot API reachability by invoking getMe().
   * Enforces a 4000ms timeout to prevent hanging.
   */
  async getTelegramHealth(bot?: Telegraf, timeoutMs = 4000): Promise<ComponentHealth> {
    if (!bot) {
      return {
        status: 'unhealthy',
        error: 'Telegram bot instance is not initialized',
      };
    }

    const start = Date.now();
    try {
      const getMePromise = bot.telegram.getMe();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Telegram health check timed out after 4000ms')), timeoutMs)
      );

      const botInfo: any = await Promise.race([getMePromise, timeoutPromise]);
      const latencyMs = Date.now() - start;

      return {
        status: 'healthy',
        latencyMs,
        details: {
          botId: botInfo.id,
          username: botInfo.username,
          canJoinGroups: botInfo.can_join_groups,
        },
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const rawError = err instanceof Error ? err.message : String(err);
      const safeError = logger.sanitize(rawError);

      logger.warn('Telegram health check failed', {
        event: 'health.telegram_failed',
        latencyMs,
        error: safeError,
      });

      return {
        status: 'unhealthy',
        latencyMs,
        error: safeError,
      };
    }
  }

  /**
   * Combines all component health checks into a comprehensive readiness result.
   */
  async getReadiness(bot?: Telegraf): Promise<SystemReadiness> {
    const app = this.getAppHealth();
    const database = await this.getDatabaseHealth();
    const telegram = await this.getTelegramHealth(bot);

    const isReady =
      app.status === 'healthy' &&
      database.status === 'healthy' &&
      telegram.status === 'healthy';

    const statusCode = isReady ? 200 : 503;

    return {
      isReady,
      statusCode,
      timestamp: new Date().toISOString(),
      uptimeSeconds: app.uptimeSeconds,
      checks: {
        app,
        database,
        telegram,
      },
    };
  }
}

export const healthService = new HealthService();
