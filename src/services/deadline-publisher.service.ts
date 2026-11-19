import { Telegram } from 'telegraf';
import { DeliveryStatus } from '@prisma/client';
import { prisma } from '../db/prisma';
import { formatDateTimeInTimezone, formatTimeRemaining } from '../utils/time';
import { classifyTelegramError } from './forwarding.service';
import { sanitizeError } from '../utils/sanitize';
import { logger } from '../utils/logger';

export interface PublishResult {
  total: number;
  sent: number;
  pinned: number;
  pinFailed: number;
  sendFailed: number;
  errors: string[];
}

export class DeadlinePublisherService {
  /**
   * Publishes deadline announcement to all active destination groups and attempts to pin the message.
   * If sending succeeds but pinning fails, records send as SUCCESS and pin failure separately without resending.
   */
  async publishAndPinDeadline(
    telegram: Telegram,
    deadlineId: string,
    token?: string
  ): Promise<PublishResult> {
    const deadline = await prisma.deadline.findUnique({
      where: { id: deadlineId },
      include: {
        announcements: {
          include: {
            destinationGroup: true,
          },
        },
      },
    });

    const result: PublishResult = {
      total: deadline?.announcements.length || 0,
      sent: 0,
      pinned: 0,
      pinFailed: 0,
      sendFailed: 0,
      errors: [],
    };

    if (!deadline) {
      result.errors.push(`Deadline with ID "${deadlineId}" was not found.`);
      return result;
    }

    const formattedMessage =
      `📅 **NEW SUBMISSION DEADLINE**\n\n` +
      `📌 **Title:** ${deadline.title}\n` +
      `📋 **Instructions:**\n${deadline.description}\n\n` +
      `⏰ **Due Date & Time:**\n${formatDateTimeInTimezone(deadline.dueAt, deadline.timezone)}\n\n` +
      `⏳ **Time Remaining:** ${formatTimeRemaining(deadline.dueAt, new Date())}\n\n` +
      `⚠️ *Please submit on or before the due date. Check pinned messages in this group for updates.*`;

    for (const announcement of deadline.announcements) {
      const dest = announcement.destinationGroup;

      // Skip inactive destination groups
      if (!dest.isActive) {
        continue;
      }

      // Idempotency check: do not resend if already sent successfully
      if (announcement.status === DeliveryStatus.SUCCESS && announcement.telegramMessageId) {
        result.sent++;
        if (announcement.isPinned) {
          result.pinned++;
        }
        continue;
      }

      const destChatId = dest.chatId.toString();

      try {
        // Step 1: Send formatted deadline announcement message
        const sentMsg = await telegram.sendMessage(destChatId, formattedMessage, {
          parse_mode: 'Markdown',
        });

        // Record send as SUCCESS
        await prisma.deadlineAnnouncement.update({
          where: { id: announcement.id },
          data: {
            status: DeliveryStatus.SUCCESS,
            telegramMessageId: sentMsg.message_id,
            sentAt: new Date(),
            errorMessage: null,
            updatedAt: new Date(),
          },
        });
        result.sent++;

        // Step 2: Attempt to pin the announcement message in the student group
        try {
          await telegram.pinChatMessage(destChatId, sentMsg.message_id);

          await prisma.deadlineAnnouncement.update({
            where: { id: announcement.id },
            data: {
              isPinned: true,
              pinErrorMessage: null,
              updatedAt: new Date(),
            },
          });
          result.pinned++;

          logger.info(`Pinned deadline message #${sentMsg.message_id} in group "${dest.groupName}" (${destChatId})`, {
            event: 'deadline.pinned',
            deadlineId: deadline.id,
            chatId: destChatId,
            messageId: sentMsg.message_id,
          });
        } catch (pinErr) {
          const safePinErr = sanitizeError(pinErr, token);
          result.pinFailed++;

          logger.warn(
            `Failed to pin deadline message in destination group "${dest.groupName}" (${destChatId}). ` +
            `Bot lacks "can_pin_messages" administrator permission or Telegram rejected pin request.`,
            {
              event: 'deadline.pin_permission_missing',
              deadlineId: deadline.id,
              chatId: destChatId,
              error: safePinErr,
            }
          );

          await prisma.deadlineAnnouncement.update({
            where: { id: announcement.id },
            data: {
              isPinned: false,
              pinErrorMessage: `Bot lacks permission to pin messages or Telegram rejected request: ${safePinErr}`,
              updatedAt: new Date(),
            },
          });
        }
      } catch (sendErr) {
        result.sendFailed++;
        const safeSendErr = sanitizeError(sendErr, token);
        const { message: classifiedMsg } = classifyTelegramError(sendErr);

        logger.error(
          `Failed to deliver deadline announcement to destination "${dest.groupName}" (${destChatId}): ${safeSendErr}`,
          {
            event: 'deadline.announcement_failed',
            deadlineId: deadline.id,
            chatId: destChatId,
            error: safeSendErr,
          }
        );

        await prisma.deadlineAnnouncement.update({
          where: { id: announcement.id },
          data: {
            status: DeliveryStatus.FAILED,
            errorMessage: classifiedMsg || safeSendErr,
            updatedAt: new Date(),
          },
        });

        result.errors.push(`Group "${dest.groupName}": ${classifiedMsg}`);
      }
    }

    return result;
  }
}

export const deadlinePublisherService = new DeadlinePublisherService();
