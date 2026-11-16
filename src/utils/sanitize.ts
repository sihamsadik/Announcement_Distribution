/**
 * Strips any occurrence of the bot token from error strings or logs.
 */
export function sanitizeError(err: unknown, token?: string): string {
  let message = err instanceof Error ? (err.message || String(err)) : String(err);
  if (token && token.length > 5) {
    message = message.split(token).join('[REDACTED_TOKEN]');
    const parts = token.split(':');
    if (parts.length === 2 && parts[1].length > 4) {
      message = message.split(parts[1]).join('[REDACTED_TOKEN]');
    }
  }
  return message;
}
