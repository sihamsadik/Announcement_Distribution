import { Telegraf } from 'telegraf';
import { isAuthorizedAdmin, denyUnauthorizedAccess } from './auth';
import { sourceService } from '../services/source.service';
import { sanitizeError } from '../utils/sanitize';

/**
 * Registers source management commands with the Telegraf bot.
 */
export function registerSourceCommands(bot: Telegraf, token?: string): void {
  // /register_source [topicId] <source_name>
  bot.command('register_source', async (ctx) => {
    try {
      const isAuth = await isAuthorizedAdmin(ctx);
      if (!isAuth) {
        await denyUnauthorizedAccess(ctx, 'register announcement sources');
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
          'ℹ️ **Usage**:\n' +
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
          '⚠️ **Telegram Topic ID not found**.\n\n' +
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

      if (result.success && result.source) {
        const src = result.source;
        if (result.isNew) {
          await ctx.reply(
            `✅ **Source Registered Successfully!**\n\n` +
            `📌 **Name:** ${src.name}\n` +
            `💬 **Chat ID:** \`${src.chatId}\`\n` +
            `🧵 **Topic ID:** \`${src.topicId}\`\n` +
            `🆔 **Source ID:** \`${src.id}\`\n` +
            `🟢 **Status:** Active\n\n` +
            `Use \`/register_destination ${src.id} <GroupName>\` inside student groups to link destinations.`
          );
        } else {
          await ctx.reply(
            `ℹ️ **Source Already Registered**:\n\n` +
            `📌 **Name:** ${src.name}\n` +
            `💬 **Chat ID:** \`${src.chatId}\`\n` +
            `🧵 **Topic ID:** \`${src.topicId}\`\n` +
            `🆔 **Source ID:** \`${src.id}\`\n` +
            `Status: ${src.isActive ? '🟢 Active' : '🔴 Inactive'}`
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

  // /list_sources
  bot.command('list_sources', async (ctx) => {
    try {
      const isAuth = await isAuthorizedAdmin(ctx);
      if (!isAuth) {
        await denyUnauthorizedAccess(ctx, 'view registered sources');
        return;
      }

      const sources = await sourceService.listSources();
      if (sources.length === 0) {
        await ctx.reply('📋 No source topics are currently registered.\n\nUse `/register_source` to register one.');
        return;
      }

      let response = `📋 **Registered Source Topics (${sources.length})**:\n\n`;
      for (const src of sources) {
        const statusIcon = src.isActive ? '🟢 Active' : '🔴 Inactive';
        response +=
          `• **${src.name}**\n` +
          `  Status: ${statusIcon}\n` +
          `  Source ID: \`${src.id}\`\n` +
          `  Chat ID: \`${src.chatId}\` | Topic ID: \`${src.topicId}\`\n` +
          `  Destinations: ${src.destinationGroups?.length ?? 0} registered\n\n`;
      }

      response += '💡 Use `/source_details <source_id>` to view linked destinations and delivery statistics.';

      await ctx.reply(response);
    } catch (err) {
      console.error('[Telegram Bot] Error in /list_sources:', sanitizeError(err, token));
      await ctx.reply('❌ An error occurred while fetching the sources list.');
    }
  });

  // /source_details <source_id>
  bot.command('source_details', async (ctx) => {
    try {
      const isAuth = await isAuthorizedAdmin(ctx);
      if (!isAuth) {
        await denyUnauthorizedAccess(ctx, 'view source details');
        return;
      }

      const text = 'text' in ctx.message ? ctx.message.text : '';
      const rawArgs = text.replace(/^\/source_details(@\w+)?\s*/, '').trim();
      const sourceId = rawArgs.split(/\s+/)[0];

      if (!sourceId) {
        await ctx.reply('ℹ️ Usage: `/source_details <source_id>`\n\nTip: Use `/list_sources` to copy a source ID.');
        return;
      }

      const details = await sourceService.getSourceDetails(sourceId);
      if (!details) {
        await ctx.reply(`❌ Source not found with ID: \`${sourceId}\``);
        return;
      }

      const src = details.source;
      const statusIcon = src.isActive ? '🟢 Active' : '🔴 Inactive';

      let response =
        `📌 **Source Details: "${src.name}"**\n\n` +
        `• **Source ID:** \`${src.id}\`\n` +
        `• **Status:** ${statusIcon}\n` +
        `• **Chat ID:** \`${src.chatId}\`\n` +
        `• **Topic ID:** \`${src.topicId}\`\n` +
        `• **Registered At:** ${src.createdAt.toISOString().replace('T', ' ').substring(0, 19)}\n\n` +
        `📊 **Delivery Metrics**:\n` +
        `• Total Deliveries: ${details.totalDeliveries}\n` +
        `• Successful: ${details.successfulDeliveries} ✅\n` +
        `• Failed / Retrying: ${details.failedDeliveries} ❌\n\n` +
        `👥 **Associated Destinations (${details.totalDestinations})**:\n`;

      if (details.destinations.length === 0) {
        response += `  _No destinations linked yet._\n  _Use \`/register_destination ${src.id} <name>\` to add one._\n`;
      } else {
        for (const dest of details.destinations) {
          const destStatus = dest.isActive ? '🟢 Active' : '🔴 Inactive';
          response += `  • **${dest.groupName}** (${destStatus})\n    ID: \`${dest.id}\` | Chat: \`${dest.chatId}\`\n`;
        }
      }

      await ctx.reply(response);
    } catch (err) {
      console.error('[Telegram Bot] Error in /source_details:', sanitizeError(err, token));
      await ctx.reply('❌ An error occurred while fetching source details.');
    }
  });

  // /remove_source <source_id>
  bot.command('remove_source', async (ctx) => {
    try {
      const isAuth = await isAuthorizedAdmin(ctx);
      if (!isAuth) {
        await denyUnauthorizedAccess(ctx, 'remove or deactivate announcement sources');
        return;
      }

      const text = 'text' in ctx.message ? ctx.message.text : '';
      const rawArgs = text.replace(/^\/remove_source(@\w+)?\s*/, '').trim();
      const parts = rawArgs.split(/\s+/);
      const sourceId = parts[0];
      const isForce = parts.includes('--force');

      if (!sourceId) {
        await ctx.reply(
          'ℹ️ **Usage**:\n' +
          '• Soft deactivation (recommended): `/remove_source <source_id>`\n' +
          '• Permanent deletion (only if no logs exist): `/remove_source <source_id> --force`\n\n' +
          'Tip: Use `/list_sources` to copy a source ID.'
        );
        return;
      }

      if (isForce) {
        // Attempt hard deletion (guarded against foreign key / log loss)
        const deleteResult = await sourceService.deleteSource(sourceId);
        if (deleteResult.success) {
          await ctx.reply(`🗑️ **Source Deleted Successfully!**\n\nSource ID: \`${sourceId}\``);
        } else {
          await ctx.reply(`❌ **Cannot Delete Source**:\n${deleteResult.message}`);
        }
        return;
      }

      // Safe soft deactivation (default behavior preserving all delivery logs)
      const result = await sourceService.setSourceStatus(sourceId, false);
      if (result.success && result.source) {
        await ctx.reply(
          `🛑 **Source Deactivated Successfully!**\n\n` +
          `📌 **Source:** ${result.source.name}\n` +
          `🆔 **Source ID:** \`${result.source.id}\`\n` +
          `🔴 **Status:** Inactive\n\n` +
          `🛡️ _Historical delivery logs and destination links have been safely preserved._\n` +
          `_New messages posted in this source topic will NOT be distributed._\n` +
          `_Use \`/activate_source ${result.source.id}\` to reactivate at any time._`
        );
      } else {
        await ctx.reply(`❌ Failed to deactivate source: ${result.message}`);
      }
    } catch (err) {
      console.error('[Telegram Bot] Error in /remove_source:', sanitizeError(err, token));
      await ctx.reply('❌ An error occurred while deactivating the source.');
    }
  });

  // /activate_source <source_id>
  bot.command('activate_source', async (ctx) => {
    try {
      const isAuth = await isAuthorizedAdmin(ctx);
      if (!isAuth) {
        await denyUnauthorizedAccess(ctx, 'activate announcement sources');
        return;
      }

      const text = 'text' in ctx.message ? ctx.message.text : '';
      const rawArgs = text.replace(/^\/activate_source(@\w+)?\s*/, '').trim();
      const sourceId = rawArgs.split(/\s+/)[0];

      if (!sourceId) {
        await ctx.reply('ℹ️ Usage: `/activate_source <source_id>`\n\nTip: Use `/list_sources` to copy a source ID.');
        return;
      }

      const result = await sourceService.setSourceStatus(sourceId, true);
      if (result.success && result.source) {
        await ctx.reply(
          `🟢 **Source Reactivated Successfully!**\n\n` +
          `📌 **Source:** ${result.source.name}\n` +
          `🆔 **Source ID:** \`${result.source.id}\`\n` +
          `🟢 **Status:** Active\n\n` +
          `Announcements in this topic will now be distributed to active destinations.`
        );
      } else {
        await ctx.reply(`❌ Failed to reactivate source: ${result.message}`);
      }
    } catch (err) {
      console.error('[Telegram Bot] Error in /activate_source:', sanitizeError(err, token));
      await ctx.reply('❌ An error occurred while activating the source.');
    }
  });
}
