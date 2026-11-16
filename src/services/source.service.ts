import { SourceGroup } from '@prisma/client';
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
   * Retrieves all registered sources.
   */
  async listSources(): Promise<SourceGroup[]> {
    try {
      return await prisma.sourceGroup.findMany({
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
}

export const sourceService = new SourceService();
