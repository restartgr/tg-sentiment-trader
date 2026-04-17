import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import input from "input";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const SESSION_FILE = path.join(process.cwd(), "session.txt");

async function main() {
  if (fs.existsSync(SESSION_FILE)) {
    fs.unlinkSync(SESSION_FILE);
    console.log("🗑️ 已删除旧的 session.txt，重新登录中...");
  }

  const apiId = parseInt(process.env.TG_API_ID!);
  const apiHash = process.env.TG_API_HASH!;

  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 1,
  });

  await client.start({
    phoneNumber: async () => await input.text("手机号（含区号，如 +81...）："),
    password: async () => await input.text("两步验证密码（没有直接回车）："),
    phoneCode: async () => await input.text("验证码："),
    onError: (err) => console.error("登录错误:", err),
  });

  const session = client.session.save() as unknown as string;
  fs.writeFileSync(SESSION_FILE, session, "utf-8");
  console.log("✅ 登录成功，session 已保存到 session.txt");
  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("登录失败:", err);
  process.exit(1);
});
