# tg-sentiment-trader

监控 Telegram 散户投机群的聊天记录，用大模型做**群体情绪分析**，作为反向交易（contrarian）的参考信号。

所有分析结果**只发送到你自己的 Telegram「已保存消息」（Saved Messages），绝不发到群里** —— 纯只读监控，不会在群内留下任何痕迹。

## 核心：四档情绪分析漏斗

实时监控按每 `SENTIMENT_BATCH_SIZE`(默认 20) 条消息触发一次。先用一次轻量评分（不调行情）打分，再按**情绪绝对值**决定分析深度，逐级递增成本：

| 情绪绝对值 | 档位 | 分析内容 | 调实时行情 | 单票分析 |
|---|---|---|---|---|
| `< 0.5` | 轻量 | 仅情绪总览（分数 + 一句点评） | ❌ | ❌ |
| `0.5 ~ 0.6` | 🔍 简单分析 | 深度情绪剖析（分歧/群体行为/Top资产） | ❌ | ❌ |
| `0.6 ~ 0.65` | 👀 进入监控区 | 深度剖析 + 行情视角（斐波那契/ORB） | ✅ | ❌ |
| `>= 0.65` | 🔥 主要监控 | 上面全部 + Top3 资产逐个单票分析 | ✅ | ✅ |

> 阈值都可在 `.env` 调（见下方配置）。轻量评分负责决定是否进入复核；深度分析完成后会按最终分数重新确认档位，避免低分结果误挂监控区。

行情上下文走 Yahoo Finance（实时报价 / 斐波那契回撤 / ORB 开盘区间 / 新闻），全程带缓存和失败降级；取不到数据时会明确约束模型**不许编造价位**。

## 独立日报脚本

除了实时监控，还有两条互相独立的按需分析命令（同样只发到「已保存消息」）：

- **`pnpm panic`** — 👻 鬼叫指数日报：区分交易鬼叫与全群烈度，结合真实大盘行情给出稳定性评分和条件式行情推演。
- **`pnpm summary`** — 📋 今日综合总结：一次性分析当天 JST 09:00 至执行时刻的全部群消息，并结合配置的大盘行情总结普通讨论、情绪和市场状态；不包含鬼叫指数或个股详情。

## 快速开始

```bash
pnpm install

# 1. 配置环境变量
cp .env.example .env   # 然后填入你的凭证（见下）

# 2. 登录 Telegram（首次，会让你输手机号/验证码，session 存到 session.txt）
pnpm auth

# 3.（可选）列出你加入的群，方便拿到群 username / chat id
pnpm list-groups

# 4.（可选）提前初始化 SQLite；启动监控时也会自动初始化
pnpm init-db

# 5. 启动实时监控
pnpm start          # 或 pnpm dev（带热重载）
```

## 数据持久化

监控数据保存在本地 SQLite 文件 `data/tg-sentiment.db`，不需要单独启动数据库服务。当前包含三张核心表：

- `messages`：每条 Telegram 原始消息，使用 `group_id + tg_message_id` 去重。
- `batches`：一次情绪分析的分数、档位、摘要、结果和状态。
- `batch_messages`：记录一次分析具体使用了哪些消息。

消息到达后会先写入 `messages`，再进入内存 batch。原始消息通过 Telegram ID 幂等写入，不会因为重启而重复；每次启动会为当天全部消息新增一次 `preheat` 总结快照，启动后的实时消息才按 batch size 分析。`data/` 默认不会提交到 Git。

不需要手写 SQL 就能检查数据库：

```bash
pnpm db:inspect
```

该命令通过 `db.ts` 的查询函数显示数据量、最近消息和最近分析批次。查询层目前提供：

- `getRecentMessages()`：读取最近消息。
- `searchMessages()`：按群组、关键词和时间范围搜索。
- `getBatchesInRange()`：读取指定范围的分析结果。
- `getDatabaseStats()`：统计消息、批次和关联数量。

## MCP 查询入口

项目提供了一个最小 MCP server，用来把本地 SQLite 里的情绪记忆暴露给 agent 查询：

```bash
pnpm mcp
```

当前只注册了一个只读 tool：

