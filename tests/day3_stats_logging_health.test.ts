import http from 'http';
import { prisma } from '../src/db/prisma';
import { sourceService } from '../src/services/source.service';
import { destinationService } from '../src/services/destination.service';
import { monitoringService } from '../src/services/monitoring.service';
import { healthService } from '../src/services/health.service';
import { HealthServer } from '../src/server/health.server';
import { Logger } from '../src/utils/logger';
import { ForwardingStatus } from '@prisma/client';

describe('Day 3 - Distribution Statistics, Logging & Error Monitoring, and Health Checks', () => {
  const TEST_SOURCE_CHAT = BigInt(-100999010);
  const TEST_DEST_CHAT = BigInt(-100888010);
  let sourceId: string;
  let destId: string;

  beforeAll(async () => {
    // Clean up test records
    await prisma.forwardingLog.deleteMany({
      where: { sourceChatId: TEST_SOURCE_CHAT },
    });
    await prisma.destinationGroup.deleteMany({
      where: { chatId: TEST_DEST_CHAT },
    });
    await prisma.sourceGroup.deleteMany({
      where: { chatId: TEST_SOURCE_CHAT },
    });

    const s = await sourceService.registerSource({
      chatId: TEST_SOURCE_CHAT,
      topicId: 404,
      name: 'Stats & Health Verification Source',
    });
    sourceId = s.source!.id;

    const d = await destinationService.registerDestination({
      chatId: TEST_DEST_CHAT,
      groupName: 'Stats & Health Verification Destination',
      sourceGroupId: sourceId,
    });
    destId = d.destination!.id;
  });

  afterAll(async () => {
    await prisma.forwardingLog.deleteMany({
      where: { sourceChatId: TEST_SOURCE_CHAT },
    });
    await prisma.destinationGroup.deleteMany({
      where: { chatId: TEST_DEST_CHAT },
    });
    await prisma.sourceGroup.deleteMany({
      where: { chatId: TEST_SOURCE_CHAT },
    });
    await prisma.$disconnect();
  });

  // ==========================================
  // TASK 4: DISTRIBUTION STATISTICS
  // ==========================================
  describe('Task 4: Distribution Statistics', () => {
    it('should handle empty delivery state gracefully without division-by-zero errors', async () => {
      // Create a temporary source with zero deliveries
      const tempSource = await sourceService.registerSource({
        chatId: -100999099,
        topicId: 999,
        name: 'Empty Stats Source',
      });

      const stats = await monitoringService.getDeliveryStats(tempSource.source!.id);

      expect(stats.totalDeliveries).toBe(0);
      expect(stats.successfulDeliveries).toBe(0);
      expect(stats.failedDeliveries).toBe(0);
      expect(stats.pendingDeliveries).toBe(0);
      expect(stats.retryingDeliveries).toBe(0);
      expect(stats.totalRetryAttempts).toBe(0);
      expect(stats.successRate).toBe('0.0%');
      expect(stats.failureRate).toBe('0.0%');
      expect(stats.uniqueAnnouncements).toBe(0);

      // Clean up temp source
      await prisma.sourceGroup.delete({ where: { id: tempSource.source!.id } });
    });

    it('should aggregate statistics from actual stored delivery records', async () => {
      // Insert test delivery logs:
      // 1. Success (0 retries)
      await prisma.forwardingLog.create({
        data: {
          sourceChatId: TEST_SOURCE_CHAT,
          sourceMessageId: 1001,
          destinationGroupId: destId,
          status: ForwardingStatus.SUCCESS,
          retryCount: 0,
        },
      });

      // 2. Success after 2 retries
      await prisma.forwardingLog.create({
        data: {
          sourceChatId: TEST_SOURCE_CHAT,
          sourceMessageId: 1002,
          destinationGroupId: destId,
          status: ForwardingStatus.SUCCESS,
          retryCount: 2,
        },
      });

      // 3. Terminal Failure after 3 retries
      await prisma.forwardingLog.create({
        data: {
          sourceChatId: TEST_SOURCE_CHAT,
          sourceMessageId: 1003,
          destinationGroupId: destId,
          status: ForwardingStatus.FAILED,
          retryCount: 3,
          errorMessage: 'Bot was kicked from destination group',
        },
      });

      // 4. Retrying (1 retry attempt so far)
      await prisma.forwardingLog.create({
        data: {
          sourceChatId: TEST_SOURCE_CHAT,
          sourceMessageId: 1004,
          destinationGroupId: destId,
          status: ForwardingStatus.RETRYING,
          retryCount: 1,
          errorMessage: 'Rate limit: retry after 10s',
        },
      });

      // 5. Pending (0 retries)
      await prisma.forwardingLog.create({
        data: {
          sourceChatId: TEST_SOURCE_CHAT,
          sourceMessageId: 1005,
          destinationGroupId: destId,
          status: ForwardingStatus.PENDING,
          retryCount: 0,
        },
      });

      const stats = await monitoringService.getDeliveryStats(sourceId);

      // 5 distinct destination delivery attempts:
      expect(stats.totalDeliveries).toBe(5);
      expect(stats.successfulDeliveries).toBe(2);
      expect(stats.failedDeliveries).toBe(1);
      expect(stats.retryingDeliveries).toBe(1);
      expect(stats.pendingDeliveries).toBe(1);

      // Total retry attempts = 0 + 2 + 3 + 1 + 0 = 6:
      expect(stats.totalRetryAttempts).toBe(6);

      // Success rate = (2 / 5) * 100 = 40.0%
      expect(stats.successRate).toBe('40.0%');

      // Failure rate = (1 / 5) * 100 = 20.0%
      expect(stats.failureRate).toBe('20.0%');

      // Unique announcements = 5
      expect(stats.uniqueAnnouncements).toBe(5);
    });

    it('should distinguish between delivery records and individual retry attempts without inflation', async () => {
      // In Task 4: Each destination delivery is represented by one ForwardingLog record.
      // Re-attempts increment `retryCount` on that record without inserting duplicate destination rows.
      const stats = await monitoringService.getDeliveryStats(sourceId);

      expect(stats.totalDeliveries).toBe(5);
      expect(stats.totalRetryAttempts).toBe(6);
      expect(stats.totalRetryAttempts).not.toBe(stats.totalDeliveries);
    });

    it('should filter statistics by timeframe (e.g. 24h, 7d)', async () => {
      // Insert an older record from 2 days ago
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await prisma.forwardingLog.create({
        data: {
          sourceChatId: TEST_SOURCE_CHAT,
          sourceMessageId: 900,
          destinationGroupId: destId,
          status: ForwardingStatus.SUCCESS,
          retryCount: 0,
          createdAt: twoDaysAgo,
        },
      });

      // Query past 24 hours: should exclude the 48h-old record
      const stats24h = await monitoringService.getDeliveryStats({
        sourceGroupId: sourceId,
        timeframe: '24h',
      });
      expect(stats24h.totalDeliveries).toBe(5);

      // Query past 7 days: should include the 48h-old record
      const stats7d = await monitoringService.getDeliveryStats({
        sourceGroupId: sourceId,
        timeframe: '7d',
      });
      expect(stats7d.totalDeliveries).toBe(6);
    });

    it('should format distribution statistics matching the required Telegram output layout', async () => {
      const stats = await monitoringService.getDeliveryStats(sourceId);
      const formatted = monitoringService.formatStatsMessage(stats);

      expect(formatted).toContain('Distribution Statistics');
      expect(formatted).toContain('Total deliveries:');
      expect(formatted).toContain('Successful:');
      expect(formatted).toContain('Failed:');
      expect(formatted).toContain('Pending:');
      expect(formatted).toContain('Retrying:');
      expect(formatted).toContain('Total retry attempts:');
      expect(formatted).toContain('Success rate:');
      expect(formatted).toContain('Failure rate:');
      expect(formatted.length).toBeLessThan(4096);
    });
  });

  // ==========================================
  // TASK 5: LOGGING & ERROR MONITORING
  // ==========================================
  describe('Task 5: Structured Logging & Error Monitoring', () => {
    let customLogger: Logger;

    beforeEach(() => {
      customLogger = new Logger('debug', 'json');
    });

    it('should output valid JSON in structured JSON format', () => {
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      customLogger.info('Forwarding completed successfully', {
        event: 'forwarding.succeeded',
        sourceChatId: BigInt(-100123),
        sourceTopicId: 404,
        sourceMessageId: 42,
        destinationChatId: BigInt(-100456),
        deliveryId: 'log-uuid-123',
        retryCount: 1,
      });

      expect(consoleLogSpy).toHaveBeenCalled();
      const rawLogged = consoleLogSpy.mock.calls[0][0];
      const parsed = JSON.parse(rawLogged);

      expect(parsed.level).toBe('INFO');
      expect(parsed.event).toBe('forwarding.succeeded');
      expect(parsed.message).toBe('Forwarding completed successfully');
      expect(parsed.sourceChatId).toBe('-100123'); // Safely serialized BigInt!
      expect(parsed.destinationChatId).toBe('-100456');
      expect(parsed.sourceMessageId).toBe(42);
      expect(parsed.deliveryId).toBe('log-uuid-123');
      expect(parsed.retryCount).toBe(1);
      expect(parsed.timestamp).toBeDefined();

      consoleLogSpy.mockRestore();
    });

    it('should sanitize bot tokens and database passwords from logs', () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      customLogger.error('Connection failed to Telegram and Database', {
        event: 'network.error',
        error: new Error(
          'Failed calling https://api.telegram.org/bot123456789:ABCdefGhI_FAKE_TOKEN/sendMessage with postgresql://dbuser:SecretPassword123@localhost:5432/announcements'
        ),
      });

      expect(consoleErrorSpy).toHaveBeenCalled();
      const rawLogged = consoleErrorSpy.mock.calls[0][0];

      // Sensitive items must be sanitized
      expect(rawLogged).not.toContain('123456789:ABCdefGhI_FAKE_TOKEN');
      expect(rawLogged).not.toContain('SecretPassword123');
      expect(rawLogged).toContain('[REDACTED_BOT_TOKEN]');
      expect(rawLogged).toContain('[REDACTED_DATABASE_URL]');

      consoleErrorSpy.mockRestore();
    });

    it('should respect configured log severity levels', () => {
      const infoLogger = new Logger('warn', 'json');
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      infoLogger.debug('Debug trace');
      infoLogger.info('Info notice');
      expect(consoleLogSpy).not.toHaveBeenCalled();

      infoLogger.warn('Warning alert');
      expect(consoleWarnSpy).toHaveBeenCalled();

      consoleLogSpy.mockRestore();
      consoleWarnSpy.mockRestore();
    });

    it('should render human-readable bracketed text in development text mode', () => {
      const textLogger = new Logger('info', 'text');
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      textLogger.info('Announcement detected in source topic', {
        event: 'announcement.detected',
        sourceChatId: -100555,
        sourceMessageId: 88,
      });

      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0][0];

      expect(output).toMatch(/^\[.+\] \[INFO\] \[announcement\.detected\] Announcement detected in source topic/);
      expect(output).toContain('"sourceChatId":-100555');

      consoleLogSpy.mockRestore();
    });

    it('should generate valid correlation IDs for distributed tracing', () => {
      const id1 = customLogger.createCorrelationId();
      const id2 = customLogger.createCorrelationId();

      expect(id1).toMatch(/^corr_\d+_[a-z0-9]+$/);
      expect(id2).toMatch(/^corr_\d+_[a-z0-9]+$/);
      expect(id1).not.toBe(id2);
    });
  });

  // ==========================================
  // TASK 6: SYSTEM HEALTH CHECKS
  // ==========================================
  describe('Task 6: System Health Checks & HTTP Endpoints', () => {
    let server: HealthServer;
    const TEST_PORT = 3199;

    beforeAll(() => {
      server = new HealthServer();
    });

    afterAll(async () => {
      await server.stop();
    });

    it('healthService.getAppHealth should report application lifecycle state', () => {
      healthService.markInitialized();
      const health = healthService.getAppHealth();

      expect(health.status).toBe('healthy');
      expect(health.isInitialized).toBe(true);
      expect(health.isShuttingDown).toBe(false);
      expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });

    it('healthService.getDatabaseHealth should verify PostgreSQL connectivity', async () => {
      const dbHealth = await healthService.getDatabaseHealth();

      expect(dbHealth.status).toBe('healthy');
      expect(typeof dbHealth.latencyMs).toBe('number');
      expect(dbHealth.latencyMs).toBeGreaterThanOrEqual(0);
      expect(dbHealth.details?.reachable).toBe(true);
    });

    it('healthService.getDatabaseHealth should catch errors without crashing when query fails', async () => {
      const queryRawSpy = jest.spyOn(prisma, '$queryRawUnsafe').mockRejectedValueOnce(
        new Error('connection to server on socket "/tmp/.s.PGSQL.5433" failed: Connection refused')
      );

      const dbHealth = await healthService.getDatabaseHealth();

      expect(dbHealth.status).toBe('unhealthy');
      expect(dbHealth.error).toContain('Connection refused');
      expect(typeof dbHealth.latencyMs).toBe('number');

      queryRawSpy.mockRestore();
    });

    it('healthService.getTelegramHealth should verify Telegram Bot API reachability', async () => {
      const mockBot: any = {
        telegram: {
          getMe: jest.fn().mockResolvedValue({
            id: 123456789,
            is_bot: true,
            first_name: 'Test Announcement Bot',
            username: 'test_announcement_bot',
            can_join_groups: true,
          }),
        },
      };

      const tgHealth = await healthService.getTelegramHealth(mockBot);

      expect(tgHealth.status).toBe('healthy');
      expect(tgHealth.details?.username).toBe('test_announcement_bot');
      expect(tgHealth.details?.botId).toBe(123456789);
      expect(typeof tgHealth.latencyMs).toBe('number');
    });

    it('healthService.getTelegramHealth should report unhealthy when Telegram API fails', async () => {
      const mockBot: any = {
        telegram: {
          getMe: jest.fn().mockRejectedValue(new Error('401 Unauthorized: token is invalid 123456789:SecretToken')),
        },
      };

      const tgHealth = await healthService.getTelegramHealth(mockBot);

      expect(tgHealth.status).toBe('unhealthy');
      expect(tgHealth.error).not.toContain('SecretToken');
      expect(tgHealth.error).toContain('[REDACTED_BOT_TOKEN]');
    });

    it('should serve GET /health returning 200 OK', async () => {
      await server.start(TEST_PORT);

      const res = await makeHttpRequest(`http://127.0.0.1:${TEST_PORT}/health`);

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.status).toBe('ok');
      expect(typeof json.uptimeSeconds).toBe('number');
      expect(json.isInitialized).toBe(true);
      expect(json.isShuttingDown).toBe(false);
      expect(json.timestamp).toBeDefined();
    });

    it('should serve GET /health/ready returning 200 OK when components are healthy', async () => {
      const mockBot: any = {
        telegram: {
          getMe: jest.fn().mockResolvedValue({ id: 98765, username: 'LiveBot' }),
        },
      };
      server.setBot(mockBot);

      const res = await makeHttpRequest(`http://127.0.0.1:${TEST_PORT}/health/ready`);

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.status).toBe('ready');
      expect(json.checks.app.status).toBe('healthy');
      expect(json.checks.database.status).toBe('healthy');
      expect(json.checks.telegram.status).toBe('healthy');
    });

    it('should return 503 on GET /health/ready if a component is unhealthy', async () => {
      const mockBrokenBot: any = {
        telegram: {
          getMe: jest.fn().mockRejectedValue(new Error('ETIMEDOUT to Telegram API')),
        },
      };
      server.setBot(mockBrokenBot);

      const res = await makeHttpRequest(`http://127.0.0.1:${TEST_PORT}/health/ready`);

      expect(res.statusCode).toBe(503);
      const json = JSON.parse(res.body);
      expect(json.status).toBe('unhealthy');
      expect(json.checks.database.status).toBe('healthy');
      expect(json.checks.telegram.status).toBe('unhealthy');
    });

    it('should return 404 for unknown endpoints', async () => {
      const res = await makeHttpRequest(`http://127.0.0.1:${TEST_PORT}/unknown-route`);
      expect(res.statusCode).toBe(404);
    });

    it('should return 405 for non-GET methods', async () => {
      const res = await makeHttpRequest(`http://127.0.0.1:${TEST_PORT}/health`, 'POST');
      expect(res.statusCode).toBe(405);
    });
  });
});

/**
 * Lightweight helper to execute HTTP requests without external dependencies.
 */
function makeHttpRequest(urlStr: string, method = 'GET'): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        timeout: 5000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }));
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('HTTP request timeout'));
    });

    req.end();
  });
}
