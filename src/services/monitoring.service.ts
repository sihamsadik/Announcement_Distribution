import { ForwardingStatus, ForwardingLog, DestinationGroup, SourceGroup } from '@prisma/client';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';

export type TimeframeOption = '24h' | '7d' | '30d' | 'all';

export interface DeliveryStatsQuery {
  sourceGroupId?: string;
  timeframe?: TimeframeOption;
  since?: Date;
}

export interface DeliveryStats {
  sourceGroupId?: string;
  sourceName?: string;
  timeframe?: TimeframeOption;
  since?: Date;
  totalDeliveries: number;
  successfulDeliveries: number;
  failedDeliveries: number;
  retryingDeliveries: number;
  pendingDeliveries: number;
  totalRetryAttempts: number;
  successRate: string;
  failureRate: string;
  uniqueAnnouncements: number;
  totalSources: number;
  activeSources: number;
  totalDestinations: number;
  activeDestinations: number;
}

export type DeliveryLogWithRelations = ForwardingLog & {
  destinationGroup: DestinationGroup & {
    sourceGroup: SourceGroup;
  };
};

export interface RecentDeliveriesQuery {
  limit?: number;
  offset?: number;
  sourceGroupId?: string;
  status?: ForwardingStatus;
  since?: Date;
}

export interface FailedDeliveriesQuery {
  limit?: number;
  offset?: number;
  sourceGroupId?: string;
  since?: Date;
}

export class MonitoringService {
  /**
   * Sanitizes sensitive information (such as bot tokens or database URLs) from text.
   */
  sanitizeText(text?: string | null): string {
    return logger.sanitize(text);
  }

  /**
   * Resolves a timeframe option (e.g., '24h', '7d', '30d') to a concrete starting Date.
   */
  parseTimeframeDate(timeframe?: string): Date | undefined {
    if (!timeframe) return undefined;
    const tf = timeframe.toLowerCase().trim();
    const now = Date.now();

    switch (tf) {
      case '24h':
      case '1d':
        return new Date(now - 24 * 60 * 60 * 1000);
      case '7d':
        return new Date(now - 7 * 24 * 60 * 60 * 1000);
      case '30d':
        return new Date(now - 30 * 24 * 60 * 60 * 1000);
      default:
        return undefined;
    }
  }

