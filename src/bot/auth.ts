import { Context } from 'telegraf';
import { getAdminUserIds } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Checks if the message sender is authorized to perform administrative actions.
 * 
 * Strict authorization criteria:
 * 1. User ID must be a valid positive integer.
 * 2. If the user ID is explicitly listed in ADMIN_USER_IDS, access is granted everywhere.
 * 3. In group/supergroup contexts, if the user is a verified Administrator or Owner (Creator)
 *    of that group, access is granted for group-level operations.
 * 4. In private chats, ONLY users explicitly in ADMIN_USER_IDS are authorized.
 * 5. Ordinary group members and unauthenticated callers are strictly denied.
 */
export async function isAuthorizedAdmin(ctx: Context): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId || typeof userId !== 'number' || userId <= 0 || !Number.isInteger(userId)) {
    return false;
  }

  // 1. Check explicit environment administrators
  const adminUserIds = getAdminUserIds();
  if (adminUserIds.includes(userId)) {
    return true;
  }

  // 2. In private chats, only explicit environment administrators are allowed
  if (!ctx.chat || ctx.chat.type === 'private') {
    return false;
  }

  // 3. In group/supergroup contexts, check Telegram group administrator privileges
  if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
    try {
      let admins: any[] = [];
      if (typeof ctx.getChatAdministrators === 'function') {
        admins = await ctx.getChatAdministrators();
      } else if (ctx.telegram && typeof ctx.telegram.getChatAdministrators === 'function') {
        admins = await ctx.telegram.getChatAdministrators(ctx.chat.id);
      } else {
        return false;
      }
      return admins.some((admin) => admin.user?.id === userId);
    } catch (err) {
      logger.warn('Unable to query chat administrators from Telegram API', {
        event: 'auth.query_failed',
        chatId: ctx.chat.id,
        userId,
        error: err,
      });
      return false;
    }
  }

  return false;
}

/**
 * Standardized security warning, audit logging, and rejection handler for unauthorized access attempts.
 */
export async function denyUnauthorizedAccess(
  ctx: Context,
  actionDescription: string
): Promise<void> {
  const userId = ctx.from?.id ?? 'unknown';
  const chatId = ctx.chat?.id ?? 'unknown';
  const chatType = ctx.chat?.type ?? 'unknown';

  logger.warn(`Unauthorized ${actionDescription} attempt`, {
    event: 'security.unauthorized_access',
    action: actionDescription,
    userId,
    chatId,
    chatType,
  });

  console.warn(`[Security Alert] Unauthorized ${actionDescription} attempt by user ${userId} in chat ${chatId}`);

  try {
    await ctx.reply(`⛔ Access denied: You are not authorized to ${actionDescription}.`);
  } catch (err) {
    logger.error('Failed to send access denied reply to user', {
      event: 'security.reply_failed',
      userId,
      chatId,
      error: err,
    });
  }
}
