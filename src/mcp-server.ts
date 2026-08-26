import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  closeDatabase,
  getBatchesInRange,
  initDatabase,
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
