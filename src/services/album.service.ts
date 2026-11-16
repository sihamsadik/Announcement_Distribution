import { Telegram } from 'telegraf';
import { SourceGroup } from '@prisma/client';
import type { DistributionSummary } from './distribution.service';

export interface QueuedAlbumMessage {
  messageId: number;
  contentType: string;
  preview?: string;
  receivedAt: number;
}

export interface QueuedAlbum {
  key: string;
  sourceGroup: SourceGroup;
  chatId: bigint;
  topicId: bigint;
  mediaGroupId: string;
  messages: QueuedAlbumMessage[];
  firstReceivedAt: number;
  timer: NodeJS.Timeout;
}

export type AlbumDistributionHandler = (
  telegram: Telegram,
  sourceGroup: SourceGroup,
  messageIds: number[],
  mediaGroupId: string,
  contentType: string,
  token?: string
) => Promise<DistributionSummary>;

/**
 * Manages the collection and debouncing of Telegram media groups (albums).
 *
 * Background:
 * Telegram sends album items as separate, individual message updates over the network.
 * There is no native "album_complete" webhook event in the Telegram Bot API.
 * This service implements a sliding collection window (debounce) that accumulates
 * all updates sharing the same `media_group_id` within a time window (default 500ms),
 * capped by a maximum ceiling (default 2500ms) to prevent indefinite buffering.
 *
 * Once the window fires, the album is forwarded atomically to all active destinations
 * using Telegram's native `forwardMessages` API, preserving order and grouping.
 */
export class AlbumService {
  private activeAlbums = new Map<string, QueuedAlbum>();
  private processedMediaGroups = new Set<string>();
  private defaultHandler?: AlbumDistributionHandler;
  private readonly windowMs: number;
  private readonly maxCeilingMs: number;

  constructor(windowMs = 500, maxCeilingMs = 2500) {
    this.windowMs = windowMs;
    this.maxCeilingMs = maxCeilingMs;
  }

  /**
   * Sets the default distribution handler to execute when an album is flushed.
   */
  setDefaultDistributionHandler(handler: AlbumDistributionHandler): void {
    this.defaultHandler = handler;
  }

  /**
   * Adds an album message item to the collection buffer.
   * Returns true if queued, or false if ignored (e.g. already processed).
   */
  addMessage(
    telegram: Telegram,
    sourceGroup: SourceGroup,
    chatId: bigint,
    topicId: bigint,
    mediaGroupId: string,
    messageId: number,
    contentType: string,
    preview?: string,
    token?: string,
    onAlbumReady?: (summary: DistributionSummary) => void,
    distributionHandler?: AlbumDistributionHandler
  ): boolean {
    const key = `${chatId.toString()}_${mediaGroupId}`;

    // 1. Prevent duplicate distribution if this album was already finalized
    if (this.processedMediaGroups.has(key)) {
      console.log(`[AlbumService] ⚠️ Ignoring late update #${messageId} for already processed album ${mediaGroupId}.`);
      return false;
    }

    const now = Date.now();
    let album = this.activeAlbums.get(key);

    if (!album) {
      // First update received for this album
      console.log(
        `[AlbumService] 📸 Detected new media album (MediaGroupID: ${mediaGroupId}, First Msg: #${messageId}) ` +
        `in source "${sourceGroup.name}". Starting collection window (${this.windowMs}ms)...`
      );

      const timer = setTimeout(async () => {
        await this.flushAlbum(key, telegram, token, onAlbumReady, distributionHandler);
      }, this.windowMs);

      album = {
        key,
        sourceGroup,
        chatId,
        topicId,
        mediaGroupId,
        messages: [{ messageId, contentType, preview, receivedAt: now }],
        firstReceivedAt: now,
        timer,
      };

      this.activeAlbums.set(key, album);
      return true;
    }

    // Subsequent update for the active album
    if (!album.messages.some((m) => m.messageId === messageId)) {
      album.messages.push({ messageId, contentType, preview, receivedAt: now });
      console.log(
        `[AlbumService] Added item #${messageId} to album ${mediaGroupId} ` +
        `(Total items in buffer: ${album.messages.length})`
      );
    }

    // Sliding debounce: extend the timer unless we've reached the maximum ceiling
    clearTimeout(album.timer);
    const elapsed = now - album.firstReceivedAt;
    const remainingToCeiling = this.maxCeilingMs - elapsed;

    if (remainingToCeiling > 0) {
      const nextDelay = Math.min(this.windowMs, remainingToCeiling);
      album.timer = setTimeout(async () => {
        await this.flushAlbum(key, telegram, token, onAlbumReady, distributionHandler);
      }, nextDelay);
    } else {
      console.log(
        `[AlbumService] Max ceiling (${this.maxCeilingMs}ms) reached for album ${mediaGroupId}. Flushing now.`
      );
      // Flush asynchronously
      setTimeout(async () => {
        await this.flushAlbum(key, telegram, token, onAlbumReady, distributionHandler);
      }, 0);
    }

    return true;
  }

