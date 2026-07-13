import { TelegramClient } from "telegram";
import { Api } from "telegram";
import { StringSession } from "telegram/sessions";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";

dayjs.extend(utc);
dayjs.extend(timezone);

dotenv.config();

export const SESSION_FILE = path.join(process.cwd(), "session.txt");

const JST_TZ = "Asia/Tokyo";
const DAY_MS = 24 * 60 * 60 * 1000;
// 交易时段：09:00–15:00 JST。
const DEFAULT_OPEN_MIN = 9 * 60;
const DEFAULT_CLOSE_MIN = 15 * 60;

export function readSessionString(): string {
  if (!fs.existsSync(SESSION_FILE)) return "";
  return fs.readFileSync(SESSION_FILE, "utf-8").trim();
}

export function createTelegramClient(): TelegramClient {
  const session = readSessionString();
  if (!session) {
    throw new Error("未找到 session，请先运行: pnpm auth");
  }

  const apiId = Number.parseInt(requireEnv("TG_API_ID"), 10);
  if (Number.isNaN(apiId)) {
    throw new Error("Invalid integer env variable: TG_API_ID");
  }

  return new TelegramClient(
    new StringSession(session),
    apiId,
    requireEnv("TG_API_HASH"),
    { connectionRetries: 5 },
  );
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env variable: ${key}`);
  return value;
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

// 判断是否是自己发的消息：优先用 Telegram 的 out 标记，退回比对 senderId。
export function isOwnMessage(
  message: Pick<Api.Message, "out" | "senderId">,
  myUserId: number,
): boolean {
  if (message.out) return true;
  const senderId = message.senderId?.toString();
  return senderId != null && senderId === myUserId.toString();
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

// 当前时刻所在「JST 自然日」的 00:00，返回该瞬间的真实 UTC 时间。
export function todayJSTStart(): Date {
  return dayjs().tz(JST_TZ).startOf("day").toDate();
}

export function todayJSTRange(): { start: number; end: number } {
  const start = todayJSTStart().getTime();
  return { start, end: start + DAY_MS };
}

export function formatJSTDateLabel(dayStartMs: number): string {
  return dayjs(dayStartMs).tz(JST_TZ).format("YYYY/MM/DD");
}

export function formatJSTTime(unixSec: number): string {
  return dayjs.unix(unixSec).tz(JST_TZ).format("HH:mm");
}

export function inJSTTradingHours(
  unixSec: number,
  openMin = DEFAULT_OPEN_MIN,
  closeMin = DEFAULT_CLOSE_MIN,
): boolean {
  const jst = dayjs.unix(unixSec).tz(JST_TZ);
  const min = jst.hour() * 60 + jst.minute();
  return min >= openMin && min < closeMin;
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
