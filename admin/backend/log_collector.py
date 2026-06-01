"""Periodic log collector — collects pod logs from all running agents."""
from __future__ import annotations

import asyncio
import csv
import hashlib
import logging
import os
import re
import tempfile
import time
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import delete, desc, func, select

from agent_manager import AgentManager
from database import AsyncSessionLocal
from db_models import LogEntry
from models import (
    LogEntryResponse,
    LogSearchRequest,
    LogSearchResponse,
    LogStatsAgent,
    LogStatsResponse,
)
from sanitize import sanitize_secrets
from templates import deployment_name

logger = logging.getLogger("hermes-admin.log_collector")

COLLECT_INTERVAL = int(os.environ.get("LOG_COLLECT_INTERVAL_SECONDS", "30"))
LOG_RETENTION_DAYS = int(os.environ.get("LOG_RETENTION_DAYS", "7"))
CONCURRENCY = 3
MAX_EXPORT_ROWS = 10000

# Level detection patterns
_LEVEL_PATTERNS = [
    (re.compile(r"\b(ERROR|CRITICAL|FATAL)\b", re.IGNORECASE), "ERROR"),
    (re.compile(r"\b(WARN|WARNING)\b", re.IGNORECASE), "WARN"),
    (re.compile(r"\b(INFO)\b", re.IGNORECASE), "INFO"),
    (re.compile(r"\b(DEBUG|TRACE)\b", re.IGNORECASE), "DEBUG"),
]

_ERROR_KEYWORDS = re.compile(
    r"\b(Error|Exception|Traceback|CRITICAL|FATAL|OOMKilled|Panic)\b",
)

_CSV_DANGEROUS_PREFIX = re.compile(r'^[=+\-@\t\r]')


def _sanitize_csv_cell(value: str) -> str:
    """Prevent CSV injection by prefixing dangerous characters with a tab."""
    if value and _CSV_DANGEROUS_PREFIX.match(value):
        return f"\t{value}"
    return value

