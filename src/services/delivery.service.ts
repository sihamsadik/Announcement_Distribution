import { ForwardingStatus, ForwardingLog } from '@prisma/client';
import { prisma } from '../db/prisma';
import { calculateNextRetryDelay } from './retry.service';

export interface ClaimResult {
  canDeliver: boolean;
  reason?: 'ALREADY_DELIVERED' | 'ALREADY_PENDING';
  logId?: string;
  isRetry?: boolean;
  existingLog?: ForwardingLog;
}

export interface ClaimAlbumResult {
  canDeliver: boolean;
  reason?: 'ALREADY_DELIVERED' | 'ALREADY_PENDING';
  claimedMessageIds: number[];
  skippedMessageIds: number[];
}

export class DeliveryService {
  private readonly stalePendingThresholdMs: number;

  constructor(stalePendingThresholdMs = 60000) {
    this.stalePendingThresholdMs = stalePendingThresholdMs;
  }

  /**
   * Checks whether a message has already been successfully delivered to a destination.
   */
  async isAlreadyDelivered(
    sourceChatId: bigint | number | string,
    sourceMessageId: number,
    destinationGroupId: string
  ): Promise<boolean> {
    const bigSourceChatId = BigInt(sourceChatId);
    const existing = await prisma.forwardingLog.findUnique({
      where: {
        sourceChatId_sourceMessageId_destinationGroupId: {
          sourceChatId: bigSourceChatId,
          sourceMessageId,
          destinationGroupId,
        },
      },
    });

    return existing?.status === ForwardingStatus.SUCCESS;
  }

  /**
   * Atomically claims delivery for a source message to a destination group.
   *
   * Idempotency & Lifecycle rules:
   * 1. If status === SUCCESS: returns canDeliver = false (ALREADY_DELIVERED).
   * 2. If status === RETRYING:
   *    - If nextRetryAt > now: returns canDeliver = false (waiting for backoff delay).
   *    - If nextRetryAt <= now: claims as PENDING and returns canDeliver = true (scheduled retry arrived).
   * 3. If status === PENDING:
   *    - If updated recently (< stale threshold): returns canDeliver = false (ALREADY_PENDING).
   *    - If stale (>= stale threshold): reclaims as PENDING (crash recovery).
   * 4. If status === FAILED: reclaims as PENDING (allows manual retry).
   * 5. If no record: creates PENDING. Catches PostgreSQL unique constraint (P2002) for concurrency.
   */
  async claimDelivery(
    sourceChatId: bigint | number | string,
    sourceMessageId: number,
    destinationGroupId: string
  ): Promise<ClaimResult> {
    const bigSourceChatId = BigInt(sourceChatId);

    try {
      // 1. Check existing record
      const existing = await prisma.forwardingLog.findUnique({
        where: {
          sourceChatId_sourceMessageId_destinationGroupId: {
            sourceChatId: bigSourceChatId,
            sourceMessageId,
            destinationGroupId,
          },
        },
      });

      if (existing) {
        if (existing.status === ForwardingStatus.SUCCESS) {
          return { canDeliver: false, reason: 'ALREADY_DELIVERED', existingLog: existing };
        }

        if (existing.status === ForwardingStatus.RETRYING) {
          const now = new Date();
          if (existing.nextRetryAt && existing.nextRetryAt > now) {
            // Still waiting for backoff window
            return { canDeliver: false, reason: 'ALREADY_PENDING', existingLog: existing };
          }

          // Retry time has arrived: claim as PENDING
          console.log(
            `[DeliveryService] Claiming scheduled RETRYING delivery (${existing.id}) for message #${sourceMessageId} ` +
            `to destination ${destinationGroupId} (Attempt ${existing.retryCount + 1}).`
          );
          const updated = await prisma.forwardingLog.update({
            where: { id: existing.id },
            data: {
              status: ForwardingStatus.PENDING,
              lastAttemptAt: new Date(),
              updatedAt: new Date(),
            },
          });
          return { canDeliver: true, logId: updated.id, isRetry: true };
        }

        if (existing.status === ForwardingStatus.PENDING) {
          const elapsed = Date.now() - existing.updatedAt.getTime();
          if (elapsed < this.stalePendingThresholdMs) {
            // Active delivery in-flight by another concurrent worker
            return { canDeliver: false, reason: 'ALREADY_PENDING', existingLog: existing };
          }

          // Stale pending from a previous crashed process: reclaim it
          console.warn(
            `[DeliveryService] ⚠️ Reclaiming stale PENDING record (${existing.id}) for message #${sourceMessageId} ` +
            `to destination ${destinationGroupId} (last active ${Math.round(elapsed / 1000)}s ago).`
          );
          const updated = await prisma.forwardingLog.update({
            where: { id: existing.id },
            data: {
              status: ForwardingStatus.PENDING,
              errorMessage: null,
              lastAttemptAt: new Date(),
              updatedAt: new Date(),
            },
          });
          return { canDeliver: true, logId: updated.id, isRetry: true };
        }

        if (existing.status === ForwardingStatus.FAILED) {
          // Retry failed delivery
          console.log(
            `[DeliveryService] Re-attempting previously FAILED delivery (${existing.id}) for message #${sourceMessageId} ` +
            `to destination ${destinationGroupId}.`
          );
          const updated = await prisma.forwardingLog.update({
            where: { id: existing.id },
            data: {
              status: ForwardingStatus.PENDING,
              errorMessage: null,
              lastAttemptAt: new Date(),
              updatedAt: new Date(),
            },
          });
          return { canDeliver: true, logId: updated.id, isRetry: true };
        }
      }

      // 2. No record exists: create new PENDING record
      const created = await prisma.forwardingLog.create({
        data: {
          sourceChatId: bigSourceChatId,
          sourceMessageId,
          destinationGroupId,
          status: ForwardingStatus.PENDING,
          lastAttemptAt: new Date(),
        },
      });

      return { canDeliver: true, logId: created.id, isRetry: false };
    } catch (err: any) {
      // Prisma P2002: unique constraint violation on (sourceChatId, sourceMessageId, destinationGroupId)
      if (err.code === 'P2002') {
        console.warn(
          `[DeliveryService] Race condition handled: Unique constraint violation on message #${sourceMessageId} ` +
          `to destination ${destinationGroupId}. Resolving existing record...`
        );
        const concurrent = await prisma.forwardingLog.findUnique({
          where: {
            sourceChatId_sourceMessageId_destinationGroupId: {
              sourceChatId: bigSourceChatId,
              sourceMessageId,
              destinationGroupId,
            },
          },
        });

        if (concurrent?.status === ForwardingStatus.SUCCESS) {
          return { canDeliver: false, reason: 'ALREADY_DELIVERED', existingLog: concurrent };
        }

        return { canDeliver: false, reason: 'ALREADY_PENDING', existingLog: concurrent || undefined };
      }

      throw err;
    }
  }

