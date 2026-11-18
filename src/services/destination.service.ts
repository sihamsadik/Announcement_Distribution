import { DestinationGroup, SourceGroup } from '@prisma/client';
import { prisma } from '../db/prisma';
import { isValidUuid, isValidTelegramChatId, validateResourceName } from '../utils/validators';

export interface RegisterDestinationInput {
  chatId: bigint | number | string;
  groupName: string;
  sourceGroupId: string;
}

export interface RegisterDestinationResult {
  success: boolean;
  isNew: boolean;
  message: string;
  destination?: DestinationWithSource;
}

export interface UpdateDestinationStatusResult {
  success: boolean;
  message: string;
  destination?: DestinationWithSource;
}

export interface DeleteDestinationResult {
  success: boolean;
  message: string;
}

export type DestinationWithSource = DestinationGroup & {
  sourceGroup: SourceGroup;
};

export class DestinationService {
  /**
   * Registers a destination group under an active source group.
   * If the destination is already registered under the same source, returns the existing record idempotently.
   */
  async registerDestination(input: RegisterDestinationInput): Promise<RegisterDestinationResult> {
    const nameValidation = validateResourceName(input.groupName, 'Destination group name');
    if (!nameValidation.valid) {
      return {
        success: false,
        isNew: false,
        message: nameValidation.error!,
      };
    }
    const trimmedGroupName = nameValidation.value!;

    const trimmedSourceId = input.sourceGroupId?.trim();
    if (!trimmedSourceId || !isValidUuid(trimmedSourceId)) {
      return {
        success: false,
        isNew: false,
        message: 'Invalid Source ID format. Expected a valid UUID.',
      };
    }

    if (!isValidTelegramChatId(input.chatId)) {
      return {
        success: false,
        isNew: false,
        message: 'Invalid destination chat ID provided.',
      };
    }

    let bigChatId: bigint;
    try {
      bigChatId = BigInt(input.chatId);
    } catch {
      return {
        success: false,
        isNew: false,
        message: 'Invalid destination chat ID provided.',
      };
    }

    try {
      // 1. Verify referenced source group exists
      const source = await prisma.sourceGroup.findUnique({
        where: { id: trimmedSourceId },
      });

      if (!source) {
        console.warn(`[DestinationService] Attempted to register destination for non-existent source: "${trimmedSourceId}"`);
        return {
          success: false,
          isNew: false,
          message: `Referenced source group with ID "${trimmedSourceId}" was not found. Please verify the source ID via /list_sources.`,
        };
      }

      if (!source.isActive) {
        return {
          success: false,
          isNew: false,
          message: `Cannot register destination under inactive source topic "${source.name}". Reactivate it first using /activate_source ${source.id}.`,
        };
      }

      // 2. Check for duplicate registration under the same source
      const existing = await prisma.destinationGroup.findUnique({
        where: {
          sourceGroupId_chatId: {
            sourceGroupId: trimmedSourceId,
            chatId: bigChatId,
          },
        },
        include: {
          sourceGroup: true,
        },
      });

      if (existing) {
        console.log(
          `[DestinationService] Duplicate registration attempt: "${existing.groupName}" (Chat: ${bigChatId}) ` +
          `is already registered under source "${existing.sourceGroup.name}".`
        );
        return {
          success: true,
          isNew: false,
          message: `This group is already registered as "${existing.groupName}" for source "${existing.sourceGroup.name}". (Status: ${existing.isActive ? 'Active' : 'Inactive'})`,
          destination: existing,
        };
      }

      // 3. Create new destination record
      const newDestination = await prisma.destinationGroup.create({
        data: {
          chatId: bigChatId,
          groupName: trimmedGroupName,
          sourceGroupId: trimmedSourceId,
          isActive: true,
        },
        include: {
          sourceGroup: true,
        },
      });

      console.log(
        `[DestinationService] Successfully registered destination "${newDestination.groupName}" ` +
        `(Chat: ${bigChatId}) under source "${newDestination.sourceGroup.name}" (ID: ${trimmedSourceId})`
      );

      return {
        success: true,
        isNew: true,
        message: `Destination group "${newDestination.groupName}" registered successfully!`,
        destination: newDestination,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[DestinationService Error] Failed to register destination: ${errorMsg}`);
      return {
        success: false,
        isNew: false,
        message: 'Database error occurred while registering destination.',
      };
    }
  }

  /**
   * Lists destination groups. Optionally filtered by a specific source group ID.
   */
  async listDestinations(sourceGroupId?: string): Promise<DestinationWithSource[]> {
    try {
      const whereClause: any = {};
      if (sourceGroupId) {
        const trimmed = sourceGroupId.trim();
        if (isValidUuid(trimmed)) {
          whereClause.sourceGroupId = trimmed;
        } else {
          return [];
        }
      }

      return await prisma.destinationGroup.findMany({
        where: whereClause,
        orderBy: {
          createdAt: 'asc',
        },
        include: {
          sourceGroup: true,
        },
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[DestinationService Error] Failed to list destinations: ${errorMsg}`);
      return [];
    }
  }

