import { Telegram, Context } from 'telegraf';
import { distributionService, DistributionService } from '../src/services/distribution.service';
import { deliveryService, DeliveryService } from '../src/services/delivery.service';
import { destinationService } from '../src/services/destination.service';
import { sourceService } from '../src/services/source.service';
import { forwardingService, ForwardingService, ForwardErrorType } from '../src/services/forwarding.service';
import { albumService } from '../src/services/album.service';
import { prisma, disconnectPrisma } from '../src/db/prisma';
import { SourceGroup, DestinationGroup, ForwardingStatus } from '@prisma/client';

describe('Persistent Delivery Tracking and Duplicate Prevention (Day 2 - Task 4)', () => {
  const dummyToken = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ';
  const testSourceChatId = BigInt(-100555001);
  const testDestChatId1 = BigInt(-100333001);
  const testDestChatId2 = BigInt(-100333002);
  const testDestChatId3 = BigInt(-100333003);

  let source: SourceGroup;
  let dest1: DestinationGroup;
  let dest2: DestinationGroup;
  let destInactive: DestinationGroup;

  beforeAll(async () => {
    // 1. Cleanup any leftover data
    await prisma.forwardingLog.deleteMany({
      where: {
        sourceChatId: testSourceChatId,
      },
    });
    await prisma.destinationGroup.deleteMany({
      where: {
        chatId: { in: [testDestChatId1, testDestChatId2, testDestChatId3] },
      },
    });
    await prisma.sourceGroup.deleteMany({
      where: {
        chatId: testSourceChatId,
      },
    });

    // 2. Register Source Group
    const resSrc = await sourceService.registerSource({
      chatId: testSourceChatId,
      topicId: BigInt(701),
      name: 'Software Engineering - Sprint Updates',
    });
    source = resSrc.source!;

    // 3. Register Destinations
    const d1 = await destinationService.registerDestination({
      chatId: testDestChatId1,
      groupName: 'Student Team 1',
      sourceGroupId: source.id,
    });
    dest1 = d1.destination!;

    const d2 = await destinationService.registerDestination({
      chatId: testDestChatId2,
      groupName: 'Student Team 2',
      sourceGroupId: source.id,
    });
    dest2 = d2.destination!;

    const d3 = await destinationService.registerDestination({
      chatId: testDestChatId3,
      groupName: 'Inactive Team 3',
      sourceGroupId: source.id,
    });
    destInactive = d3.destination!;
    // Deactivate destInactive
    await destinationService.setDestinationStatus(destInactive.id, false);
  });

  afterAll(async () => {
    albumService.clear();
    await prisma.forwardingLog.deleteMany({
      where: {
        sourceChatId: testSourceChatId,
      },
    });
    await prisma.destinationGroup.deleteMany({
      where: {
        chatId: { in: [testDestChatId1, testDestChatId2, testDestChatId3] },
      },
    });
    await prisma.sourceGroup.deleteMany({
      where: {
        id: source.id,
      },
    });
    await disconnectPrisma();
  });

  beforeEach(async () => {
    albumService.clear();
  });

  describe('1. Successful Delivery Tracking', () => {
    it('should create a SUCCESS ForwardingLog record in database upon successful delivery', async () => {
      const msgId = 1001;
      const mockForwardMessage = jest.fn().mockResolvedValue({ message_id: 5001 });
      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      const summary = await distributionService.distributeAnnouncement(
        mockTelegram,
        source,
        msgId,
        'text',
        dummyToken
      );

      expect(summary.successfulCount).toBe(2); // dest1 and dest2
      expect(summary.failedCount).toBe(0);
      expect(summary.skippedCount).toBe(0);

      // Verify records in PostgreSQL database
      const logs = await prisma.forwardingLog.findMany({
        where: {
          sourceChatId: testSourceChatId,
          sourceMessageId: msgId,
        },
      });

      expect(logs.length).toBe(2);
      for (const log of logs) {
        expect(log.status).toBe(ForwardingStatus.SUCCESS);
        expect(log.errorMessage).toBeNull();
        expect(log.createdAt).toBeInstanceOf(Date);
        expect(log.updatedAt).toBeInstanceOf(Date);
      }
    });
  });

  describe('2. Failed Delivery Tracking', () => {
    it('should create a FAILED ForwardingLog record with error description when forwarding fails', async () => {
      const msgId = 1002;
      // dest1 fails (bot kicked), dest2 succeeds
      const mockForwardMessage = jest.fn().mockImplementation((destChatId) => {
        if (destChatId === dest1.chatId.toString()) {
          return Promise.reject(new Error('Forbidden: bot was kicked from the supergroup chat'));
        }
        return Promise.resolve({ message_id: 5002 });
      });
      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      const summary = await distributionService.distributeAnnouncement(
        mockTelegram,
        source,
        msgId,
        'text',
        dummyToken
      );

      expect(summary.successfulCount).toBe(1);
      expect(summary.failedCount).toBe(1);

      // Verify dest1 log in DB has FAILED status and error description
      const log1 = await prisma.forwardingLog.findUnique({
        where: {
          sourceChatId_sourceMessageId_destinationGroupId: {
            sourceChatId: testSourceChatId,
            sourceMessageId: msgId,
            destinationGroupId: dest1.id,
          },
        },
      });

      expect(log1).not.toBeNull();
      expect(log1?.status).toBe(ForwardingStatus.FAILED);
      expect(log1?.errorMessage).toContain('Bot is not a member');

      // Verify dest2 log in DB has SUCCESS status
      const log2 = await prisma.forwardingLog.findUnique({
        where: {
          sourceChatId_sourceMessageId_destinationGroupId: {
            sourceChatId: testSourceChatId,
            sourceMessageId: msgId,
            destinationGroupId: dest2.id,
          },
        },
      });

      expect(log2).not.toBeNull();
      expect(log2?.status).toBe(ForwardingStatus.SUCCESS);
    });
  });

  describe('3. Idempotency & Duplicate Prevention', () => {
    it('should skip forwarding when message has already been successfully delivered', async () => {
      const msgId = 1001; // Delivered in test 1
      const mockForwardMessage = jest.fn();
      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      const summary = await distributionService.distributeAnnouncement(
        mockTelegram,
        source,
        msgId,
        'text',
        dummyToken
      );

      // Both dest1 and dest2 should be skipped due to existing SUCCESS records
      expect(summary.skippedCount).toBe(2);
      expect(summary.successfulCount).toBe(0);
      expect(summary.failedCount).toBe(0);

      // Verify forwardMessage was NEVER called
      expect(mockForwardMessage).not.toHaveBeenCalled();

      // Verify results record skipped reasons
      expect(summary.results[0].skipped).toBe(true);
      expect(summary.results[0].skipReason).toContain('Already delivered');
      expect(summary.results[1].skipped).toBe(true);
      expect(summary.results[1].skipReason).toContain('Already delivered');
    });
  });

  describe('4. Inactive Destinations Isolation', () => {
    it('should never forward or create delivery records for inactive destination groups', async () => {
      const msgId = 1003;
      const mockForwardMessage = jest.fn().mockResolvedValue({ message_id: 5003 });
      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      await distributionService.distributeAnnouncement(
        mockTelegram,
        source,
        msgId,
        'text',
        dummyToken
      );

      // Inactive destination should have NO log in the database
      const inactiveLog = await prisma.forwardingLog.findUnique({
        where: {
          sourceChatId_sourceMessageId_destinationGroupId: {
            sourceChatId: testSourceChatId,
            sourceMessageId: msgId,
            destinationGroupId: destInactive.id,
          },
        },
      });

      expect(inactiveLog).toBeNull();
    });
  });

  describe('5. Retry Capability for Failed Deliveries', () => {
    it('should allow retrying a previously FAILED delivery and update it to SUCCESS', async () => {
      const msgId = 1002; // dest1 failed in test 2, dest2 succeeded

      // Now dest1 succeeds on retry!
      const mockForwardMessage = jest.fn().mockResolvedValue({ message_id: 5004 });
      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      const summary = await distributionService.distributeAnnouncement(
        mockTelegram,
        source,
        msgId,
        'text',
        dummyToken
      );

      // dest2 was already SUCCESS -> skipped. dest1 was FAILED -> retried and succeeded!
      expect(summary.skippedCount).toBe(1); // dest2 skipped
      expect(summary.successfulCount).toBe(1); // dest1 retried & succeeded
      expect(summary.failedCount).toBe(0);

      // Verify forwardMessage was only called for dest1
      expect(mockForwardMessage).toHaveBeenCalledTimes(1);
      expect(mockForwardMessage).toHaveBeenCalledWith(
        dest1.chatId.toString(),
        source.chatId.toString(),
        msgId
      );

      // Verify dest1 record in DB is now SUCCESS with null error
      const updatedLog1 = await prisma.forwardingLog.findUnique({
        where: {
          sourceChatId_sourceMessageId_destinationGroupId: {
            sourceChatId: testSourceChatId,
            sourceMessageId: msgId,
            destinationGroupId: dest1.id,
          },
        },
      });

      expect(updatedLog1?.status).toBe(ForwardingStatus.SUCCESS);
      expect(updatedLog1?.errorMessage).toBeNull();
    });
  });

  describe('6. Database Unique Constraint Enforcement', () => {
    it('should enforce unique constraint on (sourceChatId, sourceMessageId, destinationGroupId) in PostgreSQL', async () => {
      const uniqueMsgId = 1005;

      // 1. First insert succeeds
      await prisma.forwardingLog.create({
        data: {
          sourceChatId: testSourceChatId,
          sourceMessageId: uniqueMsgId,
          destinationGroupId: dest1.id,
          status: ForwardingStatus.PENDING,
        },
      });

      // 2. Duplicate insert with identical tuple must throw P2002
      await expect(
        prisma.forwardingLog.create({
          data: {
            sourceChatId: testSourceChatId,
            sourceMessageId: uniqueMsgId,
            destinationGroupId: dest1.id,
            status: ForwardingStatus.PENDING,
          },
        })
      ).rejects.toThrow();
    });
  });

  describe('7. Concurrency Safety', () => {
    it('should safely handle concurrent claimDelivery attempts without creating duplicate records', async () => {
      const concurrentMsgId = 1006;

      // Fire 2 concurrent claimDelivery calls simultaneously
      const [claim1, claim2] = await Promise.all([
        deliveryService.claimDelivery(testSourceChatId, concurrentMsgId, dest1.id),
        deliveryService.claimDelivery(testSourceChatId, concurrentMsgId, dest1.id),
      ]);

      // Exactly one must be permitted to deliver, while the other is rejected as ALREADY_PENDING
      const canDeliverCount = [claim1.canDeliver, claim2.canDeliver].filter(Boolean).length;
      expect(canDeliverCount).toBe(1);

      const rejectedClaim = !claim1.canDeliver ? claim1 : claim2;
      expect(rejectedClaim.reason).toBe('ALREADY_PENDING');

      // Verify database contains exactly 1 record for this pair
      const records = await prisma.forwardingLog.findMany({
        where: {
          sourceChatId: testSourceChatId,
          sourceMessageId: concurrentMsgId,
          destinationGroupId: dest1.id,
        },
      });
      expect(records.length).toBe(1);
    });
  });

  describe('8. Media Album Delivery Tracking & Idempotency', () => {
    const albumMsgIds = [2001, 2002, 2003];
    const albumId = 'mg_audit_album_1';

    it('should create individual ForwardingLog records for all messages in the album upon success', async () => {
      const mockForwardMessages = jest.fn().mockResolvedValue([
        { message_id: 6001 },
        { message_id: 6002 },
        { message_id: 6003 },
      ]);
      const mockTelegram = { forwardMessages: mockForwardMessages } as unknown as Telegram;

      const summary = await distributionService.distributeAlbum(
        mockTelegram,
        source,
        albumMsgIds,
        albumId,
        'album (3 items)',
        dummyToken
      );

      expect(summary.successfulCount).toBe(2);
      expect(summary.skippedCount).toBe(0);

      // Verify all 3 messages have SUCCESS records for both destinations (total 6 records)
      const albumLogs = await prisma.forwardingLog.findMany({
        where: {
          sourceChatId: testSourceChatId,
          sourceMessageId: { in: albumMsgIds },
        },
      });

      expect(albumLogs.length).toBe(6);
      for (const log of albumLogs) {
        expect(log.status).toBe(ForwardingStatus.SUCCESS);
      }
    });

    it('should skip forwarding the album when all messages in the album are already SUCCESS', async () => {
      const mockForwardMessages = jest.fn();
      const mockTelegram = { forwardMessages: mockForwardMessages } as unknown as Telegram;

      const summary = await distributionService.distributeAlbum(
        mockTelegram,
        source,
        albumMsgIds,
        albumId,
        'album (3 items)',
        dummyToken
      );

      expect(summary.skippedCount).toBe(2);
      expect(summary.successfulCount).toBe(0);
      expect(mockForwardMessages).not.toHaveBeenCalled();
    });

    it('should mark all album message items as FAILED when forwardMessages fails', async () => {
      const failedAlbumIds = [2010, 2011];
      const mockForwardMessages = jest.fn().mockRejectedValue(new Error('Forbidden: CHAT_WRITE_FORBIDDEN'));
      const mockTelegram = { forwardMessages: mockForwardMessages } as unknown as Telegram;

      const summary = await distributionService.distributeAlbum(
        mockTelegram,
        source,
        failedAlbumIds,
        'mg_failed_album',
        'album (2 items)',
        dummyToken
      );

      expect(summary.failedCount).toBe(2);

      const failedLogs = await prisma.forwardingLog.findMany({
        where: {
          sourceChatId: testSourceChatId,
          sourceMessageId: { in: failedAlbumIds },
        },
      });

      expect(failedLogs.length).toBe(4); // 2 items x 2 destinations
      for (const log of failedLogs) {
        expect(log.status).toBe(ForwardingStatus.FAILED);
        expect(log.errorMessage).toContain('permission to send messages');
      }
    });
  });

  describe('9. Interrupted Process Recovery & Stale PENDING Detection', () => {
    it('should identify stale PENDING records after an application crash or interruption', async () => {
      const crashedMsgId = 3001;

      // Simulate a crashed process: insert a PENDING record created 5 minutes ago
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const crashedLog = await prisma.forwardingLog.create({
        data: {
          sourceChatId: testSourceChatId,
          sourceMessageId: crashedMsgId,
          destinationGroupId: dest1.id,
          status: ForwardingStatus.PENDING,
          createdAt: fiveMinutesAgo,
          updatedAt: fiveMinutesAgo,
        },
      });

      // Query stale pending records (threshold: 60 seconds)
      const staleRecords = await deliveryService.getStalePendingRecords(60000);
      const found = staleRecords.find((r) => r.id === crashedLog.id);

      expect(found).toBeDefined();
      expect(found?.sourceMessageId).toBe(crashedMsgId);
      expect(found?.status).toBe(ForwardingStatus.PENDING);

      // Now attempt delivery: DeliveryService must reclaim the stale pending record
      const claim = await deliveryService.claimDelivery(testSourceChatId, crashedMsgId, dest1.id);
      expect(claim.canDeliver).toBe(true);
      expect(claim.isRetry).toBe(true);
      expect(claim.logId).toBe(crashedLog.id);
    });
  });
});
