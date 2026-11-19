import { Context, Telegram } from 'telegraf';
import { SourceGroup } from '@prisma/client';
import { destinationService, DestinationService } from './destination.service';
import { forwardingService, ForwardingService, ForwardErrorType } from './forwarding.service';
import { albumService, AlbumService } from './album.service';
import { deliveryService, DeliveryService } from './delivery.service';
import { detectSourceAnnouncement } from '../bot/detector';
import { sanitizeError } from '../utils/sanitize';

export interface DestinationDeliveryResult {
  destinationId: string;
  destinationChatId: bigint;
  groupName: string;
  success: boolean;
  skipped?: boolean;
  skipReason?: string;
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
  skippedCount: number;
  results: DestinationDeliveryResult[];
}

export class DistributionService {
  private readonly interDestinationDelayMs: number;
  private readonly maxBackoffMs: number;
  private readonly delivService: DeliveryService;
  private readonly concurrency: number;
  private activeOperations = 0;
  private isShuttingDown = false;

  constructor(
    private readonly destService: DestinationService = destinationService,
    private readonly fwdService: ForwardingService = forwardingService,
    private readonly albService: AlbumService = albumService,
    delivServiceOrDelay: DeliveryService | number = deliveryService,
    interDestinationDelayMs?: number,
    maxBackoffMs = 10000,
    concurrency = parseInt(process.env.DISTRIBUTION_CONCURRENCY || '4', 10)
  ) {
    if (typeof delivServiceOrDelay === 'number') {
      this.delivService = deliveryService;
      this.interDestinationDelayMs = delivServiceOrDelay;
      this.maxBackoffMs = interDestinationDelayMs !== undefined ? interDestinationDelayMs : maxBackoffMs;
    } else {
      this.delivService = delivServiceOrDelay;
      this.interDestinationDelayMs = interDestinationDelayMs !== undefined
        ? interDestinationDelayMs
        : (process.env.NODE_ENV === 'test' ? 0 : 50);
      this.maxBackoffMs = process.env.NODE_ENV === 'test' ? 10 : maxBackoffMs;
    }
    this.concurrency = isNaN(concurrency) || concurrency < 1 ? 4 : concurrency;

    // Register this distribution service's album handler with the album service
    this.albService.setDefaultDistributionHandler(this.distributeAlbum.bind(this));
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  public markShuttingDown(): void {
    this.isShuttingDown = true;
  }

  public getActiveOperationsCount(): number {
    return this.activeOperations;
  }

  public getConcurrency(): number {
    return this.concurrency;
  }

  public async drainActiveOperations(timeoutMs = 5000): Promise<boolean> {
    const start = Date.now();
    while (this.activeOperations > 0 && Date.now() - start < timeoutMs) {
      await this.sleep(100);
    }
    return this.activeOperations === 0;
  }

  public resetStateForTesting(): void {
    this.isShuttingDown = false;
    this.activeOperations = 0;
  }

  /**
   * Bounded concurrency runner: processes items with at most `limit` workers in parallel,
   * preserving results in the original item index order.
   */
  private async runWithConcurrency<T, R>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>
  ): Promise<R[]> {
    if (items.length === 0) return [];
    const effectiveLimit = Math.max(1, Math.min(limit, items.length));
    const results: R[] = new Array(items.length);
    let nextIndex = 0;

    const executeWorker = async () => {
      while (nextIndex < items.length) {
        const idx = nextIndex++;
        results[idx] = await worker(items[idx], idx);
      }
    };

    const workers = Array.from({ length: effectiveLimit }, () => executeWorker());
    await Promise.all(workers);
    return results;
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

    // 4. Do not forward Telegram service notifications
    const m = message as any;
    if (
      m.pinned_message ||
      m.new_chat_members ||
      m.left_chat_member ||
      m.new_chat_title ||
      m.new_chat_photo ||
      m.delete_chat_photo ||
      m.group_chat_created ||
      m.supergroup_chat_created ||
      m.channel_chat_created ||
      m.forum_topic_created ||
      m.forum_topic_edited ||
      m.forum_topic_closed ||
      m.forum_topic_reopened
    ) {
      return { eligible: false, reason: 'Message is a Telegram service notification' };
    }

    // 5. Do not forward protected content messages that restrict forwarding
    if (m.has_protected_content) {
      return { eligible: false, reason: 'Message content is protected and cannot be forwarded' };
    }

    return { eligible: true };
  }

