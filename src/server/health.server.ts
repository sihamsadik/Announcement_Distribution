import http from 'http';
import { Telegraf } from 'telegraf';
import { healthService } from '../services/health.service';
import { logger } from '../utils/logger';

export class HealthServer {
  private server: http.Server | null = null;
  private bot?: Telegraf;

  constructor(bot?: Telegraf) {
    this.bot = bot;
  }

  setBot(bot: Telegraf): void {
    this.bot = bot;
  }

  /**
   * Starts the lightweight HTTP health check server.
   */
  start(port: number): Promise<http.Server> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        const url = (req.url || '').split('?')[0];
        const method = (req.method || '').toUpperCase();

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

        if (method !== 'GET') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method Not Allowed' }));
          return;
        }

        try {
          if (url === '/health' || url === '/health/live') {
            const appHealth = healthService.getAppHealth();
            const isOk = appHealth.status === 'healthy';
            res.statusCode = isOk ? 200 : 503;
            res.end(
              JSON.stringify({
                status: isOk ? 'ok' : 'unhealthy',
                uptimeSeconds: appHealth.uptimeSeconds,
                isInitialized: appHealth.isInitialized,
                isShuttingDown: appHealth.isShuttingDown,
                timestamp: new Date().toISOString(),
              })
            );
            return;
          }

          if (url === '/health/ready') {
            const readiness = await healthService.getReadiness(this.bot);
            res.statusCode = readiness.statusCode;
            res.end(
              JSON.stringify({
                status: readiness.isReady ? 'ready' : 'unhealthy',
                uptimeSeconds: readiness.uptimeSeconds,
                timestamp: readiness.timestamp,
                checks: readiness.checks,
              })
            );
            return;
          }

          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Not Found' }));
        } catch (err) {
          const rawErr = err instanceof Error ? err.message : String(err);
          const safeErr = logger.sanitize(rawErr);
          logger.error('Error handling health check request', {
            event: 'health.http_error',
            error: safeErr,
          });

          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'Internal Health Check Error' }));
        }
      });

      this.server.on('error', (err) => {
        logger.error('Health server encountered an error', {
          event: 'health.server_error',
          error: err,
        });
        reject(err);
      });

      this.server.listen(port, () => {
        logger.info(`Health check server listening on port ${port}`, {
          event: 'health.server_started',
          port,
        });
        resolve(this.server!);
      });
    });
  }

  /**
   * Gracefully stops the HTTP health server.
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info('Health check server stopped', { event: 'health.server_stopped' });
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

export const healthServer = new HealthServer();
