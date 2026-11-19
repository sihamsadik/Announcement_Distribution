import { Telegraf } from 'telegraf';
import { setupBotHandlers } from '../src/bot/bot';
import { prisma, disconnectPrisma } from '../src/db/prisma';
import { sourceService } from '../src/services/source.service';
import { destinationService } from '../src/services/destination.service';
import { SourceGroup, DestinationGroup } from '@prisma/client';

describe('Deadline Bot Commands & Conversational Wizard', () => {
  const dummyToken = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ';
  const adminId = 888777;
  const nonAdminId = 111222;

  const testChatId = BigInt(-100888777);
  const testTopicId = BigInt(333);
  const destChatId = BigInt(-100999111);

  let source: SourceGroup;
  let destination: DestinationGroup;
  let bot: Telegraf;
  let commandHandlers: Record<string, (ctx: any) => Promise<any>>;
  let onHandlers: Record<string, (ctx: any, next: () => Promise<any>) => Promise<any>>;

  beforeAll(async () => {
    process.env.ADMIN_USER_IDS = adminId.toString();

    // Clean up
    await prisma.deadlineReminderDelivery.deleteMany({
      where: { deadline: { sourceGroup: { chatId: testChatId } } },
    });
    await prisma.deadlineAnnouncement.deleteMany({
      where: { deadline: { sourceGroup: { chatId: testChatId } } },
    });
    await prisma.deadline.deleteMany({
      where: { sourceGroup: { chatId: testChatId } },
    });
    await prisma.destinationGroup.deleteMany({
      where: { chatId: destChatId },
    });
    await prisma.sourceGroup.deleteMany({
      where: { chatId: testChatId },
    });

    const srcRes = await sourceService.registerSource({
      chatId: testChatId,
      topicId: testTopicId,
      name: 'Mobile App Course',
    });
    source = srcRes.source!;

    const dstRes = await destinationService.registerDestination({
      chatId: destChatId,
      groupName: 'Mobile Dev Team A',
      sourceGroupId: source.id,
    });
    destination = dstRes.destination!;
  });

  afterAll(async () => {
    await prisma.deadlineReminderDelivery.deleteMany({
      where: { deadline: { sourceGroup: { chatId: testChatId } } },
    });
    await prisma.deadlineAnnouncement.deleteMany({
      where: { deadline: { sourceGroup: { chatId: testChatId } } },
    });
    await prisma.deadline.deleteMany({
      where: { sourceGroup: { chatId: testChatId } },
    });
    await prisma.destinationGroup.deleteMany({
      where: { chatId: destChatId },
    });
    await prisma.sourceGroup.deleteMany({
      where: { chatId: testChatId },
    });
    await disconnectPrisma();
  });

  beforeEach(() => {
    commandHandlers = {};
    onHandlers = {};

    bot = new Telegraf(dummyToken);

    jest.spyOn(bot, 'command').mockImplementation((cmd: any, handler: any) => {
      commandHandlers[cmd] = handler;
      return bot;
    });

    jest.spyOn(bot, 'on').mockImplementation((eventType: any, handler: any) => {
      onHandlers[eventType] = handler;
      return bot;
    });

    setupBotHandlers(bot, dummyToken);
  });

  describe('1. Authorization Protection', () => {
    it('should deny non-admin access to /deadlines', async () => {
      const replyMock = jest.fn();
      const mockCtx = {
        from: { id: nonAdminId },
        chat: { id: -100123, type: 'private' },
        reply: replyMock,
      };

      await commandHandlers['deadlines'](mockCtx);
      expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Access denied'));
    });

    it('should deny non-admin access to /add_deadline', async () => {
      const replyMock = jest.fn();
      const mockCtx = {
        from: { id: nonAdminId },
        chat: { id: -100123, type: 'private' },
        message: { text: '/add_deadline' },
        reply: replyMock,
      };

      await commandHandlers['add_deadline'](mockCtx);
      expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Access denied'));
    });

    it('should deny non-admin access to /cancel_deadline', async () => {
      const replyMock = jest.fn();
      const mockCtx = {
        from: { id: nonAdminId },
        chat: { id: -100123, type: 'private' },
        message: { text: '/cancel_deadline fake-id' },
        reply: replyMock,
      };

      await commandHandlers['cancel_deadline'](mockCtx);
      expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Access denied'));
    });
  });

  describe('2. Single-line /add_deadline Execution', () => {
    it('should create and publish deadline via pipe-delimited arguments', async () => {
      const replyMock = jest.fn();
      const sendMsgMock = jest.fn().mockResolvedValue({ message_id: 1122 });
      const pinMsgMock = jest.fn().mockResolvedValue(true);

      const mockCtx = {
        from: { id: adminId },
        chat: { id: -100123, type: 'group' },
        message: {
          text: `/add_deadline ${source.id} | Midterm Project | 2026-11-25 18:00 | Africa/Addis_Ababa | 2h | Submit APK and architecture docs.`,
        },
        telegram: {
          sendMessage: sendMsgMock,
          pinChatMessage: pinMsgMock,
        },
        reply: replyMock,
      };

      await commandHandlers['add_deadline'](mockCtx);

      expect(replyMock).toHaveBeenCalledWith(
        expect.stringContaining('Deadline Created and Published Successfully!')
      );
      expect(sendMsgMock).toHaveBeenCalled();
      expect(pinMsgMock).toHaveBeenCalled();
    });
  });

  describe('3. Conversational /add_deadline Wizard', () => {
    it('should complete interactive multi-step wizard successfully', async () => {
      const sessionChatId = 777111;
      const sendMsgMock = jest.fn().mockResolvedValue({ message_id: 3344 });
      const pinMsgMock = jest.fn().mockResolvedValue(true);

      const makeMsgCtx = (text: string) => ({
        from: { id: adminId },
        chat: { id: sessionChatId, type: 'private' },
        message: { text },
        telegram: {
          sendMessage: sendMsgMock,
          pinChatMessage: pinMsgMock,
        },
        reply: jest.fn(),
      });

      // Step 0: Start /add_deadline
      const startCtx = makeMsgCtx('/add_deadline');
      await commandHandlers['add_deadline'](startCtx);
      expect(startCtx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Step 1/7'),
        expect.anything()
      );

      // Step 1: Provide source UUID
      const step1Ctx = makeMsgCtx(source.id);
      await onHandlers['text'](step1Ctx, jest.fn());
      expect(step1Ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Step 2/7'),
        expect.anything()
      );

      // Step 2: Provide Title
      const step2Ctx = makeMsgCtx('Final Exam Project');
      await onHandlers['text'](step2Ctx, jest.fn());
      expect(step2Ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Step 3/7'),
        expect.anything()
      );

      // Step 3: Provide Description
      const step3Ctx = makeMsgCtx('Submit complete source code with unit tests.');
      await onHandlers['text'](step3Ctx, jest.fn());
      expect(step3Ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Step 4/7'),
        expect.anything()
      );

      // Step 4: Provide Date
      const step4Ctx = makeMsgCtx('2026-11-26');
      await onHandlers['text'](step4Ctx, jest.fn());
      expect(step4Ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Step 5/7'),
        expect.anything()
      );

      // Step 5: Provide Time
      const step5Ctx = makeMsgCtx('23:59');
      await onHandlers['text'](step5Ctx, jest.fn());
      expect(step5Ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Step 6/7'),
        expect.anything()
      );

      // Step 6: Provide Timezone (default)
      const step6Ctx = makeMsgCtx('default');
      await onHandlers['text'](step6Ctx, jest.fn());
      expect(step6Ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Step 7/7'),
        expect.anything()
      );

      // Step 7: Provide Reminder (2h)
      const step7Ctx = makeMsgCtx('2h');
      await onHandlers['text'](step7Ctx, jest.fn());
      expect(step7Ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Deadline Created & Published Successfully!')
      );

      expect(sendMsgMock).toHaveBeenCalled();
      expect(pinMsgMock).toHaveBeenCalled();
    });

    it('should allow aborting wizard with /cancel', async () => {
      const sessionChatId = 777222;
      const startCtx = {
        from: { id: adminId },
        chat: { id: sessionChatId, type: 'private' },
        message: { text: '/add_deadline' },
        reply: jest.fn(),
      };

      await commandHandlers['add_deadline'](startCtx);
      expect(startCtx.reply).toHaveBeenCalledWith(expect.stringContaining('Step 1/7'), expect.anything());

      const cancelCtx = {
        from: { id: adminId },
        chat: { id: sessionChatId, type: 'private' },
        message: { text: '/cancel' },
        reply: jest.fn(),
      };

      await commandHandlers['cancel'](cancelCtx);
      expect(cancelCtx.reply).toHaveBeenCalledWith(expect.stringContaining('cancelled'));
    });
  });

  describe('4. List & Details Commands', () => {
    it('should list deadlines with /deadlines', async () => {
      const replyMock = jest.fn();
      const mockCtx = {
        from: { id: adminId },
        chat: { id: -100123, type: 'group' },
        reply: replyMock,
      };

      await commandHandlers['deadlines'](mockCtx);
      expect(replyMock).toHaveBeenCalledWith(
        expect.stringContaining('Upcoming Submission Deadlines'),
        expect.anything()
      );
    });
  });
});
