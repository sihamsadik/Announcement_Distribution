import { Telegram } from 'telegraf';
import { sanitizeError } from '../utils/sanitize';

export enum ForwardErrorType {
  BOT_NOT_MEMBER = 'BOT_NOT_MEMBER',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  MESSAGE_NOT_FOUND = 'MESSAGE_NOT_FOUND',
  PROTECTED_CONTENT = 'PROTECTED_CONTENT',
  RATE_LIMITED = 'RATE_LIMITED',
  NETWORK_ERROR = 'NETWORK_ERROR',
  SERVER_ERROR = 'SERVER_ERROR',
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
  isTransient?: boolean;
  retryAfterSeconds?: number;
}

export interface ClassifiedTelegramError {
  errorType: ForwardErrorType;
  message: string;
  isTransient: boolean;
  retryAfterSeconds?: number;
}

/**
 * Determines whether an error type is transient (retryable) or permanent (non-retryable).
 */
export function isTransientError(errorType: ForwardErrorType): boolean {
  switch (errorType) {
    case ForwardErrorType.RATE_LIMITED:
    case ForwardErrorType.NETWORK_ERROR:
    case ForwardErrorType.SERVER_ERROR:
      return true;
    case ForwardErrorType.BOT_NOT_MEMBER:
    case ForwardErrorType.PERMISSION_DENIED:
    case ForwardErrorType.PROTECTED_CONTENT:
    case ForwardErrorType.MESSAGE_NOT_FOUND:
    case ForwardErrorType.INVALID_CHAT_ID:
    case ForwardErrorType.UNKNOWN_ERROR:
    default:
      return false;
  }
}

/**
 * Classifies Telegram Bot API exceptions into structured, actionable error categories.
 * Separates transient errors (rate-limits, network timeouts, 5xx server issues)
 * from permanent errors (permissions, bot kicked, protected content).
 * Extracts retry_after parameters if rate limited.
 */
export function classifyTelegramError(err: unknown): ClassifiedTelegramError {
  const errMsg = err instanceof Error ? err.message : String(err);
  const lower = errMsg.toLowerCase();

  // 1. Rate Limits (Transient)
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
      isTransient: true,
      retryAfterSeconds,
    };
  }

  // 2. Temporary Telegram Server Errors (Transient)
  if (
    lower.includes('500') ||
    lower.includes('502') ||
    lower.includes('503') ||
    lower.includes('504') ||
    lower.includes('internal server error') ||
    lower.includes('bad gateway') ||
    lower.includes('service unavailable') ||
    lower.includes('gateway timeout')
  ) {
    return {
      errorType: ForwardErrorType.SERVER_ERROR,
      message: 'Temporary Telegram server error (5xx).',
      isTransient: true,
    };
  }

  // 3. Temporary Network Failures & Timeouts (Transient)
  if (
    lower.includes('etimedout') ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('socket hang up') ||
    lower.includes('network timeout') ||
    lower.includes('fetch failed') ||
    lower.includes('network error') ||
    lower.includes('timeout')
  ) {
    return {
      errorType: ForwardErrorType.NETWORK_ERROR,
      message: 'Temporary network connection failure or timeout.',
      isTransient: true,
    };
  }

  // 4. Invalid Chat ID / Chat Not Found (Permanent)
  if (lower.includes('chat not found') || lower.includes('chat_id is empty') || lower.includes('peer_id_invalid')) {
    return {
      errorType: ForwardErrorType.INVALID_CHAT_ID,
      message: 'Destination chat was not found or is invalid.',
      isTransient: false,
    };
  }

  // 5. Bot Kicked or Blocked (Permanent)
  if (
    lower.includes('bot was kicked') ||
    lower.includes('bot is not a member') ||
    lower.includes('user not found') ||
    lower.includes('bot was blocked')
  ) {
    return {
      errorType: ForwardErrorType.BOT_NOT_MEMBER,
      message: 'Bot is not a member of the destination group.',
      isTransient: false,
    };
  }

  // 6. Permission Denied / Write Forbidden (Permanent)
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
      isTransient: false,
    };
  }

  // 7. Protected Content (Permanent)
  if (
    lower.includes('chat_forwards_restricted') ||
    lower.includes("message can't be forwarded") ||
    lower.includes('protected content')
  ) {
    return {
      errorType: ForwardErrorType.PROTECTED_CONTENT,
      message: 'The source message or chat has content protection enabled and cannot be forwarded.',
      isTransient: false,
    };
  }

  // 8. Message Not Found (Permanent)
  if (
    lower.includes('message to forward not found') ||
    lower.includes('message not found') ||
    lower.includes('message can’t be found')
  ) {
    return {
      errorType: ForwardErrorType.MESSAGE_NOT_FOUND,
      message: 'The source message could not be found or has been deleted.',
      isTransient: false,
    };
  }

  // 9. Unknown Error
  return {
    errorType: ForwardErrorType.UNKNOWN_ERROR,
    message: errMsg,
    isTransient: false,
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
      const { errorType, message, isTransient, retryAfterSeconds } = classifyTelegramError(err);

      console.error(
        `[ForwardingService Error] Failed to forward message #${srcMsgId} from ${srcChatId} to ${destChatId}: ` +
        `[${errorType}] ${message} (Transient: ${isTransient}, Detail: ${sanitized})`
      );

      return {
        success: false,
        errorType,
        errorMessage: message,
        rawError: sanitized,
        isTransient,
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
      const { errorType, message, isTransient, retryAfterSeconds } = classifyTelegramError(err);

      console.error(
        `[ForwardingService Error] Failed to forward album [${sortedMsgIds.join(', ')}] from ${srcChatId} to ${destChatId}: ` +
        `[${errorType}] ${message} (Transient: ${isTransient}, Detail: ${sanitized})`
      );

      return {
        success: false,
        errorType,
        errorMessage: message,
        rawError: sanitized,
        isTransient,
        retryAfterSeconds,
      };
    }
  }
}

export const forwardingService = new ForwardingService();
