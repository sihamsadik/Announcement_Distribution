import { Context } from 'telegraf';
import { getAdminUserIds } from '../config/env';

/**
 * Checks if the message sender is authorized to perform administrative actions.
 * 
 * Authorization criteria:
 * 1. User ID is explicitly listed in ADMIN_USER_IDS environment variable, OR
 * 2. In a group/supergroup context, the user is an Administrator or Owner (Creator) of that group.
 */
export async function isAuthorizedAdmin(ctx: Context): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) {
    return false;
  }

  // 1. Check explicit environment administrators
  const adminUserIds = getAdminUserIds();
  if (adminUserIds.includes(userId)) {
    return true;
  }

  // 2. Check Telegram group administrator status
  if (
    ctx.chat &&
    (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') &&
    typeof ctx.getChatAdministrators === 'function'
  ) {
    try {
      const admins = await ctx.getChatAdministrators();
      return admins.some((admin) => admin.user.id === userId);
    } catch (err) {
      console.warn(`[Auth Warning] Unable to query chat administrators for chat ${ctx.chat.id}: ${err}`);
      return false;
    }
  }

  return false;
}