class LogCollector:
    def __init__(self, manager: AgentManager) -> None:
        self._manager = manager
        self._shutdown_event = asyncio.Event()
        self._last_collected: dict[int, datetime] = {}  # agent_number -> last collected timestamp
        self._last_cleanup_at = 0.0
        self._last_batch_hashes: dict[int, set[str]] = {}  # agent -> set of content hashes from last batch

    async def run_periodic(self) -> None:
        """Background loop: collect logs every COLLECT_INTERVAL seconds."""
        await asyncio.sleep(10)  # Initial delay
        while not self._shutdown_event.is_set():
            try:
                await self._collect_batch()
            except Exception:
                logger.exception("Log collection batch failed")
            try:
                await asyncio.wait_for(
                    self._shutdown_event.wait(), timeout=COLLECT_INTERVAL
                )
            except asyncio.TimeoutError:
                pass

    async def _collect_batch(self) -> None:
        """Collect logs from all running agents."""
        agents = await self._discover_agents()
        if not agents:
            return

        semaphore = asyncio.Semaphore(CONCURRENCY)
        tasks = [self._collect_one(agent, semaphore) for agent in agents]
        await asyncio.gather(*tasks)

        # Prune stale agent tracking data
        active_ids = {a.id for a in agents}
        for stale_id in list(self._last_batch_hashes.keys()):
            if stale_id not in active_ids:
                del self._last_batch_hashes[stale_id]
                self._last_collected.pop(stale_id, None)

        await self._maybe_cleanup()

    async def _discover_agents(self) -> list:
        resp = await self._manager.list_agents()
        return [a for a in resp.agents if a.status.value == "running"]

    async def _collect_one(self, agent, semaphore: asyncio.Semaphore) -> None:
        async with semaphore:
            aid = agent.id
            try:
                # Calculate since_seconds for incremental collection
                since_seconds: int | None = None
                if aid in self._last_collected:
                    delta = datetime.now(timezone.utc) - self._last_collected[aid]
                    since_seconds = max(int(delta.total_seconds()), 1)

                name = deployment_name(aid)
                pod_log = await self._manager.k8s.get_pod_log(
                    name,
                    since_seconds=since_seconds,
                    tail_lines=500,
                )

                if not pod_log:
                    return

                lines = pod_log.strip().split("\n")
                batch_id = str(uuid4())
                new_entries: list[dict] = []

                # Get last batch hashes for dedup
                last_hashes = self._last_batch_hashes.get(aid, set())
                current_hashes: set[str] = set()

                for line in lines:
                    line = line.strip()
                    if not line:
                        continue

                    content_hash = hashlib.sha256(line.encode()).hexdigest()[:16]
                    current_hashes.add(content_hash)

                    # Skip if seen in last batch
                    if content_hash in last_hashes:
                        continue

                    level = self._detect_level(line)
                    is_error = bool(_ERROR_KEYWORDS.search(line))
                    sanitized = sanitize_secrets(line, max_length=4000)

                    new_entries.append(
                        {
                            "batch_id": batch_id,
                            "agent_number": aid,
                            "content_hash": content_hash,
                            "content": sanitized,
                            "level": level,
                            "is_error": is_error,
                        }
                    )

                if new_entries:
                    async with AsyncSessionLocal() as session:
                        await session.execute(LogEntry.__table__.insert(), new_entries)
                        await session.commit()

                # Update tracking state
                self._last_batch_hashes[aid] = current_hashes
                self._last_collected[aid] = datetime.now(timezone.utc)

                logger.debug(
                    "Collected %d new log lines from agent %d",
                    len(new_entries),
                    aid,
                )

            except Exception:
                logger.debug(
                    "Failed to collect logs from agent %d", aid, exc_info=True
                )

    def _detect_level(self, line: str) -> str | None:
        for pattern, level in _LEVEL_PATTERNS:
            if pattern.search(line[:100]):  # Only check first 100 chars
                return level
        return None

    async def _maybe_cleanup(self) -> None:
        now = time.monotonic()
        if now - self._last_cleanup_at < 6 * 3600:  # Every 6 hours
            return
        self._last_cleanup_at = now
        try:
            async with AsyncSessionLocal() as session:
                cutoff = datetime.now(timezone.utc) - timedelta(
                    days=LOG_RETENTION_DAYS
                )
                await session.execute(
                    delete(LogEntry).where(LogEntry.collected_at < cutoff)
                )
                await session.commit()
                logger.info(
                    "Log cleanup completed (retention: %d days)", LOG_RETENTION_DAYS
                )
        except Exception:
            logger.exception("Log cleanup failed")

    # -- Search -----------------------------------------------------------------

    async def search(self, params: LogSearchRequest) -> LogSearchResponse:
        """Full-text search using pg_trgm GIN index + ILIKE."""
        start = time.monotonic()

        async with AsyncSessionLocal() as session:
            query = select(LogEntry)
            count_q = select(func.count()).select_from(LogEntry)

            # Filters
            if params.agents:
                query = query.where(LogEntry.agent_number.in_(params.agents))
                count_q = count_q.where(LogEntry.agent_number.in_(params.agents))
            if params.level:
                query = query.where(LogEntry.level == params.level)
                count_q = count_q.where(LogEntry.level == params.level)
            if params.time_from:
                query = query.where(LogEntry.collected_at >= params.time_from)
                count_q = count_q.where(LogEntry.collected_at >= params.time_from)
            if params.time_to:
                query = query.where(LogEntry.collected_at <= params.time_to)
                count_q = count_q.where(LogEntry.collected_at <= params.time_to)

            # Keyword search using pg_trgm GIN index
            if params.keywords:
                keyword_escaped = params.keywords.replace("%", "\\%").replace(
                    "_", "\\_"
                )
                like_expr = f"%{keyword_escaped}%"
                query = query.where(LogEntry.content.ilike(like_expr))
                count_q = count_q.where(LogEntry.content.ilike(like_expr))

            total = (await session.execute(count_q)).scalar() or 0

            offset = (params.page - 1) * params.page_size
            query = (
                query.order_by(desc(LogEntry.collected_at))
                .limit(params.page_size)
                .offset(offset)
            )
            result = await session.execute(query)
            entries = result.scalars().all()

            elapsed = (time.monotonic() - start) * 1000

            return LogSearchResponse(
                entries=[
                    LogEntryResponse(
                        id=e.id,
                        batch_id=str(e.batch_id),
                        agent_number=e.agent_number,
                        content=e.content,
                        level=e.level,
                        is_error=e.is_error,
                        collected_at=e.collected_at,
                    )
                    for e in entries
                ],
                total=total,
                page=params.page,
                page_size=params.page_size,
                elapsed_ms=round(elapsed, 1),
            )

    # -- Export -----------------------------------------------------------------

    async def export(self, params: LogSearchRequest) -> str:
        """Export search results as CSV file to /tmp."""
        search_result = await self.search(
            LogSearchRequest(
                keywords=params.keywords,
                agents=params.agents,
                level=params.level,
                time_from=params.time_from,
                time_to=params.time_to,
                page=1,
                page_size=MAX_EXPORT_ROWS,
            )
        )

        fd, path = tempfile.mkstemp(suffix=".csv", prefix="hermes-logs-")
        os.close(fd)  # Close immediately; reopen via path to avoid fd leak
        os.chmod(path, 0o600)
        try:
            with open(path, "w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow(["time", "agent", "level", "content"])
                for entry in search_result.entries:
                    writer.writerow(
                        [
                            entry.collected_at.isoformat(),
                            entry.agent_number,
                            entry.level or "",
                            _sanitize_csv_cell(entry.content),
                        ]
                    )
        except Exception:
            os.unlink(path)
            raise

        return path

    # -- Stats ------------------------------------------------------------------

    async def stats(self) -> LogStatsResponse:
        async with AsyncSessionLocal() as session:
            agent_stats_q = (
                select(
                    LogEntry.agent_number,
                    func.count().label("total"),
                    func.count()
                    .filter(LogEntry.is_error == True)  # noqa: E712
                    .label("errors"),
                    func.max(LogEntry.collected_at).label("last_collected"),
                )
                .group_by(LogEntry.agent_number)
                .order_by(LogEntry.agent_number)
            )
            result = await session.execute(agent_stats_q)
            rows = result.all()

            agents = [
                LogStatsAgent(
                    agent_number=r.agent_number,
                    total_count=r.total,
                    error_count=r.errors,
                    last_collected_at=r.last_collected,
                )
                for r in rows
            ]

            total_entries = sum(a.total_count for a in agents)
            total_errors = sum(a.error_count for a in agents)

            return LogStatsResponse(
                agents=agents,
                total_entries=total_entries,
                total_errors=total_errors,
                retention_days=LOG_RETENTION_DAYS,
            )

    def shutdown(self) -> None:
        self._shutdown_event.set()
