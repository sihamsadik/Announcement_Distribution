import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

export interface AppConfig {
  telegramBotToken: string;
  databaseUrl?: string;
  adminUserIds: number[];
  nodeEnv: string;
  healthPort: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logFormat: 'json' | 'text';
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

export interface RetryConfig {
  maxRetryCount: number;
  initialRetryDelaySeconds: number;
  maxRetryDelaySeconds: number;
  retryPollIntervalMs: number;
}

export function loadRetryConfig(): RetryConfig {
  const maxRetries = parseInt(process.env.MAX_RETRY_COUNT || '3', 10);
  const initialDelay = parseInt(process.env.INITIAL_RETRY_DELAY_SECONDS || '5', 10);
  const maxDelay = parseInt(process.env.MAX_RETRY_DELAY_SECONDS || '300', 10);
  const pollInterval = parseInt(process.env.RETRY_POLL_INTERVAL_MS || '10000', 10);

  return {
    maxRetryCount: isNaN(maxRetries) || maxRetries < 0 ? 3 : maxRetries,
    initialRetryDelaySeconds: isNaN(initialDelay) || initialDelay <= 0 ? 5 : initialDelay,
    maxRetryDelaySeconds: isNaN(maxDelay) || maxDelay <= 0 ? 300 : maxDelay,
    retryPollIntervalMs: isNaN(pollInterval) || pollInterval <= 0 ? 10000 : pollInterval,
  };
}

export function loadConfig(): AppConfig {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();

  if (!token) {
    throw new Error(
      'Missing required environment variable: TELEGRAM_BOT_TOKEN. ' +
      'Please check your .env file or environment configuration.'
    );
  }

  const rawPort = parseInt(process.env.HEALTH_PORT || process.env.PORT || '3000', 10);
  const healthPort = isNaN(rawPort) || rawPort <= 0 || rawPort > 65535 ? 3000 : rawPort;

  const validLogLevels = ['debug', 'info', 'warn', 'error'] as const;
  const rawLogLevel = (process.env.LOG_LEVEL || '').toLowerCase();
  const logLevel = validLogLevels.includes(rawLogLevel as any)
    ? (rawLogLevel as 'debug' | 'info' | 'warn' | 'error')
    : process.env.NODE_ENV === 'test' ? 'error' : 'info';

  const logFormat: 'json' | 'text' =
    process.env.LOG_FORMAT === 'json' || process.env.NODE_ENV === 'production'
      ? 'json'
      : 'text';

  return {
    telegramBotToken: token,
    databaseUrl: process.env.DATABASE_URL?.trim(),
    adminUserIds: getAdminUserIds(),
    nodeEnv: process.env.NODE_ENV || 'development',
    healthPort,
    logLevel,
    logFormat,
  };
}
