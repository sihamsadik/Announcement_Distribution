import { Telegram } from 'telegraf';
import { sanitizeError } from '../bot/bot';

export enum ForwardErrorType {
  BOT_NOT_MEMBER = 'BOT_NOT_MEMBER',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  MESSAGE_NOT_FOUND = 'MESSAGE_NOT_FOUND',
  PROTECTED_CONTENT = 'PROTECTED_CONTENT',
  RATE_LIMITED = 'RATE_LIMITED',
  INVALID_CHAT_ID = 'INVALID_CHAT_ID',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

export interface ForwardMessageInput {
  sourceChatId: bigint | number | string;
  sourceMessageId: number;
  destinationChatId: bigint | number | string;
}

export interface ForwardMessagesInput {
  sourceChatId: bigint | number | string;
  sourceMessageIds: number[];
  destinationChatId: bigint | number | string;
}

export interface ForwardResult {
  success: boolean;
  forwardedMessageId?: number;
  forwardedMessageIds?: number[];
  errorType?: ForwardErrorType;
  errorMessage?: string;
  rawError?: string;
  retryAfterSeconds?: number;
}

export interface ClassifiedTelegramError {
  errorType: ForwardErrorType;
  message: string;
  retryAfterSeconds?: number;
}

/**
 * Classifies Telegram Bot API exceptions into structured, actionable error categories.
 * Extracts retry_after parameters if rate limited.
 */
export function classifyTelegramError(err: unknown): ClassifiedTelegramError {
  const errMsg = err instanceof Error ? err.message : String(err);
  const lower = errMsg.toLowerCase();

  if (lower.includes('chat not found') || lower.includes('chat_id is empty') || lower.includes('peer_id_invalid')) {
    return {
      errorType: ForwardErrorType.INVALID_CHAT_ID,
      message: 'Destination chat was not found or is invalid.',
    };
  }

  if (
    lower.includes('bot was kicked') ||
    lower.includes('bot is not a member') ||
    lower.includes('user not found') ||
    lower.includes('bot was blocked')
  ) {
    return {
      errorType: ForwardErrorType.BOT_NOT_MEMBER,
      message: 'Bot is not a member of the destination group.',
    };
  }

  if (
    lower.includes('chat_write_forbidden') ||
    lower.includes('not enough rights') ||
    lower.includes('rights to send') ||
    lower.includes('need administrator rights') ||
    lower.includes('send_messages')
  ) {
    return {
      errorType: ForwardErrorType.PERMISSION_DENIED,
      message: 'Bot does not have permission to send messages in the destination group.',
    };
  }

  if (
    lower.includes('chat_forwards_restricted') ||
    lower.includes("message can't be forwarded") ||
    lower.includes('protected content')
  ) {
    return {
      errorType: ForwardErrorType.PROTECTED_CONTENT,
      message: 'The source message or chat has content protection enabled and cannot be forwarded.',
    };
  }

  if (
    lower.includes('message to forward not found') ||
    lower.includes('message not found') ||
    lower.includes('message can’t be found')
  ) {
    return {
      errorType: ForwardErrorType.MESSAGE_NOT_FOUND,
      message: 'The source message could not be found or has been deleted.',
    };
  }

  if (lower.includes('too many requests') || lower.includes('retry after')) {
    let retryAfterSeconds: number | undefined;
    const match = errMsg.match(/retry after (\d+)/i);
    if (match) {
      retryAfterSeconds = parseInt(match[1], 10);
    } else if ((err as any)?.parameters?.retry_after) {
      retryAfterSeconds = (err as any).parameters.retry_after;
    }
    return {
      errorType: ForwardErrorType.RATE_LIMITED,
      message: `Telegram API rate limit encountered.${retryAfterSeconds !== undefined ? ` Retry after ${retryAfterSeconds}s.` : ''}`,
      retryAfterSeconds,
    };
  }

  return {
    errorType: ForwardErrorType.UNKNOWN_ERROR,
    message: errMsg,
  };
}

export class ForwardingService {
  /**
   * Forwards a single message natively from sourceChatId to destinationChatId using Telegram Bot API.
   * Preserves original author and source attribution where permitted.
   */
  async forwardMessage(
    telegram: Telegram,
    input: ForwardMessageInput,
    token?: string
  ): Promise<ForwardResult> {
    const destChatId = input.destinationChatId.toString();
    const srcChatId = input.sourceChatId.toString();
    const srcMsgId = input.sourceMessageId;

    try {
      console.log(
        `[ForwardingService] Forwarding message #${srcMsgId} from source chat ${srcChatId} to destination ${destChatId}...`
      );

      const forwardedMsg = await telegram.forwardMessage(destChatId, srcChatId, srcMsgId);

      console.log(
        `[ForwardingService] Successfully forwarded message #${srcMsgId} to destination ${destChatId} ` +
        `(New Message ID: #${forwardedMsg.message_id})`
      );

      return {
        success: true,
        forwardedMessageId: forwardedMsg.message_id,
        forwardedMessageIds: [forwardedMsg.message_id],
      };
    } catch (err) {
      const sanitized = sanitizeError(err, token);
      const { errorType, message, retryAfterSeconds } = classifyTelegramError(err);

      console.error(
        `[ForwardingService Error] Failed to forward message #${srcMsgId} from ${srcChatId} to ${destChatId}: ` +
        `[${errorType}] ${message} (Detail: ${sanitized})`
      );

      return {
        success: false,
        errorType,
        errorMessage: message,
        rawError: sanitized,
        retryAfterSeconds,
      };
    }
  }

  /**
   * Forwards multiple messages natively (such as a media album) from sourceChatId to destinationChatId.
   * Preserves media album grouping and message ordering.
   */
  async forwardMessages(
    telegram: Telegram,
    input: ForwardMessagesInput,
    token?: string
  ): Promise<ForwardResult> {
    const destChatId = input.destinationChatId.toString();
    const srcChatId = input.sourceChatId.toString();
    // Telegram API requires message IDs in strictly increasing order
    const sortedMsgIds = [...input.sourceMessageIds].sort((a, b) => a - b);

    try {
      console.log(
        `[ForwardingService] Forwarding album of ${sortedMsgIds.length} messages (${sortedMsgIds.join(', ')}) ` +
        `from source chat ${srcChatId} to destination ${destChatId}...`
      );

      const forwarded = await telegram.forwardMessages(destChatId, srcChatId, sortedMsgIds);
      const newIds = forwarded.map((m) => m.message_id);

      console.log(
        `[ForwardingService] Successfully forwarded album of ${newIds.length} messages to destination ${destChatId} ` +
        `(New IDs: ${newIds.join(', ')})`
      );

      return {
        success: true,
        forwardedMessageId: newIds[0],
        forwardedMessageIds: newIds,
      };
    } catch (err) {
      const sanitized = sanitizeError(err, token);
      const { errorType, message, retryAfterSeconds } = classifyTelegramError(err);

      console.error(
        `[ForwardingService Error] Failed to forward album [${sortedMsgIds.join(', ')}] from ${srcChatId} to ${destChatId}: ` +
        `[${errorType}] ${message} (Detail: ${sanitized})`
      );

      return {
        success: false,
        errorType,
        errorMessage: message,
        rawError: sanitized,
        retryAfterSeconds,
      };
    }
  }
}

export const forwardingService = new ForwardingService();
