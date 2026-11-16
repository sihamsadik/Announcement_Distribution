import { sourceService } from '../src/services/source.service';
import { detectSourceAnnouncement, getMessageContentType } from '../src/bot/detector';
import { isAuthorizedAdmin } from '../src/bot/auth';
import { prisma, disconnectPrisma } from '../src/db/prisma';
import { Context, Telegraf } from 'telegraf';
import { setupBotHandlers } from '../src/bot/bot';

describe('Source Group and Topic Detection', () => {
  const testChatId = BigInt(-100999888777);
  const testTopicId = BigInt(105);
  const testTopicName = 'SE Section 1 - Final Project Topic';

  beforeAll(async () => {
    // Clean up test records if they exist
    await prisma.sourceGroup.deleteMany({
      where: {
        chatId: testChatId,
      },
    });
  });

  afterAll(async () => {
    // Clean up after tests
    await prisma.sourceGroup.deleteMany({
      where: {
        chatId: testChatId,
      },
    });
    await disconnectPrisma();
  });

  describe('1. SourceService Registration & Lookup', () => {
    it('should register a new source topic successfully', async () => {
      const result = await sourceService.registerSource({
        chatId: testChatId,
        topicId: testTopicId,
        name: testTopicName,
      });

      expect(result.success).toBe(true);
      expect(result.isNew).toBe(true);
      expect(result.source).toBeDefined();
      expect(result.source?.name).toBe(testTopicName);
      expect(result.source?.chatId).toBe(testChatId);
      expect(result.source?.topicId).toBe(testTopicId);
    });

    it('should not duplicate when registering the same source topic twice', async () => {
      const result = await sourceService.registerSource({
        chatId: testChatId,
        topicId: testTopicId,
        name: 'Another Name For Same Topic',
      });

      expect(result.success).toBe(true);
      expect(result.isNew).toBe(false);
      expect(result.source?.name).toBe(testTopicName);

      // Verify database count for this pair is still exactly 1
      const count = await prisma.sourceGroup.count({
        where: {
          chatId: testChatId,
          topicId: testTopicId,
        },
      });
      expect(count).toBe(1);
    });

    it('should reject registration if source name is empty', async () => {
      const result = await sourceService.registerSource({
        chatId: testChatId,
        topicId: BigInt(200),
        name: '   ',
      });

      expect(result.success).toBe(false);
      expect(result.isNew).toBe(false);
      expect(result.message).toContain('cannot be empty');
    });

    it('should find registered source by chatId and topicId', async () => {
      const source = await sourceService.findSource(testChatId, testTopicId);
      expect(source).not.toBeNull();
      expect(source?.name).toBe(testTopicName);
    });

    it('should return null when searching for unregistered topic in registered group', async () => {
      const source = await sourceService.findSource(testChatId, BigInt(999999));
      expect(source).toBeNull();
    });

    it('should list all registered sources', async () => {
      const sources = await sourceService.listSources();
      expect(Array.isArray(sources)).toBe(true);
      const found = sources.find((s) => s.chatId === testChatId && s.topicId === testTopicId);
      expect(found).toBeDefined();
    });
  });

  describe('2. Source Topic Detection', () => {
    it('should detect an announcement message from a registered topic', async () => {
      const mockCtx = {
        chat: {
          id: Number(testChatId),
          type: 'supergroup',
        },
        message: {
          message_id: 1234,
          message_thread_id: Number(testTopicId),
          text: 'Final Project milestone submission is due this Friday!',
        },
      } as unknown as Context;

      const detected = await detectSourceAnnouncement(mockCtx);

      expect(detected).not.toBeNull();
      expect(detected?.sourceGroup.name).toBe(testTopicName);
      expect(detected?.chatId).toBe(testChatId);
      expect(detected?.topicId).toBe(testTopicId);
      expect(detected?.messageId).toBe(1234);
      expect(detected?.contentType).toBe('text');
      expect(detected?.hasMedia).toBe(false);
    });

    it('should detect media messages (e.g. photo with caption) from a registered topic', async () => {
      const mockCtx = {
        chat: {
          id: Number(testChatId),
          type: 'supergroup',
        },
        message: {
          message_id: 1235,
          message_thread_id: Number(testTopicId),
          photo: [{}],
          caption: 'Project Architecture Diagram attached.',
        },
      } as unknown as Context;

      const detected = await detectSourceAnnouncement(mockCtx);

      expect(detected).not.toBeNull();
      expect(detected?.contentType).toBe('photo');
      expect(detected?.hasMedia).toBe(true);
      expect(detected?.contentPreview).toContain('Project Architecture');
    });

    it('should ignore messages from unregistered topics in the same group', async () => {
      const mockCtx = {
        chat: {
          id: Number(testChatId),
          type: 'supergroup',
        },
        message: {
          message_id: 1236,
          message_thread_id: 8888, // Unregistered topic ID
          text: 'Casual chat in general discussion topic',
        },
      } as unknown as Context;

      const detected = await detectSourceAnnouncement(mockCtx);
      expect(detected).toBeNull();
    });

    it('should ignore messages from completely unregistered groups', async () => {
      const mockCtx = {
        chat: {
          id: -100777666555, // Unregistered group
          type: 'supergroup',
        },
        message: {
          message_id: 1237,
          message_thread_id: Number(testTopicId),
          text: 'Announcement in another group',
        },
      } as unknown as Context;

      const detected = await detectSourceAnnouncement(mockCtx);
      expect(detected).toBeNull();
    });

    it('should ignore messages from private chats', async () => {
      const mockCtx = {
        chat: {
          id: 123456789,
          type: 'private',
        },
        message: {
          message_id: 1238,
          message_thread_id: Number(testTopicId),
          text: 'Direct message to bot',
        },
      } as unknown as Context;

      const detected = await detectSourceAnnouncement(mockCtx);
      expect(detected).toBeNull();
    });

    it('should handle messages without a topic ID safely (non-topic group messages)', async () => {
      const mockCtx = {
        chat: {
          id: Number(testChatId),
          type: 'supergroup',
        },
        message: {
          message_id: 1239,
          // message_thread_id is undefined
          text: 'Message in general section without thread',
        },
      } as unknown as Context;

      const detected = await detectSourceAnnouncement(mockCtx);
      expect(detected).toBeNull();
    });
  });

  describe('3. Administrator Authorization', () => {
    it('should authorize users whose ID is in ADMIN_USER_IDS', async () => {
      process.env.ADMIN_USER_IDS = '999001, 999002';

      const mockCtx = {
        from: { id: 999001 },
        chat: { id: 123, type: 'group' },
      } as unknown as Context;

      const authorized = await isAuthorizedAdmin(mockCtx);
      expect(authorized).toBe(true);
    });

    it('should authorize chat administrators in groups', async () => {
      process.env.ADMIN_USER_IDS = ''; // No global admins

      const mockCtx = {
        from: { id: 888001 },
        chat: { id: -100123, type: 'supergroup' },
        getChatAdministrators: jest.fn().mockResolvedValue([
          { user: { id: 888001 } },
          { user: { id: 888002 } },
        ]),
      } as unknown as Context;

      const authorized = await isAuthorizedAdmin(mockCtx);
      expect(authorized).toBe(true);
    });

    it('should deny authorization to regular, non-admin users', async () => {
      process.env.ADMIN_USER_IDS = '999001';

      const mockCtx = {
        from: { id: 777001 }, // Neither in env nor in chat admins
        chat: { id: -100123, type: 'supergroup' },
        getChatAdministrators: jest.fn().mockResolvedValue([
          { user: { id: 888001 } },
        ]),
      } as unknown as Context;

      const authorized = await isAuthorizedAdmin(mockCtx);
      expect(authorized).toBe(false);
    });
  });

  describe('4. Bot Commands: /register_source & /list_sources', () => {
    let bot: Telegraf;
    let handlers: { [cmd: string]: (ctx: any) => Promise<any> };

    beforeEach(() => {
      handlers = {};
      bot = new Telegraf('123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ');

      jest.spyOn(bot, 'command').mockImplementation((cmd: any, handler: any) => {
        handlers[cmd] = handler;
        return bot;
      });

      setupBotHandlers(bot, '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ');
    });

    it('should deny /register_source to non-admin users', async () => {
      process.env.ADMIN_USER_IDS = '999001';

      const replyMock = jest.fn().mockResolvedValue({});
      const mockCtx = {
        from: { id: 555001 }, // Regular user
        chat: { id: Number(testChatId), type: 'supergroup' },
        message: { text: '/register_source Test Topic' },
        getChatAdministrators: jest.fn().mockResolvedValue([]),
        reply: replyMock,
      };

      await handlers['register_source'](mockCtx);
      expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Access denied'));
    });

    it('should register source when called by admin inside forum topic', async () => {
      process.env.ADMIN_USER_IDS = '999001';

      const replyMock = jest.fn().mockResolvedValue({});
      const mockCtx = {
        from: { id: 999001 }, // Admin
        chat: { id: Number(testChatId), type: 'supergroup' },
        message: {
          text: '/register_source In-Topic Project Name',
          message_thread_id: 301,
        },
        reply: replyMock,
      };

      await handlers['register_source'](mockCtx);
      expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Source Registered Successfully!'));

      // Verify in DB
      const record = await sourceService.findSource(testChatId, 301);
      expect(record).not.toBeNull();
      expect(record?.name).toBe('In-Topic Project Name');
    });

    it('should register source when called with explicit topic ID', async () => {
      process.env.ADMIN_USER_IDS = '999001';

      const replyMock = jest.fn().mockResolvedValue({});
      const mockCtx = {
        from: { id: 999001 }, // Admin
        chat: { id: Number(testChatId), type: 'supergroup' },
        message: {
          text: '/register_source 302 Explicit Topic Project Name',
        },
        reply: replyMock,
      };

      await handlers['register_source'](mockCtx);
      expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Source Registered Successfully!'));

      // Verify in DB
      const record = await sourceService.findSource(testChatId, 302);
      expect(record).not.toBeNull();
      expect(record?.name).toBe('Explicit Topic Project Name');
    });

    it('should guide user when topic ID is missing and not provided in arguments', async () => {
      process.env.ADMIN_USER_IDS = '999001';

      const replyMock = jest.fn().mockResolvedValue({});
      const mockCtx = {
        from: { id: 999001 }, // Admin
        chat: { id: Number(testChatId), type: 'supergroup' },
        message: {
          text: '/register_source Only Name Provided Without Topic ID',
          // message_thread_id is undefined
        },
        reply: replyMock,
      };

      await handlers['register_source'](mockCtx);
      expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Telegram Topic ID not found'));
    });

    it('should list registered sources on /list_sources for admins', async () => {
      process.env.ADMIN_USER_IDS = '999001';

      const replyMock = jest.fn().mockResolvedValue({});
      const mockCtx = {
        from: { id: 999001 },
        chat: { id: Number(testChatId), type: 'supergroup' },
        reply: replyMock,
      };

      await handlers['list_sources'](mockCtx);
      expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Registered Source Topics'));
    });
  });
});
