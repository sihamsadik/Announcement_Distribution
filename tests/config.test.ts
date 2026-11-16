import { loadConfig } from '../src/config/env';

describe('Environment Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should successfully load configuration when TELEGRAM_BOT_TOKEN is provided', () => {
    process.env.TELEGRAM_BOT_TOKEN = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ';
    const config = loadConfig();

    expect(config.telegramBotToken).toBe('123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ');
    expect(config.nodeEnv).toBeDefined();
  });

  it('should trim whitespace from TELEGRAM_BOT_TOKEN', () => {
    process.env.TELEGRAM_BOT_TOKEN = '  token_with_spaces  ';
    const config = loadConfig();

    expect(config.telegramBotToken).toBe('token_with_spaces');
  });

  it('should throw an error when TELEGRAM_BOT_TOKEN is missing', () => {
    delete process.env.TELEGRAM_BOT_TOKEN;

    expect(() => loadConfig()).toThrow(
      'Missing required environment variable: TELEGRAM_BOT_TOKEN'
    );
  });

  it('should throw an error when TELEGRAM_BOT_TOKEN is empty or only whitespace', () => {
    process.env.TELEGRAM_BOT_TOKEN = '   ';

    expect(() => loadConfig()).toThrow(
      'Missing required environment variable: TELEGRAM_BOT_TOKEN'
    );
  });

  it('should not leak token in error messages', () => {
    delete process.env.TELEGRAM_BOT_TOKEN;

    try {
      loadConfig();
      fail('Expected loadConfig to throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('undefined');
    }
  });
});
