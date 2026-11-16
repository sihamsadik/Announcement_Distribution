import { destinationService } from '../src/services/destination.service';
import { sourceService } from '../src/services/source.service';
import { prisma, disconnectPrisma } from '../src/db/prisma';
import { Telegraf, Context } from 'telegraf';
import { setupBotHandlers } from '../src/bot/bot';
import { SourceGroup } from '@prisma/client';

describe('Destination Group Registration and Management', () => {
  const dummyToken = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ';
  const testChatId1 = BigInt(-100999111222);
  const testChatId2 = BigInt(-100999111333);
  const testDestChatId1 = BigInt(-100555666777);
  const testDestChatId2 = BigInt(-100555666888);

  let sourceA: SourceGroup;
  let sourceB: SourceGroup;

  beforeAll(async () => {
    // Clean up previous test data if any
    await prisma.destinationGroup.deleteMany({
      where: {
        chatId: { in: [testDestChatId1, testDestChatId2] },
      },
    });
    await prisma.sourceGroup.deleteMany({
      where: {
        chatId: { in: [testChatId1, testChatId2] },
      },
    });

    // Create 2 source groups to test multi-source mapping
    const resA = await sourceService.registerSource({
      chatId: testChatId1,
      topicId: BigInt(10),
      name: 'Source Section Alpha',
    });
    sourceA = resA.source!;

    const resB = await sourceService.registerSource({
      chatId: testChatId2,
      topicId: BigInt(20),
      name: 'Source Section Beta',
    });
    sourceB = resB.source!;
  });

  afterAll(async () => {
    // Cleanup created test records
    await prisma.destinationGroup.deleteMany({
      where: {
        chatId: { in: [testDestChatId1, testDestChatId2] },
      },
    });
    await prisma.sourceGroup.deleteMany({
      where: {
        id: { in: [sourceA.id, sourceB.id] },
      },
    });
    await disconnectPrisma();
  });

  describe('1. DestinationService Unit & Database Tests', () => {
    it('1. should register a destination group successfully', async () => {
      const result = await destinationService.registerDestination({
        chatId: testDestChatId1,
        groupName: 'Student Project Team 1',
        sourceGroupId: sourceA.id,
      });

      expect(result.success).toBe(true);
      expect(result.isNew).toBe(true);
      expect(result.destination).toBeDefined();
      expect(result.destination?.groupName).toBe('Student Project Team 1');
      expect(result.destination?.chatId).toBe(testDestChatId1);
      expect(result.destination?.sourceGroupId).toBe(sourceA.id);
      expect(result.destination?.isActive).toBe(true);
    });

    it('2. should reject registration against a non-existent source ID', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000000';
      const result = await destinationService.registerDestination({
        chatId: testDestChatId2,
        groupName: 'Student Team Orphan',
        sourceGroupId: nonExistentId,
      });

      expect(result.success).toBe(false);
      expect(result.isNew).toBe(false);
      expect(result.message).toContain('was not found');
    });

    it('3. should prevent duplicate registration for the same source and chat ID', async () => {
      const result = await destinationService.registerDestination({
        chatId: testDestChatId1,
        groupName: 'Student Project Team 1 Renamed',
        sourceGroupId: sourceA.id,
      });

      expect(result.success).toBe(true);
      expect(result.isNew).toBe(false);
      expect(result.destination?.groupName).toBe('Student Project Team 1');
      expect(result.message).toContain('already registered');

      // Verify DB count remains exactly 1
      const count = await prisma.destinationGroup.count({
        where: {
          sourceGroupId: sourceA.id,
          chatId: testDestChatId1,
        },
      });
      expect(count).toBe(1);
    });

    it('4. should allow registering the same Telegram group under a different source group', async () => {
      // Current unique constraint is @@unique([sourceGroupId, chatId])
      const result = await destinationService.registerDestination({
        chatId: testDestChatId1,
        groupName: 'Student Project Team 1 in Beta',
        sourceGroupId: sourceB.id,
      });

      expect(result.success).toBe(true);
      expect(result.isNew).toBe(true);
      expect(result.destination?.sourceGroupId).toBe(sourceB.id);
    });

    it('5. should list destination groups for a specific source and for all sources', async () => {
      const allDestinations = await destinationService.listDestinations();
      expect(allDestinations.length).toBeGreaterThanOrEqual(2);

      const sourceADestinations = await destinationService.listDestinations(sourceA.id);
      expect(sourceADestinations.every((d) => d.sourceGroupId === sourceA.id)).toBe(true);
      expect(sourceADestinations.some((d) => d.chatId === testDestChatId1)).toBe(true);
    });

    it('6. should deactivate a destination group (isActive: false)', async () => {
      const destination = await prisma.destinationGroup.findFirst({
        where: { sourceGroupId: sourceA.id, chatId: testDestChatId1 },
      });
      expect(destination).not.toBeNull();

      const result = await destinationService.setDestinationStatus(destination!.id, false);
      expect(result.success).toBe(true);
      expect(result.destination?.isActive).toBe(false);

      const updated = await destinationService.getDestinationById(destination!.id);
      expect(updated?.isActive).toBe(false);
    });

    it('7. should reactivate a destination group (isActive: true)', async () => {
      const destination = await prisma.destinationGroup.findFirst({
        where: { sourceGroupId: sourceA.id, chatId: testDestChatId1 },
      });
      expect(destination).not.toBeNull();

      const result = await destinationService.setDestinationStatus(destination!.id, true);
      expect(result.success).toBe(true);
      expect(result.destination?.isActive).toBe(true);

      const updated = await destinationService.getDestinationById(destination!.id);
      expect(updated?.isActive).toBe(true);
    });

    it('10. should ensure deactivated destination remains in the database', async () => {
      const destination = await prisma.destinationGroup.findFirst({
        where: { sourceGroupId: sourceA.id, chatId: testDestChatId1 },
      });
      expect(destination).not.toBeNull();

      await destinationService.setDestinationStatus(destination!.id, false);

      const persisted = await prisma.destinationGroup.findUnique({
        where: { id: destination!.id },
      });
      expect(persisted).not.toBeNull();
      expect(persisted?.isActive).toBe(false);
    });
  });

  describe('2. Telegram Command Handlers', () => {
    let bot: Telegraf;
    let handlers: { [cmd: string]: (ctx: any) => Promise<any> };

    beforeEach(() => {
      handlers = {};
      bot = new Telegraf(dummyToken);

      jest.spyOn(bot, 'command').mockImplementation((cmd: any, handler: any) => {
        handlers[cmd] = handler;
        return bot;
      });

      setupBotHandlers(bot, dummyToken);
    });

    it('8. should reject /register_destination executed in private chat', async () => {
      process.env.ADMIN_USER_IDS = '1001';

      const replyMock = jest.fn().mockResolvedValue({});
      const mockCtx = {
        from: { id: 1001 },
        chat: { id: 1001, type: 'private' },
        message: { text: `/register_destination ${sourceA.id} Team In Private` },
        reply: replyMock,
      };

      await handlers['register_destination'](mockCtx);
      expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Please run `/register_destination` directly inside'));
    });

    it('9. should reject unauthorized users attempting /register_destination', async () => {
      process.env.ADMIN_USER_IDS = '1001'; // User 9999 is unauthorized

      const replyMock = jest.fn().mockResolvedValue({});
      const mockCtx = {
        from: { id: 9999 },
        chat: { id: Number(testDestChatId2), type: 'supergroup' },
        message: { text: `/register_destination ${sourceA.id} Unauthorized Group` },
        reply: replyMock,
        getChatAdministrators: jest.fn().mockResolvedValue([]),
      };

      await handlers['register_destination'](mockCtx);
      expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Access denied'));
    });

    it('should register a destination group successfully via /register_destination command', async () => {
      process.env.ADMIN_USER_IDS = '1001';

      const replyMock = jest.fn().mockResolvedValue({});
      const mockCtx = {
        from: { id: 1001 },
        chat: { id: Number(testDestChatId2), type: 'supergroup' },
        message: { text: `/register_destination ${sourceA.id} Team Command Registered` },
        reply: replyMock,
      };

      await handlers['register_destination'](mockCtx);
      expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Destination Group Registered Successfully!'));

      const record = await prisma.destinationGroup.findFirst({
        where: { chatId: testDestChatId2, sourceGroupId: sourceA.id },
      });
      expect(record).not.toBeNull();
      expect(record?.groupName).toBe('Team Command Registered');
    });

    it('should list destinations via /list_destinations', async () => {
      process.env.ADMIN_USER_IDS = '1001';

      const replyMock = jest.fn().mockResolvedValue({});
      const mockCtx = {
        from: { id: 1001 },
        chat: { id: Number(testDestChatId2), type: 'supergroup' },
        message: { text: `/list_destinations ${sourceA.id}` },
        reply: replyMock,
      };

      await handlers['list_destinations'](mockCtx);
      expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Registered Destination Groups'));
    });

    it('should deactivate destination via /remove_destination', async () => {
      process.env.ADMIN_USER_IDS = '1001';

      const dest = await prisma.destinationGroup.findFirst({
        where: { chatId: testDestChatId2, sourceGroupId: sourceA.id },
      });
      expect(dest).not.toBeNull();

      const replyMock = jest.fn().mockResolvedValue({});
      const mockCtx = {
        from: { id: 1001 },
        chat: { id: Number(testDestChatId2), type: 'supergroup' },
        message: { text: `/remove_destination ${dest!.id}` },
        reply: replyMock,
      };

      await handlers['remove_destination'](mockCtx);
      expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Destination Deactivated Successfully'));

      const check = await destinationService.getDestinationById(dest!.id);
      expect(check?.isActive).toBe(false);
    });

    it('should reactivate destination via /activate_destination', async () => {
      process.env.ADMIN_USER_IDS = '1001';

      const dest = await prisma.destinationGroup.findFirst({
        where: { chatId: testDestChatId2, sourceGroupId: sourceA.id },
      });
      expect(dest).not.toBeNull();

      const replyMock = jest.fn().mockResolvedValue({});
      const mockCtx = {
        from: { id: 1001 },
        chat: { id: Number(testDestChatId2), type: 'supergroup' },
        message: { text: `/activate_destination ${dest!.id}` },
        reply: replyMock,
      };

      await handlers['activate_destination'](mockCtx);
      expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Destination Reactivated Successfully'));

      const check = await destinationService.getDestinationById(dest!.id);
      expect(check?.isActive).toBe(true);
    });
  });
});
