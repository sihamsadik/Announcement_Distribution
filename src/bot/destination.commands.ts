import { Telegraf } from 'telegraf';
import { isAuthorizedAdmin } from './auth';
import { destinationService } from '../services/destination.service';
import { sanitizeError } from './bot';

/**
 * Registers destination group management commands with the Telegraf bot.
 */
export function registerDestinationCommands(bot: Telegraf, token?: string): void {
  // /register_destination <source_id> <group_name>
  bot.command('register_destination', async (ctx) => {
    try {
      const isAuth = await isAuthorizedAdmin(ctx);
      if (!isAuth) {
        console.warn(`[Security Alert] Unauthorized /register_destination attempt by user ${ctx.from?.id} in chat ${ctx.chat?.id}`);
        await ctx.reply('⛔ Access denied: You are not authorized to register destination groups.');
        return;
      }

      if (!ctx.chat || (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup')) {
        await ctx.reply(
          '⚠️ Please run `/register_destination` directly inside the student Telegram group or supergroup.'
        );
        return;
      }

      const text = 'text' in ctx.message ? ctx.message.text : '';
      const rawArgs = text.replace(/^\/register_destination(@\w+)?\s*/, '').trim();

      if (!rawArgs) {
        await ctx.reply(
          'ℹ️ Usage:\n' +
          '`/register_destination <source_id> <group_name>`\n\n' +
          'Run this command inside the student destination group.\n' +
          'Tip: Use `/list_sources` to copy the source ID.'
        );
        return;
      }

      const parts = rawArgs.split(/\s+/);
      const sourceId = parts[0]?.trim();
      const groupName = parts.slice(1).join(' ').trim();

      if (!sourceId || !groupName) {
        await ctx.reply(
          '⚠️ Both Source ID and Destination Group Name are required.\n\n' +
          'Example:\n' +
          '`/register_destination 8a92b0c2-1234-5678-90ab-cdef12345678 Team Alpha Final Project`'
        );
        return;
      }

      console.log(
        `[DestinationCommand] Attempting to register chat ${ctx.chat.id} as "${groupName}" under source "${sourceId}"`
      );

      const result = await destinationService.registerDestination({
        chatId: ctx.chat.id,
        groupName,
        sourceGroupId: sourceId,
      });

      if (result.success && result.destination) {
        const dest = result.destination;
        if (result.isNew) {
          await ctx.reply(
            `✅ Destination Group Registered Successfully!\n\n` +
            `👥 Group Name: ${dest.groupName}\n` +
            `💬 Chat ID: ${dest.chatId}\n` +
            `🆔 Destination ID: \`${dest.id}\`\n` +
            `🔗 Source: ${dest.sourceGroup.name} (\`${dest.sourceGroupId}\`)\n` +
            `🟢 Status: Active\n\n` +
            `Note: Ensure the bot is added as an administrator or granted permission to send messages here.`
          );
        } else {
          await ctx.reply(
            `ℹ️ Destination Group Already Registered:\n\n` +
            `👥 Group Name: ${dest.groupName}\n` +
            `💬 Chat ID: ${dest.chatId}\n` +
            `🆔 Destination ID: \`${dest.id}\`\n` +
            `🔗 Source: ${dest.sourceGroup.name}\n` +
            `Status: ${dest.isActive ? '🟢 Active' : '🔴 Inactive'}`
          );
        }
      } else {
        await ctx.reply(`❌ Registration Failed: ${result.message}`);
      }
    } catch (err) {
      console.error('[Telegram Bot] Error in /register_destination:', sanitizeError(err, token));
      await ctx.reply('❌ An error occurred while registering the destination group.');
    }
  });

  // /list_destinations [source_id]
  bot.command('list_destinations', async (ctx) => {
    try {
      const isAuth = await isAuthorizedAdmin(ctx);
      if (!isAuth) {
        console.warn(`[Security Alert] Unauthorized /list_destinations attempt by user ${ctx.from?.id}`);
        await ctx.reply('⛔ Access denied: You are not authorized to view destination groups.');
        return;
      }

      const text = 'text' in ctx.message ? ctx.message.text : '';
      const rawArgs = text.replace(/^\/list_destinations(@\w+)?\s*/, '').trim();
      const sourceId = rawArgs ? rawArgs.split(/\s+/)[0] : undefined;

      const destinations = await destinationService.listDestinations(sourceId);

      if (destinations.length === 0) {
        if (sourceId) {
          await ctx.reply(
            `📋 No destination groups found for source ID: \`${sourceId}\`.\n\n` +
            `Use \`/register_destination ${sourceId} <group_name>\` inside a student group to add one.`
          );
        } else {
          await ctx.reply(
            '📋 No destination groups are currently registered.\n\n' +
            'Use `/list_sources` to copy a source ID, then run `/register_destination <source_id> <group_name>` inside each student group.'
          );
        }
        return;
      }

      let response = `📋 Registered Destination Groups (${destinations.length}):\n\n`;
      for (const dest of destinations) {
        const statusIcon = dest.isActive ? '🟢 Active' : '🔴 Inactive';
        response +=
          `• ${dest.groupName}\n` +
          `  Status: ${statusIcon}\n` +
          `  Chat ID: ${dest.chatId}\n` +
          `  Destination ID: ${dest.id}\n` +
          `  Source: ${dest.sourceGroup.name} (${dest.sourceGroupId})\n\n`;
      }

      await ctx.reply(response);
    } catch (err) {
      console.error('[Telegram Bot] Error in /list_destinations:', sanitizeError(err, token));
      await ctx.reply('❌ An error occurred while fetching the destination groups list.');
    }
  });

  // /remove_destination <destination_id> (Deactivates instead of deleting)
  bot.command('remove_destination', async (ctx) => {
    try {
      const isAuth = await isAuthorizedAdmin(ctx);
      if (!isAuth) {
        console.warn(`[Security Alert] Unauthorized /remove_destination attempt by user ${ctx.from?.id}`);
        await ctx.reply('⛔ Access denied: You are not authorized to deactivate destination groups.');
        return;
      }

      const text = 'text' in ctx.message ? ctx.message.text : '';
      const rawArgs = text.replace(/^\/remove_destination(@\w+)?\s*/, '').trim();
      const destinationId = rawArgs.split(/\s+/)[0];

      if (!destinationId) {
        await ctx.reply(
          'ℹ️ Usage:\n' +
          '`/remove_destination <destination_id>`\n\n' +
          'Tip: Use `/list_destinations` to find the destination ID.'
        );
        return;
      }

      const result = await destinationService.setDestinationStatus(destinationId, false);

      if (result.success && result.destination) {
        await ctx.reply(
          `🛑 Destination Deactivated Successfully:\n\n` +
          `👥 Group: ${result.destination.groupName}\n` +
          `🆔 Destination ID: \`${result.destination.id}\`\n` +
          `🔗 Source: ${result.destination.sourceGroup.name}\n` +
          `🔴 Status: Inactive (Delivery history retained. Use /activate_destination to resume).`
        );
      } else {
        await ctx.reply(`❌ Failed to deactivate destination: ${result.message}`);
      }
    } catch (err) {
      console.error('[Telegram Bot] Error in /remove_destination:', sanitizeError(err, token));
      await ctx.reply('❌ An error occurred while deactivating the destination group.');
    }
  });

  // /activate_destination <destination_id>
  bot.command('activate_destination', async (ctx) => {
    try {
      const isAuth = await isAuthorizedAdmin(ctx);
      if (!isAuth) {
        console.warn(`[Security Alert] Unauthorized /activate_destination attempt by user ${ctx.from?.id}`);
        await ctx.reply('⛔ Access denied: You are not authorized to activate destination groups.');
        return;
      }

      const text = 'text' in ctx.message ? ctx.message.text : '';
      const rawArgs = text.replace(/^\/activate_destination(@\w+)?\s*/, '').trim();
      const destinationId = rawArgs.split(/\s+/)[0];

      if (!destinationId) {
        await ctx.reply(
          'ℹ️ Usage:\n' +
          '`/activate_destination <destination_id>`\n\n' +
          'Tip: Use `/list_destinations` to find the destination ID.'
        );
        return;
      }

      const result = await destinationService.setDestinationStatus(destinationId, true);

      if (result.success && result.destination) {
        await ctx.reply(
          `🟢 Destination Reactivated Successfully:\n\n` +
          `👥 Group: ${result.destination.groupName}\n` +
          `🆔 Destination ID: \`${result.destination.id}\`\n` +
          `🔗 Source: ${result.destination.sourceGroup.name}\n` +
          `🟢 Status: Active (Ready to receive announcements).`
        );
      } else {
        await ctx.reply(`❌ Failed to reactivate destination: ${result.message}`);
      }
    } catch (err) {
      console.error('[Telegram Bot] Error in /activate_destination:', sanitizeError(err, token));
      await ctx.reply('❌ An error occurred while activating the destination group.');
    }
  });
}
