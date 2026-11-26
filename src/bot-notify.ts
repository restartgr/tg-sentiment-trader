// 实时告警出口：配置了 TELEGRAM_BOT_TOKEN 就用自建 bot 私聊推给自己（手机会响），
// 否则退回「已保存消息」。两者都只发给自己，不会进任何群。
import { TelegramClient } from "telegram";
import { sendToSavedMessages } from "./telegram-utils";

const TG_MESSAGE_LIMIT = 4096;

export interface BotTarget {
  token: string;
  chatId: string;
}

export async function sendViaBot(
  target: BotTarget,
  text: string,
  options: { silent?: boolean } = {},
): Promise<void> {
  const res = await fetch(
    `https://api.telegram.org/bot${target.token}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: target.chatId,
        text: text.slice(0, TG_MESSAGE_LIMIT),
        disable_web_page_preview: true,
        disable_notification: options.silent ?? false,
      }),
    },
  );
  if (!res.ok) {
    // 只带 Telegram 返回的描述，不把含 token 的 URL 写进错误。
    const body = (await res.json().catch(() => ({}))) as {
      description?: string;
    };
    throw new Error(
      `Bot API sendMessage 失败: ${res.status} ${body.description ?? ""}`.trim(),
    );
  }
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
