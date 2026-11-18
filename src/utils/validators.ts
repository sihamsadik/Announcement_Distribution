/**
 * Input validation utilities for commands, configuration, and Telegram updates.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TELEGRAM_BOT_TOKEN_REGEX = /^\d{6,14}:[A-Za-z0-9_-]{30,50}$/;

export interface ValidationOutcome<T = string> {
  valid: boolean;
  error?: string;
  value?: T;
}

/**
 * Validates whether a string is a standard UUID format.
 */
export function isValidUuid(id?: unknown): boolean {
  if (typeof id !== 'string') return false;
  return UUID_REGEX.test(id.trim());
}

/**
 * Validates a Telegram chat ID (group, supergroup, channel, or private user).
 * Numeric, typically negative for groups/supergroups (-100...).
 */
export function isValidTelegramChatId(chatId?: unknown): boolean {
  if (chatId === null || chatId === undefined) return false;

  if (typeof chatId === 'bigint') {
    return chatId !== BigInt(0);
  }

  if (typeof chatId === 'number') {
    return !isNaN(chatId) && chatId !== 0 && Number.isInteger(chatId);
  }

  if (typeof chatId === 'string') {
    const trimmed = chatId.trim();
    if (!/^-?\d{1,20}$/.test(trimmed)) return false;
    try {
      const b = BigInt(trimmed);
      return b !== BigInt(0);
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Validates a Telegram forum topic thread ID (must be a positive integer).
 */
export function isValidTelegramTopicId(topicId?: unknown): boolean {
  if (topicId === null || topicId === undefined) return false;

  if (typeof topicId === 'bigint') {
    return topicId > BigInt(0);
  }

  if (typeof topicId === 'number') {
    return !isNaN(topicId) && topicId > 0 && Number.isInteger(topicId);
  }

  if (typeof topicId === 'string') {
    const trimmed = topicId.trim();
    if (!/^\d{1,18}$/.test(trimmed)) return false;
    try {
      const b = BigInt(trimmed);
      return b > BigInt(0);
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Validates a human-readable source or destination name.
 * Prevents excessively long names, empty strings, and control characters.
 */
export function validateResourceName(name?: unknown, fieldName = 'Name'): ValidationOutcome<string> {
  if (typeof name !== 'string') {
    return { valid: false, error: `${fieldName} must be a text string.` };
  }

  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: `${fieldName} cannot be empty.` };
  }

  if (trimmed.length > 100) {
    return { valid: false, error: `${fieldName} is too long (maximum 100 characters).` };
  }

  // Reject control characters (ASCII 0-31, including newlines and carriage returns, and DEL 127)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    return { valid: false, error: `${fieldName} contains unsupported control characters or line breaks.` };
  }

  return { valid: true, value: trimmed };
}

/**
 * Validates delivery query pagination limit (must be between min and max).
 */
export function validateLimit(rawLimit?: unknown, min = 1, max = 50, defaultVal = 10): number {
  if (rawLimit === undefined || rawLimit === null) return defaultVal;

  let parsed: number;
  if (typeof rawLimit === 'number') {
    parsed = rawLimit;
  } else if (typeof rawLimit === 'string' && /^\d+$/.test(rawLimit.trim())) {
    parsed = parseInt(rawLimit.trim(), 10);
  } else {
    return defaultVal;
  }

  if (isNaN(parsed) || parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

/**
 * Validates a statistics timeframe filter option.
 */
export function isValidTimeframe(timeframe?: string): boolean {
  if (!timeframe) return false;
  return ['24h', '7d', '30d', 'all'].includes(timeframe.toLowerCase().trim());
}

/**
 * Validates a Telegram Bot Token format (<bot_id>:<secret>).
 */
export function isValidTelegramBotToken(token?: string): boolean {
  if (!token) return false;
  return TELEGRAM_BOT_TOKEN_REGEX.test(token.trim());
}

/**
 * Validates a PostgreSQL database connection string.
 */
export function isValidDatabaseUrl(url?: string): boolean {
  if (!url) return false;
  return /^postgres(?:ql)?:\/\/[^\s]+$/.test(url.trim());
}

/**
 * Comprehensive startup configuration validation.
 */
export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateStartupConfig(env: {
  telegramBotToken?: string;
  databaseUrl?: string;
  adminUserIds?: number[];
  healthPort?: number;
}): ConfigValidationResult {
  const errors: string[] = [];

  // 1. Telegram Bot Token
  if (!env.telegramBotToken || !env.telegramBotToken.trim()) {
    errors.push('Missing required environment variable: TELEGRAM_BOT_TOKEN.');
  } else if (!isValidTelegramBotToken(env.telegramBotToken)) {
    errors.push(
      'Invalid TELEGRAM_BOT_TOKEN format. Expected format: <botId>:<secret> (e.g. 123456789:ABCdefGhI_...)'
    );
  }

  // 2. Database URL
  if (!env.databaseUrl || !env.databaseUrl.trim()) {
    errors.push('Missing required environment variable: DATABASE_URL.');
  } else if (!isValidDatabaseUrl(env.databaseUrl)) {
    errors.push(
      'Invalid DATABASE_URL format. Expected a PostgreSQL connection URL (e.g. postgresql://user:pass@host:port/dbname).'
    );
  }

  // 3. Health Port
  if (env.healthPort !== undefined) {
    if (isNaN(env.healthPort) || env.healthPort < 1 || env.healthPort > 65535) {
      errors.push('Invalid HEALTH_PORT. Expected a port number between 1 and 65535.');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
