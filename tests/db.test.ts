import { prisma, disconnectPrisma } from '../src/db/prisma';
import { ForwardingStatus } from '@prisma/client';

describe('Database Schema & Prisma 7 Integration', () => {
  afterAll(async () => {
    await disconnectPrisma();
  });

  it('should successfully connect to PostgreSQL and query tables', async () => {
    const sourceCount = await prisma.sourceGroup.count();
    const destCount = await prisma.destinationGroup.count();
    const logCount = await prisma.forwardingLog.count();

    expect(typeof sourceCount).toBe('number');
    expect(typeof destCount).toBe('number');
    expect(typeof logCount).toBe('number');
  });

  it('should support creating, querying, and cascade-deleting related entities', async () => {
    const testChatId = BigInt(-1001234567890);
    const testTopicId = BigInt(42);
    const testDestChatId = BigInt(-1009876543210);

    // 1. Create a SourceGroup
    const source = await prisma.sourceGroup.create({
      data: {
        chatId: testChatId,
        topicId: testTopicId,
        name: 'Main Section - Final Project Topic',
      },
    });

    expect(source.id).toBeDefined();
    expect(source.chatId).toBe(testChatId);
    expect(source.topicId).toBe(testTopicId);

    // 2. Create a DestinationGroup linked to the SourceGroup
    const destination = await prisma.destinationGroup.create({
      data: {
        sourceGroupId: source.id,
        chatId: testDestChatId,
        groupName: 'Student Team Alpha',
        isActive: true,
      },
    });

    expect(destination.id).toBeDefined();
    expect(destination.sourceGroupId).toBe(source.id);
    expect(destination.isActive).toBe(true);

    // 3. Create a ForwardingLog entry
    const log = await prisma.forwardingLog.create({
      data: {
        sourceChatId: testChatId,
        sourceMessageId: 101,
        destinationGroupId: destination.id,
        status: ForwardingStatus.SUCCESS,
      },
    });

    expect(log.id).toBeDefined();
    expect(log.status).toBe(ForwardingStatus.SUCCESS);

    // 4. Test unique constraint on ForwardingLog (prevent duplicate forwarding)
    await expect(
      prisma.forwardingLog.create({
        data: {
          sourceChatId: testChatId,
          sourceMessageId: 101,
          destinationGroupId: destination.id,
          status: ForwardingStatus.SUCCESS,
        },
      })
    ).rejects.toThrow();

    // 5. Test cascade delete on SourceGroup (should delete destination and forwarding logs)
    await prisma.sourceGroup.delete({
      where: { id: source.id },
    });

    const deletedDest = await prisma.destinationGroup.findUnique({
      where: { id: destination.id },
    });
    const deletedLog = await prisma.forwardingLog.findUnique({
      where: { id: log.id },
    });

    expect(deletedDest).toBeNull();
    expect(deletedLog).toBeNull();
  });
});
