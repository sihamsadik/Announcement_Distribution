import { Telegram } from 'telegraf';
import { prisma, disconnectPrisma } from '../src/db/prisma';
import { sourceService } from '../src/services/source.service';
import { destinationService } from '../src/services/destination.service';
import { deadlineService } from '../src/services/deadline.service';
import { deadlinePublisherService } from '../src/services/deadline-publisher.service';
import { DeadlineSchedulerService } from '../src/services/deadline-scheduler.service';
import {
  DEFAULT_TIMEZONE,
  isValidTimezone,
  isValidDateString,
  isValidTimeString,
  parseDateTimeInTimezone,
  formatDateTimeInTimezone,
  formatTimeRemaining,
  parseAdditionalReminder,
} from '../src/utils/time';
import {
  DeadlineStatus,
  DeliveryStatus,
  ReminderType,
  SourceGroup,
  DestinationGroup,
} from '@prisma/client';

describe('Deadline Calendar, Scheduled Reminders, and Pinned Messages', () => {
  const dummyToken = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ';
  const testAdminId = 99887766;

  // Source A (Topic 1) and Source B (Topic 2)
  const sourceChatIdA = BigInt(-100666001);
  const sourceChatIdB = BigInt(-100666002);
  const topicIdA = BigInt(101);
  const topicIdB = BigInt(202);

  // Destinations for Source A
  const destChatA1 = BigInt(-100777001);
  const destChatA2 = BigInt(-100777002);
  const destChatAInactive = BigInt(-100777003);

  // Destination for Source B
  const destChatB1 = BigInt(-100777004);

  let sourceA: SourceGroup;
  let sourceB: SourceGroup;
  let destA1: DestinationGroup;
  let destA2: DestinationGroup;
  let destAInactive: DestinationGroup;
  let destB1: DestinationGroup;

  beforeAll(async () => {
    // 1. Cleanup existing test data
    await prisma.deadlineReminderDelivery.deleteMany({
      where: {
        deadline: {
          sourceGroup: {
            chatId: { in: [sourceChatIdA, sourceChatIdB] },
          },
        },
      },
    });
    await prisma.deadlineAnnouncement.deleteMany({
      where: {
        deadline: {
          sourceGroup: {
            chatId: { in: [sourceChatIdA, sourceChatIdB] },
          },
        },
      },
    });
    await prisma.deadline.deleteMany({
      where: {
        sourceGroup: {
          chatId: { in: [sourceChatIdA, sourceChatIdB] },
        },
      },
    });
    await prisma.destinationGroup.deleteMany({
      where: {
        chatId: { in: [destChatA1, destChatA2, destChatAInactive, destChatB1] },
      },
    });
    await prisma.sourceGroup.deleteMany({
      where: {
        chatId: { in: [sourceChatIdA, sourceChatIdB] },
      },
    });

    // 2. Register Source A and Source B
    const srcResA = await sourceService.registerSource({
      chatId: sourceChatIdA,
      topicId: topicIdA,
      name: 'Source A - Project Topic',
    });
    sourceA = srcResA.source!;

    const srcResB = await sourceService.registerSource({
      chatId: sourceChatIdB,
      topicId: topicIdB,
      name: 'Source B - Unrelated Topic',
    });
    sourceB = srcResB.source!;

    // 3. Register destinations for Source A
    const d1 = await destinationService.registerDestination({
      chatId: destChatA1,
      groupName: 'Dest A1 Group',
      sourceGroupId: sourceA.id,
    });
    destA1 = d1.destination!;

    const d2 = await destinationService.registerDestination({
      chatId: destChatA2,
      groupName: 'Dest A2 Group',
      sourceGroupId: sourceA.id,
    });
    destA2 = d2.destination!;

    const dInact = await destinationService.registerDestination({
      chatId: destChatAInactive,
      groupName: 'Dest A Inactive Group',
      sourceGroupId: sourceA.id,
    });
    destAInactive = dInact.destination!;
    await destinationService.setDestinationStatus(destAInactive.id, false);

    // 4. Register destination for Source B
    const dB = await destinationService.registerDestination({
      chatId: destChatB1,
      groupName: 'Dest B1 Group',
      sourceGroupId: sourceB.id,
    });
    destB1 = dB.destination!;
  });

  afterAll(async () => {
    // Cleanup records
    await prisma.deadlineReminderDelivery.deleteMany({
      where: {
        deadline: {
          sourceGroup: {
            chatId: { in: [sourceChatIdA, sourceChatIdB] },
          },
        },
      },
    });
    await prisma.deadlineAnnouncement.deleteMany({
      where: {
        deadline: {
          sourceGroup: {
            chatId: { in: [sourceChatIdA, sourceChatIdB] },
          },
        },
      },
    });
    await prisma.deadline.deleteMany({
      where: {
        sourceGroup: {
          chatId: { in: [sourceChatIdA, sourceChatIdB] },
        },
      },
    });
    await prisma.destinationGroup.deleteMany({
      where: {
        chatId: { in: [destChatA1, destChatA2, destChatAInactive, destChatB1] },
      },
    });
    await prisma.sourceGroup.deleteMany({
      where: {
        chatId: { in: [sourceChatIdA, sourceChatIdB] },
      },
    });
    await disconnectPrisma();
  });

  describe('1. Time & Timezone Utilities Validation', () => {
    it('should validate timezones correctly', () => {
      expect(isValidTimezone('Africa/Addis_Ababa')).toBe(true);
      expect(isValidTimezone('UTC')).toBe(true);
      expect(isValidTimezone('America/New_York')).toBe(true);
      expect(isValidTimezone('Invalid/Zone_Name')).toBe(false);
      expect(isValidTimezone('')).toBe(false);
    });

    it('should validate date and time strings accurately', () => {
      expect(isValidDateString('2026-11-20')).toBe(true);
      expect(isValidDateString('2026-02-31')).toBe(false);
      expect(isValidDateString('2026/11/20')).toBe(false);

      expect(isValidTimeString('23:59')).toBe(true);
      expect(isValidTimeString('00:00')).toBe(true);
      expect(isValidTimeString('24:00')).toBe(false);
      expect(isValidTimeString('12:65')).toBe(false);
    });

    it('should parse datetime in Africa/Addis_Ababa to correct UTC timestamp', () => {
      const parsed = parseDateTimeInTimezone('2026-11-20', '23:59', 'Africa/Addis_Ababa');
      expect(parsed.toISOString()).toBe('2026-11-20T20:59:00.000Z');
      const formatted = formatDateTimeInTimezone(parsed, 'Africa/Addis_Ababa');
      expect(formatted).toContain('November 20, 2026');
      expect(formatted).toContain('11:59 PM');
    });

    it('should format time remaining dynamically', () => {
      const target = new Date('2026-11-20T20:59:00.000Z');
      const from1 = new Date('2026-11-19T20:59:00.000Z');
      expect(formatTimeRemaining(target, from1)).toBe('1 day');

      const from2 = new Date('2026-11-20T18:59:00.000Z');
      expect(formatTimeRemaining(target, from2)).toBe('2 hours');

      const fromPast = new Date('2026-11-21T00:00:00.000Z');
      expect(formatTimeRemaining(target, fromPast)).toBe('Deadline has passed');
    });

    it('should parse optional additional reminder relative offsets', () => {
      const dueAt = new Date('2026-11-20T20:59:00.000Z');
      const baseNow = new Date('2026-11-18T10:00:00.000Z');

      const res2h = parseAdditionalReminder('2h', dueAt, DEFAULT_TIMEZONE, baseNow);
      expect(res2h.error).toBeUndefined();
      expect(res2h.date?.toISOString()).toBe('2026-11-20T18:59:00.000Z');

      const resNone = parseAdditionalReminder('none', dueAt, DEFAULT_TIMEZONE, baseNow);
      expect(resNone.date).toBeNull();
      expect(resNone.error).toBeUndefined();

      const resPast = parseAdditionalReminder('5d', dueAt, DEFAULT_TIMEZONE, baseNow);
      expect(resPast.error).toContain('already in the past');
    });
  });

  describe('2. Deadline Creation & Validation', () => {
    const fixedNow = new Date('2026-11-18T12:00:00.000Z');

    it('should successfully create a valid deadline with 24-hour reminder', async () => {
      const result = await deadlineService.createDeadline({
        sourceGroupId: sourceA.id,
        title: 'Project Phase 1 Submission',
        description: 'Upload PDF report and GitHub repository URL to LMS.',
        dateStr: '2026-11-20',
        timeStr: '23:59',
        timezone: 'Africa/Addis_Ababa',
        additionalReminderStr: '2h',
        createdBy: testAdminId,
        now: fixedNow,
      });

      expect(result.success).toBe(true);
      expect(result.deadline).toBeDefined();

      const d = result.deadline!;
      expect(d.title).toBe('Project Phase 1 Submission');
      expect(d.status).toBe(DeadlineStatus.ACTIVE);
      expect(d.timezone).toBe('Africa/Addis_Ababa');
      expect(d.dueAt.toISOString()).toBe('2026-11-20T20:59:00.000Z');
      expect(d.additionalReminderAt?.toISOString()).toBe('2026-11-20T18:59:00.000Z');

      // Verify only active destinations (destA1, destA2) are staged, excluding destAInactive and destB1
      expect(d.announcements.length).toBe(2);
      const destIds = d.announcements.map((a) => a.destinationGroupId);
      expect(destIds).toContain(destA1.id);
      expect(destIds).toContain(destA2.id);
      expect(destIds).not.toContain(destAInactive.id);
      expect(destIds).not.toContain(destB1.id);

      // Verify staged reminders: 2 active destinations * 2 reminder types (24_HOUR, ADDITIONAL) = 4 records
      expect(d.reminderDeliveries.length).toBe(4);

      const reminder24hDeliveries = d.reminderDeliveries.filter(
        (r) => r.reminderType === ReminderType.REMINDER_24_HOUR
      );
      expect(reminder24hDeliveries.length).toBe(2);
      expect(reminder24hDeliveries[0].scheduledFor.toISOString()).toBe('2026-11-19T20:59:00.000Z');

      const additionalDeliveries = d.reminderDeliveries.filter(
        (r) => r.reminderType === ReminderType.ADDITIONAL
      );
      expect(additionalDeliveries.length).toBe(2);
      expect(additionalDeliveries[0].scheduledFor.toISOString()).toBe('2026-11-20T18:59:00.000Z');
    });

    it('should reject deadline with date in the past', async () => {
      const result = await deadlineService.createDeadline({
        sourceGroupId: sourceA.id,
        title: 'Past Assignment',
        description: 'Should fail validation',
        dateStr: '2026-11-17',
        timeStr: '10:00',
        timezone: 'Africa/Addis_Ababa',
        createdBy: testAdminId,
        now: fixedNow,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('must be in the future');
    });

    it('should reject invalid timezone', async () => {
      const result = await deadlineService.createDeadline({
        sourceGroupId: sourceA.id,
        title: 'Invalid Timezone Assignment',
        description: 'Test timezone validation',
        dateStr: '2026-11-22',
        timeStr: '12:00',
        timezone: 'Fake/Timezone',
        createdBy: testAdminId,
        now: fixedNow,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid IANA timezone');
    });

    it('should reject invalid date format', async () => {
      const result = await deadlineService.createDeadline({
        sourceGroupId: sourceA.id,
        title: 'Malformed Date',
        description: 'Test malformed date',
        dateStr: '20-11-2026',
        timeStr: '12:00',
        createdBy: testAdminId,
        now: fixedNow,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid date format');
    });
  });

  describe('3. Publishing & Message Pinning', () => {
    let deadlineId: string;

    beforeEach(async () => {
      // Clean up previous test deadlines
      await prisma.deadlineReminderDelivery.deleteMany({
        where: { deadline: { sourceGroupId: sourceA.id } },
      });
      await prisma.deadlineAnnouncement.deleteMany({
        where: { deadline: { sourceGroupId: sourceA.id } },
      });
      await prisma.deadline.deleteMany({
        where: { sourceGroupId: sourceA.id },
      });

      const fixedNow = new Date('2026-11-18T12:00:00.000Z');
      const createRes = await deadlineService.createDeadline({
        sourceGroupId: sourceA.id,
        title: 'Lab Report 2',
        description: 'Submit Lab 2 documentation.',
        dateStr: '2026-11-21',
        timeStr: '18:00',
        timezone: 'Africa/Addis_Ababa',
        createdBy: testAdminId,
        now: fixedNow,
      });
      deadlineId = createRes.deadline!.id;
    });

    it('should send announcement and pin message in destination groups', async () => {
      const mockSendMessage = jest.fn().mockResolvedValue({ message_id: 8881 });
      const mockPinChatMessage = jest.fn().mockResolvedValue(true);
      const mockTelegram = {
        sendMessage: mockSendMessage,
        pinChatMessage: mockPinChatMessage,
      } as unknown as Telegram;

      const pubResult = await deadlinePublisherService.publishAndPinDeadline(
        mockTelegram,
        deadlineId,
        dummyToken
      );

      expect(pubResult.sent).toBe(2);
      expect(pubResult.pinned).toBe(2);
      expect(pubResult.pinFailed).toBe(0);
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      expect(mockPinChatMessage).toHaveBeenCalledTimes(2);

      // Verify database reflects SUCCESS and isPinned: true
      const announcements = await prisma.deadlineAnnouncement.findMany({
        where: { deadlineId },
      });
      expect(announcements.every((a) => a.status === DeliveryStatus.SUCCESS)).toBe(true);
      expect(announcements.every((a) => a.isPinned === true)).toBe(true);
      expect(announcements.every((a) => a.telegramMessageId === 8881)).toBe(true);
    });

    it('should record send as successful and pin failure separately when bot lacks pin permissions', async () => {
      const mockSendMessage = jest.fn().mockResolvedValue({ message_id: 8882 });
      const mockPinChatMessage = jest.fn().mockRejectedValue(
        new Error('Bad Request: not enough rights to pin a message')
      );
      const mockTelegram = {
        sendMessage: mockSendMessage,
        pinChatMessage: mockPinChatMessage,
      } as unknown as Telegram;

      const pubResult = await deadlinePublisherService.publishAndPinDeadline(
        mockTelegram,
        deadlineId,
        dummyToken
      );

      expect(pubResult.sent).toBe(2);
      expect(pubResult.pinned).toBe(0);
      expect(pubResult.pinFailed).toBe(2);

      const announcements = await prisma.deadlineAnnouncement.findMany({
        where: { deadlineId },
      });
      expect(announcements.every((a) => a.status === DeliveryStatus.SUCCESS)).toBe(true);
      expect(announcements.every((a) => a.isPinned === false)).toBe(true);
      expect(announcements.every((a) => a.pinErrorMessage?.includes('permission'))).toBe(true);

      // Idempotency: second run does not resend
      const secondRun = await deadlinePublisherService.publishAndPinDeadline(
        mockTelegram,
        deadlineId,
        dummyToken
      );
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      expect(secondRun.sent).toBe(2);
    });
  });

  describe('4. Scheduled Reminder Processing & Controllable Clock Execution', () => {
    let scheduler: DeadlineSchedulerService;
    let deadlineId: string;

    beforeEach(async () => {
      // Clean up previous test deadlines
      await prisma.deadlineReminderDelivery.deleteMany({
        where: { deadline: { sourceGroupId: { in: [sourceA.id, sourceB.id] } } },
      });
      await prisma.deadlineAnnouncement.deleteMany({
        where: { deadline: { sourceGroupId: { in: [sourceA.id, sourceB.id] } } },
      });
      await prisma.deadline.deleteMany({
        where: { sourceGroupId: { in: [sourceA.id, sourceB.id] } },
      });

      scheduler = new DeadlineSchedulerService(2 * 60 * 60 * 1000); // 2 hours grace period

      // Create deadline: Due on 2026-11-20 at 23:59 (Addis Ababa) => 2026-11-20T20:59:00.000Z UTC
      // 24h reminder due at 2026-11-19T20:59:00.000Z UTC
      // 2h reminder due at 2026-11-20T18:59:00.000Z UTC
      const baseNow = new Date('2026-11-18T10:00:00.000Z');
      const createRes = await deadlineService.createDeadline({
        sourceGroupId: sourceA.id,
        title: 'Term Paper Final Submission',
        description: 'Upload PDF and bibliography.',
        dateStr: '2026-11-20',
        timeStr: '23:59',
        timezone: 'Africa/Addis_Ababa',
        additionalReminderStr: '2h',
        createdBy: testAdminId,
        now: baseNow,
      });

      deadlineId = createRes.deadline!.id;
    });

    afterEach(() => {
      scheduler.stopPolling();
      scheduler.resetClock();
    });

    it('should NOT send reminders before the scheduled time', async () => {
      const mockSendMessage = jest.fn();
      const mockTelegram = { sendMessage: mockSendMessage } as unknown as Telegram;

      // Clock at 2026-11-19T10:00:00.000Z (10h before 24-hour reminder)
      scheduler.setClock(() => new Date('2026-11-19T10:00:00.000Z'));

      const result = await scheduler.processDueReminders(mockTelegram, dummyToken);
      expect(result.processed).toBe(0);
      expect(result.delivered).toBe(0);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('should send the 24-hour reminder at the exact scheduled time to all active destinations', async () => {
      const mockSendMessage = jest.fn().mockResolvedValue({ message_id: 9901 });
      const mockTelegram = { sendMessage: mockSendMessage } as unknown as Telegram;

      // Advance clock to exact 24h reminder time: 2026-11-19T20:59:00.000Z
      scheduler.setClock(() => new Date('2026-11-19T20:59:00.000Z'));

      const result = await scheduler.processDueReminders(mockTelegram, dummyToken);

      expect(result.processed).toBe(2);
      expect(result.delivered).toBe(2);
      expect(result.failed).toBe(0);
      expect(mockSendMessage).toHaveBeenCalledTimes(2);

      const callArgs = mockSendMessage.mock.calls[0];
      expect(callArgs[1]).toContain('24-HOUR DEADLINE REMINDER');
      expect(callArgs[1]).toContain('Term Paper Final Submission');
      expect(callArgs[1]).toContain('1 day');

      const dbDeliveries = await prisma.deadlineReminderDelivery.findMany({
        where: {
          deadlineId,
          reminderType: ReminderType.REMINDER_24_HOUR,
        },
      });
      expect(dbDeliveries.every((r) => r.status === DeliveryStatus.SUCCESS)).toBe(true);
    });

    it('should prevent duplicate reminder deliveries on subsequent scheduler runs', async () => {
      const mockSendMessage = jest.fn().mockResolvedValue({ message_id: 9902 });
      const mockTelegram = { sendMessage: mockSendMessage } as unknown as Telegram;

      scheduler.setClock(() => new Date('2026-11-19T20:59:00.000Z'));
      await scheduler.processDueReminders(mockTelegram, dummyToken);
      expect(mockSendMessage).toHaveBeenCalledTimes(2);

      scheduler.setClock(() => new Date('2026-11-19T21:05:00.000Z'));
      const secondRun = await scheduler.processDueReminders(mockTelegram, dummyToken);
      expect(secondRun.delivered).toBe(0);
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });

    it('should send the optional additional reminder at its configured time', async () => {
      const mockSendMessage = jest.fn().mockResolvedValue({ message_id: 9903 });
      const mockTelegram = { sendMessage: mockSendMessage } as unknown as Telegram;

      // 1. Advance to 24-hour reminder and process it
      scheduler.setClock(() => new Date('2026-11-19T20:59:00.000Z'));
      await scheduler.processDueReminders(mockTelegram, dummyToken);

      // 2. Advance clock to additional reminder: 2 hours before deadline (2026-11-20T18:59:00.000Z)
      scheduler.setClock(() => new Date('2026-11-20T18:59:00.000Z'));
      const addResult = await scheduler.processDueReminders(mockTelegram, dummyToken);

      expect(addResult.delivered).toBe(2);
      expect(mockSendMessage).toHaveBeenCalledTimes(4); // 2 from 24h + 2 from additional

      const addCalls = mockSendMessage.mock.calls[2];
      expect(addCalls[1]).toContain('DEADLINE REMINDER');
      expect(addCalls[1]).toContain('2 hours');

      const addDbDeliveries = await prisma.deadlineReminderDelivery.findMany({
        where: {
          deadlineId,
          reminderType: ReminderType.ADDITIONAL,
        },
      });
      expect(addDbDeliveries.every((r) => r.status === DeliveryStatus.SUCCESS)).toBe(true);
    });

    it('should NEVER send reminders after the deadline has passed', async () => {
      const mockSendMessage = jest.fn();
      const mockTelegram = { sendMessage: mockSendMessage } as unknown as Telegram;

      // Jump clock directly to 1 minute AFTER deadline: 2026-11-20T21:00:00.000Z
      scheduler.setClock(() => new Date('2026-11-20T21:00:00.000Z'));

      const result = await scheduler.processDueReminders(mockTelegram, dummyToken);

      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(result.delivered).toBe(0);

      const updatedDeadline = await prisma.deadline.findUnique({
        where: { id: deadlineId },
      });
      expect(updatedDeadline?.status).toBe(DeadlineStatus.COMPLETED);

      const expiredDeliveries = await prisma.deadlineReminderDelivery.findMany({
        where: { deadlineId },
      });
      expect(expiredDeliveries.every((r) => r.status === DeliveryStatus.EXPIRED)).toBe(true);
    });

    it('should recover pending reminders after application restart within grace period', async () => {
      const mockSendMessage = jest.fn().mockResolvedValue({ message_id: 9904 });
      const mockTelegram = { sendMessage: mockSendMessage } as unknown as Telegram;

      // Scheduled 24h reminder was due at 2026-11-19T20:59:00.000Z
      // Bot was offline and restarts 30 minutes later at 2026-11-19T21:29:00.000Z (within 2h grace period)
      const newSchedulerInstance = new DeadlineSchedulerService(2 * 60 * 60 * 1000);
      newSchedulerInstance.setClock(() => new Date('2026-11-19T21:29:00.000Z'));

      const recResult = await newSchedulerInstance.processDueReminders(mockTelegram, dummyToken);

      expect(recResult.delivered).toBe(2);
      expect(mockSendMessage).toHaveBeenCalledTimes(2);

      newSchedulerInstance.stopPolling();
    });

    it('should handle partial delivery failures gracefully without blocking other destinations', async () => {
      const mockSendMessage = jest.fn().mockImplementation((chatId: string) => {
        if (chatId === destChatA1.toString()) {
          return Promise.reject(new Error('Forbidden: bot was kicked from the supergroup chat'));
        }
        return Promise.resolve({ message_id: 9905 });
      });
      const mockTelegram = { sendMessage: mockSendMessage } as unknown as Telegram;

      scheduler.setClock(() => new Date('2026-11-19T20:59:00.000Z'));
      const result = await scheduler.processDueReminders(mockTelegram, dummyToken);

      expect(result.processed).toBe(2);
      expect(result.delivered).toBe(1);
      expect(result.failed).toBe(1);

      const d1Record = await prisma.deadlineReminderDelivery.findFirst({
        where: { deadlineId, destinationGroupId: destA1.id, reminderType: ReminderType.REMINDER_24_HOUR },
      });
      expect(d1Record?.status).toBe(DeliveryStatus.FAILED);
      expect(d1Record?.errorMessage).toContain('Bot is not a member');

      const d2Record = await prisma.deadlineReminderDelivery.findFirst({
        where: { deadlineId, destinationGroupId: destA2.id, reminderType: ReminderType.REMINDER_24_HOUR },
      });
      expect(d2Record?.status).toBe(DeliveryStatus.SUCCESS);
    });

    it('should isolate deadlines between different source topics', async () => {
      const baseNow = new Date('2026-11-18T10:00:00.000Z');
      const createResB = await deadlineService.createDeadline({
        sourceGroupId: sourceB.id,
        title: 'Source B Assignment',
        description: 'Should only affect Source B destinations.',
        dateStr: '2026-11-20',
        timeStr: '23:59',
        timezone: 'Africa/Addis_Ababa',
        createdBy: testAdminId,
        now: baseNow,
      });

      const deadlineB = createResB.deadline!;
      expect(deadlineB.announcements.length).toBe(1);
      expect(deadlineB.announcements[0].destinationGroupId).toBe(destB1.id);

      const deadlineA = await deadlineService.getDeadlineDetails(deadlineId);
      const aDestIds = deadlineA!.announcements.map((a) => a.destinationGroupId);
      expect(aDestIds).not.toContain(destB1.id);
    });

    it('should safely cancel deadline and expire remaining reminders', async () => {
      const cancelRes = await deadlineService.cancelDeadline(deadlineId);
      expect(cancelRes.success).toBe(true);

      const d = await prisma.deadline.findUnique({ where: { id: deadlineId } });
      expect(d?.status).toBe(DeadlineStatus.CANCELLED);

      const reminders = await prisma.deadlineReminderDelivery.findMany({
        where: { deadlineId, status: DeliveryStatus.PENDING },
      });
      expect(reminders.length).toBe(0);
    });

    it('should protect historical delivery audit records from deletion', async () => {
      // Mark an announcement as SUCCESS to simulate delivered announcement
      await prisma.deadlineAnnouncement.updateMany({
        where: { deadlineId },
        data: { status: DeliveryStatus.SUCCESS },
      });

      const protectedDelete = await deadlineService.deleteDeadline(deadlineId);
      expect(protectedDelete.success).toBe(false);
      expect(protectedDelete.message).toContain('historical records exist');
      expect(protectedDelete.message).toContain('/cancel_deadline');
    });
  });
});
