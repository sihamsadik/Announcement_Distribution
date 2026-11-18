import { Telegraf } from 'telegraf';
import { prisma } from '../src/db/prisma';
import { sourceService } from '../src/services/source.service';
import { destinationService } from '../src/services/destination.service';
import { monitoringService } from '../src/services/monitoring.service';
import { isAuthorizedAdmin, denyUnauthorizedAccess } from '../src/bot/auth';
import { detectSourceAnnouncement } from '../src/bot/detector';
import { ForwardingStatus } from '@prisma/client';
import { setupBotHandlers } from '../src/bot/bot';

describe('Day 3 - Admin Management, Source/Dest Improvements & Monitoring', () => {
  const ADMIN_USER_ID = 999111;
  const NON_ADMIN_USER_ID = 888222;
  const CHAT_ADMIN_USER_ID = 777333;

  beforeAll(async () => {
    // Configure environment admin user ID
    process.env.ADMIN_USER_IDS = `${ADMIN_USER_ID},123456789`;

    // Clean up test records created for Day 3 tests
    await prisma.forwardingLog.deleteMany({
      where: {
        sourceChatId: {
          in: [BigInt(-100999001), BigInt(-100999002), BigInt(-100999003)],
        },
      },
    });
    await prisma.destinationGroup.deleteMany({
      where: {
        chatId: {
          in: [BigInt(-100888001), BigInt(-100888002), BigInt(-100888003)],
        },
      },
    });
    await prisma.sourceGroup.deleteMany({
      where: {
        chatId: {
          in: [BigInt(-100999001), BigInt(-100999002), BigInt(-100999003)],
        },
      },
    });
  });

  afterAll(async () => {
    // Clean up test records
    await prisma.forwardingLog.deleteMany({
      where: {
        sourceChatId: {
          in: [BigInt(-100999001), BigInt(-100999002), BigInt(-100999003)],
        },
      },
    });
    await prisma.destinationGroup.deleteMany({
      where: {
        chatId: {
          in: [BigInt(-100888001), BigInt(-100888002), BigInt(-100888003)],
        },
      },
    });
    await prisma.sourceGroup.deleteMany({
      where: {
        chatId: {
          in: [BigInt(-100999001), BigInt(-100999002), BigInt(-100999003)],
        },
      },
    });
    await prisma.$disconnect();
  });

  describe('Task 1: Admin Management & Authorization Security', () => {
    it('should grant access to users explicitly listed in ADMIN_USER_IDS', async () => {
      const mockCtx: any = {
        from: { id: ADMIN_USER_ID },
        chat: { id: -100123456, type: 'supergroup' },
      };

      const authorized = await isAuthorizedAdmin(mockCtx);
      expect(authorized).toBe(true);
    });

    it('should deny access to users not listed in ADMIN_USER_IDS in private chat', async () => {
      const mockCtx: any = {
        from: { id: NON_ADMIN_USER_ID },
        chat: { id: NON_ADMIN_USER_ID, type: 'private' },
      };

      const authorized = await isAuthorizedAdmin(mockCtx);
      expect(authorized).toBe(false);
    });

    it('should grant access to Telegram group admins via getChatAdministrators', async () => {
      const mockCtx: any = {
        from: { id: CHAT_ADMIN_USER_ID },
        chat: { id: -100123456, type: 'supergroup' },
        getChatAdministrators: jest.fn().mockResolvedValue([
          { user: { id: CHAT_ADMIN_USER_ID } },
          { user: { id: 555444 } },
        ]),
      };

      const authorized = await isAuthorizedAdmin(mockCtx);
      expect(authorized).toBe(true);
      expect(mockCtx.getChatAdministrators).toHaveBeenCalled();
    });

    it('should deny access when user is not a group admin and not in ADMIN_USER_IDS', async () => {
      const mockCtx: any = {
        from: { id: NON_ADMIN_USER_ID },
        chat: { id: -100123456, type: 'supergroup' },
        getChatAdministrators: jest.fn().mockResolvedValue([
          { user: { id: CHAT_ADMIN_USER_ID } },
        ]),
      };

      const authorized = await isAuthorizedAdmin(mockCtx);
      expect(authorized).toBe(false);
    });

    it('denyUnauthorizedAccess should log security alert and send standardized refusal message', async () => {
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const replyMock = jest.fn().mockResolvedValue({});
      const mockCtx: any = {
        from: { id: 123999 },
        chat: { id: -100777 },
        reply: replyMock,
      };

      await denyUnauthorizedAccess(mockCtx, 'modify administrative settings');

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[Security Alert] Unauthorized modify administrative settings attempt by user 123999 in chat -100777')
      );
      expect(replyMock).toHaveBeenCalledWith('⛔ Access denied: You are not authorized to modify administrative settings.');
      consoleWarnSpy.mockRestore();
    });

    it('should reject non-admin users across all administrative commands', async () => {
      const bot = new Telegraf('123456789:ABCdefGhI_FAKE_TOKEN_FOR_TESTING');
      const registeredCommands: Record<string, Function> = {};

      jest.spyOn(bot, 'command').mockImplementation(((cmd: any, ...handlers: any[]) => {
        const cmdName = Array.isArray(cmd) ? cmd[0] : String(cmd);
        registeredCommands[cmdName] = handlers[handlers.length - 1];
        return bot;
      }) as any);

      setupBotHandlers(bot, 'FAKE_TOKEN');

      const adminCommands = [
        'register_source',
        'list_sources',
        'source_details',
        'remove_source',
        'activate_source',
        'register_destination',
        'list_destinations',
        'remove_destination',
        'activate_destination',
        'delivery_stats',
        'recent_deliveries',
        'failed_deliveries',
        'delivery_details',
      ];

      for (const cmd of adminCommands) {
        expect(registeredCommands[cmd]).toBeDefined();

        const replyMock = jest.fn().mockResolvedValue({});
        const mockCtx: any = {
          from: { id: NON_ADMIN_USER_ID },
          chat: { id: -100111222, type: 'supergroup' },
          message: { text: `/${cmd}` },
          reply: replyMock,
          getChatAdministrators: jest.fn().mockResolvedValue([]),
        };

        await registeredCommands[cmd](mockCtx);

        expect(replyMock).toHaveBeenCalledWith(
          expect.stringMatching(/⛔ Access denied: You are not authorized/)
        );
      }
    });
  });

  describe('Task 2: Source Management Lifecycle & Integrity', () => {
    let sourceId: string;

    it('should register a new source group and topic', async () => {
      const result = await sourceService.registerSource({
        chatId: -100999001,
        topicId: 101,
        name: 'Distributed Systems - Announcements',
      });

      expect(result.success).toBe(true);
      expect(result.isNew).toBe(true);
      expect(result.source).toBeDefined();
      expect(result.source!.name).toBe('Distributed Systems - Announcements');
      expect(result.source!.isActive).toBe(true);

      sourceId = result.source!.id;
    });

    it('should handle duplicate source registration idempotently without throwing', async () => {
      const result = await sourceService.registerSource({
        chatId: -100999001,
        topicId: 101,
        name: 'Distributed Systems - Announcements Updated',
      });

      expect(result.success).toBe(true);
      expect(result.isNew).toBe(false);
      expect(result.source!.id).toBe(sourceId);
      expect(result.message).toContain('already registered');
    });

    it('should list sources and include destination counts', async () => {
      const sources = await sourceService.listSources();
      expect(sources.length).toBeGreaterThan(0);

      const found = sources.find((s) => s.id === sourceId);
      expect(found).toBeDefined();
      expect(found!.isActive).toBe(true);
      expect(Array.isArray(found!.destinationGroups)).toBe(true);
    });

    it('should retrieve comprehensive source details with delivery metrics', async () => {
      const details = await sourceService.getSourceDetails(sourceId);
      expect(details).not.toBeNull();
      expect(details!.source.id).toBe(sourceId);
      expect(details!.totalDestinations).toBe(0);
      expect(details!.totalDeliveries).toBe(0);
    });

    it('should soft-deactivate a source without deleting historical records', async () => {
      const result = await sourceService.setSourceStatus(sourceId, false);
      expect(result.success).toBe(true);
      expect(result.source!.isActive).toBe(false);

      const fetched = await sourceService.getSourceById(sourceId);
      expect(fetched!.isActive).toBe(false);
    });

    it('should reactivate a deactivated source', async () => {
      const result = await sourceService.setSourceStatus(sourceId, true);
      expect(result.success).toBe(true);
      expect(result.source!.isActive).toBe(true);

      const fetched = await sourceService.getSourceById(sourceId);
      expect(fetched!.isActive).toBe(true);
    });

    it('should refuse hard deletion when forwarding logs exist', async () => {
      // 1. Create a destination
      const destResult = await destinationService.registerDestination({
        chatId: -100888001,
        groupName: 'Team Sigma 1',
        sourceGroupId: sourceId,
      });
      expect(destResult.success).toBe(true);
      const destId = destResult.destination!.id;

      // 2. Insert a simulated forwarding log
      await prisma.forwardingLog.create({
        data: {
          sourceChatId: BigInt(-100999001),
          sourceMessageId: 9901,
          destinationGroupId: destId,
          status: ForwardingStatus.SUCCESS,
        },
      });

      // 3. Attempt hard deletion of source -> must be blocked
      const deleteResult = await sourceService.deleteSource(sourceId);
      expect(deleteResult.success).toBe(false);
      expect(deleteResult.message).toContain('Cannot delete source');
      expect(deleteResult.message).toContain('forwarding log(s) exist');

      // 4. Verify source and destination still exist intact
      const sourceAfter = await sourceService.getSourceById(sourceId);
      expect(sourceAfter).not.toBeNull();
    });
  });

  describe('Task 2: Destination Management Lifecycle & Integrity', () => {
    let sourceId: string;
    let destId: string;

    beforeAll(async () => {
      const s = await sourceService.registerSource({
        chatId: -100999002,
        topicId: 202,
        name: 'Database Engineering - Source',
      });
      sourceId = s.source!.id;
    });

    it('should register a destination under an active source', async () => {
      const result = await destinationService.registerDestination({
        chatId: -100888002,
        groupName: 'Team DB 1',
        sourceGroupId: sourceId,
      });

      expect(result.success).toBe(true);
      expect(result.isNew).toBe(true);
      expect(result.destination!.isActive).toBe(true);
      destId = result.destination!.id;
    });

    it('should prevent registering destination under a non-existent or inactive source', async () => {
      // Non-existent source
      const res1 = await destinationService.registerDestination({
        chatId: -100888003,
        groupName: 'Team DB 2',
        sourceGroupId: '00000000-0000-0000-0000-000000000000',
      });
      expect(res1.success).toBe(false);
      expect(res1.message).toContain('was not found');

      // Deactivate source
      await sourceService.setSourceStatus(sourceId, false);

      // Inactive source
      const res2 = await destinationService.registerDestination({
        chatId: -100888003,
        groupName: 'Team DB 2',
        sourceGroupId: sourceId,
      });
      expect(res2.success).toBe(false);
      expect(res2.message).toContain('inactive source topic');

      // Reactivate source
      await sourceService.setSourceStatus(sourceId, true);
    });

    it('should handle duplicate destination registrations idempotently', async () => {
      const result = await destinationService.registerDestination({
        chatId: -100888002,
        groupName: 'Team DB 1 Renamed',
        sourceGroupId: sourceId,
      });

      expect(result.success).toBe(true);
      expect(result.isNew).toBe(false);
      expect(result.destination!.id).toBe(destId);
    });

    it('should soft-deactivate and reactivate a destination', async () => {
      // Deactivate
      const deact = await destinationService.setDestinationStatus(destId, false);
      expect(deact.success).toBe(true);
      expect(deact.destination!.isActive).toBe(false);

      // Verify excluded from active destinations query
      const activeDests = await destinationService.getActiveDestinations(sourceId);
      expect(activeDests.some((d) => d.id === destId)).toBe(false);

      // Reactivate
      const react = await destinationService.setDestinationStatus(destId, true);
      expect(react.success).toBe(true);
      expect(react.destination!.isActive).toBe(true);

      const activeDestsAfter = await destinationService.getActiveDestinations(sourceId);
      expect(activeDestsAfter.some((d) => d.id === destId)).toBe(true);
    });

    it('should refuse hard deletion of destination when forwarding logs exist', async () => {
      // Create a forwarding log
      await prisma.forwardingLog.create({
        data: {
          sourceChatId: BigInt(-100999002),
          sourceMessageId: 9902,
          destinationGroupId: destId,
          status: ForwardingStatus.FAILED,
          errorMessage: 'Telegram rate limit',
        },
      });

      // Attempt hard deletion -> blocked
      const deleteResult = await destinationService.deleteDestination(destId);
      expect(deleteResult.success).toBe(false);
      expect(deleteResult.message).toContain('Cannot delete destination');
      expect(deleteResult.message).toContain('forwarding log(s) exist');

      // Verify destination is still in database
      const destAfter = await destinationService.getDestinationById(destId);
      expect(destAfter).not.toBeNull();
    });
  });

  describe('Task 2 & 3: Source Detector Isolation for Deactivated Sources', () => {
    it('should ignore announcements from deactivated sources in detectSourceAnnouncement', async () => {
      const source = await sourceService.registerSource({
        chatId: -100999003,
        topicId: 303,
        name: 'Deactivated Source Test',
      });
      const testSourceId = source.source!.id;

      // Deactivate the source
      await sourceService.setSourceStatus(testSourceId, false);

      const mockCtx: any = {
        chat: { id: -100999003, type: 'supergroup' },
        message: {
          message_id: 1234,
          message_thread_id: 303,
          text: 'This announcement should be ignored because source is inactive',
        },
      };

      const detected = await detectSourceAnnouncement(mockCtx);
      expect(detected).toBeNull();

      // Reactivate and verify detected
      await sourceService.setSourceStatus(testSourceId, true);
      const detectedAfter = await detectSourceAnnouncement(mockCtx);
      expect(detectedAfter).not.toBeNull();
      expect(detectedAfter!.sourceGroup.id).toBe(testSourceId);
    });
  });

  describe('Task 3: Delivery Monitoring Service & In-Chat Commands', () => {
    let testSourceId: string;
    let testDestId: string;
    let sampleLogId: string;

    beforeAll(async () => {
      const s = await sourceService.registerSource({
        chatId: -100999001,
        topicId: 101,
        name: 'Distributed Systems - Announcements',
      });
      testSourceId = s.source!.id;

      const d = await destinationService.registerDestination({
        chatId: -100888001,
        groupName: 'Team Sigma 1',
        sourceGroupId: testSourceId,
      });
      testDestId = d.destination!.id;

      // Insert diverse delivery logs for monitoring checks
      const log1 = await prisma.forwardingLog.create({
        data: {
          sourceChatId: BigInt(-100999001),
          sourceMessageId: 7001,
          destinationGroupId: testDestId,
          status: ForwardingStatus.SUCCESS,
        },
      });
      sampleLogId = log1.id;

      await prisma.forwardingLog.create({
        data: {
          sourceChatId: BigInt(-100999001),
          sourceMessageId: 7002,
          destinationGroupId: testDestId,
          status: ForwardingStatus.FAILED,
          errorMessage: '403 Forbidden: bot was blocked by the group 123456789:AAEFakeTokenSecretHere',
          retryCount: 3,
        },
      });

      await prisma.forwardingLog.create({
        data: {
          sourceChatId: BigInt(-100999001),
          sourceMessageId: 7003,
          destinationGroupId: testDestId,
          status: ForwardingStatus.RETRYING,
          errorMessage: '429 Too Many Requests: retry after 20',
          retryCount: 1,
        },
      });
    });

    it('getDeliveryStats should aggregate metrics correctly', async () => {
      const stats = await monitoringService.getDeliveryStats(testSourceId);

      expect(stats.sourceGroupId).toBe(testSourceId);
      expect(stats.sourceName).toBe('Distributed Systems - Announcements');
      expect(stats.totalDeliveries).toBeGreaterThanOrEqual(3);
      expect(stats.successfulDeliveries).toBeGreaterThanOrEqual(1);
      expect(stats.failedDeliveries).toBeGreaterThanOrEqual(1);
      expect(stats.retryingDeliveries).toBeGreaterThanOrEqual(1);
      expect(stats.successRate).toMatch(/^\d+\.\d+%$/);
      expect(stats.uniqueAnnouncements).toBeGreaterThanOrEqual(3);
    });

    it('getRecentDeliveries should retrieve latest delivery records with joins', async () => {
      const recent = await monitoringService.getRecentDeliveries({
        sourceGroupId: testSourceId,
        limit: 5,
      });

      expect(recent.length).toBeGreaterThan(0);
      expect(recent[0].destinationGroup).toBeDefined();
      expect(recent[0].destinationGroup.sourceGroup).toBeDefined();
      expect(recent[0].destinationGroup.sourceGroup.id).toBe(testSourceId);
    });

    it('getFailedDeliveries should return only FAILED and RETRYING logs', async () => {
      const failed = await monitoringService.getFailedDeliveries({
        sourceGroupId: testSourceId,
        limit: 10,
      });

      expect(failed.length).toBeGreaterThanOrEqual(2);
      for (const item of failed) {
        expect([ForwardingStatus.FAILED, ForwardingStatus.RETRYING]).toContain(item.status);
      }
    });

    it('getDeliveryDetails should retrieve single log by ID with related entities', async () => {
      const detail = await monitoringService.getDeliveryDetails(sampleLogId);

      expect(detail).not.toBeNull();
      expect(detail!.id).toBe(sampleLogId);
      expect(detail!.status).toBe(ForwardingStatus.SUCCESS);
      expect(detail!.destinationGroup.groupName).toBe('Team Sigma 1');
    });

    it('sanitizeText should redact Telegram bot tokens from error messages', () => {
      const sensitiveError = 'Error connecting with bot123456789:ABCdefGhI_FAKE_TOKEN_FOR_TESTING to Telegram API';
      const sanitized = monitoringService.sanitizeText(sensitiveError);

      expect(sanitized).not.toContain('123456789:ABCdefGhI_FAKE_TOKEN_FOR_TESTING');
      expect(sanitized).toContain('[REDACTED_BOT_TOKEN]');
    });

    it('formatting functions should produce Telegram-safe output (<4096 chars)', async () => {
      const stats = await monitoringService.getDeliveryStats(testSourceId);
      const statsMsg = monitoringService.formatStatsMessage(stats);
      expect(statsMsg.length).toBeLessThan(4096);
      expect(statsMsg).toContain('Statistics for');

      const recent = await monitoringService.getRecentDeliveries({ limit: 10 });
      const recentMsg = monitoringService.formatRecentDeliveries(recent);
      expect(recentMsg.length).toBeLessThan(4096);

      const failed = await monitoringService.getFailedDeliveries({ limit: 10 });
      const failedMsg = monitoringService.formatFailedDeliveries(failed);
      expect(failedMsg.length).toBeLessThan(4096);
      expect(failedMsg).not.toContain('AAEFakeTokenSecretHere'); // Sanitized!
    });
  });
});
