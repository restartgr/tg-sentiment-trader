# tg-sentiment-trader

tg股票群聊天记录分析，简单的demo。

## 运行 demo

```bash
python demo.py --pretty
```

也可以传入自定义聊天记录文件（每行一条消息）：

```bash
python demo.py --input /path/to/chat.txt --pretty
```

聊天记录格式示例：

```text
[2026-04-16 09:31] Alice: 000001 今天突破了，我看多，准备加仓
[2026-04-16 09:33] Bob: TSLA 这波有风险，先减仓，短线看空
[2026-04-16 09:35] Carol: AAPL 利好消息出来了，buy buy!
```
