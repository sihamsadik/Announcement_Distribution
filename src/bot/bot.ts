import { Telegraf } from 'telegraf';
import { BOT_MESSAGES } from './messages';
import { isAuthorizedAdmin } from './auth';
import { sourceService } from '../services/source.service';
import { detectSourceAnnouncement } from './detector';
import { registerDestinationCommands } from './destination.commands';
import { registerForwardingCommands } from './forwarding.commands';
import { distributionService } from '../services/distribution.service';

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

  // /register_source command
  bot.command('register_source', async (ctx) => {
    try {
      const isAuth = await isAuthorizedAdmin(ctx);
      if (!isAuth) {
        await ctx.reply('⛔ Access denied: You are not authorized to register announcement sources.');
        return;
      }

      if (!ctx.chat || (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup')) {
        await ctx.reply('⚠️ Please run `/register_source` within a Telegram group or supergroup.');
        return;
      }

      const text = 'text' in ctx.message ? ctx.message.text : '';
      const rawArgs = text.replace(/^\/register_source(@\w+)?\s*/, '').trim();

      if (!rawArgs) {
        await ctx.reply(
          'ℹ️ Usage:\n' +
          '• Inside a forum topic: `/register_source <Source Name>`\n' +
          '• With explicit topic ID: `/register_source <Topic ID> <Source Name>`\n\n' +
          'Example: `/register_source Final Project`'
        );
        return;
      }

      const contextTopicId = (ctx.message as any).message_thread_id;
      const parts = rawArgs.split(/\s+/);
      let targetTopicId: number | undefined;
      let sourceName = '';

      if (/^\d+$/.test(parts[0])) {
        // Explicit topic ID provided in command arguments
        targetTopicId = parseInt(parts[0], 10);
        sourceName = parts.slice(1).join(' ').trim();
      } else if (contextTopicId !== undefined) {
        // Inherited topic ID from Telegram forum context
        targetTopicId = contextTopicId;
        sourceName = rawArgs;
      }

      if (targetTopicId === undefined) {
        await ctx.reply(
          '⚠️ Telegram Topic ID not found.\n\n' +
          'Telegram did not include a forum topic thread ID for this message.\n' +
          'This occurs when running in general chat or non-forum groups.\n\n' +
          '👉 Please run inside the forum topic, or specify the topic ID explicitly:\n' +
          '`/register_source <Topic ID> <Source Name>`'
        );
        return;
      }

      if (!sourceName) {
        await ctx.reply('⚠️ Please provide a name for this source topic.\nExample: `/register_source Final Project`');
        return;
      }

      const result = await sourceService.registerSource({
        chatId: ctx.chat.id,
        topicId: targetTopicId,
        name: sourceName,
      });

      if (result.success) {
        if (result.isNew) {
          await ctx.reply(
            `✅ Source Registered Successfully!\n\n` +
            `📌 Name: ${result.source!.name}\n` +
            `💬 Chat ID: ${result.source!.chatId}\n` +
            `🧵 Topic ID: ${result.source!.topicId}`
          );
        } else {
          await ctx.reply(
            `ℹ️ Source is already registered:\n\n` +
            `📌 Name: ${result.source!.name}\n` +
            `💬 Chat ID: ${result.source!.chatId}\n` +
            `🧵 Topic ID: ${result.source!.topicId}`
          );
        }
      } else {
        await ctx.reply(`❌ Failed to register source: ${result.message}`);
      }
    } catch (err) {
      console.error('[Telegram Bot] Error in /register_source:', sanitizeError(err, token));
      await ctx.reply('❌ An error occurred while processing your request.');
    }
  });

  // /list_sources command
  bot.command('list_sources', async (ctx) => {
    try {
      const isAuth = await isAuthorizedAdmin(ctx);
      if (!isAuth) {
        await ctx.reply('⛔ Access denied: You are not authorized to view registered sources.');
        return;
      }

      const sources = await sourceService.listSources();
      if (sources.length === 0) {
        await ctx.reply('📋 No source topics are currently registered.\n\nUse `/register_source` to register one.');
        return;
      }

      let response = `📋 Registered Source Topics (${sources.length}):\n\n`;
      for (const src of sources) {
        response += `• ${src.name}\n  Chat ID: ${src.chatId}\n  Topic ID: ${src.topicId}\n\n`;
      }

      await ctx.reply(response);
    } catch (err) {
      console.error('[Telegram Bot] Error in /list_sources:', sanitizeError(err, token));
      await ctx.reply('❌ An error occurred while fetching the sources list.');
    }
  });

  // Register destination management commands (/register_destination, /list_destinations, etc.)
  registerDestinationCommands(bot, token);

  // Register message forwarding test command (/test_forward)
  registerForwardingCommands(bot, token);

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
