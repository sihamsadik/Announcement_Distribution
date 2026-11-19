/**
 * Utility functions for timezone-aware date/time parsing, validation, and formatting.
 * Uses native Intl.DateTimeFormat (no external calendar libraries required).
 */

export const DEFAULT_TIMEZONE = 'Africa/Addis_Ababa';

/**
 * Validates whether an IANA timezone string is valid in the JavaScript runtime.
 */
export function isValidTimezone(timezone: string): boolean {
  if (!timezone || typeof timezone !== 'string') return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone.trim() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates date string in YYYY-MM-DD format.
 */
export function isValidDateString(dateStr: string): boolean {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr.trim())) return false;
  const [year, month, day] = dateStr.trim().split('-').map(Number);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;

  const d = new Date(year, month - 1, day);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

/**
 * Validates time string in HH:MM or HH:MM:SS format (24-hour).
 */
export function isValidTimeString(timeStr: string): boolean {
  if (!timeStr || !/^\d{1,2}:\d{2}(:\d{2})?$/.test(timeStr.trim())) return false;
  const parts = timeStr.trim().split(':').map(Number);
  const hour = parts[0];
  const minute = parts[1];
  const second = parts[2] !== undefined ? parts[2] : 0;

  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59;
}

/**
 * Parses a date string (YYYY-MM-DD) and time string (HH:MM or HH:MM:SS) in a specific IANA timezone,
 * returning a UTC JavaScript Date object.
 */
export function parseDateTimeInTimezone(dateStr: string, timeStr: string, timezone = DEFAULT_TIMEZONE): Date {
  if (!isValidDateString(dateStr)) {
    throw new Error(`Invalid date format: "${dateStr}". Expected YYYY-MM-DD.`);
  }
  if (!isValidTimeString(timeStr)) {
    throw new Error(`Invalid time format: "${timeStr}". Expected HH:MM in 24-hour format.`);
  }
  const cleanTz = timezone.trim();
  if (!isValidTimezone(cleanTz)) {
    throw new Error(`Invalid IANA time zone: "${timezone}". Default is "${DEFAULT_TIMEZONE}".`);
  }

  const [year, month, day] = dateStr.trim().split('-').map(Number);
  const timeParts = timeStr.trim().split(':').map(Number);
  const hour = timeParts[0];
  const minute = timeParts[1];
  const second = timeParts[2] !== undefined ? timeParts[2] : 0;

  // Initial UTC guess
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  // Determine the timezone offset at this instant using Intl.DateTimeFormat
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: cleanTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const getRenderedDate = (d: Date): Date => {
    const parts = formatter.formatToParts(d);
    const map: Record<string, number> = {};
    for (const p of parts) {
      if (p.type !== 'literal') map[p.type] = Number(p.value);
    }
    if (map.hour === 24) map.hour = 0;
    return new Date(Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second));
  };

  const renderedAsLocal = getRenderedDate(utcGuess);
  const diffMs = utcGuess.getTime() - renderedAsLocal.getTime();
  const targetDate = new Date(utcGuess.getTime() + diffMs);

  // Second pass verification to account for daylight saving boundary adjustments
  const verified = getRenderedDate(targetDate);
  const finalDiff = targetDate.getTime() + (utcGuess.getTime() - verified.getTime());
  return new Date(finalDiff);
}

/**
 * Formats a Date object in a human-readable string in the specified timezone.
 * Example: "Friday, November 20, 2026 at 11:59 PM (Africa/Addis_Ababa)"
 */
export function formatDateTimeInTimezone(date: Date, timezone = DEFAULT_TIMEZONE): string {
  const cleanTz = isValidTimezone(timezone) ? timezone.trim() : DEFAULT_TIMEZONE;

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: cleanTz,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  return `${formatter.format(date)} (${cleanTz})`;
}

/**
 * Formats time remaining until a target date from reference point (defaults to now).
 */
export function formatTimeRemaining(targetDate: Date, fromDate = new Date()): string {
  const diffMs = targetDate.getTime() - fromDate.getTime();
  if (diffMs <= 0) {
    return 'Deadline has passed';
  }

  const totalMinutes = Math.floor(diffMs / (1000 * 60));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days} day${days === 1 ? '' : 's'}`);
  }
  if (hours > 0) {
    parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  }
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  }

  return parts.join(', ');
}

export interface ParsedReminderResult {
  date: Date | null;
  error?: string;
}

/**
 * Parses an optional additional reminder specification:
 * - "none", "no", "0" => null
 * - Relative offset: "2h", "2 hours", "30m", "30 mins", "1d" => dueAt - offset
 * - Absolute date & time: "2026-11-20 18:00" in timezone
 */
export function parseAdditionalReminder(
  input: string | undefined | null,
  dueAt: Date,
  timezone = DEFAULT_TIMEZONE,
  now = new Date()
): ParsedReminderResult {
  if (!input || !input.trim()) {
    return { date: null };
  }

  const raw = input.trim();
  const lower = raw.toLowerCase();

  if (['none', 'no', 'off', '0', 'null', 'disable'].includes(lower)) {
    return { date: null };
  }

  // Check relative format: e.g., 2h, 30m, 1d, 2 hours, 45 minutes
  const relativeMatch = raw.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i);
  if (relativeMatch) {
    const value = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();

    let offsetMs = 0;
    if (unit.startsWith('m')) {
      offsetMs = value * 60 * 1000;
    } else if (unit.startsWith('h')) {
      offsetMs = value * 60 * 60 * 1000;
    } else if (unit.startsWith('d')) {
      offsetMs = value * 24 * 60 * 60 * 1000;
    }

    if (offsetMs <= 0) {
      return { date: null, error: 'Reminder offset must be greater than 0.' };
    }

    const reminderDate = new Date(dueAt.getTime() - offsetMs);
    if (reminderDate.getTime() <= now.getTime()) {
      return {
        date: null,
        error: `Additional reminder calculated at ${formatDateTimeInTimezone(reminderDate, timezone)} is already in the past.`,
      };
    }
    if (reminderDate.getTime() >= dueAt.getTime()) {
      return {
        date: null,
        error: 'Additional reminder must be scheduled before the submission deadline.',
      };
    }

    return { date: reminderDate };
  }

  // Check absolute format: "YYYY-MM-DD HH:MM"
  const absoluteParts = raw.split(/\s+/);
  if (absoluteParts.length === 2 && isValidDateString(absoluteParts[0]) && isValidTimeString(absoluteParts[1])) {
    try {
      const parsedDate = parseDateTimeInTimezone(absoluteParts[0], absoluteParts[1], timezone);
      if (parsedDate.getTime() <= now.getTime()) {
        return {
          date: null,
          error: `Additional reminder (${formatDateTimeInTimezone(parsedDate, timezone)}) is in the past.`,
        };
      }
      if (parsedDate.getTime() >= dueAt.getTime()) {
        return {
          date: null,
          error: 'Additional reminder must be scheduled before the submission deadline.',
        };
      }
      return { date: parsedDate };
    } catch (err: any) {
      return { date: null, error: err.message };
    }
  }

  return {
    date: null,
    error:
      'Invalid additional reminder format. Specify offset (e.g., "2h", "30m", "1d") or date/time "YYYY-MM-DD HH:MM", or "none".',
  };
}
