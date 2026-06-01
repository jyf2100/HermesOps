"""Shared secret sanitization — used by log_collector and alert_engine."""
from __future__ import annotations

import re

SECRET_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"(sk-[a-zA-Z0-9]{20,})", re.IGNORECASE),
    re.compile(r"(api[_-]?key\s*[=:]\s*)\S+", re.IGNORECASE),
    re.compile(r"(token\s*[=:]\s*)\S+", re.IGNORECASE),
    re.compile(r"(bearer\s+)\S+", re.IGNORECASE),
    re.compile(r"(password\s*[=:]\s*)\S+", re.IGNORECASE),
]


def sanitize_secrets(text: str, max_length: int = 500) -> str:
    """Replace secret patterns with <redacted> and truncate."""
    for pattern in SECRET_PATTERNS:
        text = pattern.sub(r"\1<redacted>", text)
    return text[:max_length]
