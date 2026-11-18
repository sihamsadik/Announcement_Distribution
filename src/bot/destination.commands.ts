import { Telegraf } from 'telegraf';
import { isAuthorizedAdmin, denyUnauthorizedAccess } from './auth';
import { destinationService } from '../services/destination.service';
import { sanitizeError } from '../utils/sanitize';
import { isValidUuid, validateResourceName } from '../utils/validators';

/**
 * Registers destination group management commands with the Telegraf bot.
 */
export function registerDestinationCommands(bot: Telegraf, token?: string): void {
  // /register_destination <source_id> <group_name>
  bot.command('register_destination', async (ctx) => {
    try {
      const isAuth = await isAuthorizedAdmin(ctx);
      if (!isAuth) {
        await denyUnauthorizedAccess(ctx, 'register destination groups');
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
          'ℹ️ **Usage**:\n' +
          '`/register_destination <source_id> <group_name>`\n\n' +
          'Run this command inside the student destination group.\n' +
          'Tip: Use `/list_sources` to copy the source ID.'
        );
        return;
      }

      const parts = rawArgs.split(/\s+/);
      const sourceId = parts[0]?.trim();
      const rawGroupName = parts.slice(1).join(' ').trim();

      if (!sourceId || !rawGroupName) {
        await ctx.reply(
          '⚠️ Both Source ID and Destination Group Name are required.\n\n' +
          'Example:\n' +
          '`/register_destination 8a92b0c2-1234-5678-90ab-cdef12345678 Team Alpha Final Project`'
        );
        return;
      }

      if (!isValidUuid(sourceId)) {
        await ctx.reply(
          '❌ Invalid Source ID format. Expected a valid UUID (e.g. 12345678-1234-1234-1234-123456789abc).\n\nTip: Use `/list_sources` to copy a valid ID.'
        );
        return;
      }

      const nameValidation = validateResourceName(rawGroupName, 'Destination group name');
      if (!nameValidation.valid) {
        await ctx.reply(`⚠️ ${nameValidation.error}`);
        return;
      }

      console.log(
        `[DestinationCommand] Attempting to register chat ${ctx.chat.id} as "${nameValidation.value}" under source "${sourceId}"`
      );

      const result = await destinationService.registerDestination({
        chatId: ctx.chat.id,
        groupName: nameValidation.value!,
        sourceGroupId: sourceId,
      });

      if (result.success && result.destination) {
        const dest = result.destination;
        if (result.isNew) {
          await ctx.reply(
            `✅ **Destination Group Registered Successfully!**\n\n` +
            `👥 **Group Name:** ${dest.groupName}\n` +
            `💬 **Chat ID:** \`${dest.chatId}\`\n` +
            `🆔 **Destination ID:** \`${dest.id}\`\n` +
            `🔗 **Source:** ${dest.sourceGroup.name} (\`${dest.sourceGroupId}\`)\n` +
            `🟢 **Status:** Active\n\n` +
            `Note: Ensure the bot is added as an administrator or granted permission to send messages here.`
          );
        } else {
          await ctx.reply(
            `ℹ️ **Destination Group Already Registered**:\n\n` +
            `👥 **Group Name:** ${dest.groupName}\n` +
            `💬 **Chat ID:** \`${dest.chatId}\`\n` +
            `🆔 **Destination ID:** \`${dest.id}\`\n` +
            `🔗 **Source:** ${dest.sourceGroup.name}\n` +
            `Status: ${dest.isActive ? '🟢 Active' : '🔴 Inactive'}`
          );
        }
      } else {
        await ctx.reply(`❌ **Registration Failed**: ${result.message}`);
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
        await denyUnauthorizedAccess(ctx, 'view destination groups');
        return;
      }

      const text = 'text' in ctx.message ? ctx.message.text : '';
      const rawArgs = text.replace(/^\/list_destinations(@\w+)?\s*/, '').trim();
      const sourceId = rawArgs ? rawArgs.split(/\s+/)[0] : undefined;

      if (sourceId && !isValidUuid(sourceId)) {
        await ctx.reply('❌ Invalid Source ID format. Expected a valid UUID.\n\nTip: Use `/list_sources` to copy a valid ID.');
        return;
      }

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

      let response = `📋 **Registered Destination Groups (${destinations.length})**:\n\n`;
      for (const dest of destinations) {
        const statusIcon = dest.isActive ? '🟢 Active' : '🔴 Inactive';
        response +=
          `• **${dest.groupName}**\n` +
          `  Status: ${statusIcon}\n` +
          `  Destination ID: \`${dest.id}\`\n` +
          `  Chat ID: \`${dest.chatId}\`\n` +
          `  Source: ${dest.sourceGroup.name} (\`${dest.sourceGroupId}\`)\n\n`;
      }

      response += '💡 Use `/remove_destination <id>` to deactivate or `/activate_destination <id>` to reactivate.';

      await ctx.reply(response);
    } catch (err) {
      console.error('[Telegram Bot] Error in /list_destinations:', sanitizeError(err, token));
      await ctx.reply('❌ An error occurred while fetching the destination groups list.');
    }
  });

  // /remove_destination <destination_id> [--force]
  bot.command('remove_destination', async (ctx) => {
    try {
      const isAuth = await isAuthorizedAdmin(ctx);
      if (!isAuth) {
        await denyUnauthorizedAccess(ctx, 'remove or deactivate destination groups');
        return;
      }

      const text = 'text' in ctx.message ? ctx.message.text : '';
      const rawArgs = text.replace(/^\/remove_destination(@\w+)?\s*/, '').trim();
      const parts = rawArgs.split(/\s+/);
      const destinationId = parts[0];
      const isForce = parts.includes('--force');

      if (!destinationId) {
        await ctx.reply(
          'ℹ️ **Usage**:\n' +
          '• Soft deactivation (recommended): `/remove_destination <destination_id>`\n' +
          '• Permanent deletion (only if no logs exist): `/remove_destination <destination_id> --force`\n\n' +
          'Tip: Use `/list_destinations` to find the destination ID.'
        );
        return;
      }

      if (!isValidUuid(destinationId)) {
        await ctx.reply('❌ Invalid Destination ID format. Expected a valid UUID.\n\nTip: Use `/list_destinations` to find the ID.');
        return;
      }

      if (isForce) {
        // Attempt hard deletion (guarded against foreign key / log loss)
        const deleteResult = await destinationService.deleteDestination(destinationId);
        if (deleteResult.success) {
          await ctx.reply(`🗑️ **Destination Deleted Successfully!**\n\nDestination ID: \`${destinationId}\``);
        } else {
          await ctx.reply(`❌ **Cannot Delete Destination**:\n${deleteResult.message}`);
        }
        return;
      }

      // Safe soft deactivation (default behavior preserving all delivery logs)
      const result = await destinationService.setDestinationStatus(destinationId, false);

      if (result.success && result.destination) {
        await ctx.reply(
          `🛑 **Destination Deactivated Successfully!**\n\n` +
          `👥 **Group:** ${result.destination.groupName}\n` +
          `🆔 **Destination ID:** \`${result.destination.id}\`\n` +
          `🔗 **Source:** ${result.destination.sourceGroup.name}\n` +
          `🔴 **Status:** Inactive\n\n` +
          `🛡️ _Historical delivery logs are safely preserved._\n` +
          `_Use \`/activate_destination ${result.destination.id}\` to resume announcements at any time._`
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
        await denyUnauthorizedAccess(ctx, 'activate destination groups');
        return;
      }

      const text = 'text' in ctx.message ? ctx.message.text : '';
      const rawArgs = text.replace(/^\/activate_destination(@\w+)?\s*/, '').trim();
      const destinationId = rawArgs.split(/\s+/)[0];

      if (!destinationId) {
        await ctx.reply(
          'ℹ️ **Usage**: `/activate_destination <destination_id>`\n\nTip: Use `/list_destinations` to find the destination ID.'
        );
        return;
      }

      if (!isValidUuid(destinationId)) {
        await ctx.reply('❌ Invalid Destination ID format. Expected a valid UUID.\n\nTip: Use `/list_destinations` to find the ID.');
        return;
      }

      const result = await destinationService.setDestinationStatus(destinationId, true);

      if (result.success && result.destination) {
        await ctx.reply(
          `🟢 **Destination Reactivated Successfully!**\n\n` +
          `👥 **Group:** ${result.destination.groupName}\n` +
          `🆔 **Destination ID:** \`${result.destination.id}\`\n` +
          `🔗 **Source:** ${result.destination.sourceGroup.name}\n` +
          `🟢 **Status:** Active (Ready to receive announcements).`
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
