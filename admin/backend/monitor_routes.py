"""Monitoring / Inspection routes — manual trigger, results, anomalies, summary."""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import desc, func, select, text

from database import AsyncSessionLocal
from db_models import AlertRecord, AlertRule, InspectionAnomaly, InspectionSnapshot
from models import (
    AlertRecordListResponse,
    AlertRecordResponse,
    AlertRuleCreate,
    AlertRuleListResponse,
    AlertRuleResponse,
    AlertRuleUpdate,
    AnomalyItem,
    AnomalyListResponse,
    AnomalyUpdateRequest,
    InspectionBatchResponse,
    InspectionCheckResult,
    InspectionTrendPoint,
    InspectionTrendResponse,
    LogSearchRequest,
    LogSearchResponse,
    LogStatsResponse,
    MonitorSummary,
)

logger = logging.getLogger("hermes-admin.monitor")

router = APIRouter(prefix="/monitor", tags=["monitor"])


# ── Auth dependencies (injected from main.py at include time) ──────
# We add them via route.dependencies after import, matching dispatch_routes pattern.


# ── POST /monitor/inspections — manual trigger ────────────────────

@router.post("/inspections")
async def trigger_inspection(request: Request):
    """Manually trigger an inspection batch. Returns 409 if already running."""
    runner = getattr(request.app.state, "inspection_runner", None)
    if runner is None:
        raise HTTPException(status_code=503, detail="Inspection runner not initialized")

    try:
        batch_id = await runner.run_batch()
    except RuntimeError as exc:
        if "already in progress" in str(exc).lower():
            raise HTTPException(status_code=409, detail="Inspection batch already in progress")
        raise

    # Fetch the snapshot count for this batch to report checked_count
    async with AsyncSessionLocal() as session:
        count_result = await session.execute(
            select(func.count()).select_from(InspectionSnapshot).where(
                InspectionSnapshot.batch_id == batch_id
            )
        )
        checked_count = count_result.scalar() or 0

    return {"batch_id": batch_id, "checked_count": checked_count}


# ── GET /monitor/inspections/latest — latest batch results ────────

@router.get("/inspections/latest", response_model=InspectionBatchResponse)
async def get_latest_inspection(request: Request):
    """Return the most recent inspection batch with all check results."""
    async with AsyncSessionLocal() as session:
        # Subquery: latest batch_id
        latest_batch_q = (
            select(InspectionSnapshot.batch_id)
            .order_by(desc(InspectionSnapshot.created_at))
            .limit(1)
        )
        batch_result = await session.execute(latest_batch_q)
        batch_id_row = batch_result.first()
        if batch_id_row is None:
            raise HTTPException(status_code=404, detail="No inspection data found")

        batch_id = batch_id_row[0]

        # Fetch all snapshots for this batch
        result = await session.execute(
            select(InspectionSnapshot)
            .where(InspectionSnapshot.batch_id == batch_id)
            .order_by(InspectionSnapshot.agent_number)
        )
        snapshots = result.scalars().all()

        # Count anomalies in this batch
        anomaly_count_result = await session.execute(
            select(func.count()).select_from(InspectionAnomaly).where(
                InspectionAnomaly.status == "active"
            )
        )
        anomaly_count = anomaly_count_result.scalar() or 0

        # Get batch created_at from first snapshot
        created_at = snapshots[0].created_at if snapshots else datetime.now(timezone.utc)

        results = [
            InspectionCheckResult(
                agent_number=s.agent_number,
                health_ok=s.health_ok,
                health_latency_ms=s.health_latency_ms,
                pod_phase=s.pod_phase,
                pod_restart_count=s.pod_restart_count or 0,
                cpu_usage_pct=s.cpu_usage_pct,
                memory_usage_pct=s.memory_usage_pct,
                # Fix #13: include raw resource fields
                cpu_cores=s.cpu_cores,
                cpu_limit_cores=s.cpu_limit_cores,
                memory_bytes=s.memory_bytes,
                memory_limit_bytes=s.memory_limit_bytes,
                error_message=s.error_message,
            )
            for s in snapshots
        ]

        return InspectionBatchResponse(
            batch_id=str(batch_id),
            checked_count=len(snapshots),
            anomaly_count=anomaly_count,
            results=results,
            created_at=created_at,
        )


# ── GET /monitor/inspections — historical batch list ──────────────

