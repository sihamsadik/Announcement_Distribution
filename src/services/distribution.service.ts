import { Context, Telegram } from 'telegraf';
import { SourceGroup } from '@prisma/client';
import { destinationService, DestinationService } from './destination.service';
import { forwardingService, ForwardingService, ForwardErrorType } from './forwarding.service';
import { albumService, AlbumService } from './album.service';
import { detectSourceAnnouncement } from '../bot/detector';
import { sanitizeError } from '../bot/bot';

export interface DestinationDeliveryResult {
  destinationId: string;
  destinationChatId: bigint;
  groupName: string;
  success: boolean;
  forwardedMessageId?: number;
  forwardedMessageIds?: number[];
  errorType?: ForwardErrorType;
  errorMessage?: string;
  retryAfterSeconds?: number;
}

export interface DistributionSummary {
  sourceGroupId: string;
  sourceGroupName: string;
  sourceChatId: bigint;
  sourceTopicId: bigint;
  sourceMessageId?: number;
  sourceMessageIds?: number[];
  mediaGroupId?: string;
  isAlbum: boolean;
  contentType: string;
  totalDestinations: number;
  successfulCount: number;
  failedCount: number;
  results: DestinationDeliveryResult[];
}

export class DistributionService {
  private readonly interDestinationDelayMs: number;
  private readonly maxBackoffMs: number;

