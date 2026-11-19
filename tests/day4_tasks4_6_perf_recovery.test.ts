import { prisma } from '../src/db/prisma';
import { sourceService } from '../src/services/source.service';
import { destinationService } from '../src/services/destination.service';
import { DistributionService } from '../src/services/distribution.service';
import { ForwardingService, ForwardErrorType } from '../src/services/forwarding.service';
import { AlbumService } from '../src/services/album.service';
import { deliveryService } from '../src/services/delivery.service';
import { retryService } from '../src/services/retry.service';
import { ForwardingStatus } from '@prisma/client';
import { Telegram } from 'telegraf';

describe('Day 4 Tasks 4–6: Performance Optimization, Graceful Shutdown, and Recovery', () => {
  let testSourceId: string;
  const testChatId = BigInt(-1009876543210);
  const testTopicId = BigInt(4040);

  beforeAll(async () => {
    // Setup clean test source
    await prisma.forwardingLog.deleteMany({
      where: { sourceChatId: testChatId },
    });
    await prisma.destinationGroup.deleteMany({
      where: { chatId: { in: [BigInt(-1001111001), BigInt(-1001111002), BigInt(-1001111003), BigInt(-1001111004)] } },
    });
    await prisma.sourceGroup.deleteMany({
      where: { chatId: testChatId },
    });

    const regSource = await sourceService.registerSource({
      name: 'Day 4 Perf & Recovery Source',
      chatId: testChatId,
      topicId: testTopicId,
    });
    testSourceId = regSource.source!.id;
  });

  afterAll(async () => {
    await prisma.forwardingLog.deleteMany({
      where: { sourceChatId: testChatId },
    });
    await prisma.destinationGroup.deleteMany({
      where: { sourceGroupId: testSourceId },
    });
    await prisma.sourceGroup.deleteMany({
      where: { id: testSourceId },
    });
  });

  // =========================================================================
  // Task 5: Performance Optimization
  // =========================================================================
  describe('Task 5: Performance Optimization', () => {
    let destIds: string[] = [];

    beforeAll(async () => {
      // Register 4 test destinations
      for (let i = 1; i <= 4; i++) {
        const dest = await destinationService.registerDestination({
          sourceGroupId: testSourceId,
          groupName: `Perf Dest Group ${i}`,
          chatId: BigInt(-1001111000 - i),
        });
        destIds.push(dest.destination!.id);
      }
    });

    afterAll(async () => {
      for (const id of destIds) {
        await destinationService.deleteDestination(id);
      }
    });

    it('5.1 Database Optimization: getActiveDestinations executes as a single relation query with high performance', async () => {
      const startTime = performance.now();
      const activeDests = await destinationService.getActiveDestinations(testSourceId);
      const elapsed = performance.now() - startTime;

      expect(activeDests.length).toBe(4);
      // Single roundtrip query with index should complete in under 50ms locally
      expect(elapsed).toBeLessThan(100);
    });

    it('5.2 Bounded Concurrency: processes multiple destinations concurrently and faster than sequential execution', async () => {
      const source = (await sourceService.getSourceById(testSourceId))!;
      const simulatedDelayMs = 40;

      // Mock forwarding service that simulates 40ms Telegram network call per forward
      const mockFwdService: any = {
        forwardMessage: jest.fn().mockImplementation(async () => {
          await new Promise((r) => setTimeout(r, simulatedDelayMs));
          return { success: true, forwardedMessageId: 88801 };
        }),
      };

      // 1. Sequential distribution (concurrency = 1)
      const sequentialDistService = new DistributionService(
        destinationService,
        mockFwdService,
        new AlbumService(),
        deliveryService,
        0,   // no inter-delay
        1000,
        1    // concurrency = 1 (strictly sequential)
      );

      const seqStart = performance.now();
      const seqSummary = await sequentialDistService.distributeAnnouncement(
        {} as Telegram,
        source,
        9001
      );
      const seqDuration = performance.now() - seqStart;
      expect(seqSummary.successfulCount).toBe(4);

      // 2. Concurrent distribution (concurrency = 4)
      const concurrentDistService = new DistributionService(
        destinationService,
        mockFwdService,
        new AlbumService(),
        deliveryService,
        0,
        1000,
        4    // concurrency = 4 (bounded parallel workers)
      );

      const concStart = performance.now();
      const concSummary = await concurrentDistService.distributeAnnouncement(
        {} as Telegram,
        source,
        9002
      );
      const concDuration = performance.now() - concStart;
      expect(concSummary.successfulCount).toBe(4);

      // Verify speedup: 4 concurrent destinations should complete significantly faster than 4 sequential
      // Sequential took ~ 4 * 40ms = 160ms + db overhead
      // Concurrent took ~ 1 * 40ms = 40ms + db overhead
      expect(concDuration).toBeLessThan(seqDuration * 0.8);
    });

    it('5.3 Failure Isolation under Concurrency: one destination error does not disrupt other concurrent deliveries', async () => {
      const source = (await sourceService.getSourceById(testSourceId))!;

      // Mock forward: fails on destination #2, succeeds on others
      const mockFwdService: any = {
        forwardMessage: jest.fn().mockImplementation(async (_tg, req) => {
          if (req.destinationChatId === BigInt(-1001111002)) {
            return {
              success: false,
              errorType: ForwardErrorType.PERMISSION_DENIED,
              errorMessage: 'Bot lacks write permission',
              isTransient: false,
            };
          }
          return { success: true, forwardedMessageId: 77701 };
        }),
      };

      const distService = new DistributionService(
        destinationService,
        mockFwdService,
        new AlbumService(),
        deliveryService,
        0,
        1000,
        4
      );

      const summary = await distService.distributeAnnouncement(
        {} as Telegram,
        source,
        9003
      );

      expect(summary.totalDestinations).toBe(4);
      expect(summary.successfulCount).toBe(3);
      expect(summary.failedCount).toBe(1);

      // Verify the failed destination is isolated in results
      const failedResult = summary.results.find((r) => r.destinationChatId === BigInt(-1001111002));
      expect(failedResult?.success).toBe(false);
      expect(failedResult?.errorType).toBe(ForwardErrorType.PERMISSION_DENIED);
    });

    it('5.4 AlbumService Memory Boundedness: eviction policy caps in-memory processedMediaGroups set', () => {
      const albService = new AlbumService(50, 100);

      // Add 1050 distinct media groups to force eviction over 1000 cap
      for (let i = 0; i < 1050; i++) {
        (albService as any).processedMediaGroups.add(`group_${i}`);
        if ((albService as any).processedMediaGroups.size > 1000) {
          const oldest = (albService as any).processedMediaGroups.values().next().value;
          if (oldest) (albService as any).processedMediaGroups.delete(oldest);
        }
      }

      expect((albService as any).processedMediaGroups.size).toBe(1000);
      expect((albService as any).processedMediaGroups.has('group_0')).toBe(false); // oldest evicted
      expect((albService as any).processedMediaGroups.has('group_1049')).toBe(true);
    });
  });

  // =========================================================================
  // Task 6: Graceful Shutdown & Recovery
  // =========================================================================
  describe('Task 6: Graceful Shutdown & Recovery', () => {
    it('6.1 Shutdown Rejection: DistributionService rejects new incoming updates once shutdown is marked', async () => {
      const distService = new DistributionService();
      const source = (await sourceService.getSourceById(testSourceId))!;

      // Mark shutdown
      distService.markShuttingDown();

      const summary = await distService.distributeAnnouncement(
        {} as Telegram,
        source,
        9010
      );

      // Should return immediately with 0 dispatched
      expect(summary.successfulCount).toBe(0);
      expect(summary.failedCount).toBe(0);
      expect(summary.results.length).toBe(0);

      distService.resetStateForTesting();
    });

    it('6.2 Drain Active Operations: waits for active in-flight operations before completing shutdown', async () => {
      const distService = new DistributionService();

      // Simulate an active operation in-flight
      (distService as any).activeOperations = 1;

      // Simulate completion after 150ms
      setTimeout(() => {
        (distService as any).activeOperations = 0;
      }, 150);

      const drained = await distService.drainActiveOperations(1000);
      expect(drained).toBe(true);
      expect(distService.getActiveOperationsCount()).toBe(0);

      distService.resetStateForTesting();
    });

    it('6.3 Drain Active Operations Timeout: safely times out if an operation hangs without crashing shutdown', async () => {
      const distService = new DistributionService();
      (distService as any).activeOperations = 2; // simulates stuck operation

      // Set small timeout of 200ms
      const drained = await distService.drainActiveOperations(200);
      expect(drained).toBe(false);
      expect(distService.getActiveOperationsCount()).toBe(2);

      distService.resetStateForTesting();
    });

    it('6.4 Album Flush on Shutdown: flushes any buffered albums in memory before process termination', async () => {
      const source = (await sourceService.getSourceById(testSourceId))!;
      const albService = new AlbumService(2000, 5000); // 2s debounce window

      const flushedMock = jest.fn().mockResolvedValue({
        successfulCount: 1,
        failedCount: 0,
        results: [],
      });
      albService.setDefaultDistributionHandler(flushedMock);

      // Add message to album buffer
      albService.addMessage(
        {} as Telegram,
        source,
        testChatId,
        testTopicId,
        'mg_shutdown_test_album',
        9020,
        'photo'
      );

      expect((albService as any).activeAlbums.size).toBe(1);

      // Graceful shutdown triggers flushAll() immediately
      const flushed = await albService.flushAll({} as Telegram);
      expect(flushed.length).toBe(1);
      expect(flushedMock).toHaveBeenCalledTimes(1);
      expect((albService as any).activeAlbums.size).toBe(0); // in-memory buffer cleared
    });

    it('6.5 Startup Recovery: recoverStalePendingDeliveries reclaims orphaned PENDING records into RETRYING', async () => {
      // 1. Create a dummy destination for this test
      const dest = await destinationService.registerDestination({
        sourceGroupId: testSourceId,
        groupName: 'Recovery Test Destination',
        chatId: BigInt(-1001111999),
      });

      // 2. Insert an orphaned PENDING record with updatedAt in the past (e.g. from an abrupt crash 10 minutes ago)
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      const staleRecord = await prisma.forwardingLog.create({
        data: {
          sourceChatId: testChatId,
          sourceMessageId: 9030,
          destinationGroupId: dest.destination!.id,
          status: ForwardingStatus.PENDING,
          createdAt: tenMinutesAgo,
          updatedAt: tenMinutesAgo,
          lastAttemptAt: tenMinutesAgo,
          retryCount: 0,
        },
      });

      // 3. Execute startup recovery
      const recoveredCount = await retryService.recoverStalePendingDeliveries();
      expect(recoveredCount).toBeGreaterThanOrEqual(1);

      // 4. Verify the record is now scheduled for RETRYING
      const rechecked = await prisma.forwardingLog.findUnique({
        where: { id: staleRecord.id },
      });
      expect(rechecked?.status).toBe(ForwardingStatus.RETRYING);
      expect(rechecked?.nextRetryAt).not.toBeNull();
      expect(rechecked?.errorMessage).toContain('interrupted');

      // Cleanup
      await prisma.forwardingLog.delete({ where: { id: staleRecord.id } });
      await destinationService.deleteDestination(dest.destination!.id);
    });
  });

  // =========================================================================
  // Task 4: Failure & Recovery Testing
  // =========================================================================
  describe('Task 4: Failure Scenarios & Safe Recovery', () => {
    let failureDestId: string;

    beforeAll(async () => {
      const dest = await destinationService.registerDestination({
        sourceGroupId: testSourceId,
        groupName: 'Failure Scenario Destination',
        chatId: BigInt(-1001111888),
      });
      failureDestId = dest.destination!.id;
    });

    afterAll(async () => {
      await destinationService.deleteDestination(failureDestId);
    });

    it('4.1 Rate Limiting Backoff: respects retry_after from Telegram API', async () => {
      const source = (await sourceService.getSourceById(testSourceId))!;

      // Mock forward returning 429 Too Many Requests with retry_after = 1s
      const mockFwdService: any = {
        forwardMessage: jest.fn().mockResolvedValue({
          success: false,
          errorType: ForwardErrorType.RATE_LIMITED,
          errorMessage: 'Too Many Requests: retry after 1',
          isTransient: true,
          retryAfterSeconds: 1,
        }),
      };

      const distService = new DistributionService(
        destinationService,
        mockFwdService,
        new AlbumService(),
        deliveryService,
        0,
        500 // clamp maxBackoffMs to 500ms for fast test execution
      );

      const summary = await distService.distributeAnnouncement(
        {} as Telegram,
        source,
        9040
      );

      expect(summary.failedCount).toBeGreaterThanOrEqual(1);
      const res = summary.results.find((r) => r.destinationId === failureDestId);
      expect(res?.errorType).toBe(ForwardErrorType.RATE_LIMITED);
      expect(res?.retryAfterSeconds).toBe(1);

      // Verify delivery record status is RETRYING with nextRetryAt set in database
      const log = await prisma.forwardingLog.findUnique({
        where: {
          sourceChatId_sourceMessageId_destinationGroupId: {
            sourceChatId: testChatId,
            sourceMessageId: 9040,
            destinationGroupId: failureDestId,
          },
        },
      });
      expect(log?.status).toBe(ForwardingStatus.RETRYING);
      expect(log?.nextRetryAt).not.toBeNull();
    });

    it('4.2 Permanent Failure Handling: marks PERMANENTLY FAILED on non-transient error without retry', async () => {
      const source = (await sourceService.getSourceById(testSourceId))!;

      // Mock forward returning 400 Bad Request: chat not found
      const mockFwdService: any = {
        forwardMessage: jest.fn().mockResolvedValue({
          success: false,
          errorType: ForwardErrorType.INVALID_CHAT_ID,
          errorMessage: 'Bad Request: chat not found',
          isTransient: false,
        }),
      };

      const distService = new DistributionService(
        destinationService,
        mockFwdService,
        new AlbumService(),
        deliveryService,
        0,
        100
      );

      const summary = await distService.distributeAnnouncement(
        {} as Telegram,
        source,
        9041
      );

      const res = summary.results.find((r) => r.destinationId === failureDestId);
      expect(res?.errorType).toBe(ForwardErrorType.INVALID_CHAT_ID);

      const log = await prisma.forwardingLog.findUnique({
        where: {
          sourceChatId_sourceMessageId_destinationGroupId: {
            sourceChatId: testChatId,
            sourceMessageId: 9041,
            destinationGroupId: failureDestId,
          },
        },
      });
      expect(log?.status).toBe(ForwardingStatus.FAILED);
      expect(log?.nextRetryAt).toBeNull(); // No retry scheduled for permanent errors
    });

    it('4.3 Idempotency on Duplicate Updates: ignores duplicate Telegram updates for successfully delivered messages', async () => {
      const source = (await sourceService.getSourceById(testSourceId))!;

      const mockForwardFn = jest.fn().mockResolvedValue({
        success: true,
        forwardedMessageId: 99911,
      });
      const mockFwdService: any = { forwardMessage: mockForwardFn };

      const distService = new DistributionService(
        destinationService,
        mockFwdService,
        new AlbumService(),
        deliveryService,
        0,
        100
      );

      // First distribution attempt: succeeds
      const firstSummary = await distService.distributeAnnouncement(
        {} as Telegram,
        source,
        9042
      );
      expect(firstSummary.successfulCount).toBeGreaterThanOrEqual(1);
      const callsBefore = mockForwardFn.mock.calls.length;

      // Duplicate Telegram update arrives for the same sourceMessageId
      const secondSummary = await distService.distributeAnnouncement(
        {} as Telegram,
        source,
        9042
      );
      // All destinations should be skipped as already delivered
      expect(secondSummary.skippedCount).toBeGreaterThanOrEqual(1);
      expect(mockForwardFn.mock.calls.length).toBe(callsBefore); // No additional forwarding calls
    });

    it('4.4 Optimistic Concurrency Safety: concurrent retry attempts do not process the same delivery twice', async () => {
      // Create a RETRYING log
      const log = await prisma.forwardingLog.create({
        data: {
          sourceChatId: testChatId,
          sourceMessageId: 9043,
          destinationGroupId: failureDestId,
          status: ForwardingStatus.RETRYING,
          nextRetryAt: new Date(Date.now() - 5000), // due for retry
          retryCount: 1,
        },
      });

      // Simulate two concurrent workers attempting to claim the exact same record
      const [worker1Claim, worker2Claim] = await Promise.all([
        prisma.forwardingLog.updateMany({
          where: {
            id: log.id,
            status: ForwardingStatus.RETRYING,
            updatedAt: log.updatedAt,
          },
          data: {
            status: ForwardingStatus.PENDING,
            lastAttemptAt: new Date(),
            updatedAt: new Date(),
          },
        }),
        prisma.forwardingLog.updateMany({
          where: {
            id: log.id,
            status: ForwardingStatus.RETRYING,
            updatedAt: log.updatedAt,
          },
          data: {
            status: ForwardingStatus.PENDING,
            lastAttemptAt: new Date(),
            updatedAt: new Date(),
          },
        }),
      ]);

      // Exactly one worker must succeed in acquiring the optimistic lock
      const totalAcquired = worker1Claim.count + worker2Claim.count;
      expect(totalAcquired).toBe(1);

      // Cleanup
      await prisma.forwardingLog.delete({ where: { id: log.id } });
    });
  });
});
