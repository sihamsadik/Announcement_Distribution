import { Telegram, Telegraf, Context } from 'telegraf';
import { distributionService, DistributionService } from '../src/services/distribution.service';
import { destinationService } from '../src/services/destination.service';
import { sourceService } from '../src/services/source.service';
import { ForwardErrorType, ForwardingService } from '../src/services/forwarding.service';
import { prisma, disconnectPrisma } from '../src/db/prisma';
import { setupBotHandlers } from '../src/bot/bot';
import { SourceGroup, DestinationGroup } from '@prisma/client';

describe('Announcement Distribution Service', () => {
  const dummyToken = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ';
  const testSourceChatId1 = BigInt(-100888001);
  const testSourceChatId2 = BigInt(-100888002);
  const testDestChatId1 = BigInt(-100777001);
  const testDestChatId2 = BigInt(-100777002);
  const testDestChatId3 = BigInt(-100777003);
  const testDestChatId4 = BigInt(-100777004);

  let sourceA: SourceGroup;
  let sourceB: SourceGroup;
  let destA1: DestinationGroup;
  let destA2: DestinationGroup;
  let destA3: DestinationGroup;
  let destB1: DestinationGroup;

  beforeAll(async () => {
    // Clean up previous test data if any
    await prisma.destinationGroup.deleteMany({
      where: {
        chatId: { in: [testDestChatId1, testDestChatId2, testDestChatId3, testDestChatId4] },
      },
    });
    await prisma.sourceGroup.deleteMany({
      where: {
        chatId: { in: [testSourceChatId1, testSourceChatId2] },
      },
    });

    // 1. Register Source A (Software Engineering - Final Project Topic 101)
    const resA = await sourceService.registerSource({
      chatId: testSourceChatId1,
      topicId: BigInt(101),
      name: 'Source A - Final Project',
    });
    sourceA = resA.source!;

    // 2. Register Source B (Computer Networks - Lab Topic 202)
    const resB = await sourceService.registerSource({
      chatId: testSourceChatId2,
      topicId: BigInt(202),
      name: 'Source B - Lab Topic',
    });
    sourceB = resB.source!;

    // 3. Register destinations for Source A
    const dA1 = await destinationService.registerDestination({
      chatId: testDestChatId1,
      groupName: 'Student Team 1',
      sourceGroupId: sourceA.id,
    });
    destA1 = dA1.destination!;

    const dA2 = await destinationService.registerDestination({
      chatId: testDestChatId2,
      groupName: 'Student Team 2',
      sourceGroupId: sourceA.id,
    });
    destA2 = dA2.destination!;

    const dA3 = await destinationService.registerDestination({
      chatId: testDestChatId3,
      groupName: 'Student Team 3 (Inactive)',
      sourceGroupId: sourceA.id,
    });
    destA3 = dA3.destination!;
    // Deactivate destA3 for filtering tests
    await destinationService.setDestinationStatus(destA3.id, false);

    // 4. Register destination for Source B
    const dB1 = await destinationService.registerDestination({
      chatId: testDestChatId4,
      groupName: 'Networks Team 1',
      sourceGroupId: sourceB.id,
    });
    destB1 = dB1.destination!;
  });

  afterAll(async () => {
    // Cleanup created test records
    await prisma.destinationGroup.deleteMany({
      where: {
        chatId: { in: [testDestChatId1, testDestChatId2, testDestChatId3, testDestChatId4] },
      },
    });
    await prisma.sourceGroup.deleteMany({
      where: {
        id: { in: [sourceA.id, sourceB.id] },
      },
    });
    await disconnectPrisma();
  });

  describe('1. Message Eligibility & Bot Loop Protection', () => {
    it('should reject context without message', () => {
      const ctx = {} as Context;
      const res = distributionService.isEligibleMessage(ctx);
      expect(res.eligible).toBe(false);
      expect(res.reason).toContain('No message object');
    });

    it('should reject messages sent by bots (message.from.is_bot = true)', () => {
      const ctx = {
        message: {
          message_id: 10,
          from: { id: 12345, is_bot: true, first_name: 'OtherBot', username: 'other_bot' },
          text: 'Automatic notification',
        },
      } as Context;

      const res = distributionService.isEligibleMessage(ctx);
      expect(res.eligible).toBe(false);
      expect(res.reason).toContain('Sender is a bot');
    });

    it('should reject bot own messages when ctx.botInfo matches sender ID', () => {
      const ctx = {
        botInfo: { id: 999999, is_bot: true, first_name: 'OurBot', username: 'our_announcement_bot' },
        message: {
          message_id: 11,
          from: { id: 999999, is_bot: false, first_name: 'OurBot' },
          text: 'Admin update from bot',
        },
      } as unknown as Context;

      const res = distributionService.isEligibleMessage(ctx);
      expect(res.eligible).toBe(false);
      expect(res.reason).toContain('bot itself');
    });

    it('should reject command messages starting with /', () => {
      const ctx = {
        message: {
          message_id: 12,
          from: { id: 55555, is_bot: false, first_name: 'Professor' },
          text: '/register_destination -100777005 Team 5',
        },
      } as unknown as Context;

      const res = distributionService.isEligibleMessage(ctx);
      expect(res.eligible).toBe(false);
      expect(res.reason).toContain('command');
    });

    it('should approve valid announcement messages from human users', () => {
      const ctx = {
        message: {
          message_id: 13,
          from: { id: 55555, is_bot: false, first_name: 'Professor' },
          text: 'Final Project milestone 1 is due next Friday at 23:59!',
        },
      } as unknown as Context;

      const res = distributionService.isEligibleMessage(ctx);
      expect(res.eligible).toBe(true);
    });
  });

  describe('2. Active Destination Retrieval and Scoping', () => {
    it('should retrieve only active destinations for Source A (excluding inactive destA3)', async () => {
      const active = await destinationService.getActiveDestinations(sourceA.id);
      expect(active.length).toBe(2);
      const ids = active.map((d) => d.id);
      expect(ids).toContain(destA1.id);
      expect(ids).toContain(destA2.id);
      expect(ids).not.toContain(destA3.id);
    });

    it('should retrieve only destinations belonging to Source B, ignoring Source A destinations', async () => {
      const activeB = await destinationService.getActiveDestinations(sourceB.id);
      expect(activeB.length).toBe(1);
      expect(activeB[0].id).toBe(destB1.id);
      expect(activeB[0].chatId).toBe(testDestChatId4);
    });

    it('should return empty list when source has no destinations or empty ID', async () => {
      const activeNone = await destinationService.getActiveDestinations('non-existent-source-id');
      expect(activeNone).toEqual([]);

      const activeEmpty = await destinationService.getActiveDestinations('');
      expect(activeEmpty).toEqual([]);
    });
  });

  describe('3. Core Announcement Distribution Service', () => {
    it('should distribute announcement to all active destinations of the matched source', async () => {
      const mockForwardMessage = jest.fn().mockImplementation((destChatId, srcChatId, srcMsgId) => {
        return Promise.resolve({ message_id: 9000 + Number(srcMsgId) });
      });

      const mockTelegram = {
        forwardMessage: mockForwardMessage,
      } as unknown as Telegram;

      const summary = await distributionService.distributeAnnouncement(
        mockTelegram,
        sourceA,
        501,
        dummyToken
      );

      // Verify summary structure
      expect(summary.sourceGroupId).toBe(sourceA.id);
      expect(summary.sourceGroupName).toBe(sourceA.name);
      expect(summary.sourceChatId).toBe(sourceA.chatId);
      expect(summary.sourceTopicId).toBe(sourceA.topicId);
      expect(summary.sourceMessageId).toBe(501);
      expect(summary.totalDestinations).toBe(2);
      expect(summary.successfulCount).toBe(2);
      expect(summary.failedCount).toBe(0);
      expect(summary.results.length).toBe(2);

      // Verify each active destination received the forward
      const deliveredDestIds = summary.results.map((r) => r.destinationId);
      expect(deliveredDestIds).toContain(destA1.id);
      expect(deliveredDestIds).toContain(destA2.id);
      expect(deliveredDestIds).not.toContain(destA3.id); // inactive was excluded

      // Verify forwardMessage called for each active destination with correct parameters
      expect(mockForwardMessage).toHaveBeenCalledTimes(2);
      expect(mockForwardMessage).toHaveBeenCalledWith(
        destA1.chatId.toString(),
        sourceA.chatId.toString(),
        501
      );
      expect(mockForwardMessage).toHaveBeenCalledWith(
        destA2.chatId.toString(),
        sourceA.chatId.toString(),
        501
      );
    });

    it('should distribute only to Source B destinations when Source B message is processed', async () => {
      const mockForwardMessage = jest.fn().mockImplementation(() => {
        return Promise.resolve({ message_id: 9999 });
      });

      const mockTelegram = {
        forwardMessage: mockForwardMessage,
      } as unknown as Telegram;

      const summary = await distributionService.distributeAnnouncement(
        mockTelegram,
        sourceB,
        601,
        dummyToken
      );

      expect(summary.sourceGroupId).toBe(sourceB.id);
      expect(summary.totalDestinations).toBe(1);
      expect(summary.successfulCount).toBe(1);
      expect(summary.results[0].destinationId).toBe(destB1.id);
      expect(mockForwardMessage).toHaveBeenCalledTimes(1);
      expect(mockForwardMessage).toHaveBeenCalledWith(
        destB1.chatId.toString(),
        sourceB.chatId.toString(),
        601
      );
    });

    it('should return empty summary with 0 forwards if source has no active destinations', async () => {
      // Temporarily deactivate destB1
      await destinationService.setDestinationStatus(destB1.id, false);

      const mockForwardMessage = jest.fn();
      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      const summary = await distributionService.distributeAnnouncement(
        mockTelegram,
        sourceB,
        602,
        dummyToken
      );

      expect(summary.totalDestinations).toBe(0);
      expect(summary.successfulCount).toBe(0);
      expect(summary.failedCount).toBe(0);
      expect(summary.results).toEqual([]);
      expect(mockForwardMessage).not.toHaveBeenCalled();

      // Reactivate destB1
      await destinationService.setDestinationStatus(destB1.id, true);
    });
  });

  describe('4. Error Handling and Partial Failure Resilience', () => {
    it('should continue distribution to remaining groups when one destination fails', async () => {
      // Setup mock where destA1 fails (bot was kicked) and destA2 succeeds
      const mockForwardMessage = jest.fn().mockImplementation((destChatId) => {
        if (destChatId === destA1.chatId.toString()) {
          return Promise.reject(new Error('Forbidden: bot was kicked from the supergroup chat'));
        }
        return Promise.resolve({ message_id: 9050 });
      });

      const mockTelegram = {
        forwardMessage: mockForwardMessage,
      } as unknown as Telegram;

      const summary = await distributionService.distributeAnnouncement(
        mockTelegram,
        sourceA,
        700,
        dummyToken
      );

      // Verify loop continued through all active destinations
      expect(summary.totalDestinations).toBe(2);
      expect(summary.successfulCount).toBe(1);
      expect(summary.failedCount).toBe(1);
      expect(summary.results.length).toBe(2);

      // Failed destination result
      const failedResult = summary.results.find((r) => r.destinationId === destA1.id);
      expect(failedResult).toBeDefined();
      expect(failedResult!.success).toBe(false);
      expect(failedResult!.errorType).toBe(ForwardErrorType.BOT_NOT_MEMBER);
      expect(failedResult!.errorMessage).toContain('Bot is not a member');

      // Succeeded destination result
      const successResult = summary.results.find((r) => r.destinationId === destA2.id);
      expect(successResult).toBeDefined();
      expect(successResult!.success).toBe(true);
      expect(successResult!.forwardedMessageId).toBe(9050);
    });

    it('should handle permission denied errors without throwing or stopping the service', async () => {
      const mockForwardMessage = jest.fn().mockImplementation((destChatId) => {
        if (destChatId === destA1.chatId.toString()) {
          return Promise.reject(new Error('Forbidden: CHAT_WRITE_FORBIDDEN'));
        }
        return Promise.resolve({ message_id: 9051 });
      });

      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      const summary = await distributionService.distributeAnnouncement(
        mockTelegram,
        sourceA,
        701,
        dummyToken
      );

      expect(summary.successfulCount).toBe(1);
      expect(summary.failedCount).toBe(1);

      const failedResult = summary.results.find((r) => r.destinationId === destA1.id);
      expect(failedResult!.errorType).toBe(ForwardErrorType.PERMISSION_DENIED);
    });
  });

  describe('5. End-to-End processIncomingMessage Integration', () => {
    it('should ignore message if sent by another bot', async () => {
      const mockForwardMessage = jest.fn();
      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      const ctx = {
        telegram: mockTelegram,
        chat: { id: Number(sourceA.chatId), type: 'supergroup' },
        message: {
          message_id: 800,
          message_thread_id: Number(sourceA.topicId),
          from: { id: 8888, is_bot: true, first_name: 'SpamBot' },
          text: 'Automated notification message',
        },
      } as unknown as Context;

      const summary = await distributionService.processIncomingMessage(ctx, dummyToken);
      expect(summary).toBeNull();
      expect(mockForwardMessage).not.toHaveBeenCalled();
    });

    it('should ignore commands sent in the source topic', async () => {
      const mockForwardMessage = jest.fn();
      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      const ctx = {
        telegram: mockTelegram,
        chat: { id: Number(sourceA.chatId), type: 'supergroup' },
        message: {
          message_id: 801,
          message_thread_id: Number(sourceA.topicId),
          from: { id: 1111, is_bot: false, first_name: 'Admin' },
          text: '/list_destinations',
        },
      } as unknown as Context;

      const summary = await distributionService.processIncomingMessage(ctx, dummyToken);
      expect(summary).toBeNull();
      expect(mockForwardMessage).not.toHaveBeenCalled();
    });

    it('should ignore messages from unregistered topics in the same group', async () => {
      const mockForwardMessage = jest.fn();
      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      const ctx = {
        telegram: mockTelegram,
        chat: { id: Number(sourceA.chatId), type: 'supergroup' },
        message: {
          message_id: 802,
          message_thread_id: 9999, // Unregistered topic in Source A group
          from: { id: 1111, is_bot: false, first_name: 'Student' },
          text: 'Discussion in general topic',
        },
      } as unknown as Context;

      const summary = await distributionService.processIncomingMessage(ctx, dummyToken);
      expect(summary).toBeNull();
      expect(mockForwardMessage).not.toHaveBeenCalled();
    });

    it('should process and distribute valid announcement message posted in registered topic', async () => {
      const mockForwardMessage = jest.fn().mockImplementation(() => {
        return Promise.resolve({ message_id: 9500 });
      });
      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      const ctx = {
        telegram: mockTelegram,
        chat: { id: Number(sourceA.chatId), type: 'supergroup' },
        message: {
          message_id: 805,
          message_thread_id: Number(sourceA.topicId),
          from: { id: 1111, is_bot: false, first_name: 'Professor' },
          text: '📢 Important Update: Project submission deadline is extended by 24 hours!',
        },
      } as unknown as Context;

      const summary = await distributionService.processIncomingMessage(ctx, dummyToken);
      expect(summary).not.toBeNull();
      expect(summary!.sourceGroupId).toBe(sourceA.id);
      expect(summary!.sourceMessageId).toBe(805);
      expect(summary!.successfulCount).toBe(2);
      expect(mockForwardMessage).toHaveBeenCalledTimes(2);
    });
  });
});
