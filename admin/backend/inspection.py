"""Agent health inspection engine — runs periodic batch checks."""
from __future__ import annotations

import asyncio
import logging
import os
import random
import re
import time
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import delete, desc, func, select, text

from agent_manager import AgentManager
from database import AsyncSessionLocal
from db_models import InspectionAnomaly, InspectionSnapshot
from models import InspectionCheckResult
from templates import deployment_name

logger = logging.getLogger("hermes-admin.inspection")

# ── Constants ──────────────────────────────────────────────────

DEFAULT_CPU_THRESHOLD_PCT = 90.0
DEFAULT_MEMORY_THRESHOLD_PCT = 90.0
DEFAULT_RESTART_THRESHOLD = 5
FLAPPING_SUPPRESSION_ROUNDS = 2
CLEANUP_INTERVAL_SECONDS = 6 * 3600
INSPECTION_INTERVAL = int(os.environ.get("INSPECTION_INTERVAL_SECONDS", "60"))

_IP_PORT_RE = re.compile(r"\d{1,3}(\.\d{1,3}){3}:\d+")
_K8S_DOMAIN_RE = re.compile(r"\S+\.svc\.cluster\.local\S*")


def _sanitize(msg: str) -> str:
    """Remove IP:port patterns and K8s internal domains, truncate to 200 chars."""
    cleaned = _IP_PORT_RE.sub("<ip>:<port>", msg)
    cleaned = _K8S_DOMAIN_RE.sub("<k8s-svc>", cleaned)
    return cleaned[:200]


# ── InspectionRunner ───────────────────────────────────────────


