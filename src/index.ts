import { loadConfig } from './config/env';
import { createBot, sanitizeError } from './bot/bot';

async function main(): Promise<void> {
  let token = '';

  try {
    const config = loadConfig();
    token = config.telegramBotToken;

    const bot = createBot(token);

    // Setup graceful shutdown handlers
    const stopBot = (signal: string) => {
      console.log(`\nReceived ${signal}. Gracefully stopping Telegram bot...`);
      bot.stop(signal);
      process.exit(0);
    };

    process.once('SIGINT', () => stopBot('SIGINT'));
    process.once('SIGTERM', () => stopBot('SIGTERM'));

    // Start bot polling
    console.log('Connecting to Telegram Bot API...');
    await bot.launch();

    // Verify bot identity
    const botInfo = await bot.telegram.getMe();
    console.log(`Telegram Bot started successfully as @${botInfo.username} (ID: ${botInfo.id})`);
    console.log('Bot is ready to receive /start and /help commands.');
  } catch (err) {
    const safeMsg = sanitizeError(err, token);
    console.error(`[Fatal Startup Error] Failed to start application: ${safeMsg}`);
    process.exit(1);
  }
}

// Execute application
if (require.main === module) {
  main();
}

export { main };
