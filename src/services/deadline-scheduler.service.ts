import { Telegram } from 'telegraf';
import { DeadlineStatus, DeliveryStatus, ReminderType } from '@prisma/client';
import { prisma } from '../db/prisma';
import { formatDateTimeInTimezone, formatTimeRemaining } from '../utils/time';
import { classifyTelegramError } from './forwarding.service';
import { sanitizeError } from '../utils/sanitize';
import { logger } from '../utils/logger';

export interface SchedulerProcessResult {
  processed: number;
  delivered: number;
  failed: number;
  expired: number;
  skipped: number;
}

export class DeadlineSchedulerService {
  private pollTimer?: NodeJS.Timeout;
  private readonly processingIds = new Set<string>();
  private readonly gracePeriodMs: number;
  private isProcessing = false;
  private clockFn: () => Date;

  constructor(
    gracePeriodMs = 2 * 60 * 60 * 1000, // 2 hours late-delivery grace period
    clockFn: () => Date = () => new Date()
  ) {
    this.gracePeriodMs = gracePeriodMs;
    this.clockFn = clockFn;
  }

  /**
   * Sets custom clock function for testing.
   */
  setClock(clockFn: () => Date): void {
    this.clockFn = clockFn;
  }

  /**
   * Resets to system wall clock.
   */
  resetClock(): void {
    this.clockFn = () => new Date();
  }

  getNow(): Date {
    return this.clockFn();
  }

