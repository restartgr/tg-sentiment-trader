import assert from "node:assert/strict";
import {
  explainBatchSchema,
  handleExplainBatch,
  handleQueryBatches,
  handleQueryRecentSentiment,
  handleSearchMessages,
  queryBatchesSchema,
  queryRecentSentimentSchema,
  searchMessagesSchema,
} from "./mcp-server";
import { closeDatabase, initDatabase, saveBatch, saveMessage } from "./db";

function test(name: string, run: () => void): void {
  run();
  console.log(`✓ ${name}`);
}

test("rejects limit below minimum", () => {
  const result = queryBatchesSchema.safeParse({ limit: 0 });
  assert.equal(result.success, false);
});

test("rejects an invalid time range", () => {
  const result = handleQueryBatches({ startTime: 100, endTime: 100 });
  assert.equal(result.isError, true);
});

test("returns zero batches for an empty database", () => {
  initDatabase(":memory:");
  try {
    const result = handleQueryBatches({});
    assert.notEqual(result.isError, true);

    const block = result.content[0];
    if (block.type !== "text") {
      throw new Error("unExpected result");
    } else {
      const content = JSON.parse(block.text);
      assert.equal(content.count, 0);
    }
  } finally {
    closeDatabase();
  }
});

test("returns a saved batch with its id", () => {
  initDatabase(":memory:");
  try {
    const messageId = saveMessage({
      tgMessageId: 1,
      groupId: "1",
      senderId: "1",
      username: "test",
      text: "test",
      messageTs: 1,
    });
    const saveBatchId = saveBatch({
      groupId: "1",
      messageIds: [messageId],
      startTime: 1,
      endTime: 2,
      quickScore: 0.5,
      finalScore: 0.5,
      initialTier: "1",
      finalTier: "2",
      dominantEmotion: "1",
      summary: "test",
      marketInsight: "test",
      result: "test",
      status: "completed",
    });
    const result = handleQueryBatches({});
    assert.notEqual(result.isError, true);

    const block = result.content[0];
    if (block.type !== "text") {
      throw new Error("unExpected result");
    } else {
      const content = JSON.parse(block.text);
      assert.equal(content.count, 1);
      assert.equal(content.batches[0].id, saveBatchId);
    }
  } finally {
    closeDatabase();
  }
});

test("validates explain_batch input and applies the message limit default", () => {
  assert.equal(explainBatchSchema.safeParse({ batchId: 0 }).success, false);
  assert.equal(
    explainBatchSchema.safeParse({ batchId: 1, messageLimit: 21 }).success,
    false,
  );

  const result = explainBatchSchema.safeParse({ batchId: 1 });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.messageLimit, 20);
  }
});

test("returns found false when the batch does not exist", () => {
  initDatabase(":memory:");
  try {
    const result = handleExplainBatch({ batchId: 999, messageLimit: 20 });
    assert.notEqual(result.isError, true);

    const block = result.content[0];
    if (block.type !== "text") {
      throw new Error("unexpected result");
    }

    const content = JSON.parse(block.text);
    assert.equal(content.found, false);
    assert.deepEqual(content.messages, []);
    assert.deepEqual(content.sourceMessageIds, []);
    assert.equal(content.truncated, false);
  } finally {
    closeDatabase();
  }
});

test("returns a batch with all of its source messages", () => {
  initDatabase(":memory:");
  try {
    const messageId = saveMessage({
      tgMessageId: 2,
      groupId: "1",
      senderId: "1",
      username: "test",
      text: "source message",
      messageTs: 2,
    });
    const batchId = saveBatch({
      groupId: "1",
      messageIds: [messageId],
      startTime: 1,
      endTime: 2,
      quickScore: 0.5,
      finalScore: 0.5,
      initialTier: "1",
      finalTier: "2",
      dominantEmotion: "1",
      summary: "test",
      marketInsight: "test",
      result: "test",
      status: "completed",
    });

    const result = handleExplainBatch({ batchId, messageLimit: 20 });
    assert.notEqual(result.isError, true);
    const block = result.content[0];
    if (block.type !== "text") {
      throw new Error("unexpected result");
    }

    const content = JSON.parse(block.text);
    assert.equal(content.found, true);
    assert.equal(content.batch.id, batchId);
    assert.equal(content.batchMessagesCount, 1);
    assert.equal(content.sourceMessageCount, 1);
    assert.equal(content.messages.length, 1);
    assert.deepEqual(content.sourceMessageIds, [messageId]);
    assert.equal(content.truncated, false);
  } finally {
    closeDatabase();
  }
});

