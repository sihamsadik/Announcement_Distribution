import { Telegram } from 'telegraf';
import { retryService, RetryService, calculateNextRetryDelay } from '../src/services/retry.service';
import { deliveryService } from '../src/services/delivery.service';
import { distributionService } from '../src/services/distribution.service';
import { destinationService } from '../src/services/destination.service';
import { sourceService } from '../src/services/source.service';
import { forwardingService, ForwardErrorType, classifyTelegramError, isTransientError } from '../src/services/forwarding.service';
import { prisma, disconnectPrisma } from '../src/db/prisma';
import { SourceGroup, DestinationGroup, ForwardingStatus } from '@prisma/client';

describe('Retry Mechanisms and Failure Recovery (Day 2 - Task 5)', () => {
  const dummyToken = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ';
  const testSourceChatId = BigInt(-100777001);
  const testDestChatId1 = BigInt(-100888001);
  const testDestChatId2 = BigInt(-100888002);

  let source: SourceGroup;
  let dest1: DestinationGroup;
  let dest2: DestinationGroup;

  beforeAll(async () => {
    // 1. Cleanup
    await prisma.forwardingLog.deleteMany({
      where: { sourceChatId: testSourceChatId },
    });
    await prisma.destinationGroup.deleteMany({
      where: { chatId: { in: [testDestChatId1, testDestChatId2] } },
    });
    await prisma.sourceGroup.deleteMany({
      where: { chatId: testSourceChatId },
    });

    // 2. Setup Source & Destinations
    const resSrc = await sourceService.registerSource({
      chatId: testSourceChatId,
      topicId: BigInt(801),
      name: 'Software Engineering - Sprint Milestones',
    });
    source = resSrc.source!;

    const d1 = await destinationService.registerDestination({
      chatId: testDestChatId1,
      groupName: 'Student Project Team Alpha',
      sourceGroupId: source.id,
    });
    dest1 = d1.destination!;

    const d2 = await destinationService.registerDestination({
      chatId: testDestChatId2,
      groupName: 'Student Project Team Beta',
      sourceGroupId: source.id,
    });
    dest2 = d2.destination!;
  });

  afterAll(async () => {
    retryService.stopPolling();
    await prisma.forwardingLog.deleteMany({
      where: { sourceChatId: testSourceChatId },
    });
    await prisma.destinationGroup.deleteMany({
      where: { chatId: { in: [testDestChatId1, testDestChatId2] } },
    });
    await prisma.sourceGroup.deleteMany({
      where: { id: source.id },
    });
    await disconnectPrisma();
  });

  describe('1. Error Classification (Transient vs Permanent)', () => {
    it('should classify temporary network failures as transient NETWORK_ERROR', () => {
      const err = new Error('connect ETIMEDOUT 149.154.167.220:443');
      const classified = classifyTelegramError(err);
      expect(classified.errorType).toBe(ForwardErrorType.NETWORK_ERROR);
      expect(classified.isTransient).toBe(true);
      expect(isTransientError(classified.errorType)).toBe(true);
    });

    it('should classify Telegram 5xx server errors as transient SERVER_ERROR', () => {
      const err = new Error('502 Bad Gateway from Telegram API');
      const classified = classifyTelegramError(err);
      expect(classified.errorType).toBe(ForwardErrorType.SERVER_ERROR);
      expect(classified.isTransient).toBe(true);
      expect(isTransientError(classified.errorType)).toBe(true);
    });

    it('should classify rate-limit responses as transient RATE_LIMITED with retry_after', () => {
      const err = new Error('429: Too Many Requests: retry after 20');
      const classified = classifyTelegramError(err);
      expect(classified.errorType).toBe(ForwardErrorType.RATE_LIMITED);
      expect(classified.isTransient).toBe(true);
      expect(classified.retryAfterSeconds).toBe(20);
    });

    it('should classify permission failures as permanent PERMISSION_DENIED', () => {
      const err = new Error('Forbidden: CHAT_WRITE_FORBIDDEN');
      const classified = classifyTelegramError(err);
      expect(classified.errorType).toBe(ForwardErrorType.PERMISSION_DENIED);
      expect(classified.isTransient).toBe(false);
      expect(isTransientError(classified.errorType)).toBe(false);
    });

    it('should classify bot kicked errors as permanent BOT_NOT_MEMBER', () => {
      const err = new Error('Forbidden: bot was kicked from the supergroup chat');
      const classified = classifyTelegramError(err);
      expect(classified.errorType).toBe(ForwardErrorType.BOT_NOT_MEMBER);
      expect(classified.isTransient).toBe(false);
    });

    it('should classify invalid chat IDs as permanent INVALID_CHAT_ID', () => {
      const err = new Error('Bad Request: chat not found');
      const classified = classifyTelegramError(err);
      expect(classified.errorType).toBe(ForwardErrorType.INVALID_CHAT_ID);
      expect(classified.isTransient).toBe(false);
    });

    it('should classify protected content as permanent PROTECTED_CONTENT', () => {
      const err = new Error('Bad Request: CHAT_FORWARDS_RESTRICTED');
      const classified = classifyTelegramError(err);
      expect(classified.errorType).toBe(ForwardErrorType.PROTECTED_CONTENT);
      expect(classified.isTransient).toBe(false);
    });
  });

  describe('2. Backoff Calculation', () => {
    it('should calculate exponential backoff accurately based on retryCount', () => {
      // initial = 5s
      const delay0 = calculateNextRetryDelay(0, undefined, 5, 300);
      expect(delay0).toBe(5000); // 5 * 2^0 = 5s

      const delay1 = calculateNextRetryDelay(1, undefined, 5, 300);
      expect(delay1).toBe(10000); // 5 * 2^1 = 10s

      const delay2 = calculateNextRetryDelay(2, undefined, 5, 300);
      expect(delay2).toBe(20000); // 5 * 2^2 = 20s

      const delay3 = calculateNextRetryDelay(3, undefined, 5, 300);
      expect(delay3).toBe(40000); // 5 * 2^3 = 40s
    });

    it('should respect Telegram retry_after parameter when larger than exponential delay', () => {
      // Exponential gives 5s, but Telegram requested 45s
      const delay = calculateNextRetryDelay(0, 45, 5, 300);
      expect(delay).toBe(45000); // 45s
    });

    it('should enforce maximum delay cap', () => {
      // Exponential gives 5 * 2^10 = 5120s, but max is 300s
      const delay = calculateNextRetryDelay(10, undefined, 5, 300);
      expect(delay).toBe(300000); // 300s
    });
  });

  describe('3. Automated Retry Scheduling on Failure', () => {
    it('1. Temporary network failure: schedules RETRYING with exponential backoff', async () => {
      const msgId = 5001;
      const mockForwardMessage = jest.fn().mockRejectedValue(new Error('connect ETIMEDOUT 149.154.167.220:443'));
      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      await distributionService.distributeAnnouncement(mockTelegram, source, msgId, 'text', dummyToken);

      // Check DB records: should be RETRYING with retryCount: 1 and nextRetryAt in the future
      const log = await prisma.forwardingLog.findUnique({
        where: {
          sourceChatId_sourceMessageId_destinationGroupId: {
            sourceChatId: testSourceChatId,
            sourceMessageId: msgId,
            destinationGroupId: dest1.id,
          },
        },
      });

      expect(log).not.toBeNull();
      expect(log?.status).toBe(ForwardingStatus.RETRYING);
      expect(log?.retryCount).toBe(1);
      expect(log?.nextRetryAt).toBeInstanceOf(Date);
      expect(log?.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());
      expect(log?.errorMessage).toContain('Temporary network');
    });

    it('2. Telegram rate-limit response: schedules RETRYING with nextRetryAt respecting retry_after', async () => {
      const msgId = 5002;
      const mockForwardMessage = jest.fn().mockRejectedValue(new Error('429: Too Many Requests: retry after 15'));
      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      await distributionService.distributeAnnouncement(mockTelegram, source, msgId, 'text', dummyToken);

      const log = await prisma.forwardingLog.findUnique({
        where: {
          sourceChatId_sourceMessageId_destinationGroupId: {
            sourceChatId: testSourceChatId,
            sourceMessageId: msgId,
            destinationGroupId: dest1.id,
          },
        },
      });

      expect(log?.status).toBe(ForwardingStatus.RETRYING);
      expect(log?.retryCount).toBe(1);
      // nextRetryAt should be ~15s in the future
      const delaySec = Math.round((log!.nextRetryAt!.getTime() - log!.createdAt.getTime()) / 1000);
      expect(delaySec).toBeGreaterThanOrEqual(14);
      expect(delaySec).toBeLessThanOrEqual(16);
    });

    it('3. Permission failure: marks FAILED immediately without scheduling retry', async () => {
      const msgId = 5003;
      const mockForwardMessage = jest.fn().mockRejectedValue(new Error('Forbidden: CHAT_WRITE_FORBIDDEN'));
      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      await distributionService.distributeAnnouncement(mockTelegram, source, msgId, 'text', dummyToken);

      const log = await prisma.forwardingLog.findUnique({
        where: {
          sourceChatId_sourceMessageId_destinationGroupId: {
            sourceChatId: testSourceChatId,
            sourceMessageId: msgId,
            destinationGroupId: dest1.id,
          },
        },
      });

      expect(log?.status).toBe(ForwardingStatus.FAILED);
      expect(log?.nextRetryAt).toBeNull();
      expect(log?.errorMessage).toContain('permission to send messages');
    });

    it('4. Invalid destination: marks FAILED immediately without scheduling retry', async () => {
      const msgId = 5004;
      const mockForwardMessage = jest.fn().mockRejectedValue(new Error('Bad Request: chat not found'));
      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      await distributionService.distributeAnnouncement(mockTelegram, source, msgId, 'text', dummyToken);

      const log = await prisma.forwardingLog.findUnique({
        where: {
          sourceChatId_sourceMessageId_destinationGroupId: {
            sourceChatId: testSourceChatId,
            sourceMessageId: msgId,
            destinationGroupId: dest1.id,
          },
        },
      });

      expect(log?.status).toBe(ForwardingStatus.FAILED);
      expect(log?.nextRetryAt).toBeNull();
    });
  });

  describe('4. Retry Processing and Lifecycle Transitions', () => {
    it('5. Successful retry: transitions RETRYING record to SUCCESS', async () => {
      const msgId = 5005;

      // Seed a record in RETRYING state with nextRetryAt in the past (eligible now)
      const pastTime = new Date(Date.now() - 10000);
      await prisma.forwardingLog.create({
        data: {
          sourceChatId: testSourceChatId,
          sourceMessageId: msgId,
          destinationGroupId: dest1.id,
          status: ForwardingStatus.RETRYING,
          retryCount: 1,
          nextRetryAt: pastTime,
          errorMessage: 'Initial timeout',
        },
      });

      // Mock Telegram succeeding on retry
      const mockForwardMessage = jest.fn().mockResolvedValue({ message_id: 8888 });
      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      const customRetry = new RetryService({ maxRetryCount: 3, initialRetryDelaySeconds: 5 });
      const res = await customRetry.processRetries(mockTelegram, dummyToken);

      expect(res.processed).toBeGreaterThanOrEqual(1);
      expect(res.succeeded).toBe(1);

      // Verify DB record is now SUCCESS
      const updatedLog = await prisma.forwardingLog.findUnique({
        where: {
          sourceChatId_sourceMessageId_destinationGroupId: {
            sourceChatId: testSourceChatId,
            sourceMessageId: msgId,
            destinationGroupId: dest1.id,
          },
        },
      });

      expect(updatedLog?.status).toBe(ForwardingStatus.SUCCESS);
      expect(updatedLog?.nextRetryAt).toBeNull();
      expect(updatedLog?.errorMessage).toBeNull();
    });

    it('6. Maximum retry count reached: transitions to FAILED (terminal failure)', async () => {
      const msgId = 5006;

      // Seed a record at retryCount: 2 (out of max 3), eligible now
      const pastTime = new Date(Date.now() - 10000);
      await prisma.forwardingLog.create({
        data: {
          sourceChatId: testSourceChatId,
          sourceMessageId: msgId,
          destinationGroupId: dest1.id,
          status: ForwardingStatus.RETRYING,
          retryCount: 2,
          nextRetryAt: pastTime,
          errorMessage: 'Attempt 2 failed with network timeout',
        },
      });

      // Attempt 3 fails with another network timeout
      const mockForwardMessage = jest.fn().mockRejectedValue(new Error('Network timeout'));
      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      const customRetry = new RetryService({ maxRetryCount: 3 });
      const res = await customRetry.processRetries(mockTelegram, dummyToken);

      expect(res.permanentlyFailed).toBe(1);

      // Verify record is now terminal FAILED with nextRetryAt = null
      const failedLog = await prisma.forwardingLog.findUnique({
        where: {
          sourceChatId_sourceMessageId_destinationGroupId: {
            sourceChatId: testSourceChatId,
            sourceMessageId: msgId,
            destinationGroupId: dest1.id,
          },
        },
      });

      expect(failedLog?.status).toBe(ForwardingStatus.FAILED);
      expect(failedLog?.retryCount).toBe(3);
      expect(failedLog?.nextRetryAt).toBeNull();
      expect(failedLog?.errorMessage).toContain('Exhausted maximum retries');
    });

    it('7. Application restart: recovers stale PENDING deliveries from database', async () => {
      const crashedMsgId = 5007;

      // Simulate an application crash: record left PENDING 2 minutes ago
      const twoMinutesAgo = new Date(Date.now() - 120000);
      await prisma.forwardingLog.create({
        data: {
          sourceChatId: testSourceChatId,
          sourceMessageId: crashedMsgId,
          destinationGroupId: dest1.id,
          status: ForwardingStatus.PENDING,
          retryCount: 0,
          createdAt: twoMinutesAgo,
          updatedAt: twoMinutesAgo,
        },
      });

      // Run startup crash recovery
      const customRetry = new RetryService({ maxRetryCount: 3 });
      const recoveredCount = await customRetry.recoverStalePendingDeliveries(60000);

      expect(recoveredCount).toBeGreaterThanOrEqual(1);

      // Verify record was transitioned to RETRYING with nextRetryAt = now
      const recoveredLog = await prisma.forwardingLog.findUnique({
        where: {
          sourceChatId_sourceMessageId_destinationGroupId: {
            sourceChatId: testSourceChatId,
            sourceMessageId: crashedMsgId,
            destinationGroupId: dest1.id,
          },
        },
      });

      expect(recoveredLog?.status).toBe(ForwardingStatus.RETRYING);
      expect(recoveredLog?.nextRetryAt).toBeInstanceOf(Date);
      expect(recoveredLog?.nextRetryAt!.getTime()).toBeLessThanOrEqual(Date.now());

      // Now process retries: should successfully pick up the recovered delivery!
      const mockForwardMessage = jest.fn().mockResolvedValue({ message_id: 9991 });
      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      const retryRes = await customRetry.processRetries(mockTelegram, dummyToken);
      expect(retryRes.succeeded).toBeGreaterThanOrEqual(1);

      const finalLog = await prisma.forwardingLog.findUnique({
        where: {
          sourceChatId_sourceMessageId_destinationGroupId: {
            sourceChatId: testSourceChatId,
            sourceMessageId: crashedMsgId,
            destinationGroupId: dest1.id,
          },
        },
      });
      expect(finalLog?.status).toBe(ForwardingStatus.SUCCESS);
    });

    it('8. Duplicate retry workers: optimistic lock prevents processing the same record twice', async () => {
      const raceMsgId = 5008;

      // Seed eligible RETRYING record
      const pastTime = new Date(Date.now() - 5000);
      await prisma.forwardingLog.create({
        data: {
          sourceChatId: testSourceChatId,
          sourceMessageId: raceMsgId,
          destinationGroupId: dest1.id,
          status: ForwardingStatus.RETRYING,
          retryCount: 1,
          nextRetryAt: pastTime,
        },
      });

      const mockForwardMessage = jest.fn().mockImplementation(() => {
        // slight artificial delay to test concurrency race
        return new Promise((resolve) => setTimeout(() => resolve({ message_id: 9992 }), 50));
      });
      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      const worker1 = new RetryService({ maxRetryCount: 3 });
      const worker2 = new RetryService({ maxRetryCount: 3 });

      // Run both retry workers concurrently
      const [res1, res2] = await Promise.all([
        worker1.processRetries(mockTelegram, dummyToken),
        worker2.processRetries(mockTelegram, dummyToken),
      ]);

      // Exactly ONE worker must have processed and succeeded on this record
      const totalSucceeded = res1.succeeded + res2.succeeded;
      expect(totalSucceeded).toBe(1);

      // Verify forwardMessage was called exactly ONCE
      expect(mockForwardMessage).toHaveBeenCalledTimes(1);
    });

    it('9. Successful delivery never being retried', async () => {
      const successMsgId = 5009;

      // Seed a SUCCESS record
      await prisma.forwardingLog.create({
        data: {
          sourceChatId: testSourceChatId,
          sourceMessageId: successMsgId,
          destinationGroupId: dest1.id,
          status: ForwardingStatus.SUCCESS,
          nextRetryAt: null,
        },
      });

      const mockForwardMessage = jest.fn();
      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      const customRetry = new RetryService();
      const res = await customRetry.processRetries(mockTelegram, dummyToken);

      // Verify SUCCESS record was not processed
      expect(mockForwardMessage).not.toHaveBeenCalled();

      // Verify claimDelivery also rejects it
      const claim = await deliveryService.claimDelivery(testSourceChatId, successMsgId, dest1.id);
      expect(claim.canDeliver).toBe(false);
      expect(claim.reason).toBe('ALREADY_DELIVERED');
    });
  });
});
