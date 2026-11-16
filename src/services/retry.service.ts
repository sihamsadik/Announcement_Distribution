import { Telegram } from 'telegraf';
import { ForwardingStatus, ForwardingLog } from '@prisma/client';
import { prisma } from '../db/prisma';
import { forwardingService, ForwardingService, isTransientError } from './forwarding.service';
import { loadRetryConfig, RetryConfig } from '../config/env';
import { sanitizeError } from '../utils/sanitize';

export interface RetryProcessResult {
  processed: number;
  succeeded: number;
  retrying: number;
  permanentlyFailed: number;
}

/**
 * Calculates exponential backoff delay with upper bound and Telegram retry_after consideration.
 *
 * Formula: delay = Math.min(Math.max(initialDelay * 2^retryCount, retryAfterSeconds), maxDelay)
 */
export function calculateNextRetryDelay(
  retryCount: number,
  retryAfterSeconds?: number,
  initialDelaySeconds = 5,
  maxDelaySeconds = 300
): number {
  let delaySec = initialDelaySeconds * Math.pow(2, retryCount);

  if (retryAfterSeconds && retryAfterSeconds > 0) {
    delaySec = Math.max(delaySec, retryAfterSeconds);
  }

  delaySec = Math.min(delaySec, maxDelaySeconds);
  return Math.round(delaySec * 1000);
}

/**
 * Service managing automated retries, failure classification, and crash recovery.
 *
 * Relies on PostgreSQL as the persistent source of truth.
 * Ensures concurrent retry operations cannot process the same delivery record.
 */
export class RetryService {
  private readonly config: RetryConfig;
  private pollTimer?: NodeJS.Timeout;

  constructor(
    config: Partial<RetryConfig> = {},
    private readonly fwdService: ForwardingService = forwardingService
  ) {
    const envConfig = loadRetryConfig();
    this.config = {
      maxRetryCount: config.maxRetryCount !== undefined ? config.maxRetryCount : envConfig.maxRetryCount,
      initialRetryDelaySeconds: config.initialRetryDelaySeconds !== undefined ? config.initialRetryDelaySeconds : envConfig.initialRetryDelaySeconds,
      maxRetryDelaySeconds: config.maxRetryDelaySeconds !== undefined ? config.maxRetryDelaySeconds : envConfig.maxRetryDelaySeconds,
      retryPollIntervalMs: config.retryPollIntervalMs !== undefined ? config.retryPollIntervalMs : envConfig.retryPollIntervalMs,
    };
  }

  get maxRetries(): number {
    return this.config.maxRetryCount;
  }

  get initialDelaySeconds(): number {
    return this.config.initialRetryDelaySeconds;
  }

  get maxDelaySeconds(): number {
    return this.config.maxRetryDelaySeconds;
  }

