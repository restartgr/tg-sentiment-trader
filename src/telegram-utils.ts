import { TelegramClient } from "telegram";
import { Api } from "telegram";
import { StringSession } from "telegram/sessions";
import fs from "fs";
import path from "path";
import { config } from "./config";

export const SESSION_FILE = path.join(process.cwd(), "session.txt");

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DEFAULT_OPEN_UTC_MIN = 1 * 60;
const DEFAULT_CLOSE_UTC_MIN = 6 * 60 + 30;

export function readSessionString(): string {
  if (!fs.existsSync(SESSION_FILE)) return "";
  return fs.readFileSync(SESSION_FILE, "utf-8").trim();
}

export function createTelegramClient(): TelegramClient {
  const session = readSessionString();
  if (!session) {
    throw new Error("未找到 session，请先运行: pnpm auth");
  }

  return new TelegramClient(
    new StringSession(session),
    config.telegram.apiId,
    config.telegram.apiHash,
    { connectionRetries: 5 },
  );
}

export async function resolveGroup(client: TelegramClient, group: string) {
  const inviteMatch = group.match(
    /(?:t\.me\/\+|t\.me\/joinchat\/)([A-Za-z0-9_-]+)/,
  );

  if (inviteMatch) {
    const hash = inviteMatch[1];
    try {
      const result = await client.invoke(
        new Api.messages.CheckChatInvite({ hash }),
      );
      if (result instanceof Api.ChatInviteAlready) return result.chat;
      if (result instanceof Api.ChatInvite) {
        throw new Error(
          `群组 ${group} 尚未加入。请先手动加入该群，然后把 TG_TARGET_GROUPS 改成稳定的 username 或 chat id，不建议长期使用 invite link。`,
        );
      }
    } catch (e: any) {
      if (e.errorMessage === "INVITE_REQUEST_SENT") {
        throw new Error(`群组 ${group} 需要管理员审核`);
      }
      if (e.errorMessage === "INVITE_HASH_EXPIRED") {
        throw new Error(
          `群组邀请链接已过期：${group}。invite link 不适合长期监控，请改用群 username 或数字 chat id。`,
        );
      }
      throw e;
    }
  }

  const asNum = Number.parseInt(group, 10);
  if (!Number.isNaN(asNum)) return client.getEntity(asNum);
  return client.getEntity(group);
}

export function normalizeTelegramId(id: string): string {
  return id.replace(/^-100/, "");
}

// Safety boundary: analysis/report output must only go to Saved Messages.
export async function sendToSavedMessages(
  client: TelegramClient,
  message: string,
): Promise<void> {
  await client.sendMessage("me", { message });
}

export async function getSenderName(
  message: Pick<Api.Message, "getSender">,
): Promise<string> {
  const sender = await message.getSender();
  if (!sender) return "匿名";
  if ("username" in sender && sender.username) return sender.username;
  if ("firstName" in sender && sender.firstName) return sender.firstName;
  return "匿名";
}

export function todayJSTStart(): Date {
  const now = new Date();
  const jstMidnight = new Date(now);
  jstMidnight.setUTCHours(15, 0, 0, 0);
  if (now.getUTCHours() < 15) {
    jstMidnight.setUTCDate(jstMidnight.getUTCDate() - 1);
  }
  return jstMidnight;
}

export function todayJSTRange(): { start: number; end: number } {
  const start = todayJSTStart().getTime();
  return { start, end: start + 24 * 60 * 60 * 1000 };
}

export function formatJSTDateLabel(dayStartMs: number): string {
  return new Date(dayStartMs + JST_OFFSET_MS).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function formatJSTTime(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleTimeString("zh-CN", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function inJSTTradingHours(
  unixSec: number,
  openUtcMin = DEFAULT_OPEN_UTC_MIN,
  closeUtcMin = DEFAULT_CLOSE_UTC_MIN,
): boolean {
  const d = new Date(unixSec * 1000);
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  return min >= openUtcMin && min < closeUtcMin;
}

export async function fetchMessagesSince(
  client: TelegramClient,
  entity: any,
  sinceMs: number,
  pageLimit = 100,
): Promise<Api.Message[]> {
  const allMessages: Api.Message[] = [];
  let offsetId = 0;

  while (true) {
    const batch = await client.getMessages(entity, {
      limit: pageLimit,
      offsetId,
    });
    if (batch.length === 0) break;

    allMessages.push(...batch);
    const oldest = batch[batch.length - 1];
    if (oldest.date * 1000 < sinceMs) break;
    offsetId = oldest.id;
  }

  return allMessages;
}
