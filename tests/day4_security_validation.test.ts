import {
  isValidUuid,
  isValidTelegramChatId,
  isValidTelegramTopicId,
  validateResourceName,
  validateLimit,
  isValidTimeframe,
  isValidTelegramBotToken,
  isValidDatabaseUrl,
  validateStartupConfig,
} from '../src/utils/validators';
import { distributionService } from '../src/services/distribution.service';
import { isAuthorizedAdmin, denyUnauthorizedAccess } from '../src/bot/auth';
import { logger } from '../src/utils/logger';
import { sourceService } from '../src/services/source.service';
import { destinationService } from '../src/services/destination.service';
import { Context } from 'telegraf';

describe('Day 4: Security Hardening, Input Validation, and Authorization Review', () => {
  const originalAdminIds = process.env.ADMIN_USER_IDS;

  beforeAll(() => {
    process.env.ADMIN_USER_IDS = '1001,1002';
  });

  afterAll(() => {
    process.env.ADMIN_USER_IDS = originalAdminIds;
  });

  // ==========================================
  // 1. Validator Functions
  // ==========================================
  describe('Task 2: Input Validator Functions', () => {
    it('should validate UUID v4 correctly', () => {
      expect(isValidUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
      expect(isValidUuid('a3bb189e-8bf9-3888-9912-ace4e6543002')).toBe(true);
      expect(isValidUuid('invalid-uuid-string')).toBe(false);
      expect(isValidUuid('12345')).toBe(false);
      expect(isValidUuid('')).toBe(false);
      expect(isValidUuid(null as any)).toBe(false);
      expect(isValidUuid(undefined as any)).toBe(false);
      expect(isValidUuid('550e8400-e29b-41d4-a716-44665544000g')).toBe(false); // invalid hex
    });

    it('should validate Telegram chat IDs correctly', () => {
      expect(isValidTelegramChatId('-1001234567890')).toBe(true);
      expect(isValidTelegramChatId(-1001234567890)).toBe(true);
      expect(isValidTelegramChatId('123456789')).toBe(true);
      expect(isValidTelegramChatId(123456789)).toBe(true);
      expect(isValidTelegramChatId(0)).toBe(false);
      expect(isValidTelegramChatId('0')).toBe(false);
      expect(isValidTelegramChatId('not-a-number')).toBe(false);
      expect(isValidTelegramChatId('')).toBe(false);
      expect(isValidTelegramChatId('123.456')).toBe(false);
      expect(isValidTelegramChatId(null as any)).toBe(false);
    });

    it('should validate Telegram topic IDs correctly', () => {
      expect(isValidTelegramTopicId(1)).toBe(true);
      expect(isValidTelegramTopicId(1054)).toBe(true);
      expect(isValidTelegramTopicId('42')).toBe(true);
      expect(isValidTelegramTopicId(0)).toBe(false);
      expect(isValidTelegramTopicId(-1)).toBe(false);
      expect(isValidTelegramTopicId('abc')).toBe(false);
      expect(isValidTelegramTopicId(12.34)).toBe(false);
      expect(isValidTelegramTopicId(null as any)).toBe(false);
    });

    it('should validate resource names correctly', () => {
      expect(validateResourceName('Valid Name')).toEqual({ valid: true, value: 'Valid Name' });
      expect(validateResourceName('   Padded Name   ')).toEqual({ valid: true, value: 'Padded Name' });
      expect(validateResourceName('').valid).toBe(false);
      expect(validateResourceName('   ').valid).toBe(false);
      
      const longName = 'a'.repeat(101);
      const longResult = validateResourceName(longName);
      expect(longResult.valid).toBe(false);
      expect(longResult.error).toContain('maximum 100 characters');

      // Control characters rejected
      expect(validateResourceName('Name with \n newline').valid).toBe(false);
      expect(validateResourceName('Name with \0 null byte').valid).toBe(false);
      expect(validateResourceName('Name with \r carriage return').valid).toBe(false);
    });

    it('should validate and clamp limits correctly', () => {
      expect(validateLimit(10, 1, 100, 20)).toBe(10);
      expect(validateLimit('15', 1, 100, 20)).toBe(15);
      expect(validateLimit(150, 1, 100, 20)).toBe(100); // clamped to max
      expect(validateLimit(0, 1, 100, 20)).toBe(1);     // clamped to min
      expect(validateLimit(-5, 1, 100, 20)).toBe(1);    // clamped to min
      expect(validateLimit('invalid', 1, 100, 20)).toBe(20);
      expect(validateLimit(undefined, 1, 100, 20)).toBe(20);
    });

    it('should validate timeframes correctly', () => {
      expect(isValidTimeframe('24h')).toBe(true);
      expect(isValidTimeframe('7d')).toBe(true);
      expect(isValidTimeframe('30d')).toBe(true);
      expect(isValidTimeframe('all')).toBe(true);
      expect(isValidTimeframe('10m')).toBe(false);
      expect(isValidTimeframe('random')).toBe(false);
      expect(isValidTimeframe('')).toBe(false);
    });
  });

  // ==========================================
  // 2. Startup Configuration Validation
  // ==========================================
  describe('Task 1: Startup Configuration Validation', () => {
    it('should validate bot token format', () => {
      expect(isValidTelegramBotToken('123456789:ABCdef-GHIjklMNOpqrSTUvwxYZ1234567')).toBe(true);
      expect(isValidTelegramBotToken('invalid_token')).toBe(false);
      expect(isValidTelegramBotToken('')).toBe(false);
      expect(isValidTelegramBotToken('abc:def')).toBe(false);
    });

    it('should validate database URL format', () => {
      expect(isValidDatabaseUrl('postgresql://user:pass@localhost:5432/db')).toBe(true);
      expect(isValidDatabaseUrl('postgres://user:pass@localhost:5432/db')).toBe(true);
      expect(isValidDatabaseUrl('mysql://user:pass@localhost:3306/db')).toBe(false);
      expect(isValidDatabaseUrl('not_a_url')).toBe(false);
      expect(isValidDatabaseUrl('')).toBe(false);
    });

    it('should validate valid startup config', () => {
      const validConfig = {
        telegramBotToken: '123456789:ABCdef-GHIjklMNOpqrSTUvwxYZ1234567',
        databaseUrl: 'postgresql://postgres:postgres@localhost:5432/db',
        adminUserIds: [123456, 789012],
        healthPort: 3000,
      };
      const result = validateStartupConfig(validConfig);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject invalid startup configs', () => {
      expect(validateStartupConfig({
        telegramBotToken: 'bad_token',
        databaseUrl: 'postgresql://localhost:5432/db',
        adminUserIds: [],
        healthPort: 3000,
      }).valid).toBe(false);

      expect(validateStartupConfig({
        telegramBotToken: '123456789:ABCdef-GHIjklMNOpqrSTUvwxYZ1234567',
        databaseUrl: 'bad_db_url',
        adminUserIds: [],
        healthPort: 3000,
      }).valid).toBe(false);

      expect(validateStartupConfig({
        telegramBotToken: '123456789:ABCdef-GHIjklMNOpqrSTUvwxYZ1234567',
        databaseUrl: 'postgresql://localhost:5432/db',
        adminUserIds: [],
        healthPort: 70000, // Invalid port
      }).valid).toBe(false);
    });
  });

  // ==========================================
  // 3. Telegram Update Eligibility Filtering
  // ==========================================
  describe('Task 2: Telegram Update Eligibility Filtering', () => {
    it('should accept regular announcement messages', () => {
      const ctx: any = {
        message: {
          message_id: 101,
          chat: { id: -1001234567890 },
          text: 'Important company announcement',
          from: { id: 111, is_bot: false },
        },
      };
      expect(distributionService.isEligibleMessage(ctx).eligible).toBe(true);
    });

    it('should accept media announcements (photos, documents, videos)', () => {
      const ctx: any = {
        message: {
          message_id: 102,
          chat: { id: -1001234567890 },
          photo: [{ file_id: 'abc' }],
          caption: 'Announcement with photo',
          from: { id: 111, is_bot: false },
        },
      };
      expect(distributionService.isEligibleMessage(ctx).eligible).toBe(true);
    });

    it('should reject messages sent by bots to avoid loops', () => {
      const ctx: any = {
        message: {
          message_id: 103,
          chat: { id: -1001234567890 },
          text: 'Automated post',
          from: { id: 222, is_bot: true, username: 'some_bot' },
        },
      };
      const res = distributionService.isEligibleMessage(ctx);
      expect(res.eligible).toBe(false);
      expect(res.reason).toContain('Sender is a bot');
    });

    it('should reject messages starting with a bot command', () => {
      const ctx: any = {
        message: {
          message_id: 104,
          chat: { id: -1001234567890 },
          text: '/source_details 550e8400-e29b-41d4-a716-446655440000',
          from: { id: 111, is_bot: false },
        },
      };
      const res = distributionService.isEligibleMessage(ctx);
      expect(res.eligible).toBe(false);
      expect(res.reason).toContain('bot command');
    });

    it('should reject service notification messages in topic threads', () => {
      const pinnedCtx: any = {
        message: {
          message_id: 105,
          chat: { id: -1001234567890 },
          pinned_message: { message_id: 100 },
          from: { id: 111, is_bot: false },
        },
      };
      expect(distributionService.isEligibleMessage(pinnedCtx).eligible).toBe(false);

      const topicCreatedCtx: any = {
        message: {
          message_id: 106,
          chat: { id: -1001234567890 },
          forum_topic_created: { name: 'Announcements', icon_color: 7322096 },
          from: { id: 111, is_bot: false },
        },
      };
      expect(distributionService.isEligibleMessage(topicCreatedCtx).eligible).toBe(false);

      const topicEditedCtx: any = {
        message: {
          message_id: 107,
          chat: { id: -1001234567890 },
          forum_topic_edited: { name: 'New Announcements Name' },
          from: { id: 111, is_bot: false },
        },
      };
      expect(distributionService.isEligibleMessage(topicEditedCtx).eligible).toBe(false);

      const topicClosedCtx: any = {
        message: {
          message_id: 108,
          chat: { id: -1001234567890 },
          forum_topic_closed: {},
          from: { id: 111, is_bot: false },
        },
      };
      expect(distributionService.isEligibleMessage(topicClosedCtx).eligible).toBe(false);

      const newMembersCtx: any = {
        message: {
          message_id: 109,
          chat: { id: -1001234567890 },
          new_chat_members: [{ id: 999, first_name: 'John' }],
          from: { id: 111, is_bot: false },
        },
      };
      expect(distributionService.isEligibleMessage(newMembersCtx).eligible).toBe(false);
    });

    it('should reject messages with protected content flag', () => {
      const protectedCtx: any = {
        message: {
          message_id: 110,
          chat: { id: -1001234567890 },
          text: 'Secret announcement',
          has_protected_content: true,
          from: { id: 111, is_bot: false },
        },
      };
      const res = distributionService.isEligibleMessage(protectedCtx);
      expect(res.eligible).toBe(false);
      expect(res.reason).toContain('protected');
    });
  });

  // ==========================================
  // 4. Service Boundary Input Validation
  // ==========================================
  describe('Task 2: Service Boundary Validation', () => {
    it('sourceService should reject invalid inputs safely', async () => {
      // Invalid name
      const res1 = await sourceService.registerSource({
        name: '',
        chatId: '-1001234567890',
        topicId: 1,
      });
      expect(res1.success).toBe(false);
      expect(res1.message).toContain('cannot be empty');

      // Invalid chat ID
      const res2 = await sourceService.registerSource({
        name: 'Valid Name',
        chatId: 'not-a-chat-id',
        topicId: 1,
      });
      expect(res2.success).toBe(false);
      expect(res2.message).toContain('Invalid chat ID');

      // Invalid topic ID
      const res3 = await sourceService.registerSource({
        name: 'Valid Name',
        chatId: '-1001234567890',
        topicId: -5,
      });
      expect(res3.success).toBe(false);
      expect(res3.message).toContain('Invalid chat ID or topic ID');

      // Invalid UUID for lookup
      const res4 = await sourceService.getSourceById('invalid-uuid');
      expect(res4).toBeNull();

      // Invalid UUID for delete
      const res5 = await sourceService.deleteSource('invalid-uuid');
      expect(res5.success).toBe(false);
      expect(res5.message).toContain('Expected a valid UUID');
    });

    it('destinationService should reject invalid inputs safely', async () => {
      // Invalid source UUID
      const res1 = await destinationService.registerDestination({
        sourceGroupId: 'invalid-uuid',
        groupName: 'Dest Name',
        chatId: '-1001234567890',
      });
      expect(res1.success).toBe(false);
      expect(res1.message).toContain('Expected a valid UUID');

      // Invalid destination name
      const res2 = await destinationService.registerDestination({
        sourceGroupId: '550e8400-e29b-41d4-a716-446655440000',
        groupName: '',
        chatId: '-1001234567890',
      });
      expect(res2.success).toBe(false);
      expect(res2.message).toContain('cannot be empty');

      // Invalid chat ID
      const res3 = await destinationService.registerDestination({
        sourceGroupId: '550e8400-e29b-41d4-a716-446655440000',
        groupName: 'Dest Name',
        chatId: 'invalid-chat-id',
      });
      expect(res3.success).toBe(false);
      expect(res3.message).toContain('Invalid destination chat ID');

      // Invalid UUID for lookup
      const res4 = await destinationService.getDestinationById('invalid-uuid');
      expect(res4).toBeNull();

      // Invalid UUID for delete
      const res5 = await destinationService.deleteDestination('invalid-uuid');
      expect(res5.success).toBe(false);
      expect(res5.message).toContain('Expected a valid UUID');
    });
  });

  // ==========================================
  // 5. Authorization Review & Fail-Closed Security
  // ==========================================
  describe('Task 3: Authorization Review & Fail-Closed Security', () => {
    it('should fail-closed if userId is missing or invalid', async () => {
      const mockCtx: any = {
        chat: { id: -1001234567890, type: 'supergroup' },
        from: undefined,
      };
      expect(await isAuthorizedAdmin(mockCtx)).toBe(false);

      const mockCtxNegative: any = {
        chat: { id: -1001234567890, type: 'supergroup' },
        from: { id: -5 },
      };
      expect(await isAuthorizedAdmin(mockCtxNegative)).toBe(false);
    });

    it('in private chats, should strictly authorize only users in ADMIN_USER_IDS', async () => {
      const authorizedCtx: any = {
        chat: { id: 1001, type: 'private' },
        from: { id: 1001 },
      };
      // 1001 is set in test mock env
      expect(await isAuthorizedAdmin(authorizedCtx)).toBe(true);

      const unauthorizedCtx: any = {
        chat: { id: 9999, type: 'private' },
        from: { id: 9999 },
      };
      expect(await isAuthorizedAdmin(unauthorizedCtx)).toBe(false);
    });

    it('in group chats, should authorize chat administrators and creators', async () => {
      const groupAdminCtx: any = {
        chat: { id: -1001234567890, type: 'supergroup' },
        from: { id: 5555 },
        telegram: {
          getChatAdministrators: jest.fn().mockResolvedValue([
            { user: { id: 5555 }, status: 'administrator' },
            { user: { id: 6666 }, status: 'creator' },
          ]),
        },
      };
      expect(await isAuthorizedAdmin(groupAdminCtx)).toBe(true);
    });

    it('in group chats, should strictly reject ordinary members', async () => {
      const ordinaryMemberCtx: any = {
        chat: { id: -1001234567890, type: 'supergroup' },
        from: { id: 7777 },
        telegram: {
          getChatAdministrators: jest.fn().mockResolvedValue([
            { user: { id: 5555 }, status: 'administrator' },
            { user: { id: 6666 }, status: 'creator' },
          ]),
        },
      };
      expect(await isAuthorizedAdmin(ordinaryMemberCtx)).toBe(false);
    });

    it('should fail-closed if Telegram API getChatAdministrators throws an error', async () => {
      const errorCtx: any = {
        chat: { id: -1001234567890, type: 'supergroup' },
        from: { id: 8888 },
        telegram: {
          getChatAdministrators: jest.fn().mockRejectedValue(new Error('Network error')),
        },
      };
      expect(await isAuthorizedAdmin(errorCtx)).toBe(false);
    });

    it('denyUnauthorizedAccess should reply with access denied and emit structured security audit log', async () => {
      const replyMock = jest.fn().mockResolvedValue(true);
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
      const loggerWarnSpy = jest.spyOn(logger, 'warn').mockImplementation();

      const mockCtx: any = {
        chat: { id: -1001234567890, type: 'supergroup' },
        from: { id: 9999, username: 'attacker' },
        reply: replyMock,
      };

      await denyUnauthorizedAccess(mockCtx, 'modify destination group');

      expect(replyMock).toHaveBeenCalledWith(
        expect.stringContaining('⛔ Access denied: You are not authorized to modify destination group.')
      );

      // Verify structured audit log format and fields
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unauthorized modify destination group attempt'),
        expect.objectContaining({
          event: 'security.unauthorized_access',
          userId: 9999,
          action: 'modify destination group',
        })
      );

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[Security Alert] Unauthorized modify destination group attempt by user 9999 in chat -1001234567890')
      );

      consoleWarnSpy.mockRestore();
      loggerWarnSpy.mockRestore();
    });
  });

  // ==========================================
  // 6. Error Sanitization & Secret Redaction
  // ==========================================
  describe('Task 1: Error Sanitization and Secret Redaction', () => {
    it('logger.sanitize should redact Telegram bot tokens from error text', () => {
      const rawText = 'Error connecting to Telegram with token 123456789:ABCdef-GHIjklMNOpqrSTUvwxYZ1234567 in URL';
      const sanitized = logger.sanitize(rawText);
      expect(sanitized).not.toContain('123456789:ABCdef-GHIjklMNOpqrSTUvwxYZ1234567');
      expect(sanitized).toContain('[REDACTED_BOT_TOKEN]');
    });
  });
});
