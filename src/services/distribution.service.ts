import { Context, Telegram } from 'telegraf';
import { SourceGroup, DestinationGroup } from '@prisma/client';
import { destinationService, DestinationService } from './destination.service';
import { forwardingService, ForwardingService, ForwardErrorType } from './forwarding.service';
import { detectSourceAnnouncement, DetectedAnnouncement } from '../bot/detector';
import { sanitizeError } from '../bot/bot';

export interface DestinationDeliveryResult {
  destinationId: string;
  destinationChatId: bigint;
  groupName: string;
  success: boolean;
  forwardedMessageId?: number;
  errorType?: ForwardErrorType;
  errorMessage?: string;
}

export interface DistributionSummary {
  sourceGroupId: string;
  sourceGroupName: string;
  sourceChatId: bigint;
  sourceTopicId: bigint;
  sourceMessageId: number;
  totalDestinations: number;
  successfulCount: number;
  failedCount: number;
  results: DestinationDeliveryResult[];
}

export class DistributionService {
  constructor(
    private readonly destService: DestinationService = destinationService,
    private readonly fwdService: ForwardingService = forwardingService
  ) {}

  /**
   * Verifies if an incoming message is eligible for announcement distribution.
   * Prevents bot loops, commands, and non-message events.
   */
  isEligibleMessage(ctx: Context): { eligible: boolean; reason?: string } {
    const message = ctx.message;
    if (!message) {
      return { eligible: false, reason: 'No message object in context' };
    }

    // 1. Prevent bot loops: check message.from.is_bot
    if (message.from && message.from.is_bot) {
      return { eligible: false, reason: `Sender is a bot (${message.from.username || message.from.id})` };
    }

    // 2. Prevent bot loops: check bot's own ID if botInfo is available
    if (ctx.botInfo && message.from && message.from.id === ctx.botInfo.id) {
      return { eligible: false, reason: "Sender is the bot itself" };
    }

    // 3. Do not forward command messages (starting with '/')
    if ('text' in message && message.text && message.text.startsWith('/')) {
      return { eligible: false, reason: 'Message is a bot command' };
    }

    return { eligible: true };
  }

  /**
   * Central distribution logic: distributes a message from a registered source topic
   * to all of its active associated destination groups.
   *
   * Continues on partial failure so one unreachable group does not block others.
   */
  async distributeAnnouncement(
    telegram: Telegram,
    sourceGroup: SourceGroup,
    messageId: number,
    token?: string
  ): Promise<DistributionSummary> {
    console.log(
      `[DistributionService] 🚀 Starting distribution for message #${messageId} from source "${sourceGroup.name}" ` +
      `(Chat: ${sourceGroup.chatId}, Topic: ${sourceGroup.topicId})`
    );

    // 1. Retrieve all active destination groups associated with this source
    const activeDestinations = await this.destService.getActiveDestinations(sourceGroup.id);

    const summary: DistributionSummary = {
      sourceGroupId: sourceGroup.id,
      sourceGroupName: sourceGroup.name,
      sourceChatId: sourceGroup.chatId,
      sourceTopicId: sourceGroup.topicId,
      sourceMessageId: messageId,
      totalDestinations: activeDestinations.length,
      successfulCount: 0,
      failedCount: 0,
      results: [],
    };

    if (activeDestinations.length === 0) {
      console.log(
        `[DistributionService] ⚠️ No active destination groups found for source "${sourceGroup.name}" (${sourceGroup.id}). ` +
        `No messages forwarded.`
      );
      return summary;
    }

    console.log(
      `[DistributionService] Distributing to ${activeDestinations.length} active destination group(s)...`
    );

    // 2. Iterate through each active destination and forward the announcement
    for (const destination of activeDestinations) {
      try {
        const forwardResult = await this.fwdService.forwardMessage(
          telegram,
          {
            sourceChatId: sourceGroup.chatId,
            sourceMessageId: messageId,
            destinationChatId: destination.chatId,
          },
          token
        );

        if (forwardResult.success) {
          summary.successfulCount++;
          summary.results.push({
            destinationId: destination.id,
            destinationChatId: destination.chatId,
            groupName: destination.groupName,
            success: true,
            forwardedMessageId: forwardResult.forwardedMessageId,
          });
        } else {
          summary.failedCount++;
          summary.results.push({
            destinationId: destination.id,
            destinationChatId: destination.chatId,
            groupName: destination.groupName,
            success: false,
            errorType: forwardResult.errorType,
            errorMessage: forwardResult.errorMessage,
          });
        }
      } catch (err) {
        // Fallback resilience: catch unexpected errors to guarantee loop continuation
        const sanitized = sanitizeError(err, token);
        console.error(
          `[DistributionService Error] Unexpected error forwarding to "${destination.groupName}" (${destination.chatId}): ${sanitized}`
        );
        summary.failedCount++;
        summary.results.push({
          destinationId: destination.id,
          destinationChatId: destination.chatId,
          groupName: destination.groupName,
          success: false,
          errorType: ForwardErrorType.UNKNOWN_ERROR,
          errorMessage: sanitized,
        });
      }
    }

    console.log(
      `[DistributionService] ✅ Finished distribution for message #${messageId} from "${sourceGroup.name}": ` +
      `${summary.successfulCount}/${summary.totalDestinations} successful, ${summary.failedCount} failed.`
    );

    return summary;
  }

  /**
   * Processes an incoming message context end-to-end:
   * 1. Validates eligibility (no bot loops, no commands).
   * 2. Detects registered source topic.
   * 3. Forwards to all active destination groups.
   */
  async processIncomingMessage(ctx: Context, token?: string): Promise<DistributionSummary | null> {
    const eligibility = this.isEligibleMessage(ctx);
    if (!eligibility.eligible) {
      return null;
    }

    const detected = await detectSourceAnnouncement(ctx);
    if (!detected) {
      return null;
    }

    return await this.distributeAnnouncement(
      ctx.telegram,
      detected.sourceGroup,
      detected.messageId,
      token
    );
  }
}

export const distributionService = new DistributionService();
