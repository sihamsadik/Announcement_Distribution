import { Context } from 'telegraf';
import { SourceGroup } from '@prisma/client';
import { sourceService } from '../services/source.service';

export interface DetectedAnnouncement {
  sourceGroup: SourceGroup;
  chatId: bigint;
  topicId: bigint;
  messageId: number;
  contentType: string;
  hasMedia: boolean;
  contentPreview?: string;
}

/**
 * Extracts content type and media summary from a Telegram message.
 */
export function getMessageContentType(message: any): { contentType: string; hasMedia: boolean; preview?: string } {
  if (!message) {
    return { contentType: 'unknown', hasMedia: false };
  }

  if (message.text) {
    const preview = message.text.length > 50 ? `${message.text.substring(0, 47)}...` : message.text;
    return { contentType: 'text', hasMedia: false, preview };
  }

  const captionPreview = message.caption ? (message.caption.length > 50 ? `${message.caption.substring(0, 47)}...` : message.caption) : undefined;

  if (message.photo) return { contentType: 'photo', hasMedia: true, preview: captionPreview };
  if (message.document) return { contentType: 'document', hasMedia: true, preview: captionPreview };
  if (message.video) return { contentType: 'video', hasMedia: true, preview: captionPreview };
  if (message.animation) return { contentType: 'animation', hasMedia: true, preview: captionPreview };
  if (message.audio) return { contentType: 'audio', hasMedia: true, preview: captionPreview };
  if (message.voice) return { contentType: 'voice', hasMedia: true, preview: captionPreview };
  if (message.poll) return { contentType: 'poll', hasMedia: false, preview: message.poll.question };

  return { contentType: 'other', hasMedia: false };
}

/**
 * Inspects an incoming message and determines if it originates from a registered source topic.
 * Returns the detected announcement metadata, or null if the message should be ignored.
 */
export async function detectSourceAnnouncement(ctx: Context): Promise<DetectedAnnouncement | null> {
  // 1. Must have chat and message
  const chat = ctx.chat;
  const message = ctx.message;

  if (!chat || !message) {
    return null;
  }

  // 2. Reject private chats - only group/supergroup messages can be source announcements
  if (chat.type !== 'group' && chat.type !== 'supergroup') {
    return null;
  }

  // 3. Extract message_thread_id (forum topic ID)
  // In Telegraf, message_thread_id is located on ctx.message
  const topicId = (message as any).message_thread_id;

  if (topicId === undefined || topicId === null) {
    // Non-topic message in group
    return null;
  }

  // 4. Query database for registered source group & topic
  const sourceGroup = await sourceService.findSource(chat.id, topicId);

  if (!sourceGroup) {
    // Unregistered source group or different topic in registered group
    return null;
  }

  // 5. Source matched! Extract message metadata
  const { contentType, hasMedia, preview } = getMessageContentType(message);

  console.log(
    `[SourceDetector] 📢 Recognized announcement in registered source "${sourceGroup.name}" ` +
    `(Chat: ${chat.id}, Topic: ${topicId}, Message: #${message.message_id}, Type: ${contentType})`
  );

  return {
    sourceGroup,
    chatId: BigInt(chat.id),
    topicId: BigInt(topicId),
    messageId: message.message_id,
    contentType,
    hasMedia,
    contentPreview: preview,
  };
}
