// 实时告警出口：配置了 TELEGRAM_BOT_TOKEN 就用自建 bot 私聊推给自己（手机会响），
// 否则退回「已保存消息」。两者都只发给自己，不会进任何群。
import net from "node:net";
import { TelegramClient } from "telegram";
import { sendToSavedMessages } from "./telegram-utils";

const TG_MESSAGE_LIMIT = 4096;

// Node 默认 happy eyeballs 每个地址只给 250ms 建连；服务器没有 IPv6、到 api.telegram.org
// 的 IPv4 握手偶尔超过 250ms，就会报 "fetch failed (ETIMEDOUT)"。放宽到 2 秒。
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);

export interface BotTarget {
  token: string;
  chatId: string;
}

// 通用 Bot API 调用。错误只带 Telegram 返回的描述，不把含 token 的 URL 写进错误。
export async function callBotApi<T = unknown>(
  target: Pick<BotTarget, "token">,
  method: string,
  payload: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.telegram.org/bot${target.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
    };
    if (!res.ok || !body.ok) {
      throw new Error(`Bot API ${method} 失败: ${res.status} ${body.description ?? ""}`.trim());
    }
    return body.result as T;
  } finally {
    clearTimeout(timer);
  }
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export async function sendViaBot(
  target: BotTarget,
  text: string,
  options: { silent?: boolean; buttons?: InlineButton[][] } = {},
): Promise<void> {
  await callBotApi(target, "sendMessage", {
    chat_id: target.chatId,
    text: text.slice(0, TG_MESSAGE_LIMIT),
    disable_web_page_preview: true,
    disable_notification: options.silent ?? false,
    ...(options.buttons ? { reply_markup: { inline_keyboard: options.buttons } } : {}),
  });
}

export interface CallbackQuery {
  id: string;
  from: { id: number };
  data?: string;
  message?: { message_id: number; chat: { id: number }; text?: string };
}

// 长轮询接收按钮回调。只处理来自 ownerId 的点击，其他人点了直接忽略。
export function startCallbackPoller(
  target: BotTarget,
  ownerId: string,
  handle: (query: CallbackQuery) => Promise<string>,
): void {
  let offset = 0;
  const loop = async () => {
    for (;;) {
      try {
        const updates = await callBotApi<{ update_id: number; callback_query?: CallbackQuery }[]>(
          target,
          "getUpdates",
          { offset, timeout: 30, allowed_updates: ["callback_query"] },
          40_000,
        );
        for (const u of updates) {
          offset = u.update_id + 1;
          const q = u.callback_query;
          if (!q) continue;
          if (String(q.from.id) !== ownerId) {
            await callBotApi(target, "answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});
            continue;
          }
          let reply: string;
          try {
            reply = await handle(q);
          } catch (err) {
            console.error("处理 bot 按钮回调失败:", err);
            reply = "处理失败，请看日志";
          }
          await callBotApi(target, "answerCallbackQuery", {
            callback_query_id: q.id,
            text: reply,
          }).catch((err) => console.error("answerCallbackQuery 失败:", err));
          if (q.message) {
            await callBotApi(target, "editMessageText", {
              chat_id: q.message.chat.id,
              message_id: q.message.message_id,
              text: `${q.message.text ?? ""}\n\n${reply}`.slice(0, TG_MESSAGE_LIMIT),
            }).catch((err) => console.error("editMessageText 失败:", err));
          }
        }
      } catch (err) {
        console.error("bot getUpdates 失败，5 秒后重试:", err instanceof Error ? err.message : err);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };
  void loop();
}

export async function sendAlert(
  client: TelegramClient,
  bot: BotTarget | null,
  text: string,
): Promise<void> {
  if (bot) {
    await sendViaBot(bot, text);
    return;
  }
  await sendToSavedMessages(client, text);
}