  constructor(
    private readonly destService: DestinationService = destinationService,
    private readonly fwdService: ForwardingService = forwardingService,
    private readonly albService: AlbumService = albumService,
    interDestinationDelayMs = process.env.NODE_ENV === 'test' ? 0 : 50,
    maxBackoffMs = 10000
  ) {
    this.interDestinationDelayMs = interDestinationDelayMs;
    this.maxBackoffMs = maxBackoffMs;

    // Register this distribution service's album handler with the album service
    this.albService.setDefaultDistributionHandler(this.distributeAlbum.bind(this));
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

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
   * Central distribution logic for single messages (text, single photo, document, video, sticker, etc.).
   *
   * Continues on partial failure so one unreachable group does not block others.
   * Backs off safely when encountering Telegram rate limits (429 retry-after).
   */
  async distributeAnnouncement(
    telegram: Telegram,
    sourceGroup: SourceGroup,
    messageId: number,
    contentTypeOrToken = 'text',
    token?: string
  ): Promise<DistributionSummary> {
    let actualContentType = 'text';
    let actualToken = token;

    if (contentTypeOrToken) {
      if (contentTypeOrToken.includes(':') || /^\d+:[\w-]+$/.test(contentTypeOrToken)) {
        actualToken = contentTypeOrToken;
      } else {
        actualContentType = contentTypeOrToken;
      }
    }

    console.log(
      `[DistributionService] 🚀 Starting distribution for message #${messageId} (Type: ${actualContentType}) ` +
      `from source "${sourceGroup.name}" (Chat: ${sourceGroup.chatId}, Topic: ${sourceGroup.topicId})`
    );

    // 1. Retrieve all active destination groups associated with this source
    const activeDestinations = await this.destService.getActiveDestinations(sourceGroup.id);

    const summary: DistributionSummary = {
      sourceGroupId: sourceGroup.id,
      sourceGroupName: sourceGroup.name,
      sourceChatId: sourceGroup.chatId,
      sourceTopicId: sourceGroup.topicId,
      sourceMessageId: messageId,
      sourceMessageIds: [messageId],
      isAlbum: false,
      contentType: actualContentType,
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
    for (let i = 0; i < activeDestinations.length; i++) {
      const destination = activeDestinations[i];
      try {
        const forwardResult = await this.fwdService.forwardMessage(
          telegram,
          {
            sourceChatId: sourceGroup.chatId,
            sourceMessageId: messageId,
            destinationChatId: destination.chatId,
          },
          actualToken
        );

        if (forwardResult.success) {
          summary.successfulCount++;
          summary.results.push({
            destinationId: destination.id,
            destinationChatId: destination.chatId,
            groupName: destination.groupName,
            success: true,
            forwardedMessageId: forwardResult.forwardedMessageId,
            forwardedMessageIds: forwardResult.forwardedMessageIds,
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
            retryAfterSeconds: forwardResult.retryAfterSeconds,
          });

          // Handle rate limit backoff if Telegram returns retry_after
          if (forwardResult.errorType === ForwardErrorType.RATE_LIMITED && forwardResult.retryAfterSeconds) {
            const backoffMs = Math.min(forwardResult.retryAfterSeconds * 1000, this.maxBackoffMs);
            console.warn(
              `[DistributionService RateLimit] Rate limit encountered on destination ${destination.chatId}. ` +
              `Backing off for ${backoffMs}ms before continuing...`
            );
            await this.sleep(backoffMs);
          }
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

      // Small polite inter-destination delay to avoid burst violations across many groups
      if (this.interDestinationDelayMs > 0 && i < activeDestinations.length - 1) {
        await this.sleep(this.interDestinationDelayMs);
      }
    }

    console.log(
      `[DistributionService] ✅ Finished distribution for message #${messageId} from "${sourceGroup.name}": ` +
      `${summary.successfulCount}/${summary.totalDestinations} successful, ${summary.failedCount} failed.`
    );

    return summary;
  }

  /**
   * Central distribution logic for Telegram media groups (albums).
   * Forwards multiple messages atomically using native forwardMessages, preserving grouping and order.
   */
  async distributeAlbum(
    telegram: Telegram,
    sourceGroup: SourceGroup,
    messageIds: number[],
    mediaGroupId: string,
    contentType = 'album',
    token?: string
  ): Promise<DistributionSummary> {
    const sortedIds = [...messageIds].sort((a, b) => a - b);
    console.log(
      `[DistributionService] 🚀 Starting album distribution for MediaGroup ${mediaGroupId} ` +
      `(${sortedIds.length} items: [${sortedIds.join(', ')}]) ` +
      `from source "${sourceGroup.name}" (Chat: ${sourceGroup.chatId}, Topic: ${sourceGroup.topicId})`
    );

    const activeDestinations = await this.destService.getActiveDestinations(sourceGroup.id);

    const summary: DistributionSummary = {
      sourceGroupId: sourceGroup.id,
      sourceGroupName: sourceGroup.name,
      sourceChatId: sourceGroup.chatId,
      sourceTopicId: sourceGroup.topicId,
      sourceMessageId: sortedIds[0],
      sourceMessageIds: sortedIds,
      mediaGroupId,
      isAlbum: true,
      contentType,
      totalDestinations: activeDestinations.length,
      successfulCount: 0,
      failedCount: 0,
      results: [],
    };

    if (activeDestinations.length === 0) {
      console.log(
        `[DistributionService] ⚠️ No active destination groups found for source "${sourceGroup.name}" (${sourceGroup.id}). ` +
        `Album not forwarded.`
      );
      return summary;
    }

    console.log(
      `[DistributionService] Distributing album to ${activeDestinations.length} active destination group(s)...`
    );

    for (let i = 0; i < activeDestinations.length; i++) {
      const destination = activeDestinations[i];
      try {
        const forwardResult = await this.fwdService.forwardMessages(
          telegram,
          {
            sourceChatId: sourceGroup.chatId,
            sourceMessageIds: sortedIds,
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
            forwardedMessageIds: forwardResult.forwardedMessageIds,
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
            retryAfterSeconds: forwardResult.retryAfterSeconds,
          });

          // Handle rate limit backoff if Telegram returns retry_after
          if (forwardResult.errorType === ForwardErrorType.RATE_LIMITED && forwardResult.retryAfterSeconds) {
            const backoffMs = Math.min(forwardResult.retryAfterSeconds * 1000, this.maxBackoffMs);
            console.warn(
              `[DistributionService RateLimit] Rate limit encountered on destination ${destination.chatId}. ` +
              `Backing off for ${backoffMs}ms before continuing...`
            );
            await this.sleep(backoffMs);
          }
        }
      } catch (err) {
        const sanitized = sanitizeError(err, token);
        console.error(
          `[DistributionService Error] Unexpected error forwarding album to "${destination.groupName}" (${destination.chatId}): ${sanitized}`
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

      // Small polite inter-destination delay
      if (this.interDestinationDelayMs > 0 && i < activeDestinations.length - 1) {
        await this.sleep(this.interDestinationDelayMs);
      }
    }

    console.log(
      `[DistributionService] ✅ Finished album distribution for ${mediaGroupId} from "${sourceGroup.name}": ` +
      `${summary.successfulCount}/${summary.totalDestinations} successful, ${summary.failedCount} failed.`
    );

    return summary;
  }

  /**
   * Processes an incoming message context end-to-end:
   * 1. Validates eligibility (no bot loops, no commands).
   * 2. Detects registered source topic.
   * 3. For media albums: routes to album collection service with sliding debounce.
   * 4. For standalone messages: immediately distributes to active destinations.
   */
  async processIncomingMessage(
    ctx: Context,
    token?: string,
    onAlbumReady?: (summary: DistributionSummary) => void
  ): Promise<DistributionSummary | null> {
    const eligibility = this.isEligibleMessage(ctx);
    if (!eligibility.eligible) {
      return null;
    }

    const detected = await detectSourceAnnouncement(ctx);
    if (!detected) {
      return null;
    }

    // Media album check: if message belongs to a media group, route through AlbumService
    if (detected.mediaGroupId) {
      this.albService.addMessage(
        ctx.telegram,
        detected.sourceGroup,
        detected.chatId,
        detected.topicId,
        detected.mediaGroupId,
        detected.messageId,
        detected.contentType,
        detected.contentPreview,
        token,
        onAlbumReady
      );
      // Album is handled asynchronously when the collection window closes
      return null;
    }

    // Standalone single message
    return await this.distributeAnnouncement(
      ctx.telegram,
      detected.sourceGroup,
      detected.messageId,
      detected.contentType,
      token
    );
  }
}

export const distributionService = new DistributionService();
