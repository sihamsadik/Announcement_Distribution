import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

export interface AppConfig {
  telegramBotToken: string;
  nodeEnv: string;
}

export function loadConfig(): AppConfig {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();

  if (!token) {
    throw new Error(
      'Missing required environment variable: TELEGRAM_BOT_TOKEN. ' +
      'Please check your .env file or environment configuration.'
    );
  }

  return {
    telegramBotToken: token,
    nodeEnv: process.env.NODE_ENV || 'development',
  };
}