  /**
   * Processes all due deadline reminders from PostgreSQL.
   * Safe for concurrent scheduler runs and survives restarts.
   */
  async processDueReminders(telegram: Telegram, token?: string): Promise<SchedulerProcessResult> {
    if (this.isProcessing) {
      return { processed: 0, delivered: 0, failed: 0, expired: 0, skipped: 0 };
    }
    this.isProcessing = true;

    const result: SchedulerProcessResult = {
      processed: 0,
      delivered: 0,
      failed: 0,
      expired: 0,
      skipped: 0,
    };

    try {
      const now = this.getNow();

      // 1. Mark completed deadlines where dueAt has passed
      const expiredDeadlines = await prisma.deadline.findMany({
        where: {
          status: DeadlineStatus.ACTIVE,
          dueAt: { lte: now },
        },
        select: { id: true },
      });

      if (expiredDeadlines.length > 0) {
        const expiredIds = expiredDeadlines.map((d) => d.id);
        await prisma.$transaction(async (tx) => {
          await tx.deadline.updateMany({
            where: { id: { in: expiredIds } },
            data: {
              status: DeadlineStatus.COMPLETED,
              updatedAt: now,
            },
          });
          await tx.deadlineReminderDelivery.updateMany({
            where: {
              deadlineId: { in: expiredIds },
              status: DeliveryStatus.PENDING,
            },
            data: {
              status: DeliveryStatus.EXPIRED,
              errorMessage: 'Deadline has passed.',
              updatedAt: now,
            },
          });
        });
      }

      // 2. Query due pending reminders for active deadlines
      const dueDeliveries = await prisma.deadlineReminderDelivery.findMany({
        where: {
          status: DeliveryStatus.PENDING,
          scheduledFor: { lte: now },
          deadline: {
            status: DeadlineStatus.ACTIVE,
          },
        },
        include: {
          deadline: true,
          destinationGroup: true,
        },
        orderBy: { scheduledFor: 'asc' },
        take: 50,
      });

      result.processed = dueDeliveries.length;

      for (const delivery of dueDeliveries) {
        // In-memory guard to prevent concurrent execution within same process
        if (this.processingIds.has(delivery.id)) {
          result.skipped++;
          continue;
        }

        // Database optimistic lock to ensure only one worker claims this record
        const lock = await prisma.deadlineReminderDelivery.updateMany({
          where: {
            id: delivery.id,
            status: DeliveryStatus.PENDING,
            updatedAt: delivery.updatedAt,
          },
          data: {
            updatedAt: now,
          },
        });

        if (lock.count === 0) {
          result.skipped++;
          continue;
        }

        this.processingIds.add(delivery.id);

        try {
          const deadline = delivery.deadline;
          const dest = delivery.destinationGroup;

          // RULE: NEVER send any scheduled reminder after the deadline has passed
          if (now.getTime() >= deadline.dueAt.getTime()) {
            await prisma.deadlineReminderDelivery.update({
              where: { id: delivery.id },
              data: {
                status: DeliveryStatus.EXPIRED,
                errorMessage: 'Deadline has passed.',
                updatedAt: now,
              },
            });
            result.expired++;
            continue;
          }

          // Offline recovery rule: check if reminder is past late-delivery grace period
          const elapsedSinceScheduled = now.getTime() - delivery.scheduledFor.getTime();
          if (elapsedSinceScheduled > this.gracePeriodMs) {
            await prisma.deadlineReminderDelivery.update({
              where: { id: delivery.id },
              data: {
                status: DeliveryStatus.EXPIRED,
                errorMessage: `Expired: Reminder was due while bot was offline beyond grace period (${Math.round(elapsedSinceScheduled / 60000)}m ago).`,
                updatedAt: now,
              },
            });
            result.expired++;
            continue;
          }

          // Skip if destination group is inactive
          if (!dest.isActive) {
            await prisma.deadlineReminderDelivery.update({
              where: { id: delivery.id },
              data: {
                status: DeliveryStatus.FAILED,
                errorMessage: 'Destination group is inactive.',
                updatedAt: now,
              },
            });
            result.failed++;
            continue;
          }

          // Build reminder message
          const reminderLabel =
            delivery.reminderType === ReminderType.REMINDER_24_HOUR
              ? '⏰ 24-HOUR DEADLINE REMINDER'
              : '🚨 DEADLINE REMINDER';

          const remainingText = formatTimeRemaining(deadline.dueAt, now);

          const reminderText =
            `**${reminderLabel}**\n\n` +
            `📌 **Title:** ${deadline.title}\n` +
            `📋 **Instructions:**\n${deadline.description}\n\n` +
            `⏰ **Due Date & Time:**\n${formatDateTimeInTimezone(deadline.dueAt, deadline.timezone)}\n\n` +
            `⏳ **Time Remaining:** ${remainingText}\n\n` +
            `⚠️ *This is an automated reminder. Please finalize your submission before the deadline passes.*`;

          const destChatId = dest.chatId.toString();

          try {
            const sentMsg = await telegram.sendMessage(destChatId, reminderText, {
              parse_mode: 'Markdown',
            });

            await prisma.deadlineReminderDelivery.update({
              where: { id: delivery.id },
              data: {
                status: DeliveryStatus.SUCCESS,
                telegramMessageId: sentMsg.message_id,
                sentAt: now,
                errorMessage: null,
                updatedAt: now,
              },
            });

            result.delivered++;
            logger.info(
              `Delivered ${delivery.reminderType} reminder for deadline "${deadline.title}" to group "${dest.groupName}"`,
              {
                event: 'deadline.reminder_delivered',
                deadlineId: deadline.id,
                destinationId: dest.id,
                chatId: destChatId,
                reminderType: delivery.reminderType,
              }
            );
          } catch (sendErr) {
            const safeSendErr = sanitizeError(sendErr, token);
            const { message: classifiedMsg, retryAfterSeconds } = classifyTelegramError(sendErr);

            // If rate limited, pause politely if retry_after is given
            if (retryAfterSeconds && retryAfterSeconds > 0) {
              logger.warn(`Telegram rate limit hit during reminder delivery. Retry after ${retryAfterSeconds}s`, {
                event: 'deadline.rate_limited',
                retryAfter: retryAfterSeconds,
              });
            }

            await prisma.deadlineReminderDelivery.update({
              where: { id: delivery.id },
              data: {
                status: DeliveryStatus.FAILED,
                errorMessage: classifiedMsg || safeSendErr,
                updatedAt: now,
              },
            });

            result.failed++;
            logger.error(
              `Failed to deliver reminder for deadline "${deadline.title}" to group "${dest.groupName}": ${safeSendErr}`,
              {
                event: 'deadline.reminder_failed',
                deadlineId: deadline.id,
                destinationId: dest.id,
                chatId: destChatId,
                error: safeSendErr,
              }
            );
          }
        } finally {
          this.processingIds.delete(delivery.id);
        }
      }
    } catch (err) {
      console.error('[DeadlineSchedulerService Error] Error during reminder processing tick:', err);
    } finally {
      this.isProcessing = false;
    }

    return result;
  }

  /**
   * Starts periodic polling for due reminders.
   */
  startPolling(telegram: Telegram, token?: string, intervalMs = 30000): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }

    this.pollTimer = setInterval(async () => {
      try {
        await this.processDueReminders(telegram, token);
      } catch (err) {
        console.error('[DeadlineSchedulerService] Error during scheduler tick:', sanitizeError(err, token));
      }
    }, intervalMs);
    this.pollTimer.unref();

    // Run immediately on boot to handle startup recovery
    this.processDueReminders(telegram, token).catch((err) => {
      console.error('[DeadlineSchedulerService] Startup recovery error:', sanitizeError(err, token));
    });
  }

  /**
   * Stops periodic polling (for clean shutdown and tests).
   */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.processingIds.clear();
    this.isProcessing = false;
  }
}

export const deadlineSchedulerService = new DeadlineSchedulerService();