  /**
   * Processes all currently eligible retries in PostgreSQL whose nextRetryAt has arrived.
   *
   * Uses optimistic locking (updateMany with status and updatedAt check) to guarantee
   * that multiple concurrent workers or interval ticks never process the same record.
   */
  async processRetries(telegram: Telegram, token?: string): Promise<RetryProcessResult> {
    const now = new Date();

    // 1. Find eligible records scheduled for retry
    const eligibleRecords = await prisma.forwardingLog.findMany({
      where: {
        status: ForwardingStatus.RETRYING,
        nextRetryAt: { lte: now },
        retryCount: { lt: this.config.maxRetryCount },
      },
      include: {
        destinationGroup: true,
      },
      orderBy: {
        nextRetryAt: 'asc',
      },
      take: 50, // bounded batch size
    });

    const result: RetryProcessResult = {
      processed: eligibleRecords.length,
      succeeded: 0,
      retrying: 0,
      permanentlyFailed: 0,
    };

    if (eligibleRecords.length === 0) {
      return result;
    }

    console.log(`[RetryService] 🔄 Processing ${eligibleRecords.length} eligible retry deliveries...`);

    for (const record of eligibleRecords) {
      try {
        // 2. Concurrency Safety: Atomically acquire lock on this record
        const lock = await prisma.forwardingLog.updateMany({
          where: {
            id: record.id,
            status: ForwardingStatus.RETRYING,
            updatedAt: record.updatedAt,
          },
          data: {
            status: ForwardingStatus.PENDING,
            lastAttemptAt: new Date(),
            updatedAt: new Date(),
          },
        });

        if (lock.count === 0) {
          // Another worker claimed this record concurrently; skip safely
          continue;
        }

        // 3. Skip if destination group is no longer active
        if (!record.destinationGroup.isActive) {
          console.log(
            `[RetryService] Destination "${record.destinationGroup.groupName}" is inactive. Marking as FAILED.`
          );
          await prisma.forwardingLog.update({
            where: { id: record.id },
            data: {
              status: ForwardingStatus.FAILED,
              nextRetryAt: null,
              errorMessage: 'Destination group is inactive.',
              updatedAt: new Date(),
            },
          });
          result.permanentlyFailed++;
          continue;
        }

        // 4. Attempt re-forwarding
        const forwardResult = await this.fwdService.forwardMessage(
          telegram,
          {
            sourceChatId: record.sourceChatId,
            sourceMessageId: record.sourceMessageId,
            destinationChatId: record.destinationGroup.chatId,
          },
          token
        );

        if (forwardResult.success) {
          // Success! Update to terminal SUCCESS
          await prisma.forwardingLog.update({
            where: { id: record.id },
            data: {
              status: ForwardingStatus.SUCCESS,
              errorMessage: null,
              nextRetryAt: null,
              updatedAt: new Date(),
            },
          });
          console.log(
            `[RetryService] ✅ Retry SUCCEEDED for message #${record.sourceMessageId} ` +
            `to destination "${record.destinationGroup.groupName}" (Attempt ${record.retryCount + 1}).`
          );
          result.succeeded++;
        } else {
          const nextAttemptCount = record.retryCount + 1;
          const isTransient = forwardResult.isTransient ?? (forwardResult.errorType ? isTransientError(forwardResult.errorType) : false);

          if (isTransient && nextAttemptCount < this.config.maxRetryCount) {
            // Schedule another retry with exponential backoff
            const delayMs = calculateNextRetryDelay(
              nextAttemptCount,
              forwardResult.retryAfterSeconds,
              this.config.initialRetryDelaySeconds,
              this.config.maxRetryDelaySeconds
            );

            await prisma.forwardingLog.update({
              where: { id: record.id },
              data: {
                status: ForwardingStatus.RETRYING,
                retryCount: nextAttemptCount,
                nextRetryAt: new Date(Date.now() + delayMs),
                errorMessage: forwardResult.errorMessage || 'Transient delivery error',
                updatedAt: new Date(),
              },
            });
            console.log(
              `[RetryService] ⏳ Retry ${nextAttemptCount}/${this.config.maxRetryCount} failed transiently for ` +
              `message #${record.sourceMessageId}. Next retry in ${Math.round(delayMs / 1000)}s.`
            );
            result.retrying++;
          } else {
            // Permanent failure or maximum retries exhausted
            const terminalReason = !isTransient
              ? `Permanent failure: ${forwardResult.errorMessage}`
              : `Exhausted maximum retries (${this.config.maxRetryCount}): ${forwardResult.errorMessage}`;

            await prisma.forwardingLog.update({
              where: { id: record.id },
              data: {
                status: ForwardingStatus.FAILED,
                retryCount: nextAttemptCount,
                nextRetryAt: null,
                errorMessage: terminalReason,
                updatedAt: new Date(),
              },
            });
            console.warn(
              `[RetryService] ❌ Delivery PERMANENTLY FAILED for message #${record.sourceMessageId} ` +
              `to destination "${record.destinationGroup.groupName}". Reason: ${terminalReason}`
            );
            result.permanentlyFailed++;
          }
        }
      } catch (err) {
        const sanitized = sanitizeError(err, token);
        console.error(`[RetryService Error] Unexpected error processing retry for record ${record.id}: ${sanitized}`);
        await prisma.forwardingLog.update({
          where: { id: record.id },
          data: {
            status: ForwardingStatus.RETRYING,
            errorMessage: sanitized,
            updatedAt: new Date(),
          },
        }).catch(() => {});
        result.retrying++;
      }
    }

    return result;
  }

  /**
   * Recovers stale PENDING deliveries after an application restart or crash.
   *
   * Deliveries stuck in PENDING longer than staleThresholdMs were interrupted in-flight
   * before they could record SUCCESS or schedule RETRYING.
   *
   * Transitions eligible records to RETRYING with nextRetryAt = now (eligible immediately),
   * or marks them FAILED if max retries were already exhausted.
   */
  async recoverStalePendingDeliveries(staleThresholdMs = 60000): Promise<number> {
    const thresholdDate = new Date(Date.now() - staleThresholdMs);

    const staleRecords = await prisma.forwardingLog.findMany({
      where: {
        status: ForwardingStatus.PENDING,
        updatedAt: { lte: thresholdDate },
      },
    });

    if (staleRecords.length === 0) {
      return 0;
    }

    console.log(`[RetryService] 🔄 Recovering ${staleRecords.length} stale PENDING records from prior application run...`);

    let recoveredCount = 0;
    for (const record of staleRecords) {
      if (record.retryCount < this.config.maxRetryCount) {
        await prisma.forwardingLog.update({
          where: { id: record.id },
          data: {
            status: ForwardingStatus.RETRYING,
            nextRetryAt: new Date(), // eligible immediately
            errorMessage: 'Recovered from interrupted application run.',
            updatedAt: new Date(),
          },
        });
        recoveredCount++;
      } else {
        await prisma.forwardingLog.update({
          where: { id: record.id },
          data: {
            status: ForwardingStatus.FAILED,
            nextRetryAt: null,
            errorMessage: 'Interrupted delivery exceeded max retry count.',
            updatedAt: new Date(),
          },
        });
      }
    }

    console.log(`[RetryService] ✅ Successfully recovered ${recoveredCount} records for retry.`);
    return recoveredCount;
  }

  /**
   * Starts periodic polling for scheduled retries.
   */
  startPolling(telegram: Telegram, token?: string, intervalMs = this.config.retryPollIntervalMs): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }

    console.log(`[RetryService] ⏱️ Starting retry background polling (Interval: ${intervalMs}ms)...`);
    this.pollTimer = setInterval(async () => {
      try {
        await this.processRetries(telegram, token);
      } catch (err) {
        console.error('[RetryService] Error during retry polling tick:', sanitizeError(err, token));
      }
    }, intervalMs);

    // Run crash recovery immediately on startup
    this.recoverStalePendingDeliveries().catch((err) => {
      console.error('[RetryService] Error during startup recovery:', sanitizeError(err, token));
    });
  }

  /**
   * Stops periodic polling (useful for clean shutdown and tests).
   */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }
}

export const retryService = new RetryService();
