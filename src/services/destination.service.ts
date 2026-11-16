import { DestinationGroup, SourceGroup } from '@prisma/client';
import { prisma } from '../db/prisma';

export interface RegisterDestinationInput {
  chatId: bigint | number | string;
  groupName: string;
  sourceGroupId: string;
}

export type DestinationWithSource = DestinationGroup & { sourceGroup: SourceGroup };

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

export class DestinationService {
  /**
   * Registers a Telegram destination group and associates it with a SourceGroup.
   */
  async registerDestination(input: RegisterDestinationInput): Promise<RegisterDestinationResult> {
    const trimmedName = input.groupName?.trim();
    if (!trimmedName) {
      return {
        success: false,
        isNew: false,
        message: 'Destination group name cannot be empty.',
      };
    }

    const trimmedSourceId = input.sourceGroupId?.trim();
    if (!trimmedSourceId) {
      return {
        success: false,
        isNew: false,
        message: 'Source group ID cannot be empty.',
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

      // 3. Create destination group record
      const destination = await prisma.destinationGroup.create({
        data: {
          chatId: bigChatId,
          groupName: trimmedName,
          sourceGroupId: trimmedSourceId,
          isActive: true,
        },
        include: {
          sourceGroup: true,
        },
      });

      console.log(
        `[DestinationService] Successfully registered destination "${destination.groupName}" ` +
        `(Chat: ${bigChatId}) under source "${destination.sourceGroup.name}" (ID: ${destination.sourceGroupId})`
      );

      return {
        success: true,
        isNew: true,
        message: `Destination group "${destination.groupName}" registered successfully under source "${destination.sourceGroup.name}".`,
        destination,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[DestinationService Error] Failed to register destination: ${errorMsg}`);
      return {
        success: false,
        isNew: false,
        message: 'Database error occurred while registering destination group.',
      };
    }
  }

  /**
   * Retrieves all destination groups, optionally filtered by sourceGroupId.
   */
  async listDestinations(sourceGroupId?: string): Promise<DestinationWithSource[]> {
    try {
      const whereClause = sourceGroupId?.trim() ? { sourceGroupId: sourceGroupId.trim() } : {};
      return await prisma.destinationGroup.findMany({
        where: whereClause,
        include: {
          sourceGroup: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[DestinationService Error] Failed to list destinations: ${errorMsg}`);
      return [];
    }
  }

  /**
   * Retrieves only active destination groups for a specific source group.
   */
  async getActiveDestinations(sourceGroupId: string): Promise<DestinationGroup[]> {
    const trimmedId = sourceGroupId?.trim();
    if (!trimmedId) {
      return [];
    }

    try {
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
      return await prisma.destinationGroup.findUnique({
        where: { id: id.trim() },
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
    if (!trimmedId) {
      return {
        success: false,
        message: 'Destination ID cannot be empty.',
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

      if (existing.isActive === isActive) {
        return {
          success: true,
          message: `Destination group "${existing.groupName}" is already ${isActive ? 'active' : 'inactive'}.`,
          destination: existing,
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
        message: `Destination group "${updated.groupName}" has been successfully ${action}.`,
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
}

export const destinationService = new DestinationService();
