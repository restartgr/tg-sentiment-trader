import unittest

from demo import analyze_messages, parse_chat_line, sentiment_score


class DemoTests(unittest.TestCase):
    def test_parse_chat_line(self):
        line = "[2026-04-16 09:31] Alice: 000001 今天突破了，我看多，准备加仓"
        parsed = parse_chat_line(line)
        self.assertEqual(parsed["timestamp"], "2026-04-16 09:31")
        self.assertEqual(parsed["user"], "Alice")
        self.assertIn("看多", parsed["text"])

    def test_sentiment_score(self):
        self.assertGreater(sentiment_score("利好，上涨，buy"), 0)
        self.assertLess(sentiment_score("利空，下跌，sell"), 0)

    def test_analyze_messages(self):
        lines = [
            "[2026-04-16 09:31] Alice: 000001 看多 买入",
            "[2026-04-16 09:33] Bob: TSLA 看空 卖出",
            "[2026-04-16 09:35] Alice: AAPL 利好 buy",
        ]
        result = analyze_messages(lines)
        self.assertEqual(result["summary"]["messages"], 3)
        self.assertIn("Alice", result["by_user"])
        self.assertIn("000001", result["by_ticker"])
        self.assertIn("TSLA", result["by_ticker"])


if __name__ == "__main__":
    unittest.main()
