import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

export interface AppConfig {
  telegramBotToken: string;
  databaseUrl?: string;
  adminUserIds: number[];
  nodeEnv: string;
}

export function parseAdminUserIds(raw?: string): number[] {
  if (!raw || !raw.trim()) {
    return [];
  }

  return raw
    .split(',')
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => !isNaN(id) && id > 0);
}

export function getAdminUserIds(): number[] {
  return parseAdminUserIds(process.env.ADMIN_USER_IDS);
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
    databaseUrl: process.env.DATABASE_URL?.trim(),
    adminUserIds: getAdminUserIds(),
    nodeEnv: process.env.NODE_ENV || 'development',
  };
}
