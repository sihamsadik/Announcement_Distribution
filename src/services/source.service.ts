import { SourceGroup, DestinationGroup } from '@prisma/client';
import { prisma } from '../db/prisma';
import { isValidUuid, isValidTelegramChatId, isValidTelegramTopicId, validateResourceName } from '../utils/validators';

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
    const nameValidation = validateResourceName(input.name, 'Source name');
    if (!nameValidation.valid) {
      return {
        success: false,
        isNew: false,
        message: nameValidation.error!,
      };
    }
    const trimmedName = nameValidation.value!;

    if (!isValidTelegramChatId(input.chatId) || !isValidTelegramTopicId(input.topicId)) {
      return {
        success: false,
        isNew: false,
        message: 'Invalid chat ID or topic ID provided.',
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
      if (!isValidTelegramChatId(chatId) || !isValidTelegramTopicId(topicId)) {
        return null;
      }

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
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[SourceService Error] Failed to find source: ${errorMsg}`);
      return null;
    }
  }

  /**
   * Finds a source group by its primary key ID.
   */
  async getSourceById(id: string): Promise<SourceGroup | null> {
    try {
      if (!isValidUuid(id)) return null;

      return await prisma.sourceGroup.findUnique({
        where: { id: id.trim() },
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[SourceService Error] Failed to get source by ID: ${errorMsg}`);
      return null;
    }
  }

  /**
   * Retrieves full details for a source, including associated destination groups and delivery metrics.
   */
  async getSourceDetails(id: string): Promise<SourceDetails | null> {
    try {
      if (!isValidUuid(id)) return null;

      const source = await prisma.sourceGroup.findUnique({
        where: { id: id.trim() },
        include: {
          destinationGroups: {
            orderBy: { createdAt: 'asc' },
          },
        },
      });

      if (!source) {
        return null;
      }

      const totalDestinations = source.destinationGroups.length;
      const activeDestinations = source.destinationGroups.filter((d) => d.isActive).length;
      const inactiveDestinations = totalDestinations - activeDestinations;

      // Query delivery logs associated with this source
      const totalDeliveries = await prisma.forwardingLog.count({
        where: {
          destinationGroup: {
            sourceGroupId: source.id,
          },
        },
      });

      const successfulDeliveries = await prisma.forwardingLog.count({
        where: {
          destinationGroup: {
            sourceGroupId: source.id,
          },
          status: 'SUCCESS',
        },
      });

      const failedDeliveries = await prisma.forwardingLog.count({
        where: {
          destinationGroup: {
            sourceGroupId: source.id,
          },
          status: {
            in: ['FAILED', 'RETRYING'],
          },
        },
      });

      return {
        source,
        destinations: source.destinationGroups,
        totalDestinations,
        activeDestinations,
        inactiveDestinations,
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

  /**
   * Toggles the active status of a source group.
   * Deactivating (isActive: false) prevents the bot from forwarding announcements from this topic,
   * while completely preserving all historical delivery records and destination links.
   */
  async setSourceStatus(id: string, isActive: boolean): Promise<UpdateSourceStatusResult> {
    const trimmedId = id?.trim();
    if (!trimmedId || !isValidUuid(trimmedId)) {
      return {
        success: false,
        message: 'Invalid Source ID format. Expected a valid UUID.',
      };
    }

    try {
      const existing = await prisma.sourceGroup.findUnique({
        where: { id: trimmedId },
      });

      if (!existing) {
        return {
          success: false,
          message: `Source topic with ID "${trimmedId}" was not found.`,
        };
      }

      const updated = await prisma.sourceGroup.update({
        where: { id: trimmedId },
        data: { isActive },
      });

      const actionText = isActive ? 'reactivated' : 'deactivated';
      console.log(`[SourceService] Source topic "${updated.name}" (${updated.id}) ${actionText}.`);

      return {
        success: true,
        message: `Source topic "${updated.name}" has been ${actionText}.`,
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
   * Attempts to permanently delete a source group.
   * CRITICAL DATA INTEGRITY SAFEGUARD:
   * Rejects deletion if any historical delivery records exist for this source,
   * instructing administrators to use soft-deactivation instead.
   */
  async deleteSource(id: string): Promise<DeleteSourceResult> {
    const trimmedId = id?.trim();
    if (!trimmedId || !isValidUuid(trimmedId)) {
      return {
        success: false,
        message: 'Invalid Source ID format. Expected a valid UUID.',
      };
    }

    try {
      const existing = await prisma.sourceGroup.findUnique({
        where: { id: trimmedId },
      });

      if (!existing) {
        return {
          success: false,
          message: `Source with ID "${trimmedId}" was not found.`,
        };
      }

      // Check if forwarding logs exist across any linked destinations
      const logsCount = await prisma.forwardingLog.count({
        where: {
          destinationGroup: {
            sourceGroupId: trimmedId,
          },
        },
      });

      if (logsCount > 0) {
        return {
          success: false,
          message:
            `Cannot delete source "${existing.name}": ${logsCount} historical forwarding log(s) exist. ` +
            `To protect audit history, please use soft deactivation (/remove_source ${trimmedId}) instead.`,
        };
      }

      await prisma.sourceGroup.delete({
        where: { id: trimmedId },
      });

      console.log(`[SourceService] Permanently deleted unused source "${existing.name}" (${trimmedId}).`);

      return {
        success: true,
        message: `Source "${existing.name}" was permanently deleted.`,
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
   * Retrieves all registered source groups, ordered by creation date descending.
   */
  async listSources(): Promise<SourceWithDestinations[]> {
    try {
      return await prisma.sourceGroup.findMany({
        orderBy: {
          createdAt: 'desc',
        },
        include: {
          destinationGroups: true,
        },
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[SourceService Error] Failed to list sources: ${errorMsg}`);
      return [];
    }
  }
}

export const sourceService = new SourceService();
