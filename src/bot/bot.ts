import { Telegraf } from 'telegraf';
import { BOT_MESSAGES } from './messages';

/**
 * Strips any occurrence of the bot token from error strings or logs.
 */
export function sanitizeError(err: unknown, token?: string): string {
  let message = err instanceof Error ? (err.message || String(err)) : String(err);
  if (token && token.length > 5) {
    message = message.split(token).join('[REDACTED_TOKEN]');
    const parts = token.split(':');
    if (parts.length === 2 && parts[1].length > 4) {
      message = message.split(parts[1]).join('[REDACTED_TOKEN]');
    }
  }
  return message;
}

/**
 * Registers commands and handlers on the Telegraf instance.
 */
export function setupBotHandlers(bot: Telegraf, token?: string): void {
  // Global error handler for Telegram polling/updates
  bot.catch((err, ctx) => {
    const safeError = sanitizeError(err, token);
    const updateType = ctx.updateType || 'unknown';
    console.error(`[Telegram Bot Error] Error during update "${updateType}": ${safeError}`);
  });

  // /start command
  bot.start(async (ctx) => {
    try {
      await ctx.reply(BOT_MESSAGES.welcome);
    } catch (err) {
      console.error('[Telegram Bot] Failed to send /start reply:', sanitizeError(err, token));
    }
  });

  // /help command
  bot.help(async (ctx) => {
    try {
      await ctx.reply(BOT_MESSAGES.help);
    } catch (err) {
      console.error('[Telegram Bot] Failed to send /help reply:', sanitizeError(err, token));
    }
  });
}

/**
 * Creates and initializes a Telegraf bot instance.
 */
export function createBot(token: string): Telegraf {
  if (!token || !token.trim()) {
    throw new Error('Cannot initialize Telegram bot: Token is missing or empty.');
  }

  const bot = new Telegraf(token.trim());
  setupBotHandlers(bot, token.trim());
  return bot;
}
