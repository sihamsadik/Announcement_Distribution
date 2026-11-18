import { SourceGroup, DestinationGroup } from '@prisma/client';
import { prisma } from '../db/prisma';

export interface RegisterSourceInput {
  chatId: bigint | number | string;
  topicId: bigint | number | string;
  name: string;
}

export interface RegisterSourceResult {
  success: boolean;
  isNew: boolean;
  message: string;
  source?: SourceGroup;
}

export interface UpdateSourceStatusResult {
  success: boolean;
  message: string;
  source?: SourceGroup;
}

export interface DeleteSourceResult {
  success: boolean;
  message: string;
}

export type SourceWithDestinations = SourceGroup & {
  destinationGroups: DestinationGroup[];
};

export interface SourceDetails {
  source: SourceGroup;
  destinations: DestinationGroup[];
  totalDestinations: number;
  activeDestinations: number;
  inactiveDestinations: number;
  totalDeliveries: number;
  successfulDeliveries: number;
  failedDeliveries: number;
}

export class SourceService {
  /**
   * Registers a Telegram source group and topic.
   * If a source with the given chatId and topicId already exists, returns the existing record without duplicating.
   */
  async registerSource(input: RegisterSourceInput): Promise<RegisterSourceResult> {
    const trimmedName = input.name?.trim();
    if (!trimmedName) {
      return {
        success: false,
        isNew: false,
        message: 'Source name cannot be empty.',
      };
    }

    let bigChatId: bigint;
    let bigTopicId: bigint;

    try {
      bigChatId = BigInt(input.chatId);
      bigTopicId = BigInt(input.topicId);
    } catch {
      return {
        success: false,
        isNew: false,
        message: 'Invalid chat ID or topic ID provided.',
      };
    }

    try {
      // Check if source already exists
      const existing = await prisma.sourceGroup.findUnique({
        where: {
          chatId_topicId: {
            chatId: bigChatId,
            topicId: bigTopicId,
          },
        },
      });

      if (existing) {
        // If it was previously deactivated, reactivate it automatically on re-registration
        if (!existing.isActive) {
          const reactivated = await prisma.sourceGroup.update({
            where: { id: existing.id },
            data: { isActive: true, name: trimmedName },
          });
          console.log(`[SourceService] Reactivated previously inactive source "${reactivated.name}" (ID: ${reactivated.id})`);
          return {
            success: true,
            isNew: false,
            message: `Previously inactive source topic "${reactivated.name}" has been reactivated!`,
            source: reactivated,
          };
        }

        return {
          success: true,
          isNew: false,
          message: `Source topic "${existing.name}" is already registered (Chat: ${bigChatId}, Topic: ${bigTopicId}).`,
          source: existing,
        };
      }

      // Create new source group
      const newSource = await prisma.sourceGroup.create({
        data: {
          chatId: bigChatId,
          topicId: bigTopicId,
          name: trimmedName,
          isActive: true,
        },
      });

      console.log(`[SourceService] Registered new source: "${newSource.name}" (Chat: ${bigChatId}, Topic: ${bigTopicId})`);

      return {
        success: true,
        isNew: true,
        message: `Source topic "${newSource.name}" registered successfully!`,
        source: newSource,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[SourceService Error] Failed to register source: ${errorMsg}`);
      return {
        success: false,
        isNew: false,
        message: 'Database error occurred while registering source.',
      };
    }
  }

  /**
   * Looks up a registered source by chatId and topicId.
   */
  async findSource(chatId: bigint | number | string, topicId: bigint | number | string): Promise<SourceGroup | null> {
    try {
      const bigChatId = BigInt(chatId);
      const bigTopicId = BigInt(topicId);

      return await prisma.sourceGroup.findUnique({
        where: {
          chatId_topicId: {
            chatId: bigChatId,
            topicId: bigTopicId,
          },
        },
      });
    } catch {
      return null;
    }
  }

  /**
   * Retrieves a source group by primary key ID, including associated destination groups.
   */
  async getSourceById(id: string): Promise<SourceWithDestinations | null> {
    try {
      return await prisma.sourceGroup.findUnique({
        where: { id: id.trim() },
        include: {
          destinationGroups: {
            orderBy: { createdAt: 'asc' },
          },
        },
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[SourceService Error] Failed to find source by ID: ${errorMsg}`);
      return null;
    }
  }

