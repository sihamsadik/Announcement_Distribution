import { Telegram, Context } from 'telegraf';
import { distributionService, DistributionService } from '../src/services/distribution.service';
import { albumService, AlbumService } from '../src/services/album.service';
import { destinationService } from '../src/services/destination.service';
import { sourceService } from '../src/services/source.service';
import { forwardingService, ForwardingService, ForwardErrorType, classifyTelegramError } from '../src/services/forwarding.service';
import { getMessageContentType, detectSourceAnnouncement } from '../src/bot/detector';
import { prisma, disconnectPrisma } from '../src/db/prisma';
import { SourceGroup, DestinationGroup } from '@prisma/client';

describe('Media Types, Media Albums, and Edge Cases (Day 2 - Task 3)', () => {
  const dummyToken = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ';
  const testSourceChatId1 = BigInt(-100666001);
  const testSourceChatId2 = BigInt(-100666002);
  const testDestChatId1 = BigInt(-100444001);
  const testDestChatId2 = BigInt(-100444002);

  let sourceA: SourceGroup;
  let sourceB: SourceGroup;
  let destA1: DestinationGroup;
  let destA2: DestinationGroup;

  beforeAll(async () => {
    // Clean up test data if existing
    await prisma.destinationGroup.deleteMany({
      where: { chatId: { in: [testDestChatId1, testDestChatId2] } },
    });
    await prisma.sourceGroup.deleteMany({
      where: { chatId: { in: [testSourceChatId1, testSourceChatId2] } },
    });

    // 1. Source A
    const resA = await sourceService.registerSource({
      chatId: testSourceChatId1,
      topicId: BigInt(501),
      name: 'Software Engineering - Final Project Topic',
    });
    sourceA = resA.source!;

    // 2. Source B
    const resB = await sourceService.registerSource({
      chatId: testSourceChatId2,
      topicId: BigInt(502),
      name: 'Computer Networks - Lab Announcements',
    });
    sourceB = resB.source!;

    // 3. Destinations for Source A
    const dA1 = await destinationService.registerDestination({
      chatId: testDestChatId1,
      groupName: 'Student Project Team 1',
      sourceGroupId: sourceA.id,
    });
    destA1 = dA1.destination!;

    const dA2 = await destinationService.registerDestination({
      chatId: testDestChatId2,
      groupName: 'Student Project Team 2',
      sourceGroupId: sourceA.id,
    });
    destA2 = dA2.destination!;
  });

  afterAll(async () => {
    albumService.clear();
    await prisma.destinationGroup.deleteMany({
      where: { chatId: { in: [testDestChatId1, testDestChatId2] } },
    });
    await prisma.sourceGroup.deleteMany({
      where: { chatId: { in: [testSourceChatId1, testSourceChatId2] } },
    });
    await disconnectPrisma();
  });

  beforeEach(() => {
    albumService.clear();
  });

  describe('1. Message Content Type Classification', () => {
    it('should classify text messages correctly', () => {
      const msg = { text: 'Announcement: Homework 3 is released.' };
      const res = getMessageContentType(msg);
      expect(res.contentType).toBe('text');
      expect(res.hasMedia).toBe(false);
      expect(res.preview).toBe('Announcement: Homework 3 is released.');
    });

    it('should classify photos with captions correctly', () => {
      const msg = { photo: [{}, {}], caption: 'Poster for the hackathon' };
      const res = getMessageContentType(msg);
      expect(res.contentType).toBe('photo');
      expect(res.hasMedia).toBe(true);
      expect(res.preview).toBe('Poster for the hackathon');
    });

    it('should classify PDF documents with file name and caption correctly', () => {
      const msg = {
        document: { file_name: 'project_guidelines.pdf', mime_type: 'application/pdf' },
        caption: 'Please read the updated project guidelines carefully.',
      };
      const res = getMessageContentType(msg);
      expect(res.contentType).toBe('document');
      expect(res.hasMedia).toBe(true);
      expect(res.preview).toContain('Please read');
    });

    it('should classify documents without caption by using file_name', () => {
      const msg = {
        document: { file_name: 'milestone1_spec.pdf', mime_type: 'application/pdf' },
      };
      const res = getMessageContentType(msg);
      expect(res.contentType).toBe('document');
      expect(res.hasMedia).toBe(true);
      expect(res.preview).toBe('milestone1_spec.pdf');
    });

    it('should classify videos with caption correctly', () => {
      const msg = { video: { duration: 120 }, caption: 'Tutorial video on Git rebase' };
      const res = getMessageContentType(msg);
      expect(res.contentType).toBe('video');
      expect(res.hasMedia).toBe(true);
      expect(res.preview).toBe('Tutorial video on Git rebase');
    });

    it('should classify audio files correctly', () => {
      const msg = { audio: { title: 'Lecture 12 Audio', duration: 3600 } };
      const res = getMessageContentType(msg);
      expect(res.contentType).toBe('audio');
      expect(res.hasMedia).toBe(true);
      expect(res.preview).toBe('Lecture 12 Audio');
    });

    it('should classify voice messages correctly', () => {
      const msg = { voice: { duration: 45 } };
      const res = getMessageContentType(msg);
      expect(res.contentType).toBe('voice');
      expect(res.hasMedia).toBe(true);
      expect(res.preview).toBe('Voice message');
    });

    it('should classify video notes (round video messages) correctly', () => {
      const msg = { video_note: { duration: 30 } };
      const res = getMessageContentType(msg);
      expect(res.contentType).toBe('video_note');
      expect(res.hasMedia).toBe(true);
      expect(res.preview).toBe('Video message');
    });

    it('should classify stickers correctly with emoji', () => {
      const msg = { sticker: { emoji: '🎉', set_name: 'CelebrationPack' } };
      const res = getMessageContentType(msg);
      expect(res.contentType).toBe('sticker');
      expect(res.hasMedia).toBe(true);
      expect(res.preview).toBe('Sticker 🎉');
    });

    it('should classify animations (GIFs) correctly', () => {
      const msg = { animation: { duration: 5 }, caption: 'Good luck on exams!' };
      const res = getMessageContentType(msg);
      expect(res.contentType).toBe('animation');
      expect(res.hasMedia).toBe(true);
      expect(res.preview).toBe('Good luck on exams!');
    });

    it('should classify polls correctly', () => {
      const msg = { poll: { question: 'Preferred deadline for sprint 2?' } };
      const res = getMessageContentType(msg);
      expect(res.contentType).toBe('poll');
      expect(res.hasMedia).toBe(false);
      expect(res.preview).toBe('Preferred deadline for sprint 2?');
    });

    it('should classify contacts, locations, and dice correctly', () => {
      const contactMsg = { contact: { first_name: 'Dr. Jane', last_name: 'Doe' } };
      expect(getMessageContentType(contactMsg).contentType).toBe('contact');

      const locMsg = { location: { latitude: 37.7749, longitude: -122.4194 } };
      expect(getMessageContentType(locMsg).contentType).toBe('location');

      const diceMsg = { dice: { emoji: '🎲', value: 6 } };
      expect(getMessageContentType(diceMsg).contentType).toBe('dice');
    });
  });

  describe('2. Rate Limit Recognition & Backoff Extraction', () => {
    it('should extract retry_after integer from standard Telegram 429 error string', () => {
      const err = new Error('429: Too Many Requests: retry after 42');
      const classified = classifyTelegramError(err);
      expect(classified.errorType).toBe(ForwardErrorType.RATE_LIMITED);
      expect(classified.retryAfterSeconds).toBe(42);
      expect(classified.message).toContain('Retry after 42s');
    });

    it('should extract retry_after parameter from error object parameters', () => {
      const err: any = new Error('Too Many Requests');
      err.parameters = { retry_after: 15 };
      const classified = classifyTelegramError(err);
      expect(classified.errorType).toBe(ForwardErrorType.RATE_LIMITED);
      expect(classified.retryAfterSeconds).toBe(15);
      expect(classified.message).toContain('Retry after 15s');
    });

    it('should handle rate limit backoff in DistributionService without throwing', async () => {
      const mockForwardMessage = jest.fn()
        .mockRejectedValueOnce(new Error('429: Too Many Requests: retry after 1'))
        .mockResolvedValueOnce({ message_id: 3001 });

      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      // Instantiate DistributionService with 0 delay and max 100ms backoff for fast testing
      const customDistribution = new DistributionService(
        destinationService,
        forwardingService,
        albumService,
        0,
        100 // cap backoff at 100ms during test
      );

      const summary = await customDistribution.distributeAnnouncement(
        mockTelegram,
        sourceA,
        999,
        'text',
        dummyToken
      );

      expect(summary.totalDestinations).toBe(2);
      expect(summary.failedCount).toBe(1);
      expect(summary.successfulCount).toBe(1);
      expect(summary.results[0].errorType).toBe(ForwardErrorType.RATE_LIMITED);
      expect(summary.results[0].retryAfterSeconds).toBe(1);
      expect(summary.results[1].success).toBe(true);
    });
  });

  describe('3. Native Forwarding of Non-Album Messages', () => {
    it('should forward document (PDF) natively to active destinations', async () => {
      const mockForwardMessage = jest.fn().mockResolvedValue({ message_id: 4001 });
      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      const summary = await distributionService.distributeAnnouncement(
        mockTelegram,
        sourceA,
        1201,
        'document',
        dummyToken
      );

      expect(summary.contentType).toBe('document');
      expect(summary.isAlbum).toBe(false);
      expect(summary.successfulCount).toBe(2);
      expect(mockForwardMessage).toHaveBeenCalledTimes(2);
      expect(mockForwardMessage).toHaveBeenCalledWith(
        destA1.chatId.toString(),
        sourceA.chatId.toString(),
        1201
      );
    });

    it('should forward voice message natively to active destinations', async () => {
      const mockForwardMessage = jest.fn().mockResolvedValue({ message_id: 4002 });
      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      const summary = await distributionService.distributeAnnouncement(
        mockTelegram,
        sourceA,
        1202,
        'voice',
        dummyToken
      );

      expect(summary.contentType).toBe('voice');
      expect(summary.successfulCount).toBe(2);
    });

    it('should forward sticker natively to active destinations', async () => {
      const mockForwardMessage = jest.fn().mockResolvedValue({ message_id: 4003 });
      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      const summary = await distributionService.distributeAnnouncement(
        mockTelegram,
        sourceA,
        1203,
        'sticker',
        dummyToken
      );

      expect(summary.contentType).toBe('sticker');
      expect(summary.successfulCount).toBe(2);
    });
  });

  describe('4. Telegram Media Album Collection & Batching Strategy', () => {
    it('should collect multiple items sharing media_group_id and sort message IDs ascending', async () => {
      const mockHandler = jest.fn().mockResolvedValue({
        sourceGroupId: sourceA.id,
        isAlbum: true,
        successfulCount: 2,
        totalDestinations: 2,
      });

      const testAlbumService = new AlbumService(200, 1000);
      const mockTelegram = {} as Telegram;
      const mediaGroupId = 'mg_test_1001';

      // Updates arrive in non-sequential order: #103, #101, #102
      testAlbumService.addMessage(
        mockTelegram, sourceA, sourceA.chatId, sourceA.topicId,
        mediaGroupId, 103, 'photo', 'Photo 3', dummyToken, undefined, mockHandler
      );
      testAlbumService.addMessage(
        mockTelegram, sourceA, sourceA.chatId, sourceA.topicId,
        mediaGroupId, 101, 'photo', 'Photo 1', dummyToken, undefined, mockHandler
      );
      testAlbumService.addMessage(
        mockTelegram, sourceA, sourceA.chatId, sourceA.topicId,
        mediaGroupId, 102, 'photo', 'Photo 2', dummyToken, undefined, mockHandler
      );

      // Verify active album in buffer
      const key = `${sourceA.chatId.toString()}_${mediaGroupId}`;
      const queued = testAlbumService.getActiveAlbum(key);
      expect(queued).toBeDefined();
      expect(queued?.messages.length).toBe(3);

      // Explicitly flush album
      const summary = await testAlbumService.flushAlbum(key, mockTelegram, dummyToken, undefined, mockHandler);

      expect(summary).not.toBeNull();
      // Verify handler was called with sorted message IDs [101, 102, 103]
      expect(mockHandler).toHaveBeenCalledTimes(1);
      expect(mockHandler).toHaveBeenCalledWith(
        mockTelegram,
        sourceA,
        [101, 102, 103],
        mediaGroupId,
        'album (3 items)',
        dummyToken
      );
    });

    it('should ignore duplicate message IDs in the same album update buffer', () => {
      const testAlbumService = new AlbumService(200, 1000);
      const mockTelegram = {} as Telegram;
      const mediaGroupId = 'mg_test_1002';

      testAlbumService.addMessage(
        mockTelegram, sourceA, sourceA.chatId, sourceA.topicId,
        mediaGroupId, 201, 'photo', 'Photo 1', dummyToken
      );
      // Duplicate delivery of message #201
      testAlbumService.addMessage(
        mockTelegram, sourceA, sourceA.chatId, sourceA.topicId,
        mediaGroupId, 201, 'photo', 'Photo 1', dummyToken
      );

      const key = `${sourceA.chatId.toString()}_${mediaGroupId}`;
      const queued = testAlbumService.getActiveAlbum(key);
      expect(queued?.messages.length).toBe(1);
    });

    it('should ignore late updates arriving after album has already been flushed', async () => {
      const mockHandler = jest.fn().mockResolvedValue({
        sourceGroupId: sourceA.id,
        isAlbum: true,
      });

      const testAlbumService = new AlbumService(100, 500);
      const mockTelegram = {} as Telegram;
      const mediaGroupId = 'mg_test_1003';
      const key = `${sourceA.chatId.toString()}_${mediaGroupId}`;

      testAlbumService.addMessage(
        mockTelegram, sourceA, sourceA.chatId, sourceA.topicId,
        mediaGroupId, 301, 'photo', 'Photo 1', dummyToken, undefined, mockHandler
      );

      // Flush album
      await testAlbumService.flushAlbum(key, mockTelegram, dummyToken, undefined, mockHandler);
      expect(testAlbumService.isProcessed(key)).toBe(true);

      // Late update arrives
      const queuedLate = testAlbumService.addMessage(
        mockTelegram, sourceA, sourceA.chatId, sourceA.topicId,
        mediaGroupId, 302, 'photo', 'Late Photo', dummyToken, undefined, mockHandler
      );

      expect(queuedLate).toBe(false);
      // Handler was still called only once
      expect(mockHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('5. Native Album Forwarding (forwardMessages API)', () => {
    it('should forward album atomically using forwardMessages to all active destinations', async () => {
      const mockForwardMessages = jest.fn().mockImplementation((destChatId, srcChatId, msgIds) => {
        return Promise.resolve(msgIds.map((id: number, idx: number) => ({ message_id: 8000 + idx })));
      });

      const mockTelegram = { forwardMessages: mockForwardMessages } as unknown as Telegram;

      const summary = await distributionService.distributeAlbum(
        mockTelegram,
        sourceA,
        [501, 502, 503],
        'mg_album_photos',
        'album (3 items)',
        dummyToken
      );

      expect(summary.isAlbum).toBe(true);
      expect(summary.mediaGroupId).toBe('mg_album_photos');
      expect(summary.sourceMessageIds).toEqual([501, 502, 503]);
      expect(summary.totalDestinations).toBe(2);
      expect(summary.successfulCount).toBe(2);
      expect(summary.failedCount).toBe(0);

      // Check results structure
      expect(summary.results[0].forwardedMessageIds).toEqual([8000, 8001, 8002]);
      expect(summary.results[1].forwardedMessageIds).toEqual([8000, 8001, 8002]);

      // Check forwardMessages called with sorted message IDs
      expect(mockForwardMessages).toHaveBeenCalledTimes(2);
      expect(mockForwardMessages).toHaveBeenCalledWith(
        destA1.chatId.toString(),
        sourceA.chatId.toString(),
        [501, 502, 503]
      );
      expect(mockForwardMessages).toHaveBeenCalledWith(
        destA2.chatId.toString(),
        sourceA.chatId.toString(),
        [501, 502, 503]
      );
    });

    it('should handle protected content when forwarding album and continue to other groups', async () => {
      const mockForwardMessages = jest.fn().mockImplementation((destChatId) => {
        if (destChatId === destA1.chatId.toString()) {
          return Promise.reject(new Error('Bad Request: CHAT_FORWARDS_RESTRICTED'));
        }
        return Promise.resolve([{ message_id: 8100 }, { message_id: 8101 }]);
      });

      const mockTelegram = { forwardMessages: mockForwardMessages } as unknown as Telegram;

      const summary = await distributionService.distributeAlbum(
        mockTelegram,
        sourceA,
        [601, 602],
        'mg_protected_album',
        'album (2 items)',
        dummyToken
      );

      expect(summary.totalDestinations).toBe(2);
      expect(summary.failedCount).toBe(1);
      expect(summary.successfulCount).toBe(1);

      const failedResult = summary.results.find((r) => r.destinationId === destA1.id);
      expect(failedResult!.errorType).toBe(ForwardErrorType.PROTECTED_CONTENT);
      expect(failedResult!.errorMessage).toContain('content protection');

      const successResult = summary.results.find((r) => r.destinationId === destA2.id);
      expect(successResult!.success).toBe(true);
    });

    it('should handle deleted or missing messages in album gracefully', async () => {
      const mockForwardMessages = jest.fn().mockRejectedValue(new Error('Bad Request: message to forward not found'));
      const mockTelegram = { forwardMessages: mockForwardMessages } as unknown as Telegram;

      const summary = await distributionService.distributeAlbum(
        mockTelegram,
        sourceA,
        [701, 702],
        'mg_missing_msg',
        'album (2 items)',
        dummyToken
      );

      expect(summary.failedCount).toBe(2);
      expect(summary.successfulCount).toBe(0);
      expect(summary.results[0].errorType).toBe(ForwardErrorType.MESSAGE_NOT_FOUND);
      expect(summary.results[0].errorMessage).toContain('could not be found or has been deleted');
    });
  });

  describe('6. End-to-End processIncomingMessage with Media & Albums', () => {
    it('should route album updates through AlbumService and distribute once when flushed', async () => {
      const mockForwardMessages = jest.fn().mockResolvedValue([{ message_id: 9101 }, { message_id: 9102 }]);
      const mockTelegram = { forwardMessages: mockForwardMessages } as unknown as Telegram;

      const albumId = 'group_album_e2e_1';

      // 1. First photo update of album arrives
      const ctx1 = {
        telegram: mockTelegram,
        chat: { id: Number(sourceA.chatId), type: 'supergroup' },
        message: {
          message_id: 881,
          message_thread_id: Number(sourceA.topicId),
          media_group_id: albumId,
          from: { id: 1001, is_bot: false, first_name: 'Professor' },
          photo: [{}],
          caption: 'Final Project posters - Part 1',
        },
      } as unknown as Context;

      const res1 = await distributionService.processIncomingMessage(ctx1, dummyToken);
      // Album is buffered, returns null immediately
      expect(res1).toBeNull();

      // 2. Second photo update of album arrives
      const ctx2 = {
        telegram: mockTelegram,
        chat: { id: Number(sourceA.chatId), type: 'supergroup' },
        message: {
          message_id: 882,
          message_thread_id: Number(sourceA.topicId),
          media_group_id: albumId,
          from: { id: 1001, is_bot: false, first_name: 'Professor' },
          photo: [{}],
          caption: 'Final Project posters - Part 2',
        },
      } as unknown as Context;

      const res2 = await distributionService.processIncomingMessage(ctx2, dummyToken);
      expect(res2).toBeNull();

      // 3. Flush all active albums in albumService
      const summaries = await albumService.flushAll(mockTelegram, dummyToken);

      expect(summaries.length).toBe(1);
      const albumSummary = summaries[0];
      expect(albumSummary.isAlbum).toBe(true);
      expect(albumSummary.mediaGroupId).toBe(albumId);
      expect(albumSummary.sourceMessageIds).toEqual([881, 882]);
      expect(albumSummary.successfulCount).toBe(2);

      // Verify forwardMessages was called once per destination group (total 2 times)
      expect(mockForwardMessages).toHaveBeenCalledTimes(2);
    });

    it('should distribute single document announcement immediately', async () => {
      const mockForwardMessage = jest.fn().mockResolvedValue({ message_id: 9200 });
      const mockTelegram = { forwardMessage: mockForwardMessage } as unknown as Telegram;

      const ctx = {
        telegram: mockTelegram,
        chat: { id: Number(sourceA.chatId), type: 'supergroup' },
        message: {
          message_id: 890,
          message_thread_id: Number(sourceA.topicId),
          from: { id: 1001, is_bot: false, first_name: 'Professor' },
          document: { file_name: 'rubric.pdf', mime_type: 'application/pdf' },
          caption: 'Grading rubric for milestone 1',
        },
      } as unknown as Context;

      const summary = await distributionService.processIncomingMessage(ctx, dummyToken);

      expect(summary).not.toBeNull();
      expect(summary?.contentType).toBe('document');
      expect(summary?.isAlbum).toBe(false);
      expect(summary?.sourceMessageId).toBe(890);
      expect(summary?.successfulCount).toBe(2);
      expect(mockForwardMessage).toHaveBeenCalledTimes(2);
    });

    it('should keep Source A and Source B album distributions completely isolated', async () => {
      const mockForwardMessages = jest.fn().mockResolvedValue([{ message_id: 9300 }]);
      const mockTelegram = { forwardMessages: mockForwardMessages } as unknown as Telegram;

      const albumA = 'album_source_A';
      const albumB = 'album_source_B';

      // Album in Source A
      const ctxA = {
        telegram: mockTelegram,
        chat: { id: Number(sourceA.chatId), type: 'supergroup' },
        message: {
          message_id: 901,
          message_thread_id: Number(sourceA.topicId),
          media_group_id: albumA,
          from: { id: 1001, is_bot: false },
          photo: [{}],
        },
      } as unknown as Context;

      // Album in Source B
      const ctxB = {
        telegram: mockTelegram,
        chat: { id: Number(sourceB.chatId), type: 'supergroup' },
        message: {
          message_id: 902,
          message_thread_id: Number(sourceB.topicId),
          media_group_id: albumB,
          from: { id: 1002, is_bot: false },
          photo: [{}],
        },
      } as unknown as Context;

      await distributionService.processIncomingMessage(ctxA, dummyToken);
      await distributionService.processIncomingMessage(ctxB, dummyToken);

      const summaries = await albumService.flushAll(mockTelegram, dummyToken);
      expect(summaries.length).toBe(2);

      const summaryA = summaries.find((s) => s.mediaGroupId === albumA);
      const summaryB = summaries.find((s) => s.mediaGroupId === albumB);

      expect(summaryA?.sourceGroupId).toBe(sourceA.id);
      expect(summaryA?.totalDestinations).toBe(2); // destA1 and destA2

      expect(summaryB?.sourceGroupId).toBe(sourceB.id);
      expect(summaryB?.totalDestinations).toBe(0); // Source B currently has 0 destinations
    });
  });
});