  /**
   * Central distribution logic for single messages (text, single photo, document, video, sticker, etc.).
   *
   * Idempotency & Delivery Tracking:
   * 1. Checks persistent delivery records in ForwardingLog.
   * 2. Skips destinations that already have a SUCCESS record.
   * 3. Creates/updates PENDING record atomically before sending.
   * 4. Updates record to SUCCESS or FAILED upon completion.
   * 5. Continues on partial failure so one unreachable group does not block others.
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
      skippedCount: 0,
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
      `[DistributionService] Distributing to ${activeDestinations.length} active destination group(s) ` +
      `(Bounded concurrency: ${this.concurrency})...`
    );

    // Reject processing if system shutdown was requested
    if (this.isShuttingDown) {
      console.warn(`[DistributionService] Rejecting announcement distribution: system shutdown in progress.`);
      return summary;
    }

    this.activeOperations++;
    try {
      // 2. Dispatch to destinations using controlled bounded concurrency
      const deliveryResults = await this.runWithConcurrency(
        activeDestinations,
        this.concurrency,
        async (destination): Promise<DestinationDeliveryResult> => {
          try {
            // Step A: Idempotency & Concurrency Check via DeliveryService
            const claim = await this.delivService.claimDelivery(sourceGroup.chatId, messageId, destination.id);

            if (!claim.canDeliver) {
              if (claim.reason === 'ALREADY_DELIVERED') {
                console.log(
                  `[DistributionService Idempotency] ⏭️ Skipping destination "${destination.groupName}" (${destination.id}): ` +
                  `Message #${messageId} from chat ${sourceGroup.chatId} was already successfully delivered.`
                );
                return {
                  destinationId: destination.id,
                  destinationChatId: destination.chatId,
                  groupName: destination.groupName,
                  success: true,
                  skipped: true,
                  skipReason: 'Already delivered (Idempotency)',
                };
              }

              if (claim.reason === 'ALREADY_PENDING') {
                console.log(
                  `[DistributionService Concurrency] ⏭️ Skipping destination "${destination.groupName}" (${destination.id}): ` +
                  `Message #${messageId} is currently being processed by another worker.`
                );
                return {
                  destinationId: destination.id,
                  destinationChatId: destination.chatId,
                  groupName: destination.groupName,
                  success: false,
                  skipped: true,
                  skipReason: 'Delivery currently in flight',
                };
              }
            }

            // Step B: Attempt Forwarding
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
              // Step C1: Mark SUCCESS in database
              await this.delivService.markSuccess(sourceGroup.chatId, messageId, destination.id);

              return {
                destinationId: destination.id,
                destinationChatId: destination.chatId,
                groupName: destination.groupName,
                success: true,
                forwardedMessageId: forwardResult.forwardedMessageId,
                forwardedMessageIds: forwardResult.forwardedMessageIds,
              };
            } else {
              // Step C2: Mark FAILED or RETRYING in database
              await this.delivService.markFailure(
                sourceGroup.chatId,
                messageId,
                destination.id,
                forwardResult.errorMessage || 'Unknown forward failure',
                forwardResult.isTransient,
                forwardResult.retryAfterSeconds
              );

              // Handle rate limit backoff if Telegram returns retry_after
              if (forwardResult.errorType === ForwardErrorType.RATE_LIMITED && forwardResult.retryAfterSeconds) {
                const backoffMs = Math.min(forwardResult.retryAfterSeconds * 1000, this.maxBackoffMs);
                console.warn(
                  `[DistributionService RateLimit] Rate limit encountered on destination ${destination.chatId}. ` +
                  `Backing off for ${backoffMs}ms before continuing...`
                );
                await this.sleep(backoffMs);
              }

              return {
                destinationId: destination.id,
                destinationChatId: destination.chatId,
                groupName: destination.groupName,
                success: false,
                errorType: forwardResult.errorType,
                errorMessage: forwardResult.errorMessage,
                retryAfterSeconds: forwardResult.retryAfterSeconds,
              };
            }
          } catch (err) {
            // Fallback resilience: catch unexpected errors to guarantee loop continuation
            const sanitized = sanitizeError(err, actualToken);
            console.error(
              `[DistributionService Error] Unexpected error forwarding to "${destination.groupName}" (${destination.chatId}): ${sanitized}`
            );

            // Record failure in database
            await this.delivService.markFailure(sourceGroup.chatId, messageId, destination.id, sanitized).catch(() => {});

            return {
              destinationId: destination.id,
              destinationChatId: destination.chatId,
              groupName: destination.groupName,
              success: false,
              errorType: ForwardErrorType.UNKNOWN_ERROR,
              errorMessage: sanitized,
            };
          } finally {
            if (this.interDestinationDelayMs > 0) {
              await this.sleep(this.interDestinationDelayMs);
            }
          }
        }
      );

      // Collate results and counts in exact destination order
      for (const res of deliveryResults) {
        summary.results.push(res);
        if (res.skipped) {
          summary.skippedCount++;
        } else if (res.success) {
          summary.successfulCount++;
        } else {
          summary.failedCount++;
        }
      }
    } finally {
      this.activeOperations--;
    }

    console.log(
      `[DistributionService] ✅ Finished distribution for message #${messageId} from "${sourceGroup.name}": ` +
      `${summary.successfulCount} successful, ${summary.failedCount} failed, ${summary.skippedCount} skipped ` +
      `(out of ${summary.totalDestinations} total).`
    );

    return summary;
  }

  /**
   * Central distribution logic for Telegram media groups (albums).
   * Forwards multiple messages atomically using native forwardMessages, preserving grouping and order.
   *
   * Idempotency & Delivery Tracking:
   * 1. Checks if all items in the album were already successfully delivered to the destination.
   * 2. Claims all item message IDs as PENDING in ForwardingLog.
   * 3. Forwards atomically via forwardMessages.
   * 4. Updates all item records to SUCCESS or FAILED in database.
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
      skippedCount: 0,
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
      `[DistributionService] Distributing album to ${activeDestinations.length} active destination group(s) ` +
      `(Bounded concurrency: ${this.concurrency})...`
    );

    // Reject processing if system shutdown was requested
    if (this.isShuttingDown) {
      console.warn(`[DistributionService] Rejecting album distribution: system shutdown in progress.`);
      return summary;
    }

    this.activeOperations++;
    try {
      const deliveryResults = await this.runWithConcurrency(
        activeDestinations,
        this.concurrency,
        async (destination): Promise<DestinationDeliveryResult> => {
          try {
            // Step A: Idempotency check for the album items
            const claim = await this.delivService.claimAlbumDelivery(sourceGroup.chatId, sortedIds, destination.id);

            if (!claim.canDeliver) {
              if (claim.reason === 'ALREADY_DELIVERED') {
                console.log(
                  `[DistributionService Idempotency] ⏭️ Skipping destination "${destination.groupName}" (${destination.id}): ` +
                  `Album ${mediaGroupId} was already successfully delivered.`
                );
                return {
                  destinationId: destination.id,
                  destinationChatId: destination.chatId,
                  groupName: destination.groupName,
                  success: true,
                  skipped: true,
                  skipReason: 'Album already delivered (Idempotency)',
                };
              }

              if (claim.reason === 'ALREADY_PENDING') {
                console.log(
                  `[DistributionService Concurrency] ⏭️ Skipping destination "${destination.groupName}" (${destination.id}): ` +
                  `Album ${mediaGroupId} is currently being processed by another worker.`
                );
                return {
                  destinationId: destination.id,
                  destinationChatId: destination.chatId,
                  groupName: destination.groupName,
                  success: false,
                  skipped: true,
                  skipReason: 'Album delivery currently in flight',
                };
              }
            }

            // Step B: Forward album atomically
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
              // Step C1: Mark SUCCESS for all items in database
              await this.delivService.markAlbumSuccess(sourceGroup.chatId, sortedIds, destination.id);

              return {
                destinationId: destination.id,
                destinationChatId: destination.chatId,
                groupName: destination.groupName,
                success: true,
                forwardedMessageId: forwardResult.forwardedMessageId,
                forwardedMessageIds: forwardResult.forwardedMessageIds,
              };
            } else {
              // Step C2: Mark FAILED or RETRYING for all items in database
              await this.delivService.markAlbumFailure(
                sourceGroup.chatId,
                sortedIds,
                destination.id,
                forwardResult.errorMessage || 'Unknown forwardMessages failure',
                forwardResult.isTransient,
                forwardResult.retryAfterSeconds
              );

              // Handle rate limit backoff if Telegram returns retry_after
              if (forwardResult.errorType === ForwardErrorType.RATE_LIMITED && forwardResult.retryAfterSeconds) {
                const backoffMs = Math.min(forwardResult.retryAfterSeconds * 1000, this.maxBackoffMs);
                console.warn(
                  `[DistributionService RateLimit] Rate limit encountered on destination ${destination.chatId}. ` +
                  `Backing off for ${backoffMs}ms before continuing...`
                );
                await this.sleep(backoffMs);
              }

              return {
                destinationId: destination.id,
                destinationChatId: destination.chatId,
                groupName: destination.groupName,
                success: false,
                errorType: forwardResult.errorType,
                errorMessage: forwardResult.errorMessage,
                retryAfterSeconds: forwardResult.retryAfterSeconds,
              };
            }
          } catch (err) {
            const sanitized = sanitizeError(err, token);
            console.error(
              `[DistributionService Error] Unexpected error forwarding album to "${destination.groupName}" (${destination.chatId}): ${sanitized}`
            );

            await this.delivService.markAlbumFailure(sourceGroup.chatId, sortedIds, destination.id, sanitized).catch(() => {});

            return {
              destinationId: destination.id,
              destinationChatId: destination.chatId,
              groupName: destination.groupName,
              success: false,
              errorType: ForwardErrorType.UNKNOWN_ERROR,
              errorMessage: sanitized,
            };
          } finally {
            if (this.interDestinationDelayMs > 0) {
              await this.sleep(this.interDestinationDelayMs);
            }
          }
        }
      );

      // Collate results in exact destination order
      for (const res of deliveryResults) {
        summary.results.push(res);
        if (res.skipped) {
          summary.skippedCount++;
        } else if (res.success) {
          summary.successfulCount++;
        } else {
          summary.failedCount++;
        }
      }
    } finally {
      this.activeOperations--;
    }

    console.log(
      `[DistributionService] ✅ Finished album distribution for ${mediaGroupId} from "${sourceGroup.name}": ` +
      `${summary.successfulCount} successful, ${summary.failedCount} failed, ${summary.skippedCount} skipped ` +
      `(out of ${summary.totalDestinations} total).`
    );

    return summary;
  }

  /**
   * Processes an incoming message context end-to-end:
   * 1. Validates eligibility (no bot loops, no commands).
   * 2. Detects registered source topic.
   * 3. For media albums: routes to album collection service with sliding debounce.
   * 4. For standalone messages: immediately distributes to active destinations with idempotency.
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

    if (this.isShuttingDown) {
      console.warn(`[DistributionService] Rejecting incoming update: system shutdown in progress.`);
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