  /**
   * Retrieves all registered sources with associated destination group counts.
   */
  async listSources(): Promise<SourceWithDestinations[]> {
    try {
      return await prisma.sourceGroup.findMany({
        include: {
          destinationGroups: {
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[SourceService Error] Failed to list sources: ${errorMsg}`);
      return [];
    }
  }

  /**
   * Updates the active status of a source topic.
   * Deactivating (isActive: false) prevents future forwards while retaining full delivery history.
   */
  async setSourceStatus(id: string, isActive: boolean): Promise<UpdateSourceStatusResult> {
    const trimmedId = id?.trim();
    if (!trimmedId) {
      return {
        success: false,
        message: 'Source ID cannot be empty.',
      };
    }

    try {
      const existing = await prisma.sourceGroup.findUnique({
        where: { id: trimmedId },
      });

      if (!existing) {
        return {
          success: false,
          message: `Source topic with ID "${trimmedId}" was not found. Use /list_sources to view available sources.`,
        };
      }

      if (existing.isActive === isActive) {
        return {
          success: true,
          message: `Source topic "${existing.name}" is already ${isActive ? 'active' : 'inactive'}.`,
          source: existing,
        };
      }

      const updated = await prisma.sourceGroup.update({
        where: { id: trimmedId },
        data: { isActive },
      });

      const action = isActive ? 'reactivated' : 'deactivated';
      console.log(`[SourceService] Source topic "${updated.name}" (${updated.id}) ${action}.`);

      return {
        success: true,
        message: `Source topic "${updated.name}" has been successfully ${action}.`,
        source: updated,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[SourceService Error] Failed to update source status: ${errorMsg}`);
      return {
        success: false,
        message: 'Database error occurred while updating source status.',
      };
    }
  }

  /**
   * Safe source deletion:
   * Prevents hard deletion if historical delivery logs exist to preserve audit history.
   * Admins are instructed to deactivate instead.
   */
  async deleteSource(id: string): Promise<DeleteSourceResult> {
    const trimmedId = id?.trim();
    if (!trimmedId) {
      return {
        success: false,
        message: 'Source ID cannot be empty.',
      };
    }

    try {
      const existing = await prisma.sourceGroup.findUnique({
        where: { id: trimmedId },
        include: { destinationGroups: true },
      });

      if (!existing) {
        return {
          success: false,
          message: `Source topic with ID "${trimmedId}" was not found.`,
        };
      }

      // Check if any forwarding logs are associated with destinations of this source
      const logCount = await prisma.forwardingLog.count({
        where: {
          destinationGroup: {
            sourceGroupId: trimmedId,
          },
        },
      });

      if (logCount > 0) {
        return {
          success: false,
          message:
            `Cannot delete source "${existing.name}": ${logCount} historical forwarding log(s) exist. ` +
            `To safely preserve audit logs while stopping future distribution, deactivate it with /remove_source ${trimmedId}`,
        };
      }

      // Safe to delete because no delivery history exists
      await prisma.sourceGroup.delete({
        where: { id: trimmedId },
      });

      console.log(`[SourceService] Source "${existing.name}" (${trimmedId}) deleted safely (0 forwarding logs existed).`);
      return {
        success: true,
        message: `Source topic "${existing.name}" has been permanently deleted.`,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[SourceService Error] Failed to delete source: ${errorMsg}`);
      return {
        success: false,
        message: 'Database error occurred while deleting source.',
      };
    }
  }

  /**
   * Retrieves comprehensive metadata, destination list, and delivery statistics for a source.
   */
  async getSourceDetails(id: string): Promise<SourceDetails | null> {
    const trimmedId = id?.trim();
    if (!trimmedId) {
      return null;
    }

    try {
      const source = await prisma.sourceGroup.findUnique({
        where: { id: trimmedId },
        include: {
          destinationGroups: {
            orderBy: { createdAt: 'asc' },
          },
        },
      });

      if (!source) {
        return null;
      }

      const activeCount = source.destinationGroups.filter((d) => d.isActive).length;
      const inactiveCount = source.destinationGroups.length - activeCount;

      const [totalDeliveries, successfulDeliveries, failedDeliveries] = await Promise.all([
        prisma.forwardingLog.count({
          where: { destinationGroup: { sourceGroupId: trimmedId } },
        }),
        prisma.forwardingLog.count({
          where: { destinationGroup: { sourceGroupId: trimmedId }, status: 'SUCCESS' },
        }),
        prisma.forwardingLog.count({
          where: { destinationGroup: { sourceGroupId: trimmedId }, status: 'FAILED' },
        }),
      ]);

      return {
        source,
        destinations: source.destinationGroups,
        totalDestinations: source.destinationGroups.length,
        activeDestinations: activeCount,
        inactiveDestinations: inactiveCount,
        totalDeliveries,
        successfulDeliveries,
        failedDeliveries,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[SourceService Error] Failed to get source details: ${errorMsg}`);
      return null;
    }
  }
}

export const sourceService = new SourceService();