  /**
   * Retrieves active destination groups for a specific source group.
   * Excludes inactive destination groups and ensures source itself is active.
   */
  async getActiveDestinations(sourceGroupId: string): Promise<DestinationGroup[]> {
    const trimmedId = sourceGroupId?.trim();
    if (!trimmedId || !isValidUuid(trimmedId)) {
      return [];
    }

    try {
      // Check if source itself is active
      const source = await prisma.sourceGroup.findUnique({
        where: { id: trimmedId },
      });

      if (!source || !source.isActive) {
        return [];
      }

      return await prisma.destinationGroup.findMany({
        where: {
          sourceGroupId: trimmedId,
          isActive: true,
        },
        orderBy: {
          createdAt: 'asc',
        },
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[DestinationService Error] Failed to get active destinations: ${errorMsg}`);
      return [];
    }
  }

  /**
   * Finds a destination group by primary key ID.
   */
  async getDestinationById(id: string): Promise<DestinationWithSource | null> {
    try {
      const trimmed = id?.trim();
      if (!trimmed || !isValidUuid(trimmed)) return null;

      return await prisma.destinationGroup.findUnique({
        where: { id: trimmed },
        include: {
          sourceGroup: true,
        },
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[DestinationService Error] Failed to find destination: ${errorMsg}`);
      return null;
    }
  }

  /**
   * Updates the active status of a destination group.
   * Deactivation (isActive: false) retains delivery history while stopping forwards.
   */
  async setDestinationStatus(id: string, isActive: boolean): Promise<UpdateDestinationStatusResult> {
    const trimmedId = id?.trim();
    if (!trimmedId || !isValidUuid(trimmedId)) {
      return {
        success: false,
        message: 'Invalid Destination ID format. Expected a valid UUID.',
      };
    }

    try {
      const existing = await prisma.destinationGroup.findUnique({
        where: { id: trimmedId },
        include: { sourceGroup: true },
      });

      if (!existing) {
        return {
          success: false,
          message: `Destination group with ID "${trimmedId}" was not found.`,
        };
      }

      const updated = await prisma.destinationGroup.update({
        where: { id: trimmedId },
        data: { isActive },
        include: { sourceGroup: true },
      });

      const action = isActive ? 'reactivated' : 'deactivated';
      console.log(`[DestinationService] Destination "${updated.groupName}" (${updated.id}) ${action}.`);

      return {
        success: true,
        message: `Destination group "${updated.groupName}" has been ${action}.`,
        destination: updated,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[DestinationService Error] Failed to update destination status: ${errorMsg}`);
      return {
        success: false,
        message: 'Database error occurred while updating destination status.',
      };
    }
  }

  /**
   * Attempts to permanently delete a destination group.
   * CRITICAL DATA INTEGRITY SAFEGUARD:
   * Rejects deletion if any historical forwarding records exist for this destination,
   * instructing administrators to use soft-deactivation instead.
   */
  async deleteDestination(id: string): Promise<DeleteDestinationResult> {
    const trimmedId = id?.trim();
    if (!trimmedId || !isValidUuid(trimmedId)) {
      return {
        success: false,
        message: 'Invalid Destination ID format. Expected a valid UUID.',
      };
    }

    try {
      const existing = await prisma.destinationGroup.findUnique({
        where: { id: trimmedId },
      });

      if (!existing) {
        return {
          success: false,
          message: `Destination with ID "${trimmedId}" was not found.`,
        };
      }

      // Check if forwarding logs exist for this destination
      const logsCount = await prisma.forwardingLog.count({
        where: { destinationGroupId: trimmedId },
      });

      if (logsCount > 0) {
        return {
          success: false,
          message:
            `Cannot delete destination "${existing.groupName}": ${logsCount} historical forwarding log(s) exist. ` +
            `To protect audit history, please use soft deactivation (/remove_destination ${trimmedId}) instead.`,
        };
      }

      await prisma.destinationGroup.delete({
        where: { id: trimmedId },
      });

      console.log(`[DestinationService] Permanently deleted unused destination "${existing.groupName}" (${trimmedId}).`);

      return {
        success: true,
        message: `Destination "${existing.groupName}" was permanently deleted.`,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[DestinationService Error] Failed to delete destination: ${errorMsg}`);
      return {
        success: false,
        message: 'Database error occurred while deleting destination.',
      };
    }
  }
}

export const destinationService = new DestinationService();
