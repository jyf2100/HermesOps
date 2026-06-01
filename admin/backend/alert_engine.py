"""Alert rule evaluation engine — evaluates rules against anomalies and executes auto-remediation."""
from __future__ import annotations

import asyncio
import logging
from collections import deque
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from agent_manager import AgentManager
from database import AsyncSessionLocal
from db_models import AlertRecord, AlertRule
from sanitize import sanitize_secrets
from templates import deployment_name

logger = logging.getLogger("hermes-admin.alert_engine")

MAX_CONCURRENT_AUTO_ACTIONS = 2
MAX_RESTARTS_PER_AGENT_30MIN = 3
RESTART_RATE_WINDOW = timedelta(minutes=30)

# Action priority for dedup — higher number wins
_ACTION_PRIORITY = {"restart_pod": 3, "scale_resources": 2, "alert": 1}


class AlertEngine:
    def __init__(self, manager: AgentManager) -> None:
        self._manager = manager
        self._action_semaphore = asyncio.Semaphore(MAX_CONCURRENT_AUTO_ACTIONS)
        self._restart_timestamps: dict[int, deque] = {}  # agent_number -> deque of timestamps

    async def evaluate_rules(self, anomalies: list[dict]) -> None:
        """Evaluate all enabled alert rules against active anomalies (passed as dicts)."""
        try:
            async with AsyncSessionLocal() as session:
                rules_result = await session.execute(
                    select(AlertRule).where(AlertRule.enabled == True)  # noqa: E712
                )
                rules = rules_result.scalars().all()

                if not rules or not anomalies:
                    return

                # Batch-load recent alert records for cooldown check
                rule_ids = [r.id for r in rules]
                agent_numbers = [a["agent_number"] for a in anomalies]
                recent_records_result = await session.execute(
                    select(AlertRecord).where(
                        AlertRecord.rule_id.in_(rule_ids),
                        AlertRecord.agent_number.in_(agent_numbers),
                        AlertRecord.action_taken.notin_(["skipped_cooldown", "skipped_disabled"]),
                    ).order_by(AlertRecord.triggered_at.desc())
                )
                recent_records = recent_records_result.scalars().all()

                # Build cooldown lookup: (rule_id, agent_number) -> latest triggered_at
                cooldown_map: dict[tuple[int, int], datetime] = {}
                for rec in recent_records:
                    key = (rec.rule_id, rec.agent_number)
                    if key not in cooldown_map:
                        cooldown_map[key] = rec.triggered_at

            # Group matched actions by agent, keep highest priority
            agent_actions: dict[int, tuple[AlertRule, dict]] = {}
            for anomaly in anomalies:
                for rule in rules:
                    if self._matches_rule(rule, anomaly):
                        existing = agent_actions.get(anomaly["agent_number"])
                        if existing is None or _ACTION_PRIORITY.get(rule.action, 0) > _ACTION_PRIORITY.get(existing[0].action, 0):
                            agent_actions[anomaly["agent_number"]] = (rule, anomaly)

            # Execute actions with dedup + cooldown + rate limit
            tasks = []
            for agent_number, (rule, anomaly) in agent_actions.items():
                tasks.append(self._process_rule(agent_number, rule, anomaly, cooldown_map))
            await asyncio.gather(*tasks)

            # Prune restart timestamps for agents no longer in scope
            active_agent_numbers = {a["agent_number"] for a in anomalies}
            for stale in list(self._restart_timestamps.keys()):
                if stale not in active_agent_numbers:
                    del self._restart_timestamps[stale]

        except Exception:
            logger.exception("Alert engine evaluation failed")

    def _matches_rule(self, rule: AlertRule, anomaly: dict) -> bool:
        if rule.anomaly_type != anomaly["anomaly_type"]:
            return False
        if rule.severity_filter and anomaly["severity"] not in rule.severity_filter:
            return False
        if rule.agent_numbers and anomaly["agent_number"] not in rule.agent_numbers:
            return False
        return True

    async def _process_rule(
        self, agent_number: int, rule: AlertRule, anomaly: dict, cooldown_map: dict[tuple[int, int], datetime]
    ) -> None:
        """Check cooldown + rate limit, then execute."""
        # Check cooldown from pre-loaded map
        last_triggered = cooldown_map.get((rule.id, agent_number))
        if last_triggered is not None:
            cutoff = datetime.now(timezone.utc) - timedelta(seconds=rule.cooldown_seconds)
            if last_triggered > cutoff:
                await self._write_record(rule.id, anomaly.get("id"), agent_number, "skipped_cooldown", {"reason": "cooldown"})
                return

        # Check restart rate limit
        if rule.action == "restart_pod" and self._is_restart_rate_limited(agent_number):
            await self._write_record(rule.id, anomaly.get("id"), agent_number, "skipped_cooldown", {"reason": "rate_limited"})
            return

        # Execute action
        if rule.action == "alert":
            await self._write_record(rule.id, anomaly.get("id"), agent_number, "alert", {"status": "recorded"})
        elif rule.action == "restart_pod":
            async with self._action_semaphore:
                await self._execute_restart(agent_number, rule.id, anomaly.get("id"))
        elif rule.action == "scale_resources":
            async with self._action_semaphore:
                await self._execute_scale(agent_number, rule, anomaly.get("id"))

    def _is_restart_rate_limited(self, agent_number: int) -> bool:
        now = datetime.now(timezone.utc)
        if agent_number not in self._restart_timestamps:
            return False
        timestamps = self._restart_timestamps[agent_number]
        # Remove old entries
        while timestamps and timestamps[0] < now - RESTART_RATE_WINDOW:
            timestamps.popleft()
        return len(timestamps) >= MAX_RESTARTS_PER_AGENT_30MIN

    async def _execute_restart(self, agent_number: int, rule_id: int, anomaly_id: int) -> None:
        """Restart pod via annotation patch (no delete RBAC needed)."""
        # Write record with actual action name, mark executing in result
        record_id = await self._write_record(
            rule_id, anomaly_id, agent_number, "restart_pod", {"status": "executing"}
        )
        try:
            name = deployment_name(agent_number)
            now_iso = datetime.now(timezone.utc).isoformat()
            patch = {
                "spec": {"template": {"metadata": {
                    "annotations": {"kubectl.kubernetes.io/restartedAt": now_iso}
                }}}
            }
            await self._manager.k8s.patch_deployment(name, patch)
            # Track restart timestamp
            if agent_number not in self._restart_timestamps:
                self._restart_timestamps[agent_number] = deque()
            self._restart_timestamps[agent_number].append(datetime.now(timezone.utc))
            await self._update_record(record_id, {"status": "success", "method": "annotation_patch"})
            logger.info("Restarted agent %d via annotation patch (rule %d)", agent_number, rule_id)
        except Exception as exc:
            await self._update_record(record_id, {"status": "error", "error": _sanitize(str(exc))})
            logger.exception("Failed to restart agent %d", agent_number)

    async def _execute_scale(self, agent_number: int, rule: AlertRule, anomaly_id: int) -> None:
        """Scale agent resources via deployment patch."""
        from models import ResourceSpec

        cpu = min(rule.scale_cpu_millicores or 1000, 4000)  # ceiling 4 cores
        mem = min(rule.scale_memory_mb or 1024, 8192)  # ceiling 8 GB
        # Write record with actual action name, mark executing in result
        record_id = await self._write_record(
            rule.id, anomaly_id, agent_number, "scale_resources", {"status": "executing"}
        )
        try:
            resources = ResourceSpec(
                cpu_request=f"{max(cpu // 2, 100)}m",
                cpu_limit=f"{cpu}m",
                memory_request=f"{max(mem // 2, 128)}Mi",
                memory_limit=f"{mem}Mi",
            )
            await self._manager.update_resources(agent_number, resources)
            await self._update_record(record_id, {"status": "success", "cpu_millicores": cpu, "memory_mb": mem})
            logger.info("Scaled agent %d to %dm CPU / %dMi MEM (rule %d)", agent_number, cpu, mem, rule.id)
        except Exception as exc:
            await self._update_record(record_id, {"status": "error", "error": _sanitize(str(exc))})
            logger.exception("Failed to scale agent %d", agent_number)

    async def _write_record(
        self, rule_id: int, anomaly_id: int | None, agent_number: int, action_taken: str, result: dict
    ) -> int | None:
        async with AsyncSessionLocal() as session:
            record = AlertRecord(
                rule_id=rule_id,
                anomaly_id=anomaly_id,
                agent_number=agent_number,
                action_taken=action_taken,
                action_result=result,
            )
            session.add(record)
            await session.commit()
            await session.refresh(record)
            return record.id

    async def _update_record(self, record_id: int | None, result: dict) -> None:
        if record_id is None:
            return
        async with AsyncSessionLocal() as session:
            record = await session.get(AlertRecord, record_id)
            if record:
                record.action_result = result
                await session.commit()


def _sanitize(text: str) -> str:
    """Remove secret patterns from text (delegates to shared module)."""
    return sanitize_secrets(text)