  /**
   * Aggregates delivery statistics directly from PostgreSQL records.
   * Retries update the existing delivery record and increment retryCount;
   * totalDeliveries represents destination delivery outcomes without artificial retry inflation.
   */
  async getDeliveryStats(queryInput?: string | DeliveryStatsQuery): Promise<DeliveryStats> {
    try {
      let sourceGroupId: string | undefined;
      let timeframe: TimeframeOption | undefined;
      let since: Date | undefined;

      if (typeof queryInput === 'string') {
        sourceGroupId = queryInput.trim() || undefined;
      } else if (queryInput) {
        sourceGroupId = queryInput.sourceGroupId?.trim() || undefined;
        timeframe = queryInput.timeframe;
        since = queryInput.since || this.parseTimeframeDate(queryInput.timeframe);
      }

      let sourceName: string | undefined;

      const whereClause: any = {};
      if (sourceGroupId) {
        whereClause.destinationGroup = { sourceGroupId };
      }
      if (since) {
        whereClause.createdAt = { gte: since };
      }

      if (sourceGroupId) {
        const source = await prisma.sourceGroup.findUnique({
          where: { id: sourceGroupId },
          select: { name: true },
        });
        if (source) {
          sourceName = source.name;
        }
      }

      // Group counts by delivery status
      const statusCounts = await prisma.forwardingLog.groupBy({
        by: ['status'],
        where: whereClause,
        _count: {
          id: true,
        },
      });

      let totalDeliveries = 0;
      let successfulDeliveries = 0;
      let failedDeliveries = 0;
      let retryingDeliveries = 0;
      let pendingDeliveries = 0;

      for (const group of statusCounts) {
        const count = group._count.id;
        totalDeliveries += count;
        switch (group.status) {
          case ForwardingStatus.SUCCESS:
            successfulDeliveries = count;
            break;
          case ForwardingStatus.FAILED:
            failedDeliveries = count;
            break;
          case ForwardingStatus.RETRYING:
            retryingDeliveries = count;
            break;
          case ForwardingStatus.PENDING:
            pendingDeliveries = count;
            break;
        }
      }

      // Aggregate total individual retry attempts across delivery records
      const retryAggregate = await prisma.forwardingLog.aggregate({
        where: whereClause,
        _sum: {
          retryCount: true,
        },
      });
      const totalRetryAttempts = retryAggregate._sum.retryCount ?? 0;

      // Safe rate calculations handling empty state without division by zero
      const successRate = totalDeliveries > 0
        ? `${((successfulDeliveries / totalDeliveries) * 100).toFixed(1)}%`
        : '0.0%';

      const failureRate = totalDeliveries > 0
        ? `${((failedDeliveries / totalDeliveries) * 100).toFixed(1)}%`
        : '0.0%';

      // Count distinct announcements (sourceChatId + sourceMessageId)
      const uniqueAnnouncementsResult = await prisma.forwardingLog.groupBy({
        by: ['sourceChatId', 'sourceMessageId'],
        where: whereClause,
      });
      const uniqueAnnouncements = uniqueAnnouncementsResult.length;

      // Global or filtered source and destination counts
      let totalSources = 0;
      let activeSources = 0;
      let totalDestinations = 0;
      let activeDestinations = 0;

      if (sourceGroupId) {
        totalSources = sourceName ? 1 : 0;
        const sourceRecord = await prisma.sourceGroup.findUnique({
          where: { id: sourceGroupId },
          select: { isActive: true },
        });
        activeSources = sourceRecord?.isActive ? 1 : 0;

        totalDestinations = await prisma.destinationGroup.count({
          where: { sourceGroupId },
        });
        activeDestinations = await prisma.destinationGroup.count({
          where: { sourceGroupId, isActive: true },
        });
      } else {
        totalSources = await prisma.sourceGroup.count();
        activeSources = await prisma.sourceGroup.count({
          where: { isActive: true },
        });
        totalDestinations = await prisma.destinationGroup.count();
        activeDestinations = await prisma.destinationGroup.count({
          where: { isActive: true },
        });
      }

      return {
        sourceGroupId,
        sourceName,
        timeframe,
        since,
        totalDeliveries,
        successfulDeliveries,
        failedDeliveries,
        retryingDeliveries,
        pendingDeliveries,
        totalRetryAttempts,
        successRate,
        failureRate,
        uniqueAnnouncements,
        totalSources,
        activeSources,
        totalDestinations,
        activeDestinations,
      };
    } catch (err) {
      logger.error('Failed to aggregate delivery stats', { event: 'stats.error', error: err });
      throw err;
    }
  }

