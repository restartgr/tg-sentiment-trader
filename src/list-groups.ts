import { Api } from "telegram";
import { createTelegramClient, readSessionString } from "./telegram-utils";

function formatTargetId(entity: any): string {
  const rawId = entity?.id?.toString?.();
  if (!rawId) return "";

  if (entity instanceof Api.Channel) return `-100${rawId}`;
  return rawId;
}

function getType(entity: any, dialog: any): string {
  if (entity instanceof Api.Channel) {
    if (entity.megagroup) return "supergroup";
    if (entity.broadcast) return "channel";
    return "channel/group";
  }
  if (entity instanceof Api.Chat) return "group";
  return dialog.isGroup ? "group" : "unknown";
}

async function main() {
  if (!readSessionString()) {
    console.error("❌ 未找到 session，请先运行: pnpm auth");
    process.exit(1);
  }

  const client = createTelegramClient();
  await client.connect();

  const dialogs = await client.getDialogs({ limit: 500 });
  const groups = dialogs
    .map((dialog) => {
      const entity = dialog.entity;
      return {
        title: dialog.title ?? dialog.name ?? "",
        username: "username" in (entity as any) ? (entity as any).username : "",
        id: formatTargetId(entity),
        type: getType(entity, dialog),
        isGroup: dialog.isGroup,
        isChannel: dialog.isChannel,
      };
    })
    .filter((item) => item.id && (item.isGroup || item.isChannel))
    .sort((a, b) => a.title.localeCompare(b.title));

  console.log("可用于 TG_TARGET_GROUPS 的群组/频道：\n");

  for (const item of groups) {
    const target = item.username ? item.username : item.id;
    console.log(`- ${item.title}`);
    console.log(`  type: ${item.type}`);
    console.log(`  target: ${target}`);
    console.log(`  id: ${item.id}`);
    if (item.username) console.log(`  username: ${item.username}`);
    console.log("");
  }

  console.log("复制 target 到 .env，例如：");
  console.log("TG_TARGET_GROUPS=groupusername,-1001234567890");

  await client.disconnect();
}

main().catch((err) => {
  console.error("列出群组失败:", err);
  process.exit(1);
});
