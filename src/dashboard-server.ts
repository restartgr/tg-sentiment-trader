import { readFile } from "node:fs/promises";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import dotenv from "dotenv";
import { getBatchById, getDatabaseStats, initDatabase } from "./db";
import { getDashboardBatch, listDashboardBatches } from "./dashboard-data";
import { runAgent } from "./agent-service";
import type { TraceEvent } from "./agent-trace";

dotenv.config();

async function getRunTrace(runId: string): Promise<TraceEvent[] | null> {
  const traceFile = path.join(
    process.cwd(),
    "data",
    "traces",
    `${runId}.jsonl`,
  );
  try {
    const text = await readFile(traceFile, "utf8");
    return text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TraceEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function createDashboardServer() {
  initDatabase();
  const app = new Hono();
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.get("/api/stats", (c) => c.json(getDatabaseStats()));
  app.get("/api/batches", (c) => {
    const numberLimit = Number(c.req.query("limit") ?? 50);
    if (
      !Number.isSafeInteger(numberLimit) ||
      numberLimit < 1 ||
      numberLimit > 100
    ) {
      return c.json({ error: "limit 必须是 1 到 100 之间的正整数" }, 400);
    }
    return c.json(listDashboardBatches(numberLimit));
  });

  app.get("/api/batches/:id", (c) => {
    const batchId = Number(c.req.param("id"));
    if (!Number.isSafeInteger(batchId) || batchId < 1) {
      return c.json({ error: "批次 ID 必须是正整数" }, 400);
    }
    const result = getDashboardBatch(batchId);
    if (!result) return c.json({ error: "找不到批次" }, 404);
    return c.json(result);
  });

  app.get("/api/runs/:runId", async (c) => {
    const runId = c.req.param("runId");
    if (!/^[a-f\d-]{36}$/.test(runId)) {
      return c.json({ error: "runId 格式错误" }, 400);
    }
    const events = await getRunTrace(runId);
    if (!events) return c.json({ error: "找不到运行记录" }, 404);
    return c.json({ runId, events });
  });

  app.post(
    "/api/ask",
    bodyLimit({
      maxSize: 8_192,
      onError: (c) => c.json({ error: "问题太长" }, 413),
    }),
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "请求必须是 JSON" }, 400);
      }
      const question =
        body && typeof body === "object" && "question" in body
          ? body.question
          : undefined;
      if (typeof question !== "string" || !question.trim()) {
        return c.json({ error: "请提供 question 字符串" }, 400);
      }
      if (question.length > 2_000) {
        return c.json({ error: "问题最多 2000 字" }, 400);
      }
      const result = await runAgent(question.trim(), {
        signal: c.req.raw.signal,
      });
      const inspectedBatches = result.inspectedBatchIds.flatMap((id) => {
        const batch = getBatchById(id);
        return batch ? [{
          id: batch.id,
          summary: batch.summary,
          url: `/?batch=${batch.id}`,
        }] : [];
      });
      return c.json({ ...result, inspectedBatches });
    },
  );

  app.notFound((c) => c.json({ error: "找不到接口" }, 404));
  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: "服务端处理失败，请查看终端日志" }, 500);
  });

  app.get("/", serveStatic({ path: "./web/dist/index.html" }));
  app.use("/assets/*", serveStatic({ root: "./web/dist" }));

  return app;
}

if (require.main === module) {
  const port = Number(process.env.DASHBOARD_PORT ?? 3000);
  const app = createDashboardServer();
  serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
    console.log(`Dashboard API: http://127.0.0.1:${port}`);
  });
}