  /**
   * Retrieves recent deliveries, ordered by creation date descending.
   */
  async getRecentDeliveries(query: RecentDeliveriesQuery = {}): Promise<DeliveryLogWithRelations[]> {
    const limit = Math.min(Math.max(query.limit ?? 10, 1), 50);
    const offset = Math.max(query.offset ?? 0, 0);

    const where: any = {};
    if (query.sourceGroupId) {
      where.destinationGroup = { sourceGroupId: query.sourceGroupId };
    }
    if (query.status) {
      where.status = query.status;
    }
    if (query.since) {
      where.createdAt = { gte: query.since };
    }

    return (await prisma.forwardingLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      include: {
        destinationGroup: {
          include: {
            sourceGroup: true,
          },
        },
      },
    })) as DeliveryLogWithRelations[];
  }

  /**
   * Retrieves failed deliveries (status FAILED or RETRYING), ordered by lastAttemptAt descending.
   */
  async getFailedDeliveries(query: FailedDeliveriesQuery = {}): Promise<DeliveryLogWithRelations[]> {
    const limit = Math.min(Math.max(query.limit ?? 10, 1), 50);
    const offset = Math.max(query.offset ?? 0, 0);

    const where: any = {
      status: {
        in: [ForwardingStatus.FAILED, ForwardingStatus.RETRYING],
      },
    };

    if (query.sourceGroupId) {
      where.destinationGroup = { sourceGroupId: query.sourceGroupId };
    }
    if (query.since) {
      where.createdAt = { gte: query.since };
    }

    return (await prisma.forwardingLog.findMany({
      where,
      orderBy: { lastAttemptAt: 'desc' },
      take: limit,
      skip: offset,
      include: {
        destinationGroup: {
          include: {
            sourceGroup: true,
          },
        },
      },
    })) as DeliveryLogWithRelations[];
  }

  /**
   * Retrieves full details for a single delivery record by ID.
   */
  async getDeliveryDetails(id: string): Promise<DeliveryLogWithRelations | null> {
    const trimmedId = id.trim();
    if (!trimmedId) return null;

    return (await prisma.forwardingLog.findUnique({
      where: { id: trimmedId },
      include: {
        destinationGroup: {
          include: {
            sourceGroup: true,
          },
        },
      },
    })) as DeliveryLogWithRelations | null;
  }

  /**
   * Formats delivery statistics into a user-friendly, Telegram-ready markdown string.
   */
  formatStatsMessage(stats: DeliveryStats): string {
    let header = stats.sourceName
      ? `📊 **Distribution Statistics for "${stats.sourceName}"**`
      : '📊 **Distribution Statistics**';

    if (stats.timeframe && stats.timeframe !== 'all') {
      header += ` _(Past ${stats.timeframe})_`;
    }

    const lines = [
      header,
      '',
      `• **Total deliveries:** ${stats.totalDeliveries}`,
      `• **Successful:** ${stats.successfulDeliveries}`,
      `• **Failed:** ${stats.failedDeliveries}`,
      `• **Pending:** ${stats.pendingDeliveries}`,
      `• **Retrying:** ${stats.retryingDeliveries}`,
      `• **Total retry attempts:** ${stats.totalRetryAttempts}`,
      `• **Success rate:** ${stats.successRate}`,
      `• **Failure rate:** ${stats.failureRate}`,
      `• **Unique announcements:** ${stats.uniqueAnnouncements}`,
      '',
      `📂 **Sources:** ${stats.activeSources} active / ${stats.totalSources} registered`,
      `🎯 **Destinations:** ${stats.activeDestinations} active / ${stats.totalDestinations} registered`,
    ];

    if (stats.sourceGroupId) {
      lines.push(`🔑 **Source ID:** \`${stats.sourceGroupId}\``);
    }

    return lines.join('\n');
  }

  /**
   * Formats a list of recent deliveries into a Telegram-safe text message (<4096 chars).
   */
  formatRecentDeliveries(deliveries: DeliveryLogWithRelations[]): string {
    if (deliveries.length === 0) {
      return '📭 No delivery records found matching your query.';
    }

    const lines: string[] = [
      `📋 **Recent Deliveries (${deliveries.length} entries)**:`,
      '',
    ];

    for (const d of deliveries) {
      const statusIcon =
        d.status === ForwardingStatus.SUCCESS ? '✅' :
        d.status === ForwardingStatus.FAILED ? '❌' :
        d.status === ForwardingStatus.RETRYING ? '🔄' : '⏳';

      const sourceName = d.destinationGroup?.sourceGroup?.name || 'Unknown Source';
      const destName = d.destinationGroup?.groupName || 'Unknown Destination';
      const timeStr = d.createdAt.toISOString().replace('T', ' ').substring(0, 19);

      lines.push(
        `${statusIcon} **#${d.sourceMessageId}** ➔ **${destName}**\n` +
        `   • Source: ${sourceName} (Chat: \`${d.sourceChatId}\`)\n` +
        `   • Status: \`${d.status}\` | Retries: ${d.retryCount} | Date: ${timeStr}\n` +
        `   • ID: \`${d.id}\``
      );
    }

    lines.push('\n💡 Use `/delivery_details <id>` to inspect an entry in detail.');

    const result = lines.join('\n');
    return result.length > 4000 ? result.substring(0, 3990) + '\n... [truncated]' : result;
  }

  /**
   * Formats a list of failed deliveries into a Telegram-safe text message (<4096 chars).
   */
  formatFailedDeliveries(deliveries: DeliveryLogWithRelations[]): string {
    if (deliveries.length === 0) {
      return '🎉 No failed or retrying deliveries found!';
    }

    const lines: string[] = [
      `⚠️ **Failed / Retrying Deliveries (${deliveries.length} entries)**:`,
      '',
    ];

    for (const d of deliveries) {
      const statusIcon = d.status === ForwardingStatus.FAILED ? '❌' : '🔄';
      const sourceName = d.destinationGroup?.sourceGroup?.name || 'Unknown Source';
      const destName = d.destinationGroup?.groupName || 'Unknown Destination';
      const errorSanitized = this.sanitizeText(d.errorMessage) || 'No specific error recorded';
      const truncatedError = errorSanitized.length > 80 ? errorSanitized.substring(0, 77) + '...' : errorSanitized;

      lines.push(
        `${statusIcon} **#${d.sourceMessageId}** ➔ **${destName}**\n` +
        `   • Source: ${sourceName}\n` +
        `   • Status: \`${d.status}\` (Attempted: ${d.retryCount} times)\n` +
        `   • Error: _${truncatedError}_\n` +
        `   • ID: \`${d.id}\``
      );
    }

    lines.push('\n💡 Use `/delivery_details <id>` to view full error messages and timestamps.');

    const result = lines.join('\n');
    return result.length > 4000 ? result.substring(0, 3990) + '\n... [truncated]' : result;
  }

  /**
   * Formats a single delivery record's full details.
   */
  formatDeliveryDetails(d: DeliveryLogWithRelations): string {
    const statusIcon =
      d.status === ForwardingStatus.SUCCESS ? '✅' :
      d.status === ForwardingStatus.FAILED ? '❌' :
      d.status === ForwardingStatus.RETRYING ? '🔄' : '⏳';

    const source = d.destinationGroup?.sourceGroup;
    const dest = d.destinationGroup;
    const sanitizedError = this.sanitizeText(d.errorMessage);

    const lines = [
      `🔍 **Delivery Record Details**`,
      '',
      `• **Log ID:** \`${d.id}\``,
      `• **Status:** ${statusIcon} \`${d.status}\``,
      `• **Retry Count:** ${d.retryCount}`,
      `• **Source Message ID:** #${d.sourceMessageId}`,
      `• **Source Chat ID:** \`${d.sourceChatId}\``,
      `• **Source Topic:** ${source?.name || 'Unknown'} (Topic ID: \`${source?.topicId || 'N/A'}\`)`,
      `• **Destination Group:** ${dest?.groupName || 'Unknown'} (Chat: \`${dest?.chatId || 'N/A'}\`)`,
      `• **Created At:** ${d.createdAt.toISOString()}`,
      `• **Last Attempt:** ${d.lastAttemptAt.toISOString()}`,
      `• **Next Retry:** ${d.nextRetryAt ? d.nextRetryAt.toISOString() : 'None scheduled'}`,
      `• **Updated At:** ${d.updatedAt.toISOString()}`,
    ];

    if (sanitizedError) {
      lines.push('', `⚠️ **Error Message:**`, `\`\`\`\n${sanitizedError}\n\`\`\``);
    }

    const result = lines.join('\n');
    return result.length > 4000 ? result.substring(0, 3990) + '\n... [truncated]' : result;
  }
}

export const monitoringService = new MonitoringService();
