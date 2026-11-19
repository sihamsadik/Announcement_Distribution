import {
  Deadline,
  DeadlineAnnouncement,
  DeadlineReminderDelivery,
  DeadlineStatus,
  DeliveryStatus,
  ReminderType,
  SourceGroup,
} from '@prisma/client';
import { prisma } from '../db/prisma';
import { destinationService, DestinationService } from './destination.service';
import {
  DEFAULT_TIMEZONE,
  isValidTimezone,
  parseDateTimeInTimezone,
  parseAdditionalReminder,
  formatDateTimeInTimezone,
} from '../utils/time';
import { isValidUuid } from '../utils/validators';

export interface CreateDeadlineInput {
  sourceGroupId: string;
  title: string;
  description: string;
  dateStr: string;
  timeStr: string;
  timezone?: string;
  additionalReminderStr?: string | null;
  createdBy: bigint | number | string;
  now?: Date;
}

export interface CreateDeadlineResult {
  success: boolean;
  message: string;
  deadline?: DeadlineWithRelations;
}

export interface CancelDeadlineResult {
  success: boolean;
  message: string;
  deadline?: Deadline;
}

export interface DeleteDeadlineResult {
  success: boolean;
  message: string;
}

export type DeadlineWithRelations = Deadline & {
  sourceGroup: SourceGroup;
  announcements: DeadlineAnnouncement[];
  reminderDeliveries: DeadlineReminderDelivery[];
};

export class DeadlineService {
  constructor(private readonly destService: DestinationService = destinationService) {}