@router.get("/inspections")
async def list_inspections(
    request: Request,
    limit: int = Query(20, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """List historical inspection batches grouped by batch_id, paginated."""
    async with AsyncSessionLocal() as session:
        # Get distinct batch_ids with counts and timestamps, paginated
        batch_q = (
            select(
                InspectionSnapshot.batch_id,
                func.count().label("checked_count"),
                func.min(InspectionSnapshot.created_at).label("created_at"),
            )
            .group_by(InspectionSnapshot.batch_id)
            .order_by(desc(func.min(InspectionSnapshot.created_at)))
            .limit(limit)
            .offset(offset)
        )
        batch_result = await session.execute(batch_q)
        batches = [
            {
                "batch_id": str(row.batch_id),
                "checked_count": row.checked_count,
                "created_at": row.created_at.isoformat() if row.created_at else None,
            }
            for row in batch_result.all()
        ]

        # Total count of distinct batches
        total_result = await session.execute(
            select(func.count(func.distinct(InspectionSnapshot.batch_id)))
        )
        total = total_result.scalar() or 0

        return {"batches": batches, "total": total}


# ── GET /monitor/inspections/{agent_number}/trend — 24h trend ─────

@router.get("/inspections/{agent_number}/trend", response_model=InspectionTrendResponse)
async def get_agent_trend(agent_number: int, request: Request):
    """Return 24-hour hourly aggregated trend for a specific agent."""
    async with AsyncSessionLocal() as session:
        hour_col = func.date_trunc("hour", InspectionSnapshot.created_at).label("hour")
        result = await session.execute(
            select(
                hour_col,
                func.avg(InspectionSnapshot.cpu_usage_pct).label("avg_cpu"),
                func.avg(InspectionSnapshot.memory_usage_pct).label("avg_memory"),
                func.min(InspectionSnapshot.health_ok).label("health_ok"),  # all must be True
            )
            .where(
                InspectionSnapshot.agent_number == agent_number,
                InspectionSnapshot.created_at >= datetime.now(timezone.utc) - timedelta(hours=24),
            )
            .group_by(hour_col)
            .order_by(hour_col)
        )
        rows = result.all()

        points = [
            InspectionTrendPoint(
                created_at=row.hour,
                avg_cpu_usage_pct=round(row.avg_cpu, 1) if row.avg_cpu is not None else None,
                avg_memory_usage_pct=round(row.avg_memory, 1) if row.avg_memory is not None else None,
                health_ok=row.health_ok if row.health_ok is not None else None,
            )
            for row in rows
        ]

        return InspectionTrendResponse(agent_number=agent_number, points=points)


# ── GET /monitor/anomalies — anomaly list with filters ────────────

@router.get("/anomalies", response_model=AnomalyListResponse)
async def list_anomalies(
    request: Request,
    status: str | None = Query(None, description="Filter by status (e.g. active)"),
    severity: str | None = Query(None, description="Filter by severity (critical, warning, info)"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """List anomalies with optional status and severity filters."""
    async with AsyncSessionLocal() as session:
        query = select(InspectionAnomaly)
        count_q = select(func.count()).select_from(InspectionAnomaly)

        if status:
            query = query.where(InspectionAnomaly.status == status)
            count_q = count_q.where(InspectionAnomaly.status == status)
        if severity:
            query = query.where(InspectionAnomaly.severity == severity)
            count_q = count_q.where(InspectionAnomaly.severity == severity)

        total = (await session.execute(count_q)).scalar() or 0

        query = query.order_by(desc(InspectionAnomaly.created_at)).limit(limit).offset(offset)
        result = await session.execute(query)
        anomalies = result.scalars().all()

        items = [
            AnomalyItem(
                id=a.id,
                agent_number=a.agent_number,
                anomaly_type=a.anomaly_type,
                severity=a.severity,
                title=a.title,
                detail=a.detail or {},
                status=a.status,
                created_at=a.created_at,
                resolved_at=a.resolved_at,
            )
            for a in anomalies
        ]

        return AnomalyListResponse(anomalies=items, total=total)


# ── PATCH /monitor/anomalies/{anomaly_id} — acknowledge / ignore ──

@router.patch("/anomalies/{anomaly_id}", response_model=AnomalyItem)
async def update_anomaly(
    anomaly_id: int,
    req: AnomalyUpdateRequest,
    request: Request,
):
    """Update anomaly status to acknowledged or ignored."""
    async with AsyncSessionLocal() as session:
        anomaly = await session.get(InspectionAnomaly, anomaly_id)
        if not anomaly:
            raise HTTPException(status_code=404, detail="Anomaly not found")

        anomaly.status = req.status
        anomaly.updated_at = datetime.now(timezone.utc)
        if req.status == "ignored":
            anomaly.resolved_at = datetime.now(timezone.utc)

        await session.commit()
        await session.refresh(anomaly)

        return AnomalyItem(
            id=anomaly.id,
            agent_number=anomaly.agent_number,
            anomaly_type=anomaly.anomaly_type,
            severity=anomaly.severity,
            title=anomaly.title,
            detail=anomaly.detail or {},
            status=anomaly.status,
            created_at=anomaly.created_at,
            resolved_at=anomaly.resolved_at,
        )


# ── GET /monitor/summary — aggregated monitoring summary ──────────

@router.get("/summary", response_model=MonitorSummary)
async def get_monitor_summary(request: Request):
    """Return aggregated monitoring summary: agent counts, anomalies, last inspection."""
    # Agent list from manager (same source as /agents endpoint)
    manager = request.app.state.manager

    agent_list = await manager.list_agents()
    total_agents = len(agent_list.agents)
    running_agents = sum(1 for a in agent_list.agents if a.status.value == "running")

    async with AsyncSessionLocal() as session:
        # Active anomaly count
        anomaly_count_result = await session.execute(
            select(func.count()).select_from(InspectionAnomaly).where(
                InspectionAnomaly.status == "active"
            )
        )
        anomaly_count = anomaly_count_result.scalar() or 0

        # Fix #9: healthy_count based on each agent's latest snapshot, not 1h window
        latest_sq = (
            select(
                InspectionSnapshot.agent_number,
                InspectionSnapshot.health_ok,
                func.row_number().over(
                    partition_by=InspectionSnapshot.agent_number,
                    order_by=desc(InspectionSnapshot.created_at),
                ).label("rn"),
            )
            .subquery()
        )
        healthy_q = select(latest_sq.c.agent_number).where(
            latest_sq.c.rn == 1,
            latest_sq.c.health_ok == True,  # noqa: E712
        )
        healthy_result = await session.execute(healthy_q)
        healthy_agent_numbers = {row[0] for row in healthy_result.all()}

        # Agents with active anomalies
        anomaly_agents_result = await session.execute(
            select(func.distinct(InspectionAnomaly.agent_number)).where(
                InspectionAnomaly.status == "active"
            )
        )
        anomaly_agent_numbers = {row[0] for row in anomaly_agents_result.all()}

        healthy_count = len(healthy_agent_numbers - anomaly_agent_numbers)

        # Last inspection time
        last_inspection_result = await session.execute(
            select(func.max(InspectionSnapshot.created_at))
        )
        last_inspection_at = last_inspection_result.scalar()

        # Agent health summary
        stopped = sum(1 for a in agent_list.agents if a.status.value == "stopped")
        failed = sum(1 for a in agent_list.agents if a.status.value == "failed")
        degraded = len(anomaly_agent_numbers)
        agent_health_summary = {
            "running": running_agents,
            "stopped": stopped,
            "failed": failed,
            "degraded": degraded,
        }

        # inspection_healthy: True if no active anomalies
        inspection_healthy = anomaly_count == 0

        return MonitorSummary(
            healthy_count=healthy_count,
            anomaly_count=anomaly_count,
            total_agents=total_agents,
            running_agents=running_agents,
            last_inspection_at=last_inspection_at,
            inspection_healthy=inspection_healthy,
            agent_health_summary=agent_health_summary,
        )


# ── Alert Rules CRUD ────────────────────────────────────────────────

def _rule_to_response(r: AlertRule) -> AlertRuleResponse:
    return AlertRuleResponse(
        id=r.id, name=r.name, enabled=r.enabled,
        anomaly_type=r.anomaly_type,
        severity_filter=r.severity_filter or [],
        agent_numbers=r.agent_numbers or [],
        action=r.action,
        cooldown_seconds=r.cooldown_seconds,
        scale_cpu_millicores=r.scale_cpu_millicores,
        scale_memory_mb=r.scale_memory_mb,
        created_by=r.created_by,
        created_at=r.created_at,
        updated_at=r.updated_at,
    )


@router.get("/alert-rules", response_model=AlertRuleListResponse)
async def list_alert_rules(request: Request):
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(AlertRule).order_by(AlertRule.id)
        )
        rules = result.scalars().all()
        total = len(rules)
        return AlertRuleListResponse(
            rules=[_rule_to_response(r) for r in rules],
            total=total,
        )


@router.post("/alert-rules", response_model=AlertRuleResponse, status_code=201)
async def create_alert_rule(req: AlertRuleCreate, request: Request):
    async with AsyncSessionLocal() as session:
        rule = AlertRule(
            name=req.name, enabled=req.enabled,
            anomaly_type=req.anomaly_type,
            severity_filter=req.severity_filter,
            agent_numbers=req.agent_numbers,
            action=req.action,
            cooldown_seconds=req.cooldown_seconds,
            scale_cpu_millicores=req.scale_cpu_millicores,
            scale_memory_mb=req.scale_memory_mb,
        )
        session.add(rule)
        await session.commit()
        await session.refresh(rule)
        return _rule_to_response(rule)


@router.put("/alert-rules/{rule_id}", response_model=AlertRuleResponse)
async def update_alert_rule(rule_id: int, req: AlertRuleUpdate, request: Request):
    async with AsyncSessionLocal() as session:
        rule = await session.get(AlertRule, rule_id)
        if not rule:
            raise HTTPException(status_code=404, detail="Alert rule not found")
        update_data = req.model_dump(exclude_unset=True)
        for key, value in update_data.items():
            setattr(rule, key, value)
        rule.updated_at = datetime.now(timezone.utc)
        await session.commit()
        await session.refresh(rule)
        return _rule_to_response(rule)


@router.delete("/alert-rules/{rule_id}")
async def delete_alert_rule(rule_id: int, request: Request):
    async with AsyncSessionLocal() as session:
        rule = await session.get(AlertRule, rule_id)
        if not rule:
            raise HTTPException(status_code=404, detail="Alert rule not found")
        await session.delete(rule)
        await session.commit()
        return {"message": "Alert rule deleted"}


# ── Alert Records ────────────────────────────────────────────────────

@router.get("/alert-records", response_model=AlertRecordListResponse)
async def list_alert_records(
    request: Request,
    agent_number: int | None = Query(None),
    rule_id: int | None = Query(None),
    since: str | None = Query(None, description="ISO datetime for filtering"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    async with AsyncSessionLocal() as session:
        query = select(AlertRecord)
        count_q = select(func.count()).select_from(AlertRecord)

        if agent_number is not None:
            query = query.where(AlertRecord.agent_number == agent_number)
            count_q = count_q.where(AlertRecord.agent_number == agent_number)
        if rule_id is not None:
            query = query.where(AlertRecord.rule_id == rule_id)
            count_q = count_q.where(AlertRecord.rule_id == rule_id)
        if since:
            try:
                since_dt = datetime.fromisoformat(since)
                if since_dt.tzinfo is None:
                    since_dt = since_dt.replace(tzinfo=timezone.utc)
                query = query.where(AlertRecord.triggered_at >= since_dt)
                count_q = count_q.where(AlertRecord.triggered_at >= since_dt)
            except ValueError:
                pass

        total = (await session.execute(count_q)).scalar() or 0
        query = query.order_by(desc(AlertRecord.triggered_at)).limit(limit).offset(offset)
        result = await session.execute(query)
        records = result.scalars().all()

        return AlertRecordListResponse(
            records=[AlertRecordResponse(
                id=r.id, rule_id=r.rule_id, anomaly_id=r.anomaly_id,
                agent_number=r.agent_number, action_taken=r.action_taken,
                action_result=r.action_result or {},
                triggered_at=r.triggered_at,
            ) for r in records],
            total=total,
        )


# ── Log Search / Export / Stats (Phase 3) ────────────────────────

@router.post("/logs/search", response_model=LogSearchResponse)
async def search_logs(req: LogSearchRequest, request: Request):
    collector = getattr(request.app.state, "log_collector", None)
    if collector is None:
        raise HTTPException(status_code=503, detail="Log collector not initialized")
    return await collector.search(req)


@router.get("/logs/export")
async def export_logs(
    request: Request,
    keywords: str = Query("", max_length=200),
    agents: str = Query("", description="Comma-separated agent numbers"),
    level: str | None = Query(None, pattern=r"^(ERROR|WARN|INFO|DEBUG)$"),
    time_from: str | None = Query(None),
    time_to: str | None = Query(None),
):
    collector = getattr(request.app.state, "log_collector", None)
    if collector is None:
        raise HTTPException(status_code=503, detail="Log collector not initialized")

    agent_list = [int(a) for a in agents.split(",") if a.strip().isdigit()] if agents else []
    from_dt = datetime.fromisoformat(time_from) if time_from else None
    to_dt = datetime.fromisoformat(time_to) if time_to else None
    if from_dt is not None and from_dt.tzinfo is None:
        from_dt = from_dt.replace(tzinfo=timezone.utc)
    if to_dt is not None and to_dt.tzinfo is None:
        to_dt = to_dt.replace(tzinfo=timezone.utc)

    params = LogSearchRequest(
        keywords=keywords,
        agents=agent_list,
        level=level,
        time_from=from_dt,
        time_to=to_dt,
    )
    path = await collector.export(params)
    filename = os.path.basename(path)

    def _iter_csv():
        try:
            with open(path, "rb") as f:
                while chunk := f.read(64 * 1024):
                    yield chunk
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass

    return StreamingResponse(
        _iter_csv(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/logs/stats", response_model=LogStatsResponse)
async def get_log_stats(request: Request):
    collector = getattr(request.app.state, "log_collector", None)
    if collector is None:
        raise HTTPException(status_code=503, detail="Log collector not initialized")
    return await collector.stats()