  /**
   * Marks a delivery attempt as SUCCESS.
   */
  async markSuccess(
    sourceChatId: bigint | number | string,
    sourceMessageId: number,
    destinationGroupId: string
  ): Promise<ForwardingLog> {
    const bigSourceChatId = BigInt(sourceChatId);

    return await prisma.forwardingLog.upsert({
      where: {
        sourceChatId_sourceMessageId_destinationGroupId: {
          sourceChatId: bigSourceChatId,
          sourceMessageId,
          destinationGroupId,
        },
      },
      update: {
        status: ForwardingStatus.SUCCESS,
        errorMessage: null,
        nextRetryAt: null,
        lastAttemptAt: new Date(),
        updatedAt: new Date(),
      },
      create: {
        sourceChatId: bigSourceChatId,
        sourceMessageId,
        destinationGroupId,
        status: ForwardingStatus.SUCCESS,
        lastAttemptAt: new Date(),
      },
    });
  }

  /**
   * Handles delivery failure:
   * If error is transient and retryCount < maxRetries -> transitions to RETRYING with exponential backoff.
   * If error is permanent or retryCount >= maxRetries -> transitions to FAILED (terminal).
   */
  async markFailure(
    sourceChatId: bigint | number | string,
    sourceMessageId: number,
    destinationGroupId: string,
    errorMessage: string,
    isTransient = false,
    retryAfterSeconds?: number,
    maxRetries = 3
  ): Promise<ForwardingLog> {
    const bigSourceChatId = BigInt(sourceChatId);

    const existing = await prisma.forwardingLog.findUnique({
      where: {
        sourceChatId_sourceMessageId_destinationGroupId: {
          sourceChatId: bigSourceChatId,
          sourceMessageId,
          destinationGroupId,
        },
      },
    });

    const currentRetryCount = existing ? existing.retryCount : 0;
    const nextAttemptCount = currentRetryCount + 1;

    let targetStatus: ForwardingStatus;
    let nextRetryAt: Date | null = null;

    if (isTransient && nextAttemptCount < maxRetries) {
      targetStatus = ForwardingStatus.RETRYING;
      const delayMs = calculateNextRetryDelay(nextAttemptCount, retryAfterSeconds);
      nextRetryAt = new Date(Date.now() + delayMs);
      console.log(
        `[DeliveryService] Scheduling transient retry (${nextAttemptCount}/${maxRetries}) for message #${sourceMessageId} ` +
        `to destination ${destinationGroupId}. Next retry in ${Math.round(delayMs / 1000)}s.`
      );
    } else {
      targetStatus = ForwardingStatus.FAILED;
      nextRetryAt = null;
      console.warn(
        `[DeliveryService] Delivery marked FAILED for message #${sourceMessageId} to destination ${destinationGroupId}. ` +
        `Transient: ${isTransient}, Attempts: ${nextAttemptCount}/${maxRetries}`
      );
    }

    return await prisma.forwardingLog.upsert({
      where: {
        sourceChatId_sourceMessageId_destinationGroupId: {
          sourceChatId: bigSourceChatId,
          sourceMessageId,
          destinationGroupId,
        },
      },
      update: {
        status: targetStatus,
        retryCount: nextAttemptCount,
        nextRetryAt,
        errorMessage: errorMessage.substring(0, 1000),
        lastAttemptAt: new Date(),
        updatedAt: new Date(),
      },
      create: {
        sourceChatId: bigSourceChatId,
        sourceMessageId,
        destinationGroupId,
        status: targetStatus,
        retryCount: nextAttemptCount,
        nextRetryAt,
        errorMessage: errorMessage.substring(0, 1000),
        lastAttemptAt: new Date(),
      },
    });
  }