  /**
   * Finalizes the album collection, sorts message IDs ascending,
   * and triggers the distribution handler to deliver the album once to each active destination.
   */
  async flushAlbum(
    key: string,
    telegram: Telegram,
    token?: string,
    onAlbumReady?: (summary: DistributionSummary) => void,
    distributionHandler?: AlbumDistributionHandler
  ): Promise<DistributionSummary | null> {
    const album = this.activeAlbums.get(key);
    if (!album) {
      return null;
    }

    clearTimeout(album.timer);
    this.activeAlbums.delete(key);

    // Record as processed to avoid re-triggering from late updates
    this.processedMediaGroups.add(key);
    // Keep processed set size bounded
    if (this.processedMediaGroups.size > 1000) {
      const oldest = this.processedMediaGroups.values().next().value;
      if (oldest) this.processedMediaGroups.delete(oldest);
    }

    // Sort message IDs in ascending order as strictly required by Telegram API
    const sortedMessageIds = album.messages
      .map((m) => m.messageId)
      .sort((a, b) => a - b);

    const albumContentType = `album (${sortedMessageIds.length} items)`;

    console.log(
      `[AlbumService] 📦 Finalizing album ${album.mediaGroupId} with ${sortedMessageIds.length} item(s) ` +
      `[${sortedMessageIds.join(', ')}] for source "${album.sourceGroup.name}". Forwarding as native media group...`
    );

    const handler = distributionHandler || this.defaultHandler;
    if (!handler) {
      console.error(`[AlbumService Error] No distribution handler configured for album ${album.mediaGroupId}.`);
      return null;
    }

    const summary = await handler(
      telegram,
      album.sourceGroup,
      sortedMessageIds,
      album.mediaGroupId,
      albumContentType,
      token
    );

    if (onAlbumReady) {
      onAlbumReady(summary);
    }

    return summary;
  }

  /**
   * Flushes all currently active albums immediately (useful for testing and graceful shutdown).
   */
  async flushAll(telegram: Telegram, token?: string): Promise<DistributionSummary[]> {
    const summaries: DistributionSummary[] = [];
    const keys = Array.from(this.activeAlbums.keys());
    for (const key of keys) {
      const summary = await this.flushAlbum(key, telegram, token);
      if (summary) {
        summaries.push(summary);
      }
    }
    return summaries;
  }

  /**
   * Clears all active albums and cancels active timers (useful for test cleanup).
   */
  clear(): void {
    for (const album of this.activeAlbums.values()) {
      clearTimeout(album.timer);
    }
    this.activeAlbums.clear();
    this.processedMediaGroups.clear();
  }

  /**
   * Retrieves active album state for inspection in tests.
   */
  getActiveAlbum(key: string): QueuedAlbum | undefined {
    return this.activeAlbums.get(key);
  }

  /**
   * Checks if an album key was already processed.
   */
  isProcessed(key: string): boolean {
    return this.processedMediaGroups.has(key);
  }
}

export const albumService = new AlbumService();
