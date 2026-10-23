import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";
import {
  closeDatabase,
  getBatchById,
  getBatchesInRange,
  getBatchMessageCount,
  getBatchMessages,
  initDatabase,
  searchMessages,
  StoredBatch,
  StoredMessage,
} from "./db";

const jstFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function formatJst(timestamp: number): string {
  const epochMs = timestamp < 1_000_000_000_000 ? timestamp * 1_000 : timestamp;
  const parts = Object.fromEntries(
    jstFormatter.formatToParts(new Date(epochMs)).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} JST`;
}

function formatMessage(message: StoredMessage) {
  return { ...message, messageTimeJst: formatJst(message.messageTs) };
}

function formatBatch(batch: StoredBatch) {
  return {
    id: batch.id,
    groupId: batch.groupId,
    startTime: batch.startTime,
    startTimeJst: formatJst(batch.startTime),
    endTime: batch.endTime,
    endTimeJst: formatJst(batch.endTime),
    quickScore: batch.quickScore,
    finalScore: batch.finalScore,
    initialTier: batch.initialTier,
    finalTier: batch.finalTier,
    dominantEmotion: batch.dominantEmotion,
    summary: batch.summary,
    marketInsight: batch.marketInsight,
    status: batch.status,
    errorMessage: batch.errorMessage,
    createdAt: batch.createdAt,
  };
}

const server = new McpServer({
  name: "tg-sentiment-trader",
  version: "0.1.0",
});

export const queryRecentSentimentSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Maximum number of recent batches to return. Defaults to 5."),
  groupId: z
    .string()
    .optional()
    .describe("Optional normalized Telegram group id to filter by."),
});

type QueryRecentSentimentInput = z.infer<
  typeof queryRecentSentimentSchema
>;

export const handleQueryRecentSentiment = (
  input: QueryRecentSentimentInput,
): CallToolResult => {
  const { limit, groupId } = input;
  initDatabase();

  const batches = getBatchesInRange({
    limit: limit ?? 5,
    groupId,
  }).map(formatBatch);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            count: batches.length,
            batches,
            timeZone: "Asia/Tokyo",
          },
          null,
          2,
        ),
      },
    ],
  };
};

server.registerTool(
  "query_recent_sentiment",
  {
    title: "Query Recent Sentiment",
    description:
      "Return recent Telegram sentiment analysis batches from the local SQLite memory. Use startTimeJst and endTimeJst when describing times. This is read-only and does not call any LLM.",
    inputSchema: queryRecentSentimentSchema.shape,
  },
  async (input) => handleQueryRecentSentiment(input),
);
export const queryBatchesSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Maximum number of recent batches to return. Defaults to 20."),
  groupId: z
    .string()
    .optional()
    .describe("Optional normalized Telegram group id to filter by."),
  startTime: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Optional inclusive start time as a Unix timestamp."),
  endTime: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Optional exclusive end time as a Unix timestamp."),
  status: z
    .enum(["completed", "failed"])
    .optional()
    .describe("Optional normalized status to filter by"),
});

type QueryBatchesInput = z.infer<typeof queryBatchesSchema>;

export const handleQueryBatches = (
  input: QueryBatchesInput,
): CallToolResult => {
  const { startTime, endTime, limit, groupId, status } = input;
  if (startTime && endTime && startTime >= endTime) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "开始时间必须早于结束时间，请调整查询范围。",
        },
      ],
    };
  }
  initDatabase();

  const batches = getBatchesInRange({
    limit: limit ?? 20,
    groupId,
    startTime,
    endTime,
    status,
  }).map(formatBatch);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            count: batches.length,
            batches,
            timeZone: "Asia/Tokyo",
          },
          null,
          2,
        ),
      },
    ],
  };
};
server.registerTool(
  "query_batches",
  {
    title: "Find Sentiment which meet the query",
    description:
      "Return Telegram sentiment analysis batches that meet the query from the local SQLite memory. Use startTimeJst and endTimeJst when describing times. This is read-only and does not call any LLM.",
    inputSchema: queryBatchesSchema.shape,
  },
  async (input) => handleQueryBatches(input),
);

export const searchMessagesSchema = z.object({
  groupId: z
    .string()
    .optional()
    .describe("Optional normalized Telegram group id to filter by."),
  query: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional keyword to search for in message text."),
  startTime: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Optional inclusive start time as a Unix timestamp."),
  endTime: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Optional exclusive end time as a Unix timestamp."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Maximum number of messages to return. Defaults to 20."),
});

type SearchMessagesInput = z.infer<typeof searchMessagesSchema>;

export const handleSearchMessages = (
  input: SearchMessagesInput,
): CallToolResult => {
  const { groupId, query, startTime, endTime, limit } = input;
  initDatabase();

  const messages = searchMessages({
    groupId,
    query,
    startTime,
    endTime,
    limit: limit ?? 20,
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            count: messages.length,
            messages: messages.map(formatMessage),
            timeZone: "Asia/Tokyo",
          },
          null,
          2,
        ),
      },
    ],
  };
};

server.registerTool(
  "search_messages",
  {
    title: "search related messages",
    description:
      "Search historical Telegram messages in the local SQLite memory by keyword, group, or time range. Use messageTimeJst when describing times. This tool is read-only and does not call any LLM.",
    inputSchema: searchMessagesSchema.shape,
  },
  async (input) => handleSearchMessages(input),
);
export const explainBatchSchema = z.object({
  batchId: z
    .number()
    .int()
    .min(1)
    .describe("the batch id which user mentioned"),
  messageLimit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(20)
    .describe("Maximum number of messages to return. Defaults to 20."),
});

export const handleExplainBatch = (
  input: z.infer<typeof explainBatchSchema>,
): CallToolResult => {
  const { batchId, messageLimit } = input;
  initDatabase();
  const batch = getBatchById(batchId);
  if (!batch) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            found: false,
            batch: null,
            batchMessagesCount: 0,
            sourceMessageCount: 0,
            messages: [],
            truncated: false,
            sourceMessageIds: [],
          }),
        },
      ],
    };
  } else {
    const batchMessagesCount = getBatchMessageCount(batchId);
    const messages = getBatchMessages(batchId, messageLimit);
    const sourceMessageIds = messages.map((item) => item.id);
    const sourceMessageCount = messages.length;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            found: true,
            batch: formatBatch(batch),
            batchMessagesCount,
            sourceMessageCount,
            messages: messages.map(formatMessage),
            timeZone: "Asia/Tokyo",
            truncated: sourceMessageCount < batchMessagesCount,
            sourceMessageIds,
          }),
        },
      ],
    };
  }
};

server.registerTool(
  "explain_batch",
  {
    title: "Explain Sentiment Batch",
    description:
      "Return a stored Telegram sentiment analysis batch and a limited set of its associated source messages by batch ID. Use the *TimeJst fields when describing times. This tool is read-only and does not call an LLM.",
    inputSchema: explainBatchSchema.shape,
  },
  async ({ batchId, messageLimit }) => {
    return handleExplainBatch({ batchId, messageLimit });
  },
);

async function main() {
  initDatabase();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("tg-sentiment-trader MCP server started");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("MCP server failed:", err);
    closeDatabase();
    process.exit(1);
  });
}
