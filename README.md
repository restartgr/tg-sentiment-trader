# tg-sentiment-trader

监控 Telegram 散户投机群的聊天记录，用大模型做**群体情绪分析**，作为反向交易（contrarian）的参考信号。

所有分析结果**只发送到你自己的 Telegram「已保存消息」（Saved Messages），绝不发到群里** —— 纯只读监控，不会在群内留下任何痕迹。

## 核心：四档情绪分析漏斗

实时监控按每 `SENTIMENT_BATCH_SIZE`(默认 20) 条消息触发一次。先用一次轻量评分（不调行情）打分，再按**情绪绝对值**决定分析深度，逐级递增成本：

| 情绪绝对值 | 档位 | 分析内容 | 调实时行情 | 单票分析 |
|---|---|---|---|---|
| `< 0.6` | 轻量 | 仅情绪总览（分数 + 一句点评） | ❌ | ❌ |
| `0.6 ~ 0.65` | 🔍 简单分析 | 深度情绪剖析（分歧/群体行为/Top资产） | ❌ | ❌ |
| `0.65 ~ 0.75` | 👀 进入监控区 | 深度剖析 + 行情视角（斐波那契/ORB） | ✅ | ❌ |
| `>= 0.75` | 🔥 主要监控 | 上面全部 + Top3 资产逐个单票分析 | ✅ | ✅ |

> 阈值都可在 `.env` 调（见下方配置）。档位由**轻量评分**锁定，保证「是否调行情」和「是否做单票分析」始终一致。

行情上下文走 Yahoo Finance（实时报价 / 斐波那契回撤 / ORB 开盘区间 / 新闻），全程带缓存和失败降级；取不到数据时会明确约束模型**不许编造价位**。

## 独立日报脚本

除了实时监控，还有按需运行的日报（同样只发到「已保存消息」），分析当天 JST 交易时段（09:00–15:00，含盘中全程）的消息：

- **`pnpm panic`** — 👻 鬼叫指数日报：识别群里的恐慌/炫耀情绪爆发，给出市场稳定性评分和逆向建议。

## 快速开始

```bash
pnpm install

# 1. 配置环境变量
cp .env.example .env   # 然后填入你的凭证（见下）

# 2. 登录 Telegram（首次，会让你输手机号/验证码，session 存到 session.txt）
pnpm auth

# 3.（可选）列出你加入的群，方便拿到群 username / chat id
pnpm list-groups

# 4. 启动实时监控
pnpm start          # 或 pnpm dev（带热重载）
```

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
| `QIANWEN_API_KEY` / `ANTHROPIC_API_KEY` | 大模型 Key，二选一；都填则**千问优先**（qwen3-max），否则用 Claude |
| `SENTIMENT_BATCH_SIZE` | 每多少条消息分析一次（默认 20） |
| `SIMPLE_ANALYSIS_MIN_ABS_SCORE` | 简单分析档下限（默认 0.6）：`>=` 进入深度分析但不调行情 |
| `MONITOR_MIN_ABS_SCORE` | 监控档下限（默认 0.65）：`>=` 的深度分析会调取实时行情 |
| `ASSET_DETAIL_MIN_ABS_SCORE` | 单票分析下限（默认 0.75）：`>=` 才逐个跑 Top 资产单票分析 |
| `ASSET_DETAIL_COUNT` | 单票分析数量（默认 3） |

完整示例见 [.env.example](.env.example)。

## 命令一览

| 命令 | 作用 |
|---|---|
| `pnpm auth` | 登录 Telegram，生成 `session.txt` |
| `pnpm list-groups` | 列出已加入的群组及其 id |
| `pnpm start` / `pnpm dev` | 启动实时情绪监控（`dev` 带热重载） |
| `pnpm panic` | 生成鬼叫指数日报 |
| `pnpm build` | TypeScript 编译到 `dist/` |

## 设计原则

- **只读、只发给自己**：唯一的发送出口是 `sendToSavedMessages`（→ Telegram `"me"`），是刻意设的安全边界，分析输出不会进任何群。
- **只描述情绪，不评判人**：prompt 明确禁止评价群成员的能力/智商/性格，只客观描述情绪状态、强度和变化。
- **不编造行情**：行情数据取不到时，强制模型降级为「数据不足/观望」，不许生成支撑位、压力位、目标价等具体价位。

> ⚠️ 仅供情绪研究参考，**不构成任何投资建议**。
