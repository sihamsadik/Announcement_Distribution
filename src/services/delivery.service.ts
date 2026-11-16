import { ForwardingStatus, ForwardingLog } from '@prisma/client';
import { prisma } from '../db/prisma';

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
   * Idempotency guarantee:
   * 1. If a record already exists with status SUCCESS, returns canDeliver = false.
   * 2. If a record exists with status PENDING and was recently updated (< stale threshold),
   *    returns canDeliver = false (concurrent delivery in flight).
   * 3. If a record exists with status FAILED or stale PENDING, transitions to PENDING and returns canDeliver = true.
   * 4. If no record exists, inserts PENDING. Catches PostgreSQL unique constraint violation (P2002)
   *    if a concurrent worker inserted simultaneously, and resolves safely.
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
        updatedAt: new Date(),
      },
      create: {
        sourceChatId: bigSourceChatId,
        sourceMessageId,
        destinationGroupId,
        status: ForwardingStatus.SUCCESS,
      },
    });
  }

  /**
   * Marks a delivery attempt as FAILED with an error description.
   */
  async markFailure(
    sourceChatId: bigint | number | string,
    sourceMessageId: number,
    destinationGroupId: string,
    errorMessage: string
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
        status: ForwardingStatus.FAILED,
        errorMessage: errorMessage.substring(0, 1000), // bounded error length
        updatedAt: new Date(),
      },
      create: {
        sourceChatId: bigSourceChatId,
        sourceMessageId,
        destinationGroupId,
        status: ForwardingStatus.FAILED,
        errorMessage: errorMessage.substring(0, 1000),
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

    // Check if any album item is currently PENDING by an active concurrent worker
    const activePending = existingLogs.find(
      (l) => l.status === ForwardingStatus.PENDING && (Date.now() - l.updatedAt.getTime()) < this.stalePendingThresholdMs
    );

    if (activePending) {
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
            updatedAt: new Date(),
          },
          create: {
            sourceChatId: bigSourceChatId,
            sourceMessageId: msgId,
            destinationGroupId,
            status: ForwardingStatus.PENDING,
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
   * Marks all items in a media album as FAILED with error message.
   */
  async markAlbumFailure(
    sourceChatId: bigint | number | string,
    messageIds: number[],
    destinationGroupId: string,
    errorMessage: string
  ): Promise<void> {
    for (const msgId of messageIds) {
      await this.markFailure(sourceChatId, msgId, destinationGroupId, errorMessage);
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
