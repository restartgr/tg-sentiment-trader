#!/usr/bin/env python3
"""TG 股票群聊天记录情绪分析（简单 demo）。"""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

POSITIVE_KEYWORDS = (
    "看多",
    "上涨",
    "突破",
    "利好",
    "买入",
    "加仓",
    "bull",
    "long",
    "buy",
    "moon",
)

NEGATIVE_KEYWORDS = (
    "看空",
    "下跌",
    "暴跌",
    "利空",
    "卖出",
    "减仓",
    "bear",
    "short",
    "sell",
    "风险",
)

LINE_RE = re.compile(r"^\[(?P<timestamp>[^\]]+)\]\s*(?P<user>[^:]+):\s*(?P<text>.+)$")
TICKER_RE = re.compile(r"\$([A-Za-z]{1,6})|\b([A-Za-z]{2,6})\b|\b(\d{6})\b")


def parse_chat_line(line: str) -> dict[str, str] | None:
    line = line.strip()
    if not line:
        return None
    match = LINE_RE.match(line)
    if match:
        return match.groupdict()
    return {"timestamp": "unknown", "user": "unknown", "text": line}


def sentiment_score(text: str) -> int:
    text_lower = text.lower()
    positive = sum(1 for keyword in POSITIVE_KEYWORDS if keyword in text_lower)
    negative = sum(1 for keyword in NEGATIVE_KEYWORDS if keyword in text_lower)
    return positive - negative


def sentiment_label(score: int) -> str:
    if score > 0:
        return "positive"
    if score < 0:
        return "negative"
    return "neutral"


def extract_tickers(text: str) -> list[str]:
    tickers: list[str] = []
    for match in TICKER_RE.finditer(text):
        token = match.group(1) or match.group(2) or match.group(3)
        if not token:
            continue
        if token.isalpha() and token.lower() in {"bull", "bear", "long", "short", "buy", "sell"}:
            continue
        tickers.append(token.upper())
    return list(dict.fromkeys(tickers))


def analyze_messages(lines: list[str]) -> dict:
    parsed_messages = [item for item in (parse_chat_line(line) for line in lines) if item]

    by_user = defaultdict(lambda: {"messages": 0, "score": 0})
    by_ticker = defaultdict(lambda: {"mentions": 0, "score": 0})

    scored_messages = []
    total_score = 0
    for message in parsed_messages:
        text = message["text"]
        score = sentiment_score(text)
        label = sentiment_label(score)
        tickers = extract_tickers(text)

        scored_messages.append(
            {
                **message,
                "score": score,
                "sentiment": label,
                "tickers": tickers,
            }
        )

        total_score += score
        by_user[message["user"]]["messages"] += 1
        by_user[message["user"]]["score"] += score

        for ticker in tickers:
            by_ticker[ticker]["mentions"] += 1
            by_ticker[ticker]["score"] += score

    return {
        "summary": {
            "messages": len(scored_messages),
            "total_score": total_score,
            "overall_sentiment": sentiment_label(total_score),
        },
        "by_user": dict(by_user),
        "by_ticker": dict(by_ticker),
        "messages": scored_messages,
    }


def load_lines_from_file(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").splitlines()


def main() -> None:
    parser = argparse.ArgumentParser(description="TG 股票群聊天记录情绪分析 demo")
    parser.add_argument("--input", type=Path, help="聊天记录文件路径（每行一条）")
    parser.add_argument("--pretty", action="store_true", help="格式化输出 JSON")
    args = parser.parse_args()

    if args.input:
        lines = load_lines_from_file(args.input)
    else:
        lines = [
            "[2026-04-16 09:31] Alice: 000001 今天突破了，我看多，准备加仓",
            "[2026-04-16 09:33] Bob: TSLA 这波有风险，先减仓，短线看空",
            "[2026-04-16 09:35] Carol: AAPL 利好消息出来了，buy buy!",
        ]

    result = analyze_messages(lines)
    if args.pretty:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
