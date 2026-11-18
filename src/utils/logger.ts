export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  event?: string;
  correlationId?: string;
  sourceChatId?: bigint | number | string;
  sourceTopicId?: bigint | number | string;
  sourceMessageId?: number;
  destinationChatId?: bigint | number | string;
  destinationGroupId?: string;
  deliveryId?: string;
  retryCount?: number;
  latencyMs?: number;
  error?: unknown;
  [key: string]: unknown;
}

export interface StructuredLogRecord {
  timestamp: string;
  level: string;
  message: string;
  event: string;
  [key: string]: unknown;
}

const LOG_LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private currentLevel: LogLevel;
  private format: 'json' | 'text';

  constructor(level?: LogLevel, format?: 'json' | 'text') {
    this.currentLevel = level || (process.env.NODE_ENV === 'test' ? 'error' : 'info');
    this.format = format || (process.env.LOG_FORMAT === 'json' || process.env.NODE_ENV === 'production' ? 'json' : 'text');
  }

  setLevel(level: LogLevel): void {
    this.currentLevel = level;
  }

  setFormat(format: 'json' | 'text'): void {
    this.format = format;
  }

  /**
   * Sanitizes sensitive secrets from text (bot tokens, database credentials).
   */
  public sanitize(text?: string | null): string {
    if (!text) return '';
    return text
      // Strip Telegram bot tokens (e.g., 123456789:ABCdefGhI...)
      .replace(/(?:bot)?\d{6,14}:[A-Za-z0-9_-]{8,60}/gi, '[REDACTED_BOT_TOKEN]')
      // Strip PostgreSQL connection URLs containing passwords
      .replace(/postgres(?:ql)?:\/\/[^:]+:[^@]+@[^\s"']+/gi, '[REDACTED_DATABASE_URL]');
  }

  /**
   * Recursively prepares context for serialization, converting BigInts and sanitizing strings.
   */
  private prepareContext(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj;

    if (typeof obj === 'bigint') {
      return obj.toString();
    }

    if (typeof obj === 'string') {
      return this.sanitize(obj);
    }

    if (obj instanceof Error) {
      return {
        name: obj.name,
        message: this.sanitize(obj.message),
        stack: this.sanitize(obj.stack),
      };
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.prepareContext(item));
    }

    if (typeof obj === 'object') {
      const clean: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        clean[key] = this.prepareContext(value);
      }
      return clean;
    }

    return obj;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_SEVERITY[level] >= LOG_LEVEL_SEVERITY[this.currentLevel];
  }

  private log(level: LogLevel, message: string, context?: LogContext): void {
    if (!this.shouldLog(level)) return;

    const timestamp = new Date().toISOString();
    const event = context?.event || 'app.event';
    const sanitizedMsg = this.sanitize(message);

    const serializedContext = (this.prepareContext(context || {}) as Record<string, unknown>) || {};
    delete serializedContext.event;

    if (this.format === 'json') {
      const record: StructuredLogRecord = {
        timestamp,
        level: level.toUpperCase(),
        message: sanitizedMsg,
        event,
        ...serializedContext,
      };

      const jsonStr = JSON.stringify(record);
      if (level === 'error') {
        console.error(jsonStr);
      } else if (level === 'warn') {
        console.warn(jsonStr);
      } else {
        console.log(jsonStr);
      }
    } else {
      // Readable text mode
      const contextEntries = Object.entries(serializedContext);
      const contextStr = contextEntries.length > 0 ? ` ${JSON.stringify(serializedContext)}` : '';
      const line = `[${timestamp}] [${level.toUpperCase()}] [${event}] ${sanitizedMsg}${contextStr}`;

      if (level === 'error') {
        console.error(line);
      } else if (level === 'warn') {
        console.warn(line);
      } else {
        console.log(line);
      }
    }
  }

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.log('error', message, context);
  }

  /**
   * Generates a correlation identifier for tracing an announcement distribution cycle.
   */
  createCorrelationId(prefix = 'corr'): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  }
}

export const logger = new Logger();