- `query_recent_sentiment`：返回最近的情绪分析批次，默认 5 条，最多 20 条；可选传入 `groupId` 过滤群组。

这个 MCP server 只读取本地数据库，不连接 Telegram，也不会调用大模型。后续可以按同样模式继续添加 `search_messages`、`query_batches`、`explain_batch` 等查询工具。

### 资产俗称映射（可选但推荐）

把群里对资产的叫法映射到正式代码，能显著提升识别和行情命中率。复制 `assets.demo.json` 为 `assets.json` 并按需修改（存在 `assets.json` 时优先用它，否则回退到 demo）：

```json
[
  { "nickname": "苹果", "aliases": ["aapl", "apple"], "name": "Apple", "ticker": "AAPL", "exchange": "NASDAQ" },
  { "nickname": "纳指", "aliases": ["nq", "纳斯达克期货"], "name": "NASDAQ 100 Futures", "ticker": "NQ", "exchange": "CME" }
]
```

`exchange` 支持自动映射到 Yahoo 代码：东京/TSE → `.T`、韩国/KRX → `.KS`、CME 期货 `NQ`/`ES` → `=F`。

## 环境变量

| 变量 | 说明 |
|---|---|
| `TG_API_ID` / `TG_API_HASH` | Telegram API 凭证，从 https://my.telegram.org 获取 |
| `TG_TARGET_GROUPS` | 要监控的群组，逗号分隔。推荐用 username 或数字 chat id（invite link 会过期） |
| `TG_MY_USER_ID` | 你自己的 Telegram User ID（发消息给 @userinfobot 获取） |
| `ANTHROPIC_API_KEY` | Anthropic API Key（必填） |
| `MODEL_LIGHT` / `MODEL_DEEP` | 模型分层（可选）：light 跑高频轻量评分，deep 跑深度分析（两者默认均为 `claude-sonnet-4-6`；Haiku 首轮评分偏差大，省钱可把 light 改回 `claude-haiku-4-5`） |
| `SENTIMENT_BATCH_SIZE` | 每多少条消息分析一次（默认 20） |
| `SIMPLE_ANALYSIS_MIN_ABS_SCORE` | 简单分析档下限（默认 0.5）：`>=` 进入深度分析但不调行情 |
| `MONITOR_MIN_ABS_SCORE` | 监控档下限（默认 0.6）：`>=` 的深度分析会调取实时行情 |
| `ASSET_DETAIL_MIN_ABS_SCORE` | 单票分析下限（默认 0.65）：`>=` 才逐个跑 Top 资产单票分析 |
| `ASSET_DETAIL_COUNT` | 单票分析数量（默认 3） |
| `REPORT_BENCHMARKS` | `pnpm summary` 固定分析的大盘 Yahoo Finance symbol，逗号分隔（默认 `^N225`） |

完整示例见 [.env.example](.env.example)。

## 命令一览

| 命令 | 作用 |
|---|---|
| `pnpm auth` | 登录 Telegram，生成 `session.txt` |
| `pnpm list-groups` | 列出已加入的群组及其 id |
| `pnpm start` / `pnpm dev` | 启动实时情绪监控（`dev` 带热重载） |
| `pnpm init-db` | 初始化本地 SQLite 数据库 |
| `pnpm db:inspect` | 查看 SQLite 数据概览、最近消息和分析批次 |
| `pnpm summary` | 生成今天 JST 09:00 至当前的群聊综合总结和大盘分析 |
| `pnpm panic` | 生成鬼叫指数日报 |
| `pnpm build` | TypeScript 编译到 `dist/` |

## 设计原则

- **只读、只发给自己**：唯一的发送出口是 `sendToSavedMessages`（→ Telegram `"me"`），是刻意设的安全边界，分析输出不会进任何群。
- **只描述情绪，不评判人**：prompt 明确禁止评价群成员的能力/智商/性格，只客观描述情绪状态、强度和变化。
- **不编造行情**：行情数据取不到时，强制模型降级为「数据不足/观望」，不许生成支撑位、压力位、目标价等具体价位。

> ⚠️ 仅供情绪研究参考，**不构成任何投资建议**。
