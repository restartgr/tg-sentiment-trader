import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "path";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();
const MAX_STEPS = 5;
const client = new Client({
  name: "tg-sentiment-agent",
  version: "0.1.0",
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    path.join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
    "src/mcp-server.ts",
  ],
  cwd: process.cwd(),
  stderr: "inherit",
});

async function main() {
  const question = process.argv.slice(2).join(" ").trim();

  if (!question) {
    throw new Error("请提供问题");
  }
  console.log(`用户的问题是: ${question}`);
  // TODO 1：连接 MCP server
  try {
    await client.connect(transport);
    // TODO 2：获取 tools
    const { tools } = await client.listTools();
    const toolsName = tools.map((item) => item.name);
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("请输入openai passkey");
    }
    const openai = new OpenAI({
      apiKey,
    });

    const functionTools: OpenAI.Responses.FunctionTool[] = tools.map(
      (tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        type: "function",
        strict: false,
      }),
    );

    type ToolTextContent = {
      type: "text";
      text: string;
    };

    let nextInput: string | OpenAI.Responses.ResponseInput = question;
    let previousResponseId: string | undefined;

    for (let step = 0; step < MAX_STEPS; step++) {
      console.log(`Agent step: ${step + 1}`);

      const response: OpenAI.Responses.Response =
        await openai.responses.create({
          model: "gpt-5.6-sol",
          input: nextInput,
          previous_response_id: previousResponseId,
          tools: functionTools,
          parallel_tool_calls: false,
          reasoning: {
            effort: "low",
          },
          store: true,
        });

      const functionCall = response.output.find(
        (
          item,
        ): item is OpenAI.Responses.ResponseFunctionToolCall =>
          item.type === "function_call",
      );

      if (!functionCall) {
        console.log(`llm的结果是：${response.output_text}`);
        return;
      }

      if (!toolsName.includes(functionCall.name)) {
        throw new Error(`找不到对应的tool: ${functionCall.name}`);
      }

      const toolResult = await client.callTool({
        name: functionCall.name,
        arguments: JSON.parse(functionCall.arguments),
      });
      const content = toolResult.content as ToolTextContent[];
      const text = content.map((item) => item.text).join("\n");

      nextInput = [
        {
          type: "function_call_output",
          call_id: functionCall.call_id,
          output: text,
        },
      ];
      previousResponseId = response.id;
    }

    throw new Error(`Agent 超过最大执行步数: ${MAX_STEPS}`);
  } finally {
    // TODO 4：关闭连接
    await client.close();
  }
}

main().catch(console.error);
