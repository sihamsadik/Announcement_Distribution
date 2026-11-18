import { Telegraf } from 'telegraf';
import { BOT_MESSAGES } from './messages';
import { registerSourceCommands } from './source.commands';
import { registerDestinationCommands } from './destination.commands';
import { registerForwardingCommands } from './forwarding.commands';
import { registerMonitoringCommands } from './monitoring.commands';
import { distributionService } from '../services/distribution.service';
import { sanitizeError } from '../utils/sanitize';

export { sanitizeError };

/**
 * Registers commands, listeners, and handlers on the Telegraf instance.
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

  // Register source management commands (/register_source, /list_sources, /source_details, /remove_source, /activate_source)
  registerSourceCommands(bot, token);

  // Register destination management commands (/register_destination, /list_destinations, /remove_destination, /activate_destination)
  registerDestinationCommands(bot, token);

  // Register message forwarding test command (/test_forward)
  registerForwardingCommands(bot, token);

  // Register delivery monitoring commands (/delivery_stats, /recent_deliveries, /failed_deliveries, /delivery_details)
  registerMonitoringCommands(bot, token);

  // Listener for general messages: detects announcements from registered source topics and distributes them
  bot.on('message', async (ctx, next) => {
    try {
      await distributionService.processIncomingMessage(ctx, token);
    } catch (err) {
      console.error('[Telegram Bot] Error during announcement distribution:', sanitizeError(err, token));
    }

    return await next();
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
