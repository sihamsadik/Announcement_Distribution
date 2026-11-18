import { Telegram, Telegraf, Context } from 'telegraf';
import { distributionService, DistributionService } from '../src/services/distribution.service';
import { destinationService } from '../src/services/destination.service';
import { sourceService } from '../src/services/source.service';
import { deliveryService } from '../src/services/delivery.service';
import { retryService } from '../src/services/retry.service';
import { albumService } from '../src/services/album.service';
import { ForwardErrorType, ForwardingService } from '../src/services/forwarding.service';
import { prisma, disconnectPrisma } from '../src/db/prisma';
import { setupBotHandlers } from '../src/bot/bot';
import { SourceGroup, DestinationGroup, ForwardingStatus } from '@prisma/client';

describe('Day 2 - Task 6: Complete Integration Testing and Reliability Verification', () => {
  const dummyToken = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ';

  // Source Groups
  const srcChatA = BigInt(-100910001);
  const srcTopicA = BigInt(101); // "Final Project"
  const srcChatB = BigInt(-100910002);
  const srcTopicB = BigInt(202); // "Assignment Announcements"

  // Destination Groups for Source A
  const destChatA1 = BigInt(-100920001); // Team Apollo
  const destChatA2 = BigInt(-100920002); // Team Artemis
  const destChatA3 = BigInt(-100920003); // Team Athena
  const destChatA4 = BigInt(-100920004); // Team Inactive

  // Destination Groups for Source B
  const destChatB1 = BigInt(-100930001); // Lab Group 1
  const destChatB2 = BigInt(-100930002); // Lab Group 2

  let sourceA: SourceGroup;
  let sourceB: SourceGroup;
  let destA1: DestinationGroup;
  let destA2: DestinationGroup;
  let destA3: DestinationGroup;
  let destA4_inactive: DestinationGroup;
  let destB1: DestinationGroup;
  let destB2: DestinationGroup;

  beforeAll(async () => {
    // Clean up test data if any leftovers exist
    await prisma.forwardingLog.deleteMany({
      where: {
        sourceChatId: { in: [srcChatA, srcChatB] },
      },
    });
    await prisma.destinationGroup.deleteMany({
      where: {
        chatId: {
          in: [destChatA1, destChatA2, destChatA3, destChatA4, destChatB1, destChatB2],
        },
      },
    });
    await prisma.sourceGroup.deleteMany({
      where: {
        chatId: { in: [srcChatA, srcChatB] },
      },
    });

    // 1. Register Source A ("Final Project")
    const resA = await sourceService.registerSource({
      chatId: srcChatA,
      topicId: srcTopicA,
      name: 'Final Project',
    });
    sourceA = resA.source!;

    // 2. Register Source B ("Assignment Announcements")
    const resB = await sourceService.registerSource({
      chatId: srcChatB,
      topicId: srcTopicB,
      name: 'Assignment Announcements',
    });
    sourceB = resB.source!;

    // 3. Register Destinations for Source A
    const rA1 = await destinationService.registerDestination({
      chatId: destChatA1,
      groupName: 'Group A1 - Team Apollo',
      sourceGroupId: sourceA.id,
    });
    destA1 = rA1.destination!;

    const rA2 = await destinationService.registerDestination({
      chatId: destChatA2,
      groupName: 'Group A2 - Team Artemis',
      sourceGroupId: sourceA.id,
    });
    destA2 = rA2.destination!;

    const rA3 = await destinationService.registerDestination({
      chatId: destChatA3,
      groupName: 'Group A3 - Team Athena',
      sourceGroupId: sourceA.id,
    });
    destA3 = rA3.destination!;

    const rA4 = await destinationService.registerDestination({
      chatId: destChatA4,
      groupName: 'Group A4 - Inactive Team',
      sourceGroupId: sourceA.id,
    });
    destA4_inactive = rA4.destination!;
    // Deactivate Dest A4
    await destinationService.setDestinationStatus(destA4_inactive.id, false);

    // 4. Register Destinations for Source B
    const rB1 = await destinationService.registerDestination({
      chatId: destChatB1,
      groupName: 'Group B1 - Lab Alpha',
      sourceGroupId: sourceB.id,
    });
    destB1 = rB1.destination!;

    const rB2 = await destinationService.registerDestination({
      chatId: destChatB2,
      groupName: 'Group B2 - Lab Beta',
      sourceGroupId: sourceB.id,
    });
    destB2 = rB2.destination!;
  });

  afterAll(async () => {
    // Cleanup created records
    await prisma.forwardingLog.deleteMany({
      where: {
        sourceChatId: { in: [srcChatA, srcChatB] },
      },
    });
    await prisma.destinationGroup.deleteMany({
      where: {
        chatId: {
          in: [destChatA1, destChatA2, destChatA3, destChatA4, destChatB1, destChatB2],
        },
      },
    });
    await prisma.sourceGroup.deleteMany({
      where: {
        chatId: { in: [srcChatA, srcChatB] },
      },
    });
    await disconnectPrisma();
  });

  afterEach(() => {
    albumService.clear();
  });

  // =========================================================================
  // 1. Complete Announcement Workflow Verification
  // =========================================================================
  describe('1. Complete Announcement Workflow', () => {
    it('should complete the end-to-end announcement workflow from source topic to active destinations', async () => {
      const mockForwardMessage = jest.fn().mockImplementation((destChatId, srcChatId, msgId) => {
        return Promise.resolve({ message_id: 80000 + Number(msgId) });
      });

      const mockTelegram = {
        forwardMessage: mockForwardMessage,
      } as unknown as Telegram;

      const testMsgId = 1001;
      const ctx = {
        chat: { id: Number(srcChatA), type: 'supergroup' },
        message: {
          message_id: testMsgId,
          message_thread_id: Number(srcTopicA),
          text: '📢 Important: Milestone 1 deadline has been extended to Friday 11:59 PM.',
          from: { id: 555001, is_bot: false, first_name: 'Dr. Coordinator' },
        },
        telegram: mockTelegram,
        botInfo: { id: 999999, is_bot: true, username: 'test_announcement_bot' },
      } as unknown as Context;

      // 1. Incoming announcement processed
      const summary = await distributionService.processIncomingMessage(ctx, dummyToken);

      expect(summary).not.toBeNull();
      expect(summary?.sourceGroupId).toBe(sourceA.id);
      expect(summary?.sourceGroupName).toBe('Final Project');
      expect(summary?.totalDestinations).toBe(3); // A1, A2, A3 (A4 is inactive)
      expect(summary?.successfulCount).toBe(3);
      expect(summary?.failedCount).toBe(0);
      expect(summary?.skippedCount).toBe(0);

      // Verify native forwardMessage was called for active destinations A1, A2, A3
      expect(mockForwardMessage).toHaveBeenCalledTimes(3);
      expect(mockForwardMessage).toHaveBeenCalledWith(destChatA1.toString(), srcChatA.toString(), testMsgId);
      expect(mockForwardMessage).toHaveBeenCalledWith(destChatA2.toString(), srcChatA.toString(), testMsgId);
      expect(mockForwardMessage).toHaveBeenCalledWith(destChatA3.toString(), srcChatA.toString(), testMsgId);

      // 2. Verify database records in ForwardingLog
      const logs = await prisma.forwardingLog.findMany({
        where: {
          sourceChatId: srcChatA,
          sourceMessageId: testMsgId,
        },
        include: { destinationGroup: true },
      });

      expect(logs).toHaveLength(3);
      expect(logs.every((l) => l.status === ForwardingStatus.SUCCESS)).toBe(true);
      expect(logs.every((l) => l.retryCount === 0)).toBe(true);

      // Verify inactive destination A4 received no messages and has no log
      const a4Log = logs.find((l) => l.destinationGroupId === destA4_inactive.id);
      expect(a4Log).toBeUndefined();
    });
  });

  // =========================================================================
  // 2. Message Types and Native Forwarding Verification
  // =========================================================================
  describe('2. Message Types and Native Forwarding', () => {
    const testCases = [
      {
        name: 'Plain Text Announcement',
        message: { text: 'General Project Guidelines' },
        expectedType: 'text',
        msgId: 2001,
      },
      {
        name: 'Photo Announcement with Caption',
        message: { photo: [{ file_id: 'p1', width: 800, height: 600 }], caption: 'System Architecture Diagram' },
        expectedType: 'photo',
        msgId: 2002,
      },
      {
        name: 'PDF Document Announcement',
        message: { document: { file_id: 'd1', file_name: 'Rubric_Final_Project.pdf', mime_type: 'application/pdf' }, caption: 'Project Evaluation Rubric' },
        expectedType: 'document',
        msgId: 2003,
      },
      {
        name: 'Video Announcement with Caption',
        message: { video: { file_id: 'v1', duration: 120 }, caption: 'Sprint 2 Demo Walkthrough' },
        expectedType: 'video',
        msgId: 2004,
      },
      {
        name: 'Voice Message Announcement',
        message: { voice: { file_id: 'vc1', duration: 45 } },
        expectedType: 'voice',
        msgId: 2005,
      },
      {
        name: 'Sticker Message Announcement',
        message: { sticker: { file_id: 'stk1', emoji: '🎉' } },
        expectedType: 'sticker',
        msgId: 2006,
      },
    ];

    testCases.forEach((tc) => {
      it(`should preserve and natively forward ${tc.name}`, async () => {
        const mockForwardMessage = jest.fn().mockResolvedValue({ message_id: 90000 + tc.msgId });
        const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

        const ctx = {
          chat: { id: Number(srcChatA), type: 'supergroup' },
          message: {
            message_id: tc.msgId,
            message_thread_id: Number(srcTopicA),
            ...tc.message,
            from: { id: 555001, is_bot: false },
          },
          telegram: mockTelegram,
          botInfo: { id: 999999, is_bot: true },
        } as unknown as Context;

        const summary = await distributionService.processIncomingMessage(ctx, dummyToken);

        expect(summary).not.toBeNull();
        expect(summary?.contentType).toBe(tc.expectedType);
        expect(summary?.successfulCount).toBe(3);

        // Verify native forwarding preserved the exact message ID
        expect(mockForwardMessage).toHaveBeenCalledWith(destChatA1.toString(), srcChatA.toString(), tc.msgId);

        // Verify database log
        const log = await prisma.forwardingLog.findUnique({
          where: {
            sourceChatId_sourceMessageId_destinationGroupId: {
              sourceChatId: srcChatA,
              sourceMessageId: tc.msgId,
              destinationGroupId: destA1.id,
            },
          },
        });
        expect(log?.status).toBe(ForwardingStatus.SUCCESS);
      });
    });

    it('should natively forward Media Albums (Photos & Videos) preserving order and grouping', async () => {
      const mockForwardMessages = jest.fn().mockImplementation((destChatId, srcChatId, msgIds) => {
        return Promise.resolve(msgIds.map((id: number) => ({ message_id: 95000 + id })));
      });

      const mockTelegram = { forwardMessages: mockForwardMessages } as unknown as Telegram;
      const mediaGroupId = 'album_integration_day2';
      const albumMsgIds = [2010, 2011, 2012];

      const customDist = new DistributionService(
        destinationService,
        new ForwardingService(),
        albumService,
        deliveryService,
        0
      );

      // Collect updates for the album
      for (const msgId of albumMsgIds) {
        albumService.addMessage(
          mockTelegram,
          sourceA,
          srcChatA,
          srcTopicA,
          mediaGroupId,
          msgId,
          'photo',
          'Album item caption',
          dummyToken,
          undefined,
          customDist.distributeAlbum.bind(customDist)
        );
      }

      // Flush album
      const summary = await albumService.flushAlbum(
        `${srcChatA.toString()}_${mediaGroupId}`,
        mockTelegram,
        dummyToken,
        undefined,
        customDist.distributeAlbum.bind(customDist)
      );

      expect(summary).not.toBeNull();
      expect(summary?.isAlbum).toBe(true);
      expect(summary?.sourceMessageIds).toEqual([2010, 2011, 2012]);
      expect(summary?.successfulCount).toBe(3);

      // Verify native forwardMessages was called atomically per destination
      expect(mockForwardMessages).toHaveBeenCalledTimes(3);
      expect(mockForwardMessages).toHaveBeenCalledWith(destChatA1.toString(), srcChatA.toString(), [2010, 2011, 2012]);

      // Verify database logged all 3 items per destination
      const albumLogs = await prisma.forwardingLog.findMany({
        where: {
          sourceChatId: srcChatA,
          sourceMessageId: { in: albumMsgIds },
          destinationGroupId: destA1.id,
        },
      });

      expect(albumLogs).toHaveLength(3);
      expect(albumLogs.every((l) => l.status === ForwardingStatus.SUCCESS)).toBe(true);
    });
  });

  // =========================================================================
  // 3. Multi-Source Isolation Verification
  // =========================================================================
  describe('3. Multi-Source Isolation', () => {
    it('should forward Source A announcements only to A1, A2, A3, never to B1 or B2', async () => {
      const forwardedDestinations: string[] = [];
      const mockForwardMessage = jest.fn().mockImplementation((destChatId) => {
        forwardedDestinations.push(destChatId);
        return Promise.resolve({ message_id: 8888 });
      });

      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;
      const testMsgId = 3001;

      const ctxA = {
        chat: { id: Number(srcChatA), type: 'supergroup' },
        message: {
          message_id: testMsgId,
          message_thread_id: Number(srcTopicA),
          text: 'Source A Announcement',
          from: { id: 555001, is_bot: false },
        },
        telegram: mockTelegram,
        botInfo: { id: 999999, is_bot: true },
      } as unknown as Context;

      await distributionService.processIncomingMessage(ctxA, dummyToken);

      // Forwarded only to A1, A2, A3
      expect(forwardedDestinations).toHaveLength(3);
      expect(forwardedDestinations).toContain(destChatA1.toString());
      expect(forwardedDestinations).toContain(destChatA2.toString());
      expect(forwardedDestinations).toContain(destChatA3.toString());
      expect(forwardedDestinations).not.toContain(destChatB1.toString());
      expect(forwardedDestinations).not.toContain(destChatB2.toString());
      expect(forwardedDestinations).not.toContain(destChatA4.toString()); // inactive skipped
    });

    it('should forward Source B announcements only to B1 and B2, never to A1, A2, A3', async () => {
      const forwardedDestinations: string[] = [];
      const mockForwardMessage = jest.fn().mockImplementation((destChatId) => {
        forwardedDestinations.push(destChatId);
        return Promise.resolve({ message_id: 8889 });
      });

      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;
      const testMsgId = 3002;

      const ctxB = {
        chat: { id: Number(srcChatB), type: 'supergroup' },
        message: {
          message_id: testMsgId,
          message_thread_id: Number(srcTopicB),
          text: 'Source B Announcement: Lab 3 Submission Open',
          from: { id: 555002, is_bot: false },
        },
        telegram: mockTelegram,
        botInfo: { id: 999999, is_bot: true },
      } as unknown as Context;

      await distributionService.processIncomingMessage(ctxB, dummyToken);

      // Forwarded only to B1, B2
      expect(forwardedDestinations).toHaveLength(2);
      expect(forwardedDestinations).toContain(destChatB1.toString());
      expect(forwardedDestinations).toContain(destChatB2.toString());
      expect(forwardedDestinations).not.toContain(destChatA1.toString());
      expect(forwardedDestinations).not.toContain(destChatA2.toString());
      expect(forwardedDestinations).not.toContain(destChatA3.toString());
    });

    it('should ignore messages from an unregistered topic in the same group', async () => {
      const mockForwardMessage = jest.fn();
      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      const ctxUnregistered = {
        chat: { id: Number(srcChatA), type: 'supergroup' },
        message: {
          message_id: 3003,
          message_thread_id: 9999, // Unregistered topic in Source A chat
          text: 'Discussion in off-topic thread',
          from: { id: 555001, is_bot: false },
        },
        telegram: mockTelegram,
        botInfo: { id: 999999, is_bot: true },
      } as unknown as Context;

      const result = await distributionService.processIncomingMessage(ctxUnregistered, dummyToken);

      expect(result).toBeNull();
      expect(mockForwardMessage).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 4. Duplicate Prevention and Idempotency Verification
  // =========================================================================
  describe('4. Duplicate Prevention and Idempotency', () => {
    it('should skip forwarding when receiving a duplicate Telegram update for already-delivered message', async () => {
      let forwardCount = 0;
      const mockForwardMessage = jest.fn().mockImplementation(() => {
        forwardCount++;
        return Promise.resolve({ message_id: 70000 });
      });

      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;
      const testMsgId = 4001;

      const ctx = {
        chat: { id: Number(srcChatA), type: 'supergroup' },
        message: {
          message_id: testMsgId,
          message_thread_id: Number(srcTopicA),
          text: 'Idempotency Test Message',
          from: { id: 555001, is_bot: false },
        },
        telegram: mockTelegram,
        botInfo: { id: 999999, is_bot: true },
      } as unknown as Context;

      // First delivery: should forward to 3 destinations
      const firstRun = await distributionService.processIncomingMessage(ctx, dummyToken);
      expect(firstRun?.successfulCount).toBe(3);
      expect(firstRun?.skippedCount).toBe(0);
      expect(forwardCount).toBe(3);

      // Re-delivery of identical Telegram update (e.g. webhook redelivery or restart)
      const secondRun = await distributionService.processIncomingMessage(ctx, dummyToken);
      expect(secondRun?.successfulCount).toBe(0);
      expect(secondRun?.skippedCount).toBe(3); // All 3 skipped
      expect(secondRun?.results.every((r) => r.skipped && r.skipReason?.includes('Idempotency'))).toBe(true);

      // Telegram API was NOT called again
      expect(forwardCount).toBe(3);
    });

    it('should resolve concurrent delivery attempts safely via PostgreSQL unique constraint', async () => {
      const concurrentMsgId = 4002;

      // Simulate two workers calling claimDelivery concurrently for the same (source, msg, dest)
      const [claim1, claim2] = await Promise.all([
        deliveryService.claimDelivery(srcChatA, concurrentMsgId, destA1.id),
        deliveryService.claimDelivery(srcChatA, concurrentMsgId, destA1.id),
      ]);

      // Exactly one must win the claim (canDeliver: true), the other must be prevented (canDeliver: false)
      const winners = [claim1, claim2].filter((c) => c.canDeliver);
      const losers = [claim1, claim2].filter((c) => !c.canDeliver);

      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0].reason).toBe('ALREADY_PENDING');

      // Winner marks success
      await deliveryService.markSuccess(srcChatA, concurrentMsgId, destA1.id);

      // Subsequent attempt sees ALREADY_DELIVERED
      const subsequent = await deliveryService.claimDelivery(srcChatA, concurrentMsgId, destA1.id);
      expect(subsequent.canDeliver).toBe(false);
      expect(subsequent.reason).toBe('ALREADY_DELIVERED');
    });

    it('should safely reclaim stale PENDING deliveries after application crash (>60s)', async () => {
      const crashedMsgId = 4003;
      const staleTime = new Date(Date.now() - 120 * 1000); // 2 minutes ago

      // Insert simulated crashed PENDING record
      await prisma.forwardingLog.create({
        data: {
          sourceChatId: srcChatA,
          sourceMessageId: crashedMsgId,
          destinationGroupId: destA1.id,
          status: ForwardingStatus.PENDING,
          createdAt: staleTime,
          updatedAt: staleTime,
        },
      });

      // Claiming delivery now should recognize it as stale and reclaim it
      const claim = await deliveryService.claimDelivery(srcChatA, crashedMsgId, destA1.id);
      expect(claim.canDeliver).toBe(true);
      expect(claim.isRetry).toBe(true);

      // Active pending (<60s) should NOT be reclaimed
      const freshPendingMsgId = 4004;
      await deliveryService.claimDelivery(srcChatA, freshPendingMsgId, destA1.id);
      const activeClaim = await deliveryService.claimDelivery(srcChatA, freshPendingMsgId, destA1.id);
      expect(activeClaim.canDeliver).toBe(false);
      expect(activeClaim.reason).toBe('ALREADY_PENDING');
    });
  });

  // =========================================================================
  // 5. Failure Recovery and Error Isolation Verification
  // =========================================================================
  describe('5. Failure Recovery and Error Isolation', () => {
    it('should isolate failures so one failing destination does not block successful delivery to other destinations', async () => {
      const testMsgId = 5001;

      // Mock Telegram behavior:
      // - Dest A1: Network failure (transient)
      // - Dest A2: Success
      // - Dest A3: Bot write forbidden (permanent)
      const mockForwardMessage = jest.fn().mockImplementation((destChatId) => {
        if (destChatId === destChatA1.toString()) {
          return Promise.reject(new Error('ETIMEDOUT: Connection timed out'));
        }
        if (destChatId === destChatA2.toString()) {
          return Promise.resolve({ message_id: 50002 });
        }
        if (destChatId === destChatA3.toString()) {
          return Promise.reject(new Error('Forbidden: bot does not have rights to send_messages'));
        }
        return Promise.resolve({ message_id: 50000 });
      });

      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      const ctx = {
        chat: { id: Number(srcChatA), type: 'supergroup' },
        message: {
          message_id: testMsgId,
          message_thread_id: Number(srcTopicA),
          text: 'Failure Isolation Test Announcement',
          from: { id: 555001, is_bot: false },
        },
        telegram: mockTelegram,
        botInfo: { id: 999999, is_bot: true },
      } as unknown as Context;

      const summary = await distributionService.processIncomingMessage(ctx, dummyToken);

      expect(summary).not.toBeNull();
      expect(summary?.successfulCount).toBe(1); // Dest A2 succeeded
      expect(summary?.failedCount).toBe(2);     // Dest A1 and A3 failed

      // Verify Dest A1: Transient failure -> RETRYING with nextRetryAt set
      const logA1 = await prisma.forwardingLog.findUnique({
        where: {
          sourceChatId_sourceMessageId_destinationGroupId: {
            sourceChatId: srcChatA,
            sourceMessageId: testMsgId,
            destinationGroupId: destA1.id,
          },
        },
      });
      expect(logA1?.status).toBe(ForwardingStatus.RETRYING);
      expect(logA1?.retryCount).toBe(1);
      expect(logA1?.nextRetryAt).not.toBeNull();

      // Verify Dest A2: Success -> SUCCESS
      const logA2 = await prisma.forwardingLog.findUnique({
        where: {
          sourceChatId_sourceMessageId_destinationGroupId: {
            sourceChatId: srcChatA,
            sourceMessageId: testMsgId,
            destinationGroupId: destA2.id,
          },
        },
      });
      expect(logA2?.status).toBe(ForwardingStatus.SUCCESS);
      expect(logA2?.retryCount).toBe(0);

      // Verify Dest A3: Permanent failure -> FAILED (no retry scheduled)
      const logA3 = await prisma.forwardingLog.findUnique({
        where: {
          sourceChatId_sourceMessageId_destinationGroupId: {
            sourceChatId: srcChatA,
            sourceMessageId: testMsgId,
            destinationGroupId: destA3.id,
          },
        },
      });
      expect(logA3?.status).toBe(ForwardingStatus.FAILED);
      expect(logA3?.nextRetryAt).toBeNull();
    });

    it('should process eligible retries in background and transition to SUCCESS when network recovers', async () => {
      const retryMsgId = 5002;

      // Seed a RETRYING record whose nextRetryAt is in the past (due immediately)
      await prisma.forwardingLog.create({
        data: {
          sourceChatId: srcChatA,
          sourceMessageId: retryMsgId,
          destinationGroupId: destA1.id,
          status: ForwardingStatus.RETRYING,
          retryCount: 1,
          nextRetryAt: new Date(Date.now() - 1000), // Due now
          errorMessage: 'Temporary network timeout',
        },
      });

      // Telegram forward succeeds on retry attempt
      const mockForwardMessage = jest.fn().mockResolvedValue({ message_id: 60001 });
      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      const result = await retryService.processRetries(mockTelegram, dummyToken);

      expect(result.processed).toBeGreaterThanOrEqual(1);
      expect(result.succeeded).toBeGreaterThanOrEqual(1);

      // Verify record is now marked SUCCESS
      const updatedLog = await prisma.forwardingLog.findUnique({
        where: {
          sourceChatId_sourceMessageId_destinationGroupId: {
            sourceChatId: srcChatA,
            sourceMessageId: retryMsgId,
            destinationGroupId: destA1.id,
          },
        },
      });

      expect(updatedLog?.status).toBe(ForwardingStatus.SUCCESS);
      expect(updatedLog?.nextRetryAt).toBeNull();
    });

    it('should transition to terminal FAILED once maximum retry count is reached', async () => {
      const exhaustedMsgId = 5003;

      // Seed a record that has reached max retries (e.g. retryCount: 2, maxRetryCount: 3)
      await prisma.forwardingLog.create({
        data: {
          sourceChatId: srcChatA,
          sourceMessageId: exhaustedMsgId,
          destinationGroupId: destA1.id,
          status: ForwardingStatus.RETRYING,
          retryCount: 2, // 3rd attempt will be final
          nextRetryAt: new Date(Date.now() - 1000),
          errorMessage: 'Transient server error 503',
        },
      });

      // Mock Telegram failing again with 503
      const mockTelegram = {
        forwardMessage: jest.fn().mockRejectedValue(new Error('503 Service Unavailable')),
      } as unknown as Telegram;

      const result = await retryService.processRetries(mockTelegram, dummyToken);

      expect(result.permanentlyFailed).toBeGreaterThanOrEqual(1);

      const terminalLog = await prisma.forwardingLog.findUnique({
        where: {
          sourceChatId_sourceMessageId_destinationGroupId: {
            sourceChatId: srcChatA,
            sourceMessageId: exhaustedMsgId,
            destinationGroupId: destA1.id,
          },
        },
      });

      expect(terminalLog?.status).toBe(ForwardingStatus.FAILED);
      expect(terminalLog?.nextRetryAt).toBeNull();
      expect(terminalLog?.errorMessage).toContain('Exhausted maximum retries');
    });

    it('should recover stale pending records on application restart via recoverStalePendingDeliveries()', async () => {
      const restartMsgId = 5004;
      const crashedTime = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago

      // Seed a stale pending delivery left over by an unexpected shutdown
      await prisma.forwardingLog.create({
        data: {
          sourceChatId: srcChatA,
          sourceMessageId: restartMsgId,
          destinationGroupId: destA1.id,
          status: ForwardingStatus.PENDING,
          createdAt: crashedTime,
          updatedAt: crashedTime,
        },
      });

      // Run startup recovery
      const recoveredCount = await retryService.recoverStalePendingDeliveries(60000);
      expect(recoveredCount).toBeGreaterThanOrEqual(1);

      // Record should now be RETRYING with nextRetryAt set to now
      const recoveredLog = await prisma.forwardingLog.findUnique({
        where: {
          sourceChatId_sourceMessageId_destinationGroupId: {
            sourceChatId: srcChatA,
            sourceMessageId: restartMsgId,
            destinationGroupId: destA1.id,
          },
        },
      });

      expect(recoveredLog?.status).toBe(ForwardingStatus.RETRYING);
      expect(recoveredLog?.errorMessage).toContain('Recovered from interrupted application run');
    });
  });
});
