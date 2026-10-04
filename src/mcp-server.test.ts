import assert from "node:assert/strict";
import {
  explainBatchSchema,
  handleExplainBatch,
  handleQueryBatches,
  queryBatchesSchema,
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