  /**
   * Creates a new submission deadline linked to an active source group/topic.
   * Calculates the 24-hour reminder and optional additional reminder.
   * Pre-creates announcement and reminder delivery tracking records for all active destination groups.
   */
  async createDeadline(input: CreateDeadlineInput): Promise<CreateDeadlineResult> {
    const now = input.now || new Date();
    const sourceId = input.sourceGroupId?.trim();

    if (!sourceId || !isValidUuid(sourceId)) {
      return { success: false, message: 'Invalid Source ID format. Expected a valid UUID.' };
    }

    const title = input.title?.trim();
    if (!title || title.length < 3 || title.length > 200) {
      return { success: false, message: 'Title must be between 3 and 200 characters.' };
    }

    const description = input.description?.trim();
    if (!description || description.length < 3) {
      return { success: false, message: 'Description or instructions cannot be empty.' };
    }

    const timezone = (input.timezone && input.timezone.trim()) || DEFAULT_TIMEZONE;
    if (!isValidTimezone(timezone)) {
      return {
        success: false,
        message: `Invalid IANA timezone: "${input.timezone}". Please provide a valid timezone (e.g. "${DEFAULT_TIMEZONE}").`,
      };
    }

    let dueAt: Date;
    try {
      dueAt = parseDateTimeInTimezone(input.dateStr, input.timeStr, timezone);
    } catch (err: any) {
      return { success: false, message: err.message };
    }

    if (dueAt.getTime() <= now.getTime()) {
      return {
        success: false,
        message: `Submission deadline (${formatDateTimeInTimezone(dueAt, timezone)}) must be in the future.`,
      };
    }

    // Parse optional additional reminder
    let additionalReminderAt: Date | null = null;
    if (input.additionalReminderStr && input.additionalReminderStr.trim()) {
      const parsedReminder = parseAdditionalReminder(input.additionalReminderStr, dueAt, timezone, now);
      if (parsedReminder.error) {
        return { success: false, message: parsedReminder.error };
      }
      additionalReminderAt = parsedReminder.date;
    }

    let createdByBig: bigint;
    try {
      createdByBig = BigInt(input.createdBy);
    } catch {
      return { success: false, message: 'Invalid creator user ID.' };
    }

    try {
      // 1. Verify source group exists and is active
      const source = await prisma.sourceGroup.findUnique({
        where: { id: sourceId },
      });

      if (!source) {
        return {
          success: false,
          message: `Source topic with ID "${sourceId}" was not found.`,
        };
      }

      if (!source.isActive) {
        return {
          success: false,
          message: `Source topic "${source.name}" is currently inactive. Please reactivate it first.`,
        };
      }

      // 2. Fetch active destination groups
      const activeDestinations = await this.destService.getActiveDestinations(sourceId);

      // 3. Compute reminder timestamps
      const reminder24hAt = new Date(dueAt.getTime() - 24 * 60 * 60 * 1000);

      // 4. Create Deadline and initial tracking records in an atomic transaction
      const createdDeadline = await prisma.$transaction(async (tx) => {
        const deadline = await tx.deadline.create({
          data: {
            sourceGroupId: sourceId,
            title,
            description,
            dueAt,
            timezone,
            status: DeadlineStatus.ACTIVE,
            additionalReminderAt,
            createdBy: createdByBig,
          },
        });

        for (const dest of activeDestinations) {
          // Initial Announcement record
          await tx.deadlineAnnouncement.create({
            data: {
              deadlineId: deadline.id,
              destinationGroupId: dest.id,
              status: DeliveryStatus.PENDING,
            },
          });

          // 24-hour reminder record (if reminder time is still in the future)
          if (reminder24hAt.getTime() > now.getTime()) {
            await tx.deadlineReminderDelivery.create({
              data: {
                deadlineId: deadline.id,
                destinationGroupId: dest.id,
                reminderType: ReminderType.REMINDER_24_HOUR,
                scheduledFor: reminder24hAt,
                status: DeliveryStatus.PENDING,
              },
            });
          }

          // Optional additional reminder record
          if (additionalReminderAt && additionalReminderAt.getTime() > now.getTime()) {
            await tx.deadlineReminderDelivery.create({
              data: {
                deadlineId: deadline.id,
                destinationGroupId: dest.id,
                reminderType: ReminderType.ADDITIONAL,
                scheduledFor: additionalReminderAt,
                status: DeliveryStatus.PENDING,
              },
            });
          }
        }

        return tx.deadline.findUnique({
          where: { id: deadline.id },
          include: {
            sourceGroup: true,
            announcements: true,
            reminderDeliveries: true,
          },
        });
      });

      return {
        success: true,
        message: `Deadline "${title}" created successfully!`,
        deadline: createdDeadline as DeadlineWithRelations,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[DeadlineService Error] Failed to create deadline: ${errMsg}`);
      return { success: false, message: 'Database error occurred while creating deadline.' };
    }
  }

  /**
   * Retrieves upcoming active deadlines.
   */
  async listUpcomingDeadlines(sourceGroupId?: string, now = new Date()): Promise<DeadlineWithRelations[]> {
    try {
      const where: any = {
        status: DeadlineStatus.ACTIVE,
        dueAt: { gte: now },
      };

      if (sourceGroupId && isValidUuid(sourceGroupId.trim())) {
        where.sourceGroupId = sourceGroupId.trim();
      }

      return await prisma.deadline.findMany({
        where,
        orderBy: {
          dueAt: 'asc',
        },
        include: {
          sourceGroup: true,
          announcements: {
            include: { destinationGroup: true },
          },
          reminderDeliveries: {
            include: { destinationGroup: true },
          },
        },
      }) as DeadlineWithRelations[];
    } catch (err) {
      console.error('[DeadlineService Error] Failed to list upcoming deadlines:', err);
      return [];
    }
  }

  /**
   * Retrieves comprehensive deadline details by ID.
   */
  async getDeadlineDetails(id: string): Promise<DeadlineWithRelations | null> {
    const trimmedId = id?.trim();
    if (!trimmedId || !isValidUuid(trimmedId)) return null;

    try {
      return await prisma.deadline.findUnique({
        where: { id: trimmedId },
        include: {
          sourceGroup: true,
          announcements: {
            include: { destinationGroup: true },
          },
          reminderDeliveries: {
            include: { destinationGroup: true },
          },
        },
      }) as DeadlineWithRelations | null;
    } catch (err) {
      console.error(`[DeadlineService Error] Failed to get deadline details for ${id}:`, err);
      return null;
    }
  }

  /**
   * Cancels an active deadline and marks any pending reminder deliveries as EXPIRED.
   */
  async cancelDeadline(id: string): Promise<CancelDeadlineResult> {
    const trimmedId = id?.trim();
    if (!trimmedId || !isValidUuid(trimmedId)) {
      return { success: false, message: 'Invalid Deadline ID format. Expected a valid UUID.' };
    }

    try {
      const existing = await prisma.deadline.findUnique({
        where: { id: trimmedId },
      });

      if (!existing) {
        return { success: false, message: `Deadline with ID "${trimmedId}" was not found.` };
      }

      if (existing.status === DeadlineStatus.CANCELLED) {
        return { success: false, message: `Deadline "${existing.title}" is already cancelled.` };
      }

      const updated = await prisma.$transaction(async (tx) => {
        const cancelled = await tx.deadline.update({
          where: { id: trimmedId },
          data: {
            status: DeadlineStatus.CANCELLED,
            updatedAt: new Date(),
          },
        });

        // Mark all pending reminders as expired
        await tx.deadlineReminderDelivery.updateMany({
          where: {
            deadlineId: trimmedId,
            status: DeliveryStatus.PENDING,
          },
          data: {
            status: DeliveryStatus.EXPIRED,
            errorMessage: 'Deadline cancelled by administrator.',
            updatedAt: new Date(),
          },
        });

        return cancelled;
      });

      return {
        success: true,
        message: `Deadline "${updated.title}" has been cancelled. No further reminders will be sent.`,
        deadline: updated,
      };
    } catch (err) {
      console.error(`[DeadlineService Error] Failed to cancel deadline ${id}:`, err);
      return { success: false, message: 'Database error occurred while cancelling deadline.' };
    }
  }

  /**
   * Deletes a deadline only when safe (no successful delivery records exist).
   * Preserves historical delivery records to safeguard audit trail.
   */
  async deleteDeadline(id: string): Promise<DeleteDeadlineResult> {
    const trimmedId = id?.trim();
    if (!trimmedId || !isValidUuid(trimmedId)) {
      return { success: false, message: 'Invalid Deadline ID format. Expected a valid UUID.' };
    }

    try {
      const existing = await prisma.deadline.findUnique({
        where: { id: trimmedId },
        include: {
          announcements: true,
          reminderDeliveries: true,
        },
      });

      if (!existing) {
        return { success: false, message: `Deadline with ID "${trimmedId}" was not found.` };
      }

      const deliveredAnnouncements = existing.announcements.filter((a) => a.status === DeliveryStatus.SUCCESS).length;
      const deliveredReminders = existing.reminderDeliveries.filter((r) => r.status === DeliveryStatus.SUCCESS).length;

      if (deliveredAnnouncements > 0 || deliveredReminders > 0) {
        return {
          success: false,
          message:
            `Cannot delete deadline "${existing.title}": historical records exist ` +
            `(${deliveredAnnouncements} announcement(s), ${deliveredReminders} reminder(s) delivered). ` +
            `To preserve audit history, please use /cancel_deadline ${trimmedId} instead.`,
        };
      }

      await prisma.deadline.delete({
        where: { id: trimmedId },
      });

      return {
        success: true,
        message: `Deadline "${existing.title}" and its unsent staging records were permanently deleted.`,
      };
    } catch (err) {
      console.error(`[DeadlineService Error] Failed to delete deadline ${id}:`, err);
      return { success: false, message: 'Database error occurred while deleting deadline.' };
    }
  }

  /**
   * Transitions active deadlines past their due date to COMPLETED and marks remaining PENDING reminders as EXPIRED.
   */
  async markExpiredDeadlines(now = new Date()): Promise<number> {
    try {
      const expiredDeadlines = await prisma.deadline.findMany({
        where: {
          status: DeadlineStatus.ACTIVE,
          dueAt: { lte: now },
        },
        select: { id: true },
      });

      if (expiredDeadlines.length === 0) return 0;

      const ids = expiredDeadlines.map((d) => d.id);

      await prisma.$transaction(async (tx) => {
        await tx.deadline.updateMany({
          where: { id: { in: ids } },
          data: {
            status: DeadlineStatus.COMPLETED,
            updatedAt: new Date(),
          },
        });

        await tx.deadlineReminderDelivery.updateMany({
          where: {
            deadlineId: { in: ids },
            status: DeliveryStatus.PENDING,
          },
          data: {
            status: DeliveryStatus.EXPIRED,
            errorMessage: 'Deadline has passed.',
            updatedAt: new Date(),
          },
        });
      });

      return ids.length;
    } catch (err) {
      console.error('[DeadlineService Error] Failed to mark expired deadlines:', err);
      return 0;
    }
  }
}

export const deadlineService = new DeadlineService();