class InspectionRunner:
    """Periodic health inspection engine for all Hermes agents."""

    def __init__(self, manager: AgentManager) -> None:
        self._manager = manager
        self._lock = asyncio.Lock()
        self._shutdown_event = asyncio.Event()
        self._last_cleanup_at = 0.0
        self._consecutive_normal: dict[tuple[int, str], int] = {}

    # ── Background loop ────────────────────────────────────────

    async def run_periodic(self) -> None:
        """Background loop: sleep with jitter, then run batches until shutdown."""
        await asyncio.sleep(random.uniform(0, 10))
        while not self._shutdown_event.is_set():
            try:
                batch_id = await self.run_batch()
                logger.info("Inspection batch %s completed", batch_id)
            except Exception:
                logger.exception("Inspection batch failed")
            try:
                await asyncio.wait_for(self._shutdown_event.wait(), timeout=INSPECTION_INTERVAL)
            except asyncio.TimeoutError:
                pass

    # ── Single batch ───────────────────────────────────────────

    async def run_batch(self) -> str:
        """Run one full inspection cycle across all agents."""
        if self._lock.locked():
            raise RuntimeError("Inspection batch already in progress")

        async with self._lock:
            agents = await self._discover_agents()
            if not agents:
                logger.debug("No agents discovered, skipping batch")
                return str(uuid4())

            batch_id = str(uuid4())
            semaphore = asyncio.Semaphore(5)
            results: list[InspectionCheckResult] = await asyncio.gather(
                *[self._check_one(agent, semaphore) for agent in agents]
            )

            await self._persist_batch(batch_id, results)
            anomalies = self._collect_anomalies(results, batch_id)
            await self._persist_anomalies(batch_id, anomalies)
            await self._resolve_old_anomalies(results)
            await self._maybe_cleanup()

            return batch_id

    # ── Discovery ──────────────────────────────────────────────

    async def _discover_agents(self) -> list:
        """Fetch current agent list from K8s."""
        resp = await self._manager.list_agents()
        return resp.agents

    # ── Per-agent check ────────────────────────────────────────

    async def _check_one(
        self, agent, semaphore: asyncio.Semaphore
    ) -> InspectionCheckResult:
        """Inspect a single agent: health, resources, pod status."""
        async with semaphore:
            aid = agent.id
            result = InspectionCheckResult(agent_number=aid)

            # Health
            try:
                health = await self._manager.check_health(aid)
                result.health_ok = health.status == "ok"
                result.health_latency_ms = health.latency_ms
            except Exception as exc:
                result.health_ok = False
                result.error_message = _sanitize(str(exc))

            # Resource usage (cpu/memory)
            cpu_limit_cores: float | None = None
            memory_limit_bytes: int | None = None
            try:
                usage = await self._manager.get_resource_usage(aid)
                # Fetch limits from deployment spec
                try:
                    spec = await self._manager.get_resources(aid)
                    if spec:
                        parsed_cpu = AgentManager._parse_cpu(spec.cpu_limit)
                        cpu_limit_cores = parsed_cpu
                        parsed_mem = AgentManager._parse_memory(spec.memory_limit)
                        memory_limit_bytes = parsed_mem
                except Exception:
                    logger.debug("Failed to fetch resource spec for agent %s", aid, exc_info=True)

                if usage and usage.cpu_cores is not None and cpu_limit_cores and cpu_limit_cores > 0:
                    result.cpu_usage_pct = round(usage.cpu_cores / cpu_limit_cores * 100, 1)
                if usage and usage.memory_bytes is not None and memory_limit_bytes and memory_limit_bytes > 0:
                    result.memory_usage_pct = round(usage.memory_bytes / memory_limit_bytes * 100, 1)
                # Fix #13: store raw resource values for historical analysis
                if usage:
                    result.cpu_cores = usage.cpu_cores
                    result.memory_bytes = usage.memory_bytes
                result.cpu_limit_cores = cpu_limit_cores
                result.memory_limit_bytes = memory_limit_bytes
            except Exception:
                logger.debug("Failed to fetch resource usage for agent %s", aid, exc_info=True)

            # Pod status (phase + restart count)
            try:
                name = deployment_name(aid)
                pods = await self._manager.k8s.get_pods_for_deployment(name)
                if pods:
                    pod = pods[0]
                    result.pod_phase = pod.status.phase
                    if pod.status.container_statuses:
                        result.pod_restart_count = pod.status.container_statuses[0].restart_count
            except Exception:
                logger.debug("Failed to fetch pod status for agent %s", aid, exc_info=True)

            return result

    # ── Anomaly detection ──────────────────────────────────────

    def _collect_anomalies(
        self, results: list[InspectionCheckResult], batch_id: str
    ) -> list[dict]:
        """Threshold-based anomaly detection across all check results."""
        anomalies: list[dict] = []

        for r in results:
            # health_down: critical
            if r.health_ok is False:
                anomalies.append({
                    "agent_number": r.agent_number,
                    "anomaly_type": "health_down",
                    "severity": "critical",
                    "title": f"Agent {r.agent_number} health check failed",
                    "detail": {
                        "error_message": r.error_message or "unknown",
                        "batch_id": batch_id,
                    },
                })

            # pod_not_running: critical
            if r.pod_phase and r.pod_phase != "Running":
                anomalies.append({
                    "agent_number": r.agent_number,
                    "anomaly_type": "pod_not_running",
                    "severity": "critical",
                    "title": f"Agent {r.agent_number} pod phase: {r.pod_phase}",
                    "detail": {
                        "pod_phase": r.pod_phase,
                        "batch_id": batch_id,
                    },
                })

            # high_cpu: warning
            if r.cpu_usage_pct is not None and r.cpu_usage_pct > DEFAULT_CPU_THRESHOLD_PCT:
                anomalies.append({
                    "agent_number": r.agent_number,
                    "anomaly_type": "high_cpu",
                    "severity": "warning",
                    "title": f"Agent {r.agent_number} CPU usage {r.cpu_usage_pct:.1f}%",
                    "detail": {
                        "cpu_usage_pct": r.cpu_usage_pct,
                        "threshold": DEFAULT_CPU_THRESHOLD_PCT,
                        "batch_id": batch_id,
                    },
                })

            # high_memory: warning
            if r.memory_usage_pct is not None and r.memory_usage_pct > DEFAULT_MEMORY_THRESHOLD_PCT:
                anomalies.append({
                    "agent_number": r.agent_number,
                    "anomaly_type": "high_memory",
                    "severity": "warning",
                    "title": f"Agent {r.agent_number} memory usage {r.memory_usage_pct:.1f}%",
                    "detail": {
                        "memory_usage_pct": r.memory_usage_pct,
                        "threshold": DEFAULT_MEMORY_THRESHOLD_PCT,
                        "batch_id": batch_id,
                    },
                })

            # high_restarts: warning
            if r.pod_restart_count > DEFAULT_RESTART_THRESHOLD:
                anomalies.append({
                    "agent_number": r.agent_number,
                    "anomaly_type": "high_restarts",
                    "severity": "warning",
                    "title": f"Agent {r.agent_number} restart count: {r.pod_restart_count}",
                    "detail": {
                        "restart_count": r.pod_restart_count,
                        "threshold": DEFAULT_RESTART_THRESHOLD,
                        "batch_id": batch_id,
                    },
                })

        # Fix #12: emit inspection_degraded when majority of agents lack resource data
        if results:
            no_resource_count = sum(
                1 for r in results
                if r.cpu_usage_pct is None and r.memory_usage_pct is None
            )
            if no_resource_count > len(results) // 2:
                anomalies.append({
                    "agent_number": 0,  # 0 = system-level
                    "anomaly_type": "inspection_degraded",
                    "severity": "info",
                    "title": (
                        f"Metrics unavailable: {no_resource_count}/{len(results)} "
                        f"agents have no resource data"
                    ),
                    "detail": {
                        "no_resource_count": no_resource_count,
                        "total": len(results),
                        "batch_id": batch_id,
                    },
                })

        return anomalies

    # ── Persistence ────────────────────────────────────────────

    async def _persist_batch(
        self, batch_id: str, results: list[InspectionCheckResult]
    ) -> None:
        """Bulk-insert inspection snapshots for this batch."""
        mappings = []
        for r in results:
            mappings.append({
                "batch_id": batch_id,
                "agent_number": r.agent_number,
                "health_ok": r.health_ok,
                "health_latency_ms": r.health_latency_ms,
                "pod_phase": r.pod_phase,
                "pod_restart_count": r.pod_restart_count,
                "cpu_usage_pct": r.cpu_usage_pct,
                "memory_usage_pct": r.memory_usage_pct,
                # Fix #13: persist raw resource fields
                "cpu_cores": r.cpu_cores,
                "cpu_limit_cores": r.cpu_limit_cores,
                "memory_bytes": r.memory_bytes,
                "memory_limit_bytes": r.memory_limit_bytes,
                "error_message": r.error_message,
            })
        if not mappings:
            return

        async with AsyncSessionLocal() as session:
            await session.execute(
                InspectionSnapshot.__table__.insert(),
                mappings,
            )
            await session.commit()

    async def _persist_anomalies(
        self, batch_id: str, anomalies: list[dict]
    ) -> None:
        """Upsert anomalies: update existing active ones, insert new ones."""
        if not anomalies:
            return

        async with AsyncSessionLocal() as session:
            for a in anomalies:
                existing = await session.execute(
                    select(InspectionAnomaly).where(
                        InspectionAnomaly.agent_number == a["agent_number"],
                        InspectionAnomaly.anomaly_type == a["anomaly_type"],
                        InspectionAnomaly.status == "active",
                    )
                )
                row = existing.scalar_one_or_none()
                if row:
                    row.title = a["title"]
                    row.detail = a["detail"]
                    row.updated_at = datetime.now(timezone.utc)
                else:
                    session.add(InspectionAnomaly(
                        agent_number=a["agent_number"],
                        anomaly_type=a["anomaly_type"],
                        severity=a["severity"],
                        title=a["title"],
                        detail=a["detail"],
                        status="active",
                    ))

            await session.commit()

    # ── Flapping suppression + auto-resolve ────────────────────

    async def _resolve_old_anomalies(
        self, results: list[InspectionCheckResult]
    ) -> None:
        """Mark anomalies as resolved after FLAPPING_SUPPRESSION_ROUNDS consecutive normal checks."""
        healthy_agents: set[int] = set()
        for r in results:
            is_healthy = (
                r.health_ok is not False
                and r.pod_phase in (None, "Running")
                and (r.cpu_usage_pct is None or r.cpu_usage_pct <= DEFAULT_CPU_THRESHOLD_PCT)
                and (r.memory_usage_pct is None or r.memory_usage_pct <= DEFAULT_MEMORY_THRESHOLD_PCT)
                and r.pod_restart_count <= DEFAULT_RESTART_THRESHOLD
            )
            if is_healthy:
                healthy_agents.add(r.agent_number)

        async with AsyncSessionLocal() as session:
            active_anomalies_result = await session.execute(
                select(InspectionAnomaly).where(
                    InspectionAnomaly.status == "active",
                )
            )
            # Fix #10: capture list once to avoid exhausting the SQLAlchemy result
            active_anomaly_list = active_anomalies_result.scalars().all()
            now = datetime.now(timezone.utc)
            resolved_any = False

            for anomaly in active_anomaly_list:
                key = (anomaly.agent_number, anomaly.anomaly_type)
                if anomaly.agent_number in healthy_agents:
                    self._consecutive_normal[key] = (
                        self._consecutive_normal.get(key, 0) + 1
                    )
                else:
                    self._consecutive_normal[key] = 0

                if self._consecutive_normal[key] >= FLAPPING_SUPPRESSION_ROUNDS:
                    anomaly.status = "resolved"
                    anomaly.resolved_at = now
                    anomaly.updated_at = now
                    resolved_any = True
                    del self._consecutive_normal[key]

            # Fix #10: clean stale keys to prevent unbounded growth
            active_keys = {(a.agent_number, a.anomaly_type) for a in active_anomaly_list}
            stale_keys = [k for k in self._consecutive_normal if k not in active_keys]
            for k in stale_keys:
                del self._consecutive_normal[k]

            if resolved_any:
                await session.commit()

    # ── Periodic cleanup ───────────────────────────────────────

    async def _maybe_cleanup(self) -> None:
        """Every CLEANUP_INTERVAL_SECONDS, delete old snapshots and resolved anomalies."""
        now = time.monotonic()
        if now - self._last_cleanup_at < CLEANUP_INTERVAL_SECONDS:
            return
        self._last_cleanup_at = now

        try:
            async with AsyncSessionLocal() as session:
                # Delete snapshots older than 7 days
                await session.execute(
                    delete(InspectionSnapshot).where(
                        InspectionSnapshot.created_at
                        < datetime.now(timezone.utc) - timedelta(days=7)
                    )
                )
                # Delete resolved/ignored anomalies older than 90 days
                await session.execute(
                    delete(InspectionAnomaly).where(
                        InspectionAnomaly.status.in_(["resolved", "ignored"]),
                        InspectionAnomaly.resolved_at
                        < datetime.now(timezone.utc) - timedelta(days=90),
                    )
                )
                await session.commit()
                logger.info("Inspection cleanup completed")
        except Exception:
            logger.exception("Inspection cleanup failed")

    # ── Shutdown ───────────────────────────────────────────────

    def shutdown(self) -> None:
        """Signal the background loop to stop."""
        self._shutdown_event.set()
