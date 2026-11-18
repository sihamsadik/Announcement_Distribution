import { Telegraf } from 'telegraf';
import { isAuthorizedAdmin, denyUnauthorizedAccess } from './auth';
import { forwardingService } from '../services/forwarding.service';
import { sanitizeError } from './bot';
import { isValidTelegramChatId } from '../utils/validators';

/**
 * Registers controlled message forwarding commands for administrator testing.
 */
export function registerForwardingCommands(bot: Telegraf, token?: string): void {
  // /test_forward <destination_chat_id> [source_message_id]
  bot.command('test_forward', async (ctx) => {
    try {
      const isAuth = await isAuthorizedAdmin(ctx);
      if (!isAuth) {
        await denyUnauthorizedAccess(ctx, 'test message forwarding');
        return;
      }

      if (!ctx.chat || (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup')) {
        await ctx.reply('⚠️ Please run `/test_forward` within a Telegram group or supergroup.');
        return;
      }

      const message = ctx.message;
      const text = 'text' in message ? message.text : '';
      const rawArgs = text.replace(/^\/test_forward(@\w+)?\s*/, '').trim();
      const parts = rawArgs.split(/\s+/).filter(Boolean);

      const replyToMsg = 'reply_to_message' in message ? (message as any).reply_to_message : undefined;

      let destinationChatIdStr = '';
      let targetMessageId: number | undefined;

      if (replyToMsg) {
        // Method 1 (Preferred): Command sent as a reply to the announcement message
        destinationChatIdStr = parts[0]?.trim();
        targetMessageId = replyToMsg.message_id;
      } else if (parts.length >= 2 && /^-?\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
        // Method 2: Explicitly specified both destination and source message ID
        destinationChatIdStr = parts[0].trim();
        targetMessageId = parseInt(parts[1], 10);
      }

      if (!destinationChatIdStr || targetMessageId === undefined) {
        await ctx.reply(
          'ℹ️ **Usage for /test_forward**:\n\n' +
          '• **Method 1 (Recommended)**: Reply to the announcement message with:\n' +
          '`/test_forward <destination_chat_id>`\n\n' +
          '• **Method 2**: Explicitly provide both destination and message ID:\n' +
          '`/test_forward <destination_chat_id> <source_message_id>`\n\n' +
          '*(Note: The command message itself is never treated as the announcement to forward).*'
        );
        return;
      }

      if (!isValidTelegramChatId(destinationChatIdStr)) {
        await ctx.reply('⚠️ Invalid destination chat ID. Please provide a numeric Telegram chat ID (e.g. -1001234567890).');
        return;
      }

      if (targetMessageId <= 0 || !Number.isInteger(targetMessageId)) {
        await ctx.reply('⚠️ Invalid source message ID. Must be a positive integer.');
        return;
      }

      const sourceChatId = ctx.chat.id;

      console.log(
        `[TestForward] Admin ${ctx.from?.id} initiating test forward: ` +
        `source ${sourceChatId}, message #${targetMessageId} -> destination ${destinationChatIdStr}`
      );

      const result = await forwardingService.forwardMessage(
        ctx.telegram,
        {
          sourceChatId,
          sourceMessageId: targetMessageId,
          destinationChatId: destinationChatIdStr,
        },
        token
      );

      if (result.success) {
        await ctx.reply(
          `✅ Test Forward Successful!\n\n` +
          `• Source Chat: \`${sourceChatId}\`\n` +
          `• Source Message ID: #${targetMessageId}\n` +
          `• Destination Chat: \`${destinationChatIdStr}\`\n` +
          `• Delivered Message ID: #${result.forwardedMessageId}`
        );
      } else {
        await ctx.reply(
          `❌ Test Forward Failed:\n\n` +
          `• Error Type: \`${result.errorType}\`\n` +
          `• Transient: ${result.isTransient ? 'Yes (eligible for retry)' : 'No (permanent failure)'}\n` +
          `• Details: ${result.errorMessage}`
        );
      }
    } catch (err) {
      console.error('[Telegram Bot] Error in /test_forward:', sanitizeError(err, token));
      await ctx.reply('❌ An error occurred while testing message forwarding.');
    }
  });
}
