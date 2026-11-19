import { Telegraf, Context } from 'telegraf';
import { isAuthorizedAdmin, denyUnauthorizedAccess } from './auth';
import { deadlineService } from '../services/deadline.service';
import { deadlinePublisherService } from '../services/deadline-publisher.service';
import { sourceService } from '../services/source.service';
import {
  DEFAULT_TIMEZONE,
  isValidDateString,
  isValidTimeString,
  isValidTimezone,
  formatDateTimeInTimezone,
  formatTimeRemaining,
  parseAdditionalReminder,
} from '../utils/time';
import { isValidUuid } from '../utils/validators';
import { sanitizeError } from '../utils/sanitize';
import { DeliveryStatus } from '@prisma/client';

interface AddDeadlineWizardState {
  userId: number;
  chatId: number;
  step: 'SOURCE' | 'TITLE' | 'DESCRIPTION' | 'DATE' | 'TIME' | 'TIMEZONE' | 'REMINDER' | 'CONFIRM';
  sourceGroupId?: string;
  sourceName?: string;
  title?: string;
  description?: string;
  dateStr?: string;
  timeStr?: string;
  timezone?: string;
  additionalReminderStr?: string;
  expiresAt: number;
}

const activeWizards = new Map<string, AddDeadlineWizardState>();

function getWizardKey(userId: number, chatId: number): string {
  return `${userId}:${chatId}`;
}

function clearExpiredWizards(): void {
  const now = Date.now();
  for (const [key, state] of activeWizards.entries()) {
    if (state.expiresAt < now) {
      activeWizards.delete(key);
    }
  }
}

/**
 * Registers deadline management commands with the Telegraf bot.
 */
