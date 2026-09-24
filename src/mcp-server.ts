import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
} from "./db";

function formatBatch(batch: StoredBatch) {
  return {
    id: batch.id,
    groupId: batch.groupId,
    startTime: batch.startTime,
    endTime: batch.endTime,
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

server.registerTool(
  "query_recent_sentiment",
  {
    title: "Query Recent Sentiment",
    description:
      "Return recent Telegram sentiment analysis batches from the local SQLite memory. This is read-only and does not call any LLM.",
    inputSchema: {
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
    },
  },
  async ({ limit, groupId }) => {
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
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "query_batches",
  {
    title: "Find Sentiment which meet the query",
    description:
      "Return Telegram sentiment analysis batches that meet the query from the local SQLite memory. This is read-only and does not call any LLM.",
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe(
          "Maximum number of recent batches to return. Defaults to 20.",
        ),
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
    },
  },
  async ({ limit, groupId, startTime, endTime, status }) => {
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
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "search_messages",
  {
    title: "search related messages",
    description:
      "Search historical Telegram messages in the local SQLite memory by keyword, group, or time range. This tool is read-only and does not call any LLM.",
    inputSchema: {
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
    },
  },
  async ({ groupId, query, startTime, endTime, limit }) => {
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
              messages,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "explain_batch",
  {
    title: "Explain Sentiment Batch",
    description:
      "Return a stored Telegram sentiment analysis batch and a limited set of its associated source messages by batch ID. Use this tool to inspect the evidence behind an existing analysis result. This tool is read-only and does not call an LLM.",
    inputSchema: {
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
    },
  },
  async ({ batchId, messageLimit }) => {
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
              batch,
              batchMessagesCount,
              sourceMessageCount,
              messages,
              truncated: sourceMessageCount < batchMessagesCount,
              sourceMessageIds,
            }),
          },
        ],
      };
    }
  },
);

async function main() {
  initDatabase();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("tg-sentiment-trader MCP server started");
}

main().catch((err) => {
  console.error("MCP server failed:", err);
  closeDatabase();
  process.exit(1);
});