test("tool results label message and batch times in JST", () => {
  initDatabase(":memory:");
  try {
    const messageTime = Date.UTC(2026, 9, 1, 5, 27);
    const endTime = Date.UTC(2026, 9, 1, 5, 46);
    const messageId = saveMessage({
      tgMessageId: 50,
      groupId: "test-group",
      senderId: null,
      username: "test",
      text: "time fixture",
      messageTs: messageTime,
    });
    const batchId = saveBatch({
      groupId: "test-group",
      messageIds: [messageId],
      startTime: messageTime,
      endTime,
      quickScore: 0,
      finalScore: 0,
      initialTier: "light",
      finalTier: "light",
      dominantEmotion: "neutral",
      summary: "time fixture",
      marketInsight: "",
      result: {},
      status: "completed",
    });

    const batchBlock = handleQueryBatches({}).content[0];
    const searchBlock = handleSearchMessages({}).content[0];
    const explainBlock = handleExplainBatch({ batchId, messageLimit: 20 }).content[0];
    assert.equal(batchBlock.type, "text");
    assert.equal(searchBlock.type, "text");
    assert.equal(explainBlock.type, "text");
    if (batchBlock.type !== "text" || searchBlock.type !== "text" || explainBlock.type !== "text") return;

    const batches = JSON.parse(batchBlock.text);
    const search = JSON.parse(searchBlock.text);
    const explanation = JSON.parse(explainBlock.text);
    assert.equal(batches.timeZone, "Asia/Tokyo");
    assert.equal(batches.batches[0].startTimeJst, "2026-10-01 14:27:00 JST");
    assert.equal(batches.batches[0].endTimeJst, "2026-10-01 14:46:00 JST");
    assert.equal(search.messages[0].messageTimeJst, "2026-10-01 14:27:00 JST");
    assert.equal(explanation.batch.startTimeJst, "2026-10-01 14:27:00 JST");
    assert.equal(explanation.messages[0].messageTimeJst, "2026-10-01 14:27:00 JST");

    saveMessage({
      tgMessageId: 51,
      groupId: "seconds-fixture",
      senderId: null,
      username: "test",
      text: "legacy seconds timestamp",
      messageTs: messageTime / 1_000,
    });
    const secondsBlock = handleSearchMessages({ groupId: "seconds-fixture" }).content[0];
    assert.equal(secondsBlock.type, "text");
    if (secondsBlock.type === "text") {
      assert.equal(JSON.parse(secondsBlock.text).messages[0].messageTimeJst, "2026-10-01 14:27:00 JST");
    }
  } finally {
    closeDatabase();
  }
});

test("marks the result as truncated when the message limit is smaller", () => {
  initDatabase(":memory:");
  try {
    const firstMessageId = saveMessage({
      tgMessageId: 3,
      groupId: "1",
      senderId: "1",
      username: "test",
      text: "first source message",
      messageTs: 3,
    });
    const secondMessageId = saveMessage({
      tgMessageId: 4,
      groupId: "1",
      senderId: "1",
      username: "test",
      text: "second source message",
      messageTs: 4,
    });
    const batchId = saveBatch({
      groupId: "1",
      messageIds: [firstMessageId, secondMessageId],
      startTime: 3,
      endTime: 4,
      quickScore: 0.5,
      finalScore: 0.5,
      initialTier: "1",
      finalTier: "2",
      dominantEmotion: "1",
      summary: "test",
      marketInsight: "test",
      result: "test",
      status: "completed",
    });

    const result = handleExplainBatch({ batchId, messageLimit: 1 });
    assert.notEqual(result.isError, true);
    const block = result.content[0];
    if (block.type !== "text") {
      throw new Error("unexpected result");
    }

    const content = JSON.parse(block.text);
    assert.equal(content.batchMessagesCount, 2);
    assert.equal(content.sourceMessageCount, 1);
    assert.equal(content.messages.length, 1);
    assert.equal(content.sourceMessageIds.length, 1);
    assert.equal(content.sourceMessageIds[0], content.messages[0].id);
    assert.equal(content.truncated, true);
  } finally {
    closeDatabase();
  }
});

test("validates query_recent_sentiment input", () => {
  assert.equal(
    queryRecentSentimentSchema.safeParse({ limit: 0 }).success,
    false,
  );
  assert.equal(
    queryRecentSentimentSchema.safeParse({ limit: 21 }).success,
    false,
  );
});

test("returns zero recent sentiment batches for an empty database", () => {
  initDatabase(":memory:");
  try {
    const result = handleQueryRecentSentiment({});
    assert.notEqual(result.isError, true);
    const block = result.content[0];
    if (block.type !== "text") {
      throw new Error("unexpected result");
    }

    const content = JSON.parse(block.text);
    assert.equal(content.count, 0);
    assert.deepEqual(content.batches, []);
  } finally {
    closeDatabase();
  }
});

