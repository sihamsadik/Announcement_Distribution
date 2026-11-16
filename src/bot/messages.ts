export const BOT_MESSAGES = {
  welcome:
    '👋 Welcome to the Announcement Distribution Bot!\n\n' +
    'This bot is designed to manage and distribute final-project announcements ' +
    'from the primary source topic to destination student groups.\n\n' +
    'Use /help to learn more about available commands.',

  help:
    'ℹ️ Announcement Distribution Bot - Help Manual\n\n' +
    'Purpose:\n' +
    'This bot monitors registered course source topics and manages final-project announcement distribution to student project groups.\n\n' +
    '📢 Source Management Commands (Admins only):\n' +
    '• /register_source [topicId] <name> - Register current group topic as announcement source\n' +
    '• /list_sources - View all registered source topics and their IDs\n\n' +
    '👥 Destination Management Commands (Admins only):\n' +
    '• /register_destination <source_id> <group_name> - Register current group as a destination linked to a source\n' +
    '• /list_destinations [source_id] - List destinations (optionally filtered by source ID)\n' +
    '• /remove_destination <destination_id> - Deactivate a destination group (retains delivery history)\n' +
    '• /activate_destination <destination_id> - Reactivate a previously deactivated destination group\n\n' +
    'General Commands:\n' +
    '• /start - Welcome message and introduction\n' +
    '• /help - Display this command manual\n\n' +
    'Note: Only authorized administrators may register or manage sources and destinations.',
};
