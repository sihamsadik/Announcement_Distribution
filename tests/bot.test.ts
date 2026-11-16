import { Telegraf, Context } from 'telegraf';
import { createBot, sanitizeError, setupBotHandlers } from '../src/bot/bot';
import { BOT_MESSAGES } from '../src/bot/messages';

describe('Telegram Bot Initialization & Handlers', () => {
  const dummyToken = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ';

  it('should create a Telegraf instance with a valid token', () => {
    const bot = createBot(dummyToken);
    expect(bot).toBeInstanceOf(Telegraf);
  });

  it('should throw an error if token is empty or whitespace', () => {
    expect(() => createBot('')).toThrow('Cannot initialize Telegram bot: Token is missing or empty.');
    expect(() => createBot('   ')).toThrow('Cannot initialize Telegram bot: Token is missing or empty.');
  });

  it('should sanitize sensitive tokens from error strings', () => {
    const sensitiveError = new Error(`Request to https://api.telegram.org/bot${dummyToken}/getMe failed`);
    const sanitized = sanitizeError(sensitiveError, dummyToken);

    expect(sanitized).not.toContain(dummyToken);
    expect(sanitized).toContain('[REDACTED_TOKEN]');
  });

  it('should handle non-Error objects in sanitizeError', () => {
    const sanitized = sanitizeError(`Error with token ${dummyToken}`, dummyToken);
    expect(sanitized).not.toContain(dummyToken);
    expect(sanitized).toContain('[REDACTED_TOKEN]');
  });

  describe('Command Handlers', () => {
    let bot: Telegraf;
    let handlers: { [command: string]: (ctx: any) => Promise<any> };

    beforeEach(() => {
      handlers = {};
      bot = new Telegraf(dummyToken);

      // Spy on start and help registration
      jest.spyOn(bot, 'start').mockImplementation((handler: any) => {
        handlers['start'] = handler;
        return bot;
      });

      jest.spyOn(bot, 'help').mockImplementation((handler: any) => {
        handlers['help'] = handler;
        return bot;
      });

      setupBotHandlers(bot, dummyToken);
    });

    it('should register /start handler and reply with welcome message', async () => {
      expect(handlers['start']).toBeDefined();

      const replyMock = jest.fn().mockResolvedValue({});
      const mockCtx = {
        reply: replyMock,
        updateType: 'message',
      };

      await handlers['start'](mockCtx);
      expect(replyMock).toHaveBeenCalledWith(BOT_MESSAGES.welcome);
    });

    it('should register /help handler and reply with help message', async () => {
      expect(handlers['help']).toBeDefined();

      const replyMock = jest.fn().mockResolvedValue({});
      const mockCtx = {
        reply: replyMock,
        updateType: 'message',
      };

      await handlers['help'](mockCtx);
      expect(replyMock).toHaveBeenCalledWith(BOT_MESSAGES.help);
      expect(BOT_MESSAGES.help).toContain('final-project announcement');
    });

    it('should catch handler errors gracefully without crashing', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const mockCtx = {
        reply: jest.fn().mockRejectedValue(new Error('Network error')),
        updateType: 'message',
      };

      await handlers['start'](mockCtx);
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });
});