  /**
   * Atomically claims an entire media album for delivery.
   * Ensures that all message IDs in the album are checked and marked as PENDING.
   */
  async claimAlbumDelivery(
    sourceChatId: bigint | number | string,
    messageIds: number[],
    destinationGroupId: string
  ): Promise<ClaimAlbumResult> {
    const bigSourceChatId = BigInt(sourceChatId);
    const existingLogs = await prisma.forwardingLog.findMany({
      where: {
        sourceChatId: bigSourceChatId,
        destinationGroupId,
        sourceMessageId: { in: messageIds },
      },
    });

    const successCount = existingLogs.filter((l) => l.status === ForwardingStatus.SUCCESS).length;

    // If ALL album items were already successfully delivered, skip the album
    if (successCount === messageIds.length && messageIds.length > 0) {
      return {
        canDeliver: false,
        reason: 'ALREADY_DELIVERED',
        claimedMessageIds: [],
        skippedMessageIds: messageIds,
      };
    }

    // Check if any album item is currently PENDING or RETRYING (and backoff has not expired)
    const now = new Date();
    const activePendingOrRetrying = existingLogs.find((l) => {
      if (l.status === ForwardingStatus.PENDING) {
        return (Date.now() - l.updatedAt.getTime()) < this.stalePendingThresholdMs;
      }
      if (l.status === ForwardingStatus.RETRYING) {
        return l.nextRetryAt && l.nextRetryAt > now;
      }
      return false;
    });

    if (activePendingOrRetrying) {
      return {
        canDeliver: false,
        reason: 'ALREADY_PENDING',
        claimedMessageIds: [],
        skippedMessageIds: messageIds,
      };
    }

    // Claim each message ID in the album as PENDING
    const claimedIds: number[] = [];
    for (const msgId of messageIds) {
      try {
        await prisma.forwardingLog.upsert({
          where: {
            sourceChatId_sourceMessageId_destinationGroupId: {
              sourceChatId: bigSourceChatId,
              sourceMessageId: msgId,
              destinationGroupId,
            },
          },
          update: {
            status: ForwardingStatus.PENDING,
            errorMessage: null,
            lastAttemptAt: new Date(),
            updatedAt: new Date(),
          },
          create: {
            sourceChatId: bigSourceChatId,
            sourceMessageId: msgId,
            destinationGroupId,
            status: ForwardingStatus.PENDING,
            lastAttemptAt: new Date(),
          },
        });
        claimedIds.push(msgId);
      } catch (err) {
        console.warn(`[DeliveryService] Error claiming album item #${msgId}:`, err);
      }
    }

    return {
      canDeliver: true,
      claimedMessageIds: claimedIds,
      skippedMessageIds: [],
    };
  }

  /**
   * Marks all items in a media album as SUCCESS.
   */
  async markAlbumSuccess(
    sourceChatId: bigint | number | string,
    messageIds: number[],
    destinationGroupId: string
  ): Promise<void> {
    for (const msgId of messageIds) {
      await this.markSuccess(sourceChatId, msgId, destinationGroupId);
    }
  }

  /**
   * Marks all items in a media album as FAILED or RETRYING.
   */
  async markAlbumFailure(
    sourceChatId: bigint | number | string,
    messageIds: number[],
    destinationGroupId: string,
    errorMessage: string,
    isTransient = false,
    retryAfterSeconds?: number,
    maxRetries = 3
  ): Promise<void> {
    for (const msgId of messageIds) {
      await this.markFailure(sourceChatId, msgId, destinationGroupId, errorMessage, isTransient, retryAfterSeconds, maxRetries);
    }
  }

  /**
   * Finds all stale PENDING delivery records (from previous crashed or interrupted processes).
   */
  async getStalePendingRecords(staleThresholdMs = this.stalePendingThresholdMs): Promise<ForwardingLog[]> {
    const thresholdDate = new Date(Date.now() - staleThresholdMs);
    return await prisma.forwardingLog.findMany({
      where: {
        status: ForwardingStatus.PENDING,
        updatedAt: { lte: thresholdDate },
      },
      include: {
        destinationGroup: true,
      },
    });
  }

  /**
   * Retrieves all delivery records for a given source message across all destination groups.
   */
  async getDeliveryLogsForMessage(
    sourceChatId: bigint | number | string,
    sourceMessageId: number
  ): Promise<ForwardingLog[]> {
    return await prisma.forwardingLog.findMany({
      where: {
        sourceChatId: BigInt(sourceChatId),
        sourceMessageId,
      },
      include: {
        destinationGroup: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });
  }
}

export const deliveryService = new DeliveryService();
