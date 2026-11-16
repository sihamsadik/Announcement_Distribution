export const BOT_MESSAGES = {
  welcome:
    '👋 Welcome to the Announcement Distribution Bot!\n\n' +
    'This bot is designed to manage and distribute final-project announcements ' +
    'from the primary source topic to destination student groups.\n\n' +
    'Use /help to learn more about available commands.',

  help:
    'ℹ️ Announcement Distribution Bot - Help\n\n' +
    'Purpose:\n' +
    'This bot monitors registered source topics in your course Telegram group ' +
    'and prepares to distribute final-project announcements to student groups.\n\n' +
    'Available Commands:\n' +
    '• /start - Welcome message and introduction\n' +
    '• /help - Display this command manual\n' +
    '• /register_source [topicId] <name> - Register the current group and topic as an announcement source (Admins only)\n' +
    '• /list_sources - View all registered source topics\n\n' +
    'Source Topic Registration Guide:\n' +
    '1. Run `/register_source <Name>` directly inside a forum topic.\n' +
    '2. If Telegram does not pass a topic ID, specify it explicitly:\n' +
    '   `/register_source <topicId> <Name>`\n\n' +
    'Note: Only authorized administrators may register sources.',
};