test("applies the recent sentiment default limit and group filter", () => {
  initDatabase(":memory:");
  try {
    const groupABatchIds: number[] = [];
    for (let index = 1; index <= 6; index += 1) {
      const messageId = saveMessage({
        tgMessageId: index,
        groupId: "group-a",
        senderId: "sender-a",
        username: "test",
        text: `group-a message ${index}`,
        messageTs: index,
      });
      groupABatchIds.push(
        saveBatch({
          groupId: "group-a",
          messageIds: [messageId],
          startTime: index,
          endTime: index + 1,
          quickScore: 0.5,
          finalScore: 0.5,
          initialTier: "1",
          finalTier: "2",
          dominantEmotion: "1",
          summary: "test",
          marketInsight: "test",
          result: "test",
          status: "completed",
        }),
      );
    }

    const defaultResult = handleQueryRecentSentiment({});
    const defaultBlock = defaultResult.content[0];
    if (defaultBlock.type !== "text") {
      throw new Error("unexpected result");
    }
    const defaultContent = JSON.parse(defaultBlock.text);
    assert.equal(defaultContent.count, 5);
    assert.deepEqual(
      defaultContent.batches.map((batch: { id: number }) => batch.id),
      groupABatchIds.slice(1).reverse(),
    );

    const groupBMessageId = saveMessage({
      tgMessageId: 7,
      groupId: "group-b",
      senderId: "sender-b",
      username: "test",
      text: "group-b message",
      messageTs: 7,
    });
    const groupBBatchId = saveBatch({
      groupId: "group-b",
      messageIds: [groupBMessageId],
      startTime: 7,
      endTime: 8,
      quickScore: 0.5,
      finalScore: 0.5,
      initialTier: "1",
      finalTier: "2",
      dominantEmotion: "1",
      summary: "test",
      marketInsight: "test",
      result: "test",
      status: "completed",
    });

    const filteredResult = handleQueryRecentSentiment({ groupId: "group-b" });
    const filteredBlock = filteredResult.content[0];
    if (filteredBlock.type !== "text") {
      throw new Error("unexpected result");
    }
    const filteredContent = JSON.parse(filteredBlock.text);
    assert.equal(filteredContent.count, 1);
    assert.equal(filteredContent.batches[0].id, groupBBatchId);
  } finally {
    closeDatabase();
  }
});

test("validates search_messages input", () => {
  assert.equal(
    searchMessagesSchema.safeParse({ query: "   " }).success,
    false,
  );
  assert.equal(searchMessagesSchema.safeParse({ limit: 21 }).success, false);
});

test("filters messages by group, keyword, and time range", () => {
  initDatabase(":memory:");
  try {
    const matchingMessageId = saveMessage({
      tgMessageId: 1,
      groupId: "group-a",
      senderId: "sender-a",
      username: "test",
      text: "Bitcoin is gaining momentum",
      messageTs: 10,
    });
    saveMessage({
      tgMessageId: 2,
      groupId: "group-a",
      senderId: "sender-a",
      username: "test",
      text: "Ethereum update",
      messageTs: 20,
    });
    saveMessage({
      tgMessageId: 3,
      groupId: "group-b",
      senderId: "sender-b",
      username: "test",
      text: "Bitcoin in another group",
      messageTs: 10,
    });

    const result = handleSearchMessages({
      groupId: "group-a",
      query: "Bitcoin",
      startTime: 5,
      endTime: 15,
      limit: 20,
    });
    assert.notEqual(result.isError, true);
    const block = result.content[0];
    if (block.type !== "text") {
      throw new Error("unexpected result");
    }

    const content = JSON.parse(block.text);
    assert.equal(content.count, 1);
    assert.equal(content.messages[0].id, matchingMessageId);
  } finally {
    closeDatabase();
  }
});

test("returns an empty message list when no text matches", () => {
  initDatabase(":memory:");
  try {
    saveMessage({
      tgMessageId: 1,
      groupId: "group-a",
      senderId: "sender-a",
      username: "test",
      text: "Bitcoin update",
      messageTs: 10,
    });

    const result = handleSearchMessages({ query: "not present" });
    const block = result.content[0];
    if (block.type !== "text") {
      throw new Error("unexpected result");
    }
    const content = JSON.parse(block.text);
    assert.equal(content.count, 0);
    assert.deepEqual(content.messages, []);
  } finally {
    closeDatabase();
  }
});
