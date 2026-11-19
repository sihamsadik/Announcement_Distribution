export const BOT_MESSAGES = {
  welcome:
    '👋 Welcome to the Telegram Announcement Distribution Bot!\n\n' +
    'This bot monitors registered source forum topics and automatically distributes announcements ' +
    'to registered student destination groups with persistent tracking and retry handling.\n\n' +
    'Use /help to view available administrative and monitoring commands.',

  help:
    'ℹ️ **Announcement Distribution Bot - Command Reference**\n\n' +
    'Purpose:\n' +
    'This bot monitors registered course source topics and manages final-project announcement distribution to student project groups.\n\n' +
    '📢 **Source Management (Admins only):**\n' +
    '• `/register_source [topicId] <name>` - Register current group & forum topic as a source\n' +
    '• `/list_sources` - List all registered sources with status and destination counts\n' +
    '• `/source_details <source_id>` - View linked destinations and delivery statistics for a source\n' +
    '• `/remove_source <source_id> [--force]` - Safely deactivate a source (or force delete if no logs)\n' +
    '• `/activate_source <source_id>` - Reactivate a deactivated source\n\n' +
    '👥 **Destination Management (Admins only):**\n' +
    '• `/register_destination <source_id> <name>` - Register current group as destination linked to a source\n' +
    '• `/list_destinations [source_id]` - List registered destinations (optionally filtered by source)\n' +
    '• `/remove_destination <dest_id> [--force]` - Deactivate a destination (or force delete if no logs)\n' +
    '• `/activate_destination <dest_id>` - Reactivate a deactivated destination\n\n' +
    '📅 **Deadline Management & Reminders (Admins only):**\n' +
    '• `/add_deadline` - Create submission deadline, publish, and pin announcement in student groups\n' +
    '• `/deadlines` - List upcoming submission deadlines\n' +
    '• `/deadline_details <deadline_id>` - View comprehensive deadline info, pin status, and reminders\n' +
    '• `/cancel_deadline <deadline_id>` - Cancel deadline and expire future scheduled reminders\n' +
    '• `/delete_deadline <deadline_id>` - Safely delete deadline (preserves historical delivery records)\n\n' +
    '📊 **Delivery Monitoring (Admins only):**\n' +
    '• `/delivery_stats [source_id]` - Summary of delivery metrics, success rate, and active counts\n' +
    '• `/recent_deliveries [limit]` - Inspect recent delivery attempts across destinations\n' +
    '• `/failed_deliveries [limit]` - List failed or retrying delivery attempts with error reasons\n' +
    '• `/delivery_details <log_id>` - View comprehensive metadata and error details for a delivery\n\n' +
    '📤 **Testing & Diagnostics (Admins only):**\n' +
    '• `/test_forward <dest_chat_id> [msg_id]` - Test forwarding a message directly to a destination\n\n' +
    'ℹ️ **General Commands:**\n' +
    '• `/start` - Welcome message and introduction\n' +
    '• `/help` - Display this manual\n\n' +
    '_Note: Administrative actions require authorization via ADMIN_USER_IDS or group administrator permissions._',
};