export function registerDeadlineCommands(bot: Telegraf, token?: string): void {
  // /deadlines - List upcoming deadlines
  bot.command('deadlines', async (ctx) => {
    try {
      const isAuth = await isAuthorizedAdmin(ctx);
      if (!isAuth) {
        await denyUnauthorizedAccess(ctx, 'view deadline calendar');
        return;
      }

      const deadlines = await deadlineService.listUpcomingDeadlines();

      if (deadlines.length === 0) {
        await ctx.reply(
          '📅 **Upcoming Deadlines**\n\n' +
          'No upcoming deadlines found.\n\n' +
          'To schedule a new deadline, use `/add_deadline`.'
        );
        return;
      }

      let response = `📅 **Upcoming Submission Deadlines (${deadlines.length})**\n\n`;

      for (const d of deadlines) {
        const remaining = formatTimeRemaining(d.dueAt, new Date());
        const formattedDue = formatDateTimeInTimezone(d.dueAt, d.timezone);
        const destCount = d.announcements.length;
        const successReminders = d.reminderDeliveries.filter((r) => r.status === DeliveryStatus.SUCCESS).length;

        response +=
          `📌 **${d.title}**\n` +
          `🆔 \`${d.id}\`\n` +
          `📢 **Source:** ${d.sourceGroup.name}\n` +
          `⏰ **Due:** ${formattedDue}\n` +
          `⏳ **Remaining:** ${remaining}\n` +
          `👥 **Destinations:** ${destCount} groups\n` +
          `🔔 **Reminders Sent:** ${successReminders}\n` +
          `👉 Details: \`/deadline_details ${d.id}\`\n\n`;
      }

      await ctx.reply(response, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('[DeadlineBot Error] /deadlines failed:', sanitizeError(err, token));
      await ctx.reply('❌ An error occurred while retrieving deadlines.');
    }
  });

  // /deadline_details <id> - View detailed information
  bot.command('deadline_details', async (ctx) => {
    try {
      const isAuth = await isAuthorizedAdmin(ctx);
      if (!isAuth) {
        await denyUnauthorizedAccess(ctx, 'view deadline details');
        return;
      }

      const text = 'text' in ctx.message ? ctx.message.text : '';
      const deadlineId = text.replace(/^\/deadline_details(@\w+)?\s*/, '').trim();

      if (!deadlineId) {
        await ctx.reply('ℹ️ **Usage:** `/deadline_details <deadline_id>`');
        return;
      }

      const d = await deadlineService.getDeadlineDetails(deadlineId);
      if (!d) {
        await ctx.reply(`⚠️ Deadline with ID \`${deadlineId}\` was not found.`);
        return;
      }

      const dueFormatted = formatDateTimeInTimezone(d.dueAt, d.timezone);
      const remaining = formatTimeRemaining(d.dueAt, new Date());

      const totalDest = d.announcements.length;
      const pinnedCount = d.announcements.filter((a) => a.isPinned).length;
      const pinFailedCount = d.announcements.filter((a) => a.status === DeliveryStatus.SUCCESS && !a.isPinned).length;

      const successReminders = d.reminderDeliveries.filter((r) => r.status === DeliveryStatus.SUCCESS).length;
      const failedReminders = d.reminderDeliveries.filter((r) => r.status === DeliveryStatus.FAILED).length;
      const pendingReminders = d.reminderDeliveries.filter((r) => r.status === DeliveryStatus.PENDING).length;

      let statusEmoji = '🟢';
      if (d.status === 'COMPLETED') statusEmoji = '🏁';
      if (d.status === 'CANCELLED') statusEmoji = '🔴';

      let msg =
        `📅 **Deadline Details**\n\n` +
        `📌 **Title:** ${d.title}\n` +
        `🆔 **ID:** \`${d.id}\`\n` +
        `${statusEmoji} **Status:** ${d.status}\n` +
        `📢 **Source Topic:** ${d.sourceGroup.name} (Chat: \`${d.sourceGroup.chatId}\`)\n` +
        `⏰ **Due Date & Time:** ${dueFormatted}\n` +
        `⏳ **Time Remaining:** ${remaining}\n\n` +
        `📋 **Instructions:**\n${d.description}\n\n` +
        `📊 **Announcement Delivery:**\n` +
        `• Destination Groups: ${totalDest}\n` +
        `• Pinned Messages: ${pinnedCount}/${totalDest}` +
        (pinFailedCount > 0 ? ` (⚠️ ${pinFailedCount} failed to pin due to missing permissions)` : '') +
        `\n\n` +
        `🔔 **Scheduled Reminders:**\n` +
        `• Successful Deliveries: ${successReminders}\n` +
        `• Failed Deliveries: ${failedReminders}\n` +
        `• Pending Deliveries: ${pendingReminders}\n`;

      if (d.additionalReminderAt) {
        msg += `• Additional Reminder: ${formatDateTimeInTimezone(d.additionalReminderAt, d.timezone)}\n`;
      } else {
        msg += `• Additional Reminder: None configured (default 24h only)\n`;
      }

      msg +=
        `\n🛠️ **Actions:**\n` +
        `• Cancel: \`/cancel_deadline ${d.id}\`\n` +
        `• Delete: \`/delete_deadline ${d.id}\``;

      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('[DeadlineBot Error] /deadline_details failed:', sanitizeError(err, token));
      await ctx.reply('❌ An error occurred while retrieving deadline details.');
    }
  });

  // /cancel_deadline <id>
  bot.command('cancel_deadline', async (ctx) => {
    try {
      const isAuth = await isAuthorizedAdmin(ctx);
      if (!isAuth) {
        await denyUnauthorizedAccess(ctx, 'cancel deadlines');
        return;
      }

      const text = 'text' in ctx.message ? ctx.message.text : '';
      const deadlineId = text.replace(/^\/cancel_deadline(@\w+)?\s*/, '').trim();

      if (!deadlineId) {
        await ctx.reply('ℹ️ **Usage:** `/cancel_deadline <deadline_id>`');
        return;
      }

      const result = await deadlineService.cancelDeadline(deadlineId);
      if (result.success) {
        await ctx.reply(`✅ ${result.message}`);
      } else {
        await ctx.reply(`❌ ${result.message}`);
      }
    } catch (err) {
      console.error('[DeadlineBot Error] /cancel_deadline failed:', sanitizeError(err, token));
      await ctx.reply('❌ An error occurred while cancelling the deadline.');
    }
  });

  // /delete_deadline <id>
  bot.command('delete_deadline', async (ctx) => {
    try {
      const isAuth = await isAuthorizedAdmin(ctx);
      if (!isAuth) {
        await denyUnauthorizedAccess(ctx, 'delete deadlines');
        return;
      }

      const text = 'text' in ctx.message ? ctx.message.text : '';
      const deadlineId = text.replace(/^\/delete_deadline(@\w+)?\s*/, '').trim();

      if (!deadlineId) {
        await ctx.reply('ℹ️ **Usage:** `/delete_deadline <deadline_id>`');
        return;
      }

      const result = await deadlineService.deleteDeadline(deadlineId);
      if (result.success) {
        await ctx.reply(`🗑️ ${result.message}`);
      } else {
        await ctx.reply(`⚠️ ${result.message}`);
      }
    } catch (err) {
      console.error('[DeadlineBot Error] /delete_deadline failed:', sanitizeError(err, token));
      await ctx.reply('❌ An error occurred while deleting the deadline.');
    }
  });

  // /cancel - Abort active wizard
  bot.command('cancel', async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (userId && chatId) {
      const key = getWizardKey(userId, chatId);
      if (activeWizards.has(key)) {
        activeWizards.delete(key);
        await ctx.reply('🚫 Deadline creation has been cancelled.');
        return;
      }
    }
  });

  // /add_deadline - Conversational or parameterized deadline creation
  bot.command('add_deadline', async (ctx) => {
    try {
      const isAuth = await isAuthorizedAdmin(ctx);
      if (!isAuth) {
        await denyUnauthorizedAccess(ctx, 'create deadlines');
        return;
      }

      const text = 'text' in ctx.message ? ctx.message.text : '';
      const rawArgs = text.replace(/^\/add_deadline(@\w+)?\s*/, '').trim();

      // Check if user provided piped arguments:
      // <sourceId> | <title> | <YYYY-MM-DD> <HH:MM> | [timezone] | [additionalReminder] | <description>
      if (rawArgs.includes('|')) {
        const parts = rawArgs.split('|').map((s) => s.trim());
        if (parts.length < 4) {
          await ctx.reply(
            'ℹ️ **Single-Line Format Usage:**\n' +
            '`/add_deadline <SourceID> | <Title> | <YYYY-MM-DD> <HH:MM> | [Timezone] | [AdditionalReminder] | <Description>`\n\n' +
            'Example:\n' +
            '`/add_deadline 9a38... | Final Project Submission | 2026-11-20 23:59 | Africa/Addis_Ababa | 2h | Submit GitHub repository link and PDF report.`\n\n' +
            'Or run `/add_deadline` with no arguments to start the interactive step-by-step wizard.'
          );
          return;
        }

        const sourceId = parts[0];
        const title = parts[1];
        const dateTimePart = parts[2].split(/\s+/);
        const dateStr = dateTimePart[0];
        const timeStr = dateTimePart[1] || '23:59';

        let timezone = DEFAULT_TIMEZONE;
        let additionalReminder: string | null = null;
        let description = '';

        if (parts.length === 4) {
          description = parts[3];
        } else if (parts.length === 5) {
          if (isValidTimezone(parts[3])) {
            timezone = parts[3];
          } else {
            additionalReminder = parts[3];
          }
          description = parts[4];
        } else {
          timezone = parts[3] || DEFAULT_TIMEZONE;
          additionalReminder = parts[4] || null;
          description = parts.slice(5).join(' | ');
        }

        const createRes = await deadlineService.createDeadline({
          sourceGroupId: sourceId,
          title,
          description,
          dateStr,
          timeStr,
          timezone,
          additionalReminderStr: additionalReminder,
          createdBy: ctx.from.id,
        });

        if (!createRes.success || !createRes.deadline) {
          await ctx.reply(`❌ Failed to create deadline: ${createRes.message}`);
          return;
        }

        // Publish and Pin in destination groups
        const pubRes = await deadlinePublisherService.publishAndPinDeadline(
          ctx.telegram,
          createRes.deadline.id,
          token
        );

        await ctx.reply(
          `✅ **Deadline Created and Published Successfully!**\n\n` +
          `📌 **Title:** ${createRes.deadline.title}\n` +
          `🆔 **ID:** \`${createRes.deadline.id}\`\n` +
          `⏰ **Due Date:** ${formatDateTimeInTimezone(createRes.deadline.dueAt, createRes.deadline.timezone)}\n` +
          `📢 **Announcements Sent:** ${pubRes.sent}/${pubRes.total} destinations\n` +
          `📌 **Messages Pinned:** ${pubRes.pinned}/${pubRes.total} destinations` +
          (pubRes.pinFailed > 0 ? ` (⚠️ ${pubRes.pinFailed} failed to pin: bot lacks pin permission in group)` : '') +
          `\n\n` +
          `🔔 Automatic reminders will be delivered 24 hours prior and at the scheduled reminder time.`
        );
        return;
      }

      // Otherwise, start conversational step-by-step interaction
      clearExpiredWizards();

      const sources = await sourceService.listSources();
      const activeSources = sources.filter((s) => s.isActive);

      if (activeSources.length === 0) {
        await ctx.reply(
          '⚠️ No active source topics found. Please register an active source group first using `/register_source`.'
        );
        return;
      }

      const userId = ctx.from.id;
      const chatId = ctx.chat.id;
      const key = getWizardKey(userId, chatId);

      // Start wizard: Step 1 - Choose Source Group
      let promptMsg =
        `📅 **Create Submission Deadline (Step 1/7)**\n\n` +
        `Please select an associated registered source topic by sending its number or UUID:\n\n`;

      activeSources.forEach((src, idx) => {
        promptMsg += `${idx + 1}. **${src.name}**\n   ID: \`${src.id}\`\n`;
      });

      promptMsg += `\n_Type the number (e.g. 1) or Source ID, or send /cancel to abort._`;

      activeWizards.set(key, {
        userId,
        chatId,
        step: 'SOURCE',
        expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes session
      });

      await ctx.reply(promptMsg, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('[DeadlineBot Error] /add_deadline failed:', sanitizeError(err, token));
      await ctx.reply('❌ An error occurred while initializing deadline creation.');
    }
  });

  // Message listener to advance active conversational wizard steps
  bot.on('text', async (ctx, next) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      return next(); // Let commands handle themselves
    }

    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || !chatId) return next();

    const key = getWizardKey(userId, chatId);
    const state = activeWizards.get(key);
    if (!state) return next();

    // Check expiration
    if (state.expiresAt < Date.now()) {
      activeWizards.delete(key);
      await ctx.reply('⌛ Deadline creation wizard expired. Please start again with `/add_deadline`.');
      return next();
    }

    // Refresh TTL
    state.expiresAt = Date.now() + 10 * 60 * 1000;

    try {
      switch (state.step) {
        case 'SOURCE': {
          const sources = (await sourceService.listSources()).filter((s) => s.isActive);
          let selectedSource = sources.find((s) => s.id === text);

          if (!selectedSource && /^\d+$/.test(text)) {
            const index = parseInt(text, 10) - 1;
            if (index >= 0 && index < sources.length) {
              selectedSource = sources[index];
            }
          }

          if (!selectedSource) {
            await ctx.reply('⚠️ Invalid selection. Please send a valid number or Source UUID, or /cancel to abort:');
            return;
          }

          state.sourceGroupId = selectedSource.id;
          state.sourceName = selectedSource.name;
          state.step = 'TITLE';

          await ctx.reply(
            `Selected source: **${selectedSource.name}**\n\n` +
            `👉 **Step 2/7: Enter the Deadline Title**\n` +
            `Example: \`Final Project Submission\``,
            { parse_mode: 'Markdown' }
          );
          return;
        }

        case 'TITLE': {
          if (text.length < 3 || text.length > 200) {
            await ctx.reply('⚠️ Title must be between 3 and 200 characters. Please enter a valid title:');
            return;
          }
          state.title = text;
          state.step = 'DESCRIPTION';

          await ctx.reply(
            `👉 **Step 3/7: Enter Description or Instructions**\n` +
            `Explain what students must submit, required links or formats:`,
            { parse_mode: 'Markdown' }
          );
          return;
        }

        case 'DESCRIPTION': {
          if (text.length < 3) {
            await ctx.reply('⚠️ Description cannot be empty. Please enter instructions:');
            return;
          }
          state.description = text;
          state.step = 'DATE';

          await ctx.reply(
            `👉 **Step 4/7: Enter Submission Date**\n` +
            `Format: \`YYYY-MM-DD\` (e.g. \`2026-11-20\`)`,
            { parse_mode: 'Markdown' }
          );
          return;
        }

        case 'DATE': {
          if (!isValidDateString(text)) {
            await ctx.reply('⚠️ Invalid date format. Please enter date as `YYYY-MM-DD` (e.g. `2026-11-20`):');
            return;
          }
          state.dateStr = text;
          state.step = 'TIME';

          await ctx.reply(
            `👉 **Step 5/7: Enter Submission Time (24-hour format)**\n` +
            `Format: \`HH:MM\` (e.g. \`23:59\` or \`18:00\`)`,
            { parse_mode: 'Markdown' }
          );
          return;
        }

        case 'TIME': {
          if (!isValidTimeString(text)) {
            await ctx.reply('⚠️ Invalid time format. Please enter time as `HH:MM` (e.g. `23:59`):');
            return;
          }
          state.timeStr = text;
          state.step = 'TIMEZONE';

          await ctx.reply(
            `👉 **Step 6/7: Enter Time Zone**\n` +
            `Default: \`${DEFAULT_TIMEZONE}\`\n` +
            `Send \`default\` to use \`${DEFAULT_TIMEZONE}\`, or specify another IANA timezone (e.g. \`UTC\`, \`America/New_York\`, \`Europe/London\`):`,
            { parse_mode: 'Markdown' }
          );
          return;
        }

        case 'TIMEZONE': {
          let tz = text.toLowerCase() === 'default' ? DEFAULT_TIMEZONE : text;
          if (!isValidTimezone(tz)) {
            await ctx.reply(`⚠️ Invalid timezone "${text}". Please enter a valid IANA timezone or "default":`);
            return;
          }
          state.timezone = tz;
          state.step = 'REMINDER';

          await ctx.reply(
            `👉 **Step 7/7: Optional Additional Reminder**\n\n` +
            `• The **24-hour reminder** is sent automatically.\n` +
            `• Configure an optional additional reminder (e.g. \`2h\`, \`1h\`, \`30m\`, or \`none\`):\n` +
            `Send \`none\` to keep only the 24-hour reminder.`,
            { parse_mode: 'Markdown' }
          );
          return;
        }

        case 'REMINDER': {
          state.additionalReminderStr = text;

          // Attempt creation
          const createRes = await deadlineService.createDeadline({
            sourceGroupId: state.sourceGroupId!,
            title: state.title!,
            description: state.description!,
            dateStr: state.dateStr!,
            timeStr: state.timeStr!,
            timezone: state.timezone!,
            additionalReminderStr: state.additionalReminderStr,
            createdBy: userId,
          });

          if (!createRes.success || !createRes.deadline) {
            await ctx.reply(`❌ Validation Failed: ${createRes.message}\n\nPlease send a valid reminder option or /cancel.`);
            return;
          }

          activeWizards.delete(key);

          // Publish and Pin
          await ctx.reply('🚀 Creating and publishing deadline announcement to student groups...');
          const pubRes = await deadlinePublisherService.publishAndPinDeadline(
            ctx.telegram,
            createRes.deadline.id,
            token
          );

          await ctx.reply(
            `✅ **Deadline Created & Published Successfully!**\n\n` +
            `📌 **Title:** ${createRes.deadline.title}\n` +
            `🆔 **ID:** \`${createRes.deadline.id}\`\n` +
            `📢 **Source:** ${state.sourceName}\n` +
            `⏰ **Due Date:** ${formatDateTimeInTimezone(createRes.deadline.dueAt, createRes.deadline.timezone)}\n` +
            `👥 **Destination Announcements Sent:** ${pubRes.sent}/${pubRes.total}\n` +
            `📌 **Messages Pinned:** ${pubRes.pinned}/${pubRes.total}` +
            (pubRes.pinFailed > 0 ? ` (⚠️ ${pubRes.pinFailed} failed to pin due to missing group permissions)` : '') +
            `\n\n` +
            `🔔 Reminders will be distributed automatically according to schedule.`
          );
          return;
        }
      }
    } catch (wizardErr) {
      console.error('[DeadlineWizard Error]:', sanitizeError(wizardErr, token));
      await ctx.reply('❌ An error occurred during the wizard. Please try `/add_deadline` again.');
      activeWizards.delete(key);
    }

    return next();
  });
}
