import { Telegram } from 'telegraf';
import {
  forwardingService,
  classifyTelegramError,
  ForwardErrorType,
} from '../src/services/forwarding.service';
import { setupBotHandlers } from '../src/bot/bot';
import { Telegraf } from 'telegraf';

describe('Message Forwarding Engine', () => {
  const dummyToken = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ';
  const testSourceChatId = BigInt(-1001234567890);
  const testDestChatId = BigInt(-1009876543210);

  describe('1. Telegram Error Classification Unit Tests', () => {
    it('should classify "chat not found" as INVALID_CHAT_ID', () => {
      const err = new Error('Bad Request: chat not found');
      const { errorType, message } = classifyTelegramError(err);
      expect(errorType).toBe(ForwardErrorType.INVALID_CHAT_ID);
      expect(message).toContain('Destination chat was not found');
    });

    it('should classify "bot was kicked" as BOT_NOT_MEMBER', () => {
      const err = new Error('Forbidden: bot was kicked from the supergroup chat');
      const { errorType, message } = classifyTelegramError(err);
      expect(errorType).toBe(ForwardErrorType.BOT_NOT_MEMBER);
      expect(message).toContain('Bot is not a member');
    });

    it('should classify "CHAT_WRITE_FORBIDDEN" as PERMISSION_DENIED', () => {
      const err = new Error('Forbidden: CHAT_WRITE_FORBIDDEN');
      const { errorType, message } = classifyTelegramError(err);
      expect(errorType).toBe(ForwardErrorType.PERMISSION_DENIED);
      expect(message).toContain('permission to send messages');
    });

    it('should classify "CHAT_FORWARDS_RESTRICTED" as PROTECTED_CONTENT', () => {
      const err = new Error('Bad Request: CHAT_FORWARDS_RESTRICTED');
      const { errorType, message } = classifyTelegramError(err);
      expect(errorType).toBe(ForwardErrorType.PROTECTED_CONTENT);
      expect(message).toContain('content protection');
    });

    it('should classify "message to forward not found" as MESSAGE_NOT_FOUND', () => {
      const err = new Error('Bad Request: message to forward not found');
      const { errorType, message } = classifyTelegramError(err);
      expect(errorType).toBe(ForwardErrorType.MESSAGE_NOT_FOUND);
      expect(message).toContain('could not be found or has been deleted');
    });

    it('should classify "Too Many Requests" as RATE_LIMITED', () => {
      const err = new Error('Too Many Requests: retry after 42');
      const { errorType, message } = classifyTelegramError(err);
      expect(errorType).toBe(ForwardErrorType.RATE_LIMITED);
      expect(message).toContain('rate limit');
    });

    it('should classify unmapped errors as UNKNOWN_ERROR', () => {
      const err = new Error('Some completely unexpected error occurred');
      const { errorType, message } = classifyTelegramError(err);
      expect(errorType).toBe(ForwardErrorType.UNKNOWN_ERROR);
      expect(message).toBe('Some completely unexpected error occurred');
    });
  });

  describe('2. ForwardingService Tests', () => {
    let mockTelegram: Partial<Telegram>;

    beforeEach(() => {
      mockTelegram = {
        forwardMessage: jest.fn(),
      };
    });

    it('1. should forward a text message successfully', async () => {
      (mockTelegram.forwardMessage as jest.Mock).mockResolvedValue({
        message_id: 501,
        text: 'Final Project Announcement Text',
        chat: { id: Number(testDestChatId) },
      });

      const result = await forwardingService.forwardMessage(
        mockTelegram as Telegram,
        {
          sourceChatId: testSourceChatId,
          sourceMessageId: 101,
          destinationChatId: testDestChatId,
        },
        dummyToken
      );

      expect(result.success).toBe(true);
      expect(result.forwardedMessageId).toBe(501);
      expect(mockTelegram.forwardMessage).toHaveBeenCalledWith(
        testDestChatId.toString(),
        testSourceChatId.toString(),
        101
      );
    });

    it('2. should forward a message with a photo successfully', async () => {
      (mockTelegram.forwardMessage as jest.Mock).mockResolvedValue({
        message_id: 502,
        photo: [{}],
        caption: 'Project diagram photo',
        chat: { id: Number(testDestChatId) },
      });

      const result = await forwardingService.forwardMessage(
        mockTelegram as Telegram,
        {
          sourceChatId: testSourceChatId,
          sourceMessageId: 102,
          destinationChatId: testDestChatId,
        },
        dummyToken
      );

      expect(result.success).toBe(true);
      expect(result.forwardedMessageId).toBe(502);
    });

    it('3. should forward a document successfully', async () => {
      (mockTelegram.forwardMessage as jest.Mock).mockResolvedValue({
        message_id: 503,
        document: { file_name: 'project_guidelines.pdf' },
        chat: { id: Number(testDestChatId) },
      });

      const result = await forwardingService.forwardMessage(
        mockTelegram as Telegram,
        {
          sourceChatId: testSourceChatId,
          sourceMessageId: 103,
          destinationChatId: testDestChatId,
        },
        dummyToken
      );

      expect(result.success).toBe(true);
      expect(result.forwardedMessageId).toBe(503);
    });

    it('4. should forward a video successfully', async () => {
      (mockTelegram.forwardMessage as jest.Mock).mockResolvedValue({
        message_id: 504,
        video: { duration: 120 },
        chat: { id: Number(testDestChatId) },
      });

      const result = await forwardingService.forwardMessage(
        mockTelegram as Telegram,
        {
          sourceChatId: testSourceChatId,
          sourceMessageId: 104,
          destinationChatId: testDestChatId,
        },
        dummyToken
      );

      expect(result.success).toBe(true);
      expect(result.forwardedMessageId).toBe(504);
    });

    it('5. should forward to a valid destination and return structured success', async () => {
      (mockTelegram.forwardMessage as jest.Mock).mockResolvedValue({
        message_id: 777,
      });

      const result = await forwardingService.forwardMessage(
        mockTelegram as Telegram,
        {
          sourceChatId: testSourceChatId,
          sourceMessageId: 200,
          destinationChatId: testDestChatId,
        }
      );

      expect(result.success).toBe(true);
      expect(result.forwardedMessageId).toBe(777);
      expect(result.errorType).toBeUndefined();
    });

    it('6. should handle an invalid destination error gracefully', async () => {
      (mockTelegram.forwardMessage as jest.Mock).mockRejectedValue(
        new Error('400: Bad Request: chat not found')
      );

      const result = await forwardingService.forwardMessage(
        mockTelegram as Telegram,
        {
          sourceChatId: testSourceChatId,
          sourceMessageId: 201,
          destinationChatId: -100999999999,
        }
      );

      expect(result.success).toBe(false);
      expect(result.errorType).toBe(ForwardErrorType.INVALID_CHAT_ID);
      expect(result.errorMessage).toContain('not found');
    });

    it('7. should handle missing bot permissions (write forbidden)', async () => {
      (mockTelegram.forwardMessage as jest.Mock).mockRejectedValue(
        new Error('403: Forbidden: CHAT_WRITE_FORBIDDEN')
      );

      const result = await forwardingService.forwardMessage(
        mockTelegram as Telegram,
        {
          sourceChatId: testSourceChatId,
          sourceMessageId: 202,
          destinationChatId: testDestChatId,
        }
      );

      expect(result.success).toBe(false);
      expect(result.errorType).toBe(ForwardErrorType.PERMISSION_DENIED);
      expect(result.errorMessage).toContain('permission to send messages');
    });

    it('8. should handle protected content restrictions', async () => {
      (mockTelegram.forwardMessage as jest.Mock).mockRejectedValue(
        new Error('400: Bad Request: CHAT_FORWARDS_RESTRICTED')
      );

      const result = await forwardingService.forwardMessage(
        mockTelegram as Telegram,
        {
          sourceChatId: testSourceChatId,
          sourceMessageId: 203,
          destinationChatId: testDestChatId,
        }
      );

      expect(result.success).toBe(false);
      expect(result.errorType).toBe(ForwardErrorType.PROTECTED_CONTENT);
      expect(result.errorMessage).toContain('content protection');
    });

    it('should sanitize bot token from error outputs', async () => {
      (mockTelegram.forwardMessage as jest.Mock).mockRejectedValue(
        new Error(`https://api.telegram.org/bot${dummyToken}/forwardMessage failed: 500 Network Timeout`)
      );

      const result = await forwardingService.forwardMessage(
        mockTelegram as Telegram,
        {
          sourceChatId: testSourceChatId,
          sourceMessageId: 204,
          destinationChatId: testDestChatId,
        },
        dummyToken
      );

      expect(result.success).toBe(false);
      expect(result.rawError).not.toContain(dummyToken);
      expect(result.rawError).toContain('[REDACTED_TOKEN]');
    });
  });

  describe('3. /test_forward Command Handlers', () => {
    let bot: Telegraf;
    let handlers: { [cmd: string]: (ctx: any) => Promise<any> };

    beforeEach(() => {
      handlers = {};
      bot = new Telegraf(dummyToken);

      jest.spyOn(bot, 'command').mockImplementation((cmd: any, handler: any) => {
        handlers[cmd] = handler;
        return bot;
      });

      setupBotHandlers(bot, dummyToken);
    });

    it('should reject unauthorized users attempting /test_forward', async () => {
      process.env.ADMIN_USER_IDS = '1001';

      const replyMock = jest.fn().mockResolvedValue({});
      const mockCtx = {
        from: { id: 9999 }, // Unauthorized user
        chat: { id: Number(testSourceChatId), type: 'supergroup' },
        message: { text: `/test_forward ${testDestChatId}` },
        getChatAdministrators: jest.fn().mockResolvedValue([]),
        reply: replyMock,
      };

      await handlers['test_forward'](mockCtx);
      expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Access denied'));
    });

    it('should reject /test_forward when executed in a private chat', async () => {
      process.env.ADMIN_USER_IDS = '1001';

      const replyMock = jest.fn().mockResolvedValue({});
      const mockCtx = {
        from: { id: 1001 },
        chat: { id: 1001, type: 'private' },
        message: { text: `/test_forward ${testDestChatId}` },
        reply: replyMock,
      };

      await handlers['test_forward'](mockCtx);
      expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Please run `/test_forward` within a Telegram group'));
    });

    it('should guide user when neither reply_to_message nor source_message_id is provided', async () => {
      process.env.ADMIN_USER_IDS = '1001';

      const replyMock = jest.fn().mockResolvedValue({});
      const mockCtx = {
        from: { id: 1001 },
        chat: { id: Number(testSourceChatId), type: 'supergroup' },
        message: { text: `/test_forward` },
        reply: replyMock,
      };

      await handlers['test_forward'](mockCtx);
      expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Usage for /test_forward'));
    });

    it('should forward successfully when replying to an announcement message', async () => {
      process.env.ADMIN_USER_IDS = '1001';

      const forwardMessageMock = jest.fn().mockResolvedValue({ message_id: 888 });
      const replyMock = jest.fn().mockResolvedValue({});

      const mockCtx = {
        from: { id: 1001 },
        chat: { id: Number(testSourceChatId), type: 'supergroup' },
        message: {
          text: `/test_forward ${testDestChatId}`,
          reply_to_message: {
            message_id: 42,
            text: 'Original Announcement in Source Group',
          },
        },
        telegram: {
          forwardMessage: forwardMessageMock,
        },
        reply: replyMock,
      };

      await handlers['test_forward'](mockCtx);

      expect(forwardMessageMock).toHaveBeenCalledWith(
        testDestChatId.toString(),
        testSourceChatId.toString(),
        42
      );
      expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Test Forward Successful!'));
      expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('#888'));
    });

    it('should forward successfully when passing explicit destination and message ID', async () => {
      process.env.ADMIN_USER_IDS = '1001';

      const forwardMessageMock = jest.fn().mockResolvedValue({ message_id: 889 });
      const replyMock = jest.fn().mockResolvedValue({});

      const mockCtx = {
        from: { id: 1001 },
        chat: { id: Number(testSourceChatId), type: 'supergroup' },
        message: {
          text: `/test_forward ${testDestChatId} 99`,
        },
        telegram: {
          forwardMessage: forwardMessageMock,
        },
        reply: replyMock,
      };

      await handlers['test_forward'](mockCtx);

      expect(forwardMessageMock).toHaveBeenCalledWith(
        testDestChatId.toString(),
        testSourceChatId.toString(),
        99
      );
      expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Test Forward Successful!'));
      expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('#889'));
    });

    it('should report failure clearly when Telegram API forward fails', async () => {
      process.env.ADMIN_USER_IDS = '1001';

      const forwardMessageMock = jest.fn().mockRejectedValue(new Error('Forbidden: CHAT_WRITE_FORBIDDEN'));
      const replyMock = jest.fn().mockResolvedValue({});

      const mockCtx = {
        from: { id: 1001 },
        chat: { id: Number(testSourceChatId), type: 'supergroup' },
        message: {
          text: `/test_forward ${testDestChatId} 100`,
        },
        telegram: {
          forwardMessage: forwardMessageMock,
        },
        reply: replyMock,
      };

      await handlers['test_forward'](mockCtx);

      expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Test Forward Failed:'));
      expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('PERMISSION_DENIED'));
    });
  });
});
