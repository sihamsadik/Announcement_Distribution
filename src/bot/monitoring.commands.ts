import { Telegraf } from 'telegraf';
import { isAuthorizedAdmin, denyUnauthorizedAccess } from './auth';
import { monitoringService, TimeframeOption } from '../services/monitoring.service';
import { logger } from '../utils/logger';

/**
 * Registers delivery monitoring commands with the Telegraf bot.
 */
export function registerMonitoringCommands(bot: Telegraf, token?: string): void {
  // /delivery_stats [source_id_or_timeframe] [timeframe]
  bot.command('delivery_stats', async (ctx) => {
    try {
      const isAuth = await isAuthorizedAdmin(ctx);
      if (!isAuth) {
        await denyUnauthorizedAccess(ctx, 'view delivery statistics');
        return;
      }

      const text = 'text' in ctx.message ? ctx.message.text : '';
      const rawArgs = text.replace(/^\/delivery_stats(@\w+)?\s*/, '').trim();
      const parts = rawArgs.split(/\s+/).filter(Boolean);

      let sourceId: string | undefined;
      let timeframe: TimeframeOption | undefined;

      const validTimeframes = ['24h', '7d', '30d', 'all'];

      for (const part of parts) {
        const lower = part.toLowerCase();
        if (validTimeframes.includes(lower)) {
          timeframe = lower as TimeframeOption;
        } else if (part.length > 5) {
          sourceId = part;
        }
      }

      const stats = await monitoringService.getDeliveryStats({
        sourceGroupId: sourceId,
        timeframe,
      });

      const formatted = monitoringService.formatStatsMessage(stats);
      await ctx.reply(formatted, { parse_mode: 'Markdown' });

      logger.info('Admin retrieved delivery stats', {
        event: 'admin.stats_viewed',
        sourceGroupId: sourceId,
        timeframe,
        adminUserId: ctx.from?.id,
      });
    } catch (err) {
      logger.error('Error in /delivery_stats command', { event: 'admin.stats_error', error: err });
      await ctx.reply('❌ An error occurred while retrieving delivery statistics.');
    }
  });

  // /recent_deliveries [limit] [source_id] [timeframe]
  bot.command('recent_deliveries', async (ctx) => {
    try {
      const isAuth = await isAuthorizedAdmin(ctx);
      if (!isAuth) {
        await denyUnauthorizedAccess(ctx, 'view recent deliveries');
        return;
      }

      const text = 'text' in ctx.message ? ctx.message.text : '';
      const rawArgs = text.replace(/^\/recent_deliveries(@\w+)?\s*/, '').trim();
      const parts = rawArgs.split(/\s+/).filter(Boolean);

      let limit = 10;
      let sourceId: string | undefined;
      let since: Date | undefined;

      for (const p of parts) {
        if (/^\d+$/.test(p)) {
          limit = parseInt(p, 10);
        } else if (['24h', '7d', '30d'].includes(p.toLowerCase())) {
          since = monitoringService.parseTimeframeDate(p);
        } else if (p.length > 10) {
          sourceId = p;
        }
      }

      const deliveries = await monitoringService.getRecentDeliveries({
        limit,
        sourceGroupId: sourceId,
        since,
      });
      const formatted = monitoringService.formatRecentDeliveries(deliveries);

      await ctx.reply(formatted, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error('Error in /recent_deliveries command', { event: 'admin.recent_error', error: err });
      await ctx.reply('❌ An error occurred while fetching recent deliveries.');
    }
  });

  // /failed_deliveries [limit] [source_id] [timeframe]
  bot.command('failed_deliveries', async (ctx) => {
    try {
      const isAuth = await isAuthorizedAdmin(ctx);
      if (!isAuth) {
        await denyUnauthorizedAccess(ctx, 'view failed deliveries');
        return;
      }

      const text = 'text' in ctx.message ? ctx.message.text : '';
      const rawArgs = text.replace(/^\/failed_deliveries(@\w+)?\s*/, '').trim();
      const parts = rawArgs.split(/\s+/).filter(Boolean);

      let limit = 10;
      let sourceId: string | undefined;
      let since: Date | undefined;

      for (const p of parts) {
        if (/^\d+$/.test(p)) {
          limit = parseInt(p, 10);
        } else if (['24h', '7d', '30d'].includes(p.toLowerCase())) {
          since = monitoringService.parseTimeframeDate(p);
        } else if (p.length > 10) {
          sourceId = p;
        }
      }

      const failed = await monitoringService.getFailedDeliveries({
        limit,
        sourceGroupId: sourceId,
        since,
      });
      const formatted = monitoringService.formatFailedDeliveries(failed);

      await ctx.reply(formatted, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error('Error in /failed_deliveries command', { event: 'admin.failed_error', error: err });
      await ctx.reply('❌ An error occurred while fetching failed deliveries.');
    }
  });

  // /delivery_details <log_id>
  bot.command('delivery_details', async (ctx) => {
    try {
      const isAuth = await isAuthorizedAdmin(ctx);
      if (!isAuth) {
        await denyUnauthorizedAccess(ctx, 'view delivery details');
        return;
      }

      const text = 'text' in ctx.message ? ctx.message.text : '';
      const rawArgs = text.replace(/^\/delivery_details(@\w+)?\s*/, '').trim();
      const logId = rawArgs.split(/\s+/)[0];

      if (!logId) {
        await ctx.reply(
          'ℹ️ **Usage**: `/delivery_details <log_id>`\n\n' +
          'Tip: Copy a log ID from `/recent_deliveries` or `/failed_deliveries`.'
        );
        return;
      }

      const details = await monitoringService.getDeliveryDetails(logId);
      if (!details) {
        await ctx.reply(`❌ No delivery record found with ID: \`${logId}\``);
        return;
      }

      const formatted = monitoringService.formatDeliveryDetails(details);
      await ctx.reply(formatted, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error('Error in /delivery_details command', { event: 'admin.details_error', error: err });
      await ctx.reply('❌ An error occurred while fetching delivery details.');
    }
  });
}
