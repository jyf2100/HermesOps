"""Task Dispatch routes — channel management, task dispatch, and callbacks."""
from __future__ import annotations

import asyncio
import hashlib
import logging
import secrets as _secrets
import time
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import delete, desc, func, select, text

from database import AsyncSessionLocal
from db_models import (
    DispatchAssignment,
    DispatchTask,
    TaskChannel,
    TaskChannelSubscription,
)
from models import (
    CallbackConfirmRequest,
    CallbackRejectRequest,
    CallbackResultRequest,
    ChannelCreateRequest,
    ChannelResponse,
    ChannelUpdateRequest,
    OrchestratorCallbackRequest,
    SubscriptionRequest,
    DispatchTaskRequest,
)

logger = logging.getLogger("hermes-admin.dispatch")

router = APIRouter(prefix="/dispatch", tags=["dispatch"])

# ── Kanban polling state ─────────────────────────────────────
_active_pollers: set[int] = set()  # assignment IDs with active kanban pollers

# ── Kanban auth cache (TTL-based) ────────────────────────────
_kanban_auth_cache: dict[int, tuple[float, tuple[str, str]]] = {}
_AUTH_CACHE_TTL = 300  # 5 minutes


def _orch_url(request: Request) -> str:
    return request.app.state.orchestrator_url


def _orch_key(request: Request) -> str:
    return request.app.state.orchestrator_api_key


# ── Channel CRUD ──────────────────────────────────────────────

@router.get("/channels", response_model=list[ChannelResponse])
async def list_channels(request: Request):
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(TaskChannel, func.count(TaskChannelSubscription.id).label("subscriber_count"))
            .outerjoin(TaskChannelSubscription, TaskChannelSubscription.channel_id == TaskChannel.id)
            .group_by(TaskChannel)
            .order_by(TaskChannel.name)
        )
        return [
            ChannelResponse(
                id=row.TaskChannel.id, name=row.TaskChannel.name,
                display_name=row.TaskChannel.display_name,
                description=row.TaskChannel.description or "",
                subscriber_count=row.subscriber_count,
                created_at=row.TaskChannel.created_at.isoformat() if row.TaskChannel.created_at else "",
            )
            for row in result.all()
        ]


@router.post("/channels", response_model=ChannelResponse, status_code=201)
async def create_channel(req: ChannelCreateRequest, request: Request):
    async with AsyncSessionLocal() as session:
        ch = TaskChannel(
            name=req.name, display_name=req.display_name,
            description=req.description,
        )
        session.add(ch)
        await session.commit()
        await session.refresh(ch)
        return ChannelResponse(
            id=ch.id, name=ch.name, display_name=ch.display_name,
            description=ch.description, subscriber_count=0,
            created_at=ch.created_at.isoformat() if ch.created_at else "",
        )


@router.put("/channels/{channel_id}", response_model=ChannelResponse)
async def update_channel(channel_id: int, req: ChannelUpdateRequest, request: Request):
    async with AsyncSessionLocal() as session:
        ch = await session.get(TaskChannel, channel_id)
        if not ch:
            raise HTTPException(404, "channel_not_found")
        if req.display_name is not None:
            ch.display_name = req.display_name
        if req.description is not None:
            ch.description = req.description
        await session.commit()
        await session.refresh(ch)
        return ChannelResponse(
            id=ch.id, name=ch.name, display_name=ch.display_name,
            description=ch.description or "", subscriber_count=0,
            created_at=ch.created_at.isoformat() if ch.created_at else "",
        )


@router.delete("/channels/{channel_id}")
async def delete_channel(channel_id: int, request: Request):
    async with AsyncSessionLocal() as session:
        ch = await session.get(TaskChannel, channel_id)
        if not ch:
            raise HTTPException(404, "channel_not_found")
        await session.delete(ch)
        await session.commit()
        return {"status": "deleted"}


# ── Channel Subscriptions ────────────────────────────────────

@router.get("/channels/{channel_id}/subscribers")
async def list_subscribers(channel_id: int, request: Request):
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(TaskChannelSubscription)
            .where(TaskChannelSubscription.channel_id == channel_id)
        )
        subs = result.scalars().all()
        return {"agent_numbers": [s.agent_number for s in subs]}


@router.post("/channels/{channel_id}/subscribers")
async def set_subscribers(channel_id: int, req: SubscriptionRequest, request: Request):
    async with AsyncSessionLocal() as session:
        ch = await session.execute(
            select(TaskChannel).where(TaskChannel.id == channel_id).with_for_update()
        )
        if not ch.scalar_one_or_none():
            raise HTTPException(404, "channel_not_found")
        await session.execute(
            delete(TaskChannelSubscription)
            .where(TaskChannelSubscription.channel_id == channel_id)
        )
        for agent_num in req.agent_numbers:
            session.add(TaskChannelSubscription(
                channel_id=channel_id, agent_number=agent_num,
            ))
        await session.commit()
        return {"status": "updated", "count": len(req.agent_numbers)}


# ── Task Dispatch ─────────────────────────────────────────────

@router.post("/tasks")
async def create_dispatch_task(req: DispatchTaskRequest, request: Request):
    """Create and dispatch a task to agents.

    Three-phase approach to avoid holding DB sessions during HTTP calls:
      Phase 1: Write DispatchTask + DispatchAssignment rows (commit immediately)
      Phase 2: Submit to orchestrator for each assignment (no DB session held)
      Phase 3: Open new session, update assignment/task status (commit)
    """
    # 1. Resolve target agents
    target_agents: list[int] = []
    if req.dispatch_type == "direct":
        if not req.target_agents:
            raise HTTPException(400, "target_agents required for direct dispatch")
        target_agents = req.target_agents
    elif req.dispatch_type == "channel":
        if not req.channel_id:
            raise HTTPException(400, "channel_id required for channel dispatch")
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(TaskChannelSubscription.agent_number)
                .where(TaskChannelSubscription.channel_id == req.channel_id)
            )
            target_agents = [row[0] for row in result.all()]
        if not target_agents:
            raise HTTPException(400, "No subscribers in channel")

    # 2. Get operator identity
    operator = "admin"
    email = getattr(request.state, "email", None) if hasattr(request, "state") else None
    if email:
        operator = email

    orch_url = _orch_url(request)
    orch_key = _orch_key(request)

    # ── Phase 1: Write DB rows (short session, commit immediately) ──
    dispatch_task_id: int
    assignment_info: list[tuple[int, int, str]] = []

    async with AsyncSessionLocal() as session:
        dispatch_task = DispatchTask(
            title=req.title, prompt=req.prompt, instructions=req.instructions,
            dispatch_type=req.dispatch_type, channel_id=req.channel_id,
            priority=req.priority, timeout_seconds=req.timeout_seconds,
            confirm_timeout_hours=req.confirm_timeout_hours,
            profile_hint=req.profile_hint,
            status="dispatching",
            created_by=operator,
        )
        session.add(dispatch_task)
        await session.flush()
        dispatch_task_id = dispatch_task.id

        for agent_num in target_agents:
            token = _secrets.token_urlsafe(32)
            token_hash = hashlib.sha256(token.encode()).hexdigest()
            deadline = datetime.now(timezone.utc) + timedelta(hours=req.confirm_timeout_hours)
            assignment = DispatchAssignment(
                task_id=dispatch_task_id,
                agent_number=agent_num,
                callback_token_hash=token_hash,
                confirm_deadline=deadline,
                status="pending",
            )
            session.add(assignment)
            await session.flush()
            assignment_info.append((assignment.id, agent_num, token))

        await session.commit()

    # ── Phase 2: HTTP calls (no DB session held) ──
    results: list[dict] = []
    assignment_updates: list[tuple[int, dict]] = []

    client = request.app.state.orch_client
    callback_base = "http://hermes-admin:48082/dispatch/callback"
    for assignment_id, agent_num, token in assignment_info:
        agent_name = f"hermes-gateway-{agent_num}"
        dispatch_instructions = (
            "## 任务分派通知\n\n"
            "管理员向你分派了一个任务。请按以下步骤处理：\n\n"
            "### 第一步：通知用户并等待确认\n"
            "向用户展示任务内容，询问是否接受。用户也可以在管理后台的「我的任务」页面确认。\n\n"
            "### 第二步：确认接受（用户同意后执行）\n"
            "使用 execute_code 工具执行以下代码：\n"
            f"```python\n"
            f"import urllib.request, json\n"
            f"data = json.dumps({{\"assignment_id\": {assignment_id}, \"callback_token\": \"{token}\"}}).encode()\n"
            f"req = urllib.request.Request('{callback_base}/confirm', data=data, "
            f"headers={{'Content-Type': 'application/json'}}, method='POST')\n"
            f"urllib.request.urlopen(req).read().decode()\n"
            f"```\n\n"
            "### 或者：拒绝任务（用户拒绝时执行）\n"
            f"```python\n"
            f"import urllib.request, json\n"
            f"data = json.dumps({{\"assignment_id\": {assignment_id}, \"callback_token\": \"{token}\", \"reason\": \"用户拒绝原因\"}}).encode()\n"
            f"req = urllib.request.Request('{callback_base}/reject', data=data, "
            f"headers={{'Content-Type': 'application/json'}}, method='POST')\n"
            f"urllib.request.urlopen(req).read().decode()\n"
            f"```\n\n"
            "### 第三步：完成任务后汇报结果\n"
            f"```python\n"
            f"import urllib.request, json\n"
            f"data = json.dumps({{\"assignment_id\": {assignment_id}, \"callback_token\": \"{token}\", \"result_summary\": \"任务结果摘要\"}}).encode()\n"
            f"req = urllib.request.Request('{callback_base}/result', data=data, "
            f"headers={{'Content-Type': 'application/json'}}, method='POST')\n"
            f"urllib.request.urlopen(req).read().decode()\n"
            f"```\n"
        )
        combined_instructions = (req.instructions or "") + "\n\n" + dispatch_instructions
        orch_body = {
            "prompt": req.prompt,
            "instructions": combined_instructions,
            "priority": req.priority,
            "timeout_seconds": req.timeout_seconds,
            "target_agent_id": agent_name,
            "callback_url": f"http://hermes-admin:48082/dispatch/callback/orchestrator",
            "metadata": {
                "dispatch_assignment_id": assignment_id,
                "dispatch_agent_number": agent_num,
            },
        }
        try:
            resp = await client.post(
                f"{orch_url}/api/v1/tasks",
                json=orch_body,
                headers={"Authorization": f"Bearer {orch_key}"},
            )
            if resp.status_code in (200, 201, 202):
                data = resp.json()
                orch_task_id = data.get("task_id")
                results.append({"agent_number": agent_num, "status": "dispatched"})
                assignment_updates.append((assignment_id, {
                    "status": "pending",
                    "orchestrator_task_id": orch_task_id,
                }))
            else:
                results.append({
                    "agent_number": agent_num, "status": "error",
                    "error": resp.text[:200],
                })
                assignment_updates.append((assignment_id, {
                    "status": "failed",
                    "error_message": resp.text[:500],
                }))
        except Exception as exc:
            results.append({
                "agent_number": agent_num, "status": "error",
                "error": str(exc)[:200],
            })
            assignment_updates.append((assignment_id, {
                "status": "failed",
                "error_message": str(exc)[:500],
            }))

    # ── Phase 3: Update DB with results (new session) ──
    all_ok = all(r["status"] == "dispatched" for r in results)
    final_status = "dispatched" if all_ok else "partial"

    async with AsyncSessionLocal() as session:
        for assignment_id, updates in assignment_updates:
            assignment = await session.get(DispatchAssignment, assignment_id)
            if assignment and assignment.status not in ("expired", "failed", "rejected", "cancelled"):
                for key, value in updates.items():
                    setattr(assignment, key, value)

        task = await session.get(DispatchTask, dispatch_task_id)
        if task and task.status == "dispatching":
            task.status = final_status
        await session.commit()

    return {"task_id": dispatch_task_id, "status": final_status, "assignments": results}


@router.get("/tasks")
async def list_dispatch_tasks(
    status: str | None = None,
    agent_number: int | None = None,
    limit: int = 50,
    offset: int = 0,
):
    query = select(DispatchTask).order_by(desc(DispatchTask.created_at))
    if status:
        query = query.where(DispatchTask.status == status)
    if agent_number:
        query = query.join(DispatchAssignment).where(DispatchAssignment.agent_number == agent_number)
    query = query.limit(min(limit, 200)).offset(offset)

    async with AsyncSessionLocal() as session:
        count_q = select(func.count()).select_from(DispatchTask)
        if status:
            count_q = count_q.where(DispatchTask.status == status)
        if agent_number:
            count_q = count_q.join(DispatchAssignment).where(DispatchAssignment.agent_number == agent_number)
        total = (await session.execute(count_q)).scalar() or 0

        result = await session.execute(query)
        tasks = result.scalars().all()
        if not tasks:
            return {"tasks": [], "total": total}

        task_ids = [t.id for t in tasks]
        assign_result = await session.execute(
            select(DispatchAssignment).where(DispatchAssignment.task_id.in_(task_ids))
        )
        assigns_by_task: dict[int, list] = {}
        for a in assign_result.scalars().all():
            assigns_by_task.setdefault(a.task_id, []).append(a)

        return {
            "tasks": [
                {
                    "id": t.id, "title": t.title, "dispatch_type": t.dispatch_type,
                    "status": t.status, "channel_id": t.channel_id,
                    "priority": t.priority, "created_by": t.created_by,
                    "created_at": t.created_at.isoformat() if t.created_at else "",
                    "result_summary": t.result_summary,
                    "assignments": [_assignment_to_dict(a) for a in assigns_by_task.get(t.id, [])],
                }
                for t in tasks
            ],
            "total": total,
        }


@router.get("/tasks/{task_id}")
async def get_dispatch_task(task_id: int, request: Request):
    async with AsyncSessionLocal() as session:
        task = await session.get(DispatchTask, task_id)
        if not task:
            raise HTTPException(404, "Task not found")
        assign_result = await session.execute(
            select(DispatchAssignment).where(DispatchAssignment.task_id == task_id)
        )
        assigns = assign_result.scalars().all()
        return {
            "id": task.id, "title": task.title, "prompt": task.prompt,
            "instructions": task.instructions, "dispatch_type": task.dispatch_type,
            "status": task.status, "channel_id": task.channel_id,
            "priority": task.priority, "timeout_seconds": task.timeout_seconds,
            "created_by": task.created_by,
            "created_at": task.created_at.isoformat() if task.created_at else "",
            "result_summary": task.result_summary,
            "assignments": [_assignment_to_dict(a) for a in assigns],
        }


@router.post("/tasks/{task_id}/cancel")
async def cancel_dispatch_task(task_id: int, request: Request):
    async with AsyncSessionLocal() as session:
        task = await session.get(DispatchTask, task_id)
        if not task:
            raise HTTPException(404, "Task not found")
        if task.status in ("completed", "failed", "cancelled"):
            raise HTTPException(409, f"Cannot cancel task in {task.status} state")
        assign_result = await session.execute(
            select(DispatchAssignment).where(DispatchAssignment.task_id == task_id)
            .where(DispatchAssignment.status.in_(["pending", "notified", "confirmed", "executing"]))
        )
        orch_url = _orch_url(request)
        orch_key = _orch_key(request)
        for a in assign_result.scalars().all():
            if a.orchestrator_task_id:
                try:
                    client = request.app.state.orch_client
                    await client.delete(
                        f"{orch_url}/api/v1/tasks/{a.orchestrator_task_id}",
                        headers={"Authorization": f"Bearer {orch_key}"},
                    )
                except Exception as exc:
                    logger.warning("Failed to cancel orchestrator task %s: %s", a.orchestrator_task_id, exc)
            a.status = "failed"
            a.error_message = "Cancelled by admin"
            a.callback_token_hash = None
        task.status = "cancelled"
        task.updated_at = datetime.now(timezone.utc)
        await session.commit()
    return {"status": "cancelled"}


# ── Callbacks (called by dispatch_confirm tool on agents) ────

@router.post("/callback/confirm")
async def callback_confirm(req: CallbackConfirmRequest, request: Request):
    async with AsyncSessionLocal() as session:
        assignment = await _verify_token(session, req.assignment_id, req.callback_token)
        if assignment.status not in ("pending", "notified"):
            raise HTTPException(409, f"Assignment in {assignment.status} state, cannot confirm")
        assignment.status = "confirmed"
        assignment.profile_name = req.profile_name
        assignment.profile_source = req.profile_source
        assignment.user_confirmed_at = datetime.now(timezone.utc)
        await session.commit()
    return {"status": "confirmed"}


@router.post("/callback/reject")
async def callback_reject(req: CallbackRejectRequest, request: Request):
    async with AsyncSessionLocal() as session:
        assignment = await _verify_token(session, req.assignment_id, req.callback_token)
        if assignment.status not in ("pending", "notified"):
            raise HTTPException(409, f"Assignment in {assignment.status} state, cannot reject")
        assignment.status = "rejected"
        assignment.user_confirmed_at = datetime.now(timezone.utc)
        await session.commit()
    return {"status": "rejected"}


@router.post("/callback/result")
async def callback_result(req: CallbackResultRequest, request: Request):
    async with AsyncSessionLocal() as session:
        assignment = await _verify_and_consume_token(session, req.assignment_id, req.callback_token)
        if assignment.status not in ("confirmed", "executing", "pending"):
            raise HTTPException(409, f"Assignment in {assignment.status} state, cannot submit result")
        assignment.status = "completed" if not req.error else "failed"
        assignment.result_summary = req.result_summary[:5000]
        assignment.result_data = req.result_data
        assignment.error_message = req.error
        assignment.completed_at = datetime.now(timezone.utc)
        assignment.profile_name = req.profile_name
        assignment.profile_source = req.profile_source
        await session.commit()
        await _update_dispatch_task_status(session, assignment.task_id)
        await session.commit()
    return {"status": "ok"}


# ── Orchestrator Callback (called by orchestrator _send_callback) ──

@router.post("/callback/orchestrator")
async def callback_orchestrator(req: OrchestratorCallbackRequest, request: Request):
    """Receive task completion callback from orchestrator.

    Verifies HMAC signature, finds the assignment by orchestrator_task_id,
    and updates status based on the orchestrator's reported state.
    """
    import hmac as _hmac

    body = await request.body()
    orch_key = _orch_key(request)
    expected_sig = _hmac.new(orch_key.encode(), body, hashlib.sha256).hexdigest()
    received_sig = request.headers.get("X-Hermes-Signature", "").replace("sha256=", "")
    if not _hmac.compare_digest(expected_sig, received_sig):
        raise HTTPException(403, "invalid_signature")

    orch_task_id = req.task_id
    if not orch_task_id:
        raise HTTPException(400, "missing task_id")

    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(DispatchAssignment).where(
                DispatchAssignment.orchestrator_task_id == orch_task_id
            )
        )
        assignment = result.scalar_one_or_none()
        if not assignment:
            logger.warning("Orchestrator callback for unknown task %s", orch_task_id)
            raise HTTPException(404, "assignment not found")

        if assignment.status in ("completed", "failed", "cancelled", "expired"):
            return {"status": "already_terminal", "current": assignment.status}

        if req.status == "done":
            assignment.status = "completed"
            assignment.completed_at = datetime.now(timezone.utc)
            if req.result:
                summary = req.result.get("summary") or req.result.get("output") or ""
                assignment.result_summary = str(summary)[:5000]
                assignment.result_data = req.result
        elif req.status == "failed":
            assignment.status = "failed"
            assignment.error_message = str(req.result or "orchestrator reported failure")[:500]
            assignment.completed_at = datetime.now(timezone.utc)
        else:
            logger.info("Orchestrator callback status=%s for task %s, no state change", req.status, orch_task_id)
            return {"status": "ignored", "orchestrator_status": req.status}

        await session.commit()
        await _update_dispatch_task_status(session, assignment.task_id)
        await session.commit()

    return {"status": "updated"}


# ── Helpers ──────────────────────────────────────────────────

NAMESPACE = "hermes-agent"



async def _get_kanban_auth(agent_number: int) -> tuple[str, str] | None:
    """Get (webui_url, api_key) for an agent's kanban API, with TTL cache."""
    now = time.monotonic()
    cached = _kanban_auth_cache.get(agent_number)
    if cached and now - cached[0] < _AUTH_CACHE_TTL:
        return cached[1]

    import base64
    from templates import deployment_name

    svc = deployment_name(agent_number)
    webui_url = f"http://{svc}.{NAMESPACE}.svc.cluster.local:6060"

    try:
        from main import k8s as _k8s
        secret = await _k8s.get_secret(f"{svc}-secret")
        if not secret or not secret.data or "api_key" not in secret.data:
            return None
        api_key = base64.b64decode(secret.data["api_key"]).decode()
        result = (webui_url, api_key)
        _kanban_auth_cache[agent_number] = (now, result)
        return result
    except Exception as exc:
        logger.warning("Failed to get kanban auth for agent %s: %s", agent_number, exc)
        return None


async def _kanban_create_and_dispatch(agent_number: int, title: str, body: str) -> str | None:
    """Create a kanban task and trigger dispatch via agent WebUI kanban API.

    Returns the kanban task ID if successful, None otherwise.
    """
    auth = await _get_kanban_auth(agent_number)
    if not auth:
        return None
    webui_url, api_key = auth
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            # 1. Create kanban task
            create_resp = await client.post(
                f"{webui_url}/api/hermes/kanban",
                json={"title": title, "body": body},
                headers=headers,
            )
            if create_resp.status_code not in (200, 201):
                logger.warning("Kanban create task failed for agent %s: %s", agent_number, create_resp.text[:200])
                return None

            kanban_task_id = create_resp.json().get("task", {}).get("id")
            logger.info("Kanban task created for agent %s: %s", agent_number, kanban_task_id)

            # 2. Trigger dispatch so agent picks up the task
            dispatch_resp = await client.post(
                f"{webui_url}/api/hermes/kanban/dispatch?board=default",
                json={},
                headers=headers,
            )
            if dispatch_resp.status_code in (200, 201):
                logger.info("Kanban dispatch triggered for agent %s, task %s", agent_number, kanban_task_id)
            else:
                logger.warning("Kanban dispatch failed for agent %s: %s", agent_number, dispatch_resp.text[:200])

            return kanban_task_id
    except Exception as exc:
        logger.warning("Kanban notify to agent %s failed: %s", agent_number, exc)
        return None


async def _mark_assignment_failed(assignment_id: int, error_message: str) -> None:
    """Mark an assignment as failed and roll up parent task status."""
    async with AsyncSessionLocal() as session:
        assignment = await session.get(DispatchAssignment, assignment_id)
        if assignment and assignment.status not in ("completed", "failed", "cancelled"):
            assignment.status = "failed"
            assignment.error_message = error_message[:500]
            assignment.completed_at = datetime.now(timezone.utc)
            await session.commit()
            await _update_dispatch_task_status(session, assignment.task_id)
            await session.commit()


async def _poll_kanban_status(agent_number: int, kanban_task_id: str, assignment_id: int):
    """Background task: poll kanban API until task completes, then update assignment."""
    _active_pollers.add(assignment_id)
    try:
        auth = await _get_kanban_auth(agent_number)
        if not auth:
            return
        webui_url, api_key = auth
        headers = {"Authorization": f"Bearer {api_key}"}
        max_polls = 120  # ~20 minutes max (120 * 10s)
        consecutive_errors = 0

        async with httpx.AsyncClient(timeout=15.0) as client:
            for _ in range(max_polls):
                await asyncio.sleep(10)
                try:
                    resp = await client.get(
                        f"{webui_url}/api/hermes/kanban/{kanban_task_id}",
                        headers=headers,
                    )
                    consecutive_errors = 0  # reset on success

                    if resp.status_code == 404:
                        await _mark_assignment_failed(assignment_id, "Kanban task deleted")
                        return
                    if resp.status_code != 200:
                        continue

                    data = resp.json()
                    task = data.get("task", data)
                    kb_status = task.get("status", "")
                    result = task.get("result")

                    async with AsyncSessionLocal() as session:
                        assignment = await session.get(DispatchAssignment, assignment_id)
                        if not assignment or assignment.status in ("completed", "failed", "cancelled"):
                            return  # already terminal

                        if kb_status == "running" and assignment.status != "executing":
                            assignment.status = "executing"
                            assignment.started_at = datetime.now(timezone.utc)
                            await session.commit()
                        elif kb_status in ("done", "archived"):
                            assignment.status = "completed"
                            assignment.completed_at = datetime.now(timezone.utc)
                            if result:
                                assignment.result_summary = str(result)[:5000]
                            await session.commit()
                            await _update_dispatch_task_status(session, assignment.task_id)
                            await session.commit()
                            logger.info("Assignment %d completed via kanban poll", assignment_id)
                            return
                except Exception as exc:
                    consecutive_errors += 1
                    logger.warning("Poll kanban %s error (%d): %s", kanban_task_id, consecutive_errors, exc)
                    if consecutive_errors >= 10:
                        await _mark_assignment_failed(assignment_id, f"Polling failed: {exc}")
                        return

        # Timeout
        await _mark_assignment_failed(assignment_id, "Kanban task polling timed out")
    finally:
        _active_pollers.discard(assignment_id)

async def _verify_token(session, assignment_id: int, token: str) -> DispatchAssignment:
    """Verify callback token without consuming it. Used for confirm/reject."""
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    result = await session.execute(
        select(DispatchAssignment).where(
            DispatchAssignment.id == assignment_id,
            DispatchAssignment.callback_token_hash == token_hash,
        )
    )
    assignment = result.scalar_one_or_none()
    if not assignment:
        raise HTTPException(403, "invalid_token")
    return assignment


async def _verify_and_consume_token(session, assignment_id: int, token: str) -> DispatchAssignment:
    """Verify callback token and atomically consume it. Used for final result."""
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    result = await session.execute(
        text("""
            UPDATE dispatch_assignments
            SET callback_token_hash = NULL, updated_at = NOW()
            WHERE id = :aid AND callback_token_hash = :hash
        """),
        {"aid": assignment_id, "hash": token_hash},
    )
    if result.rowcount != 1:
        raise HTTPException(403, "invalid_token")
    await session.flush()
    assignment = await session.get(DispatchAssignment, assignment_id)
    if not assignment:
        raise HTTPException(404, "Assignment not found")
    return assignment


async def _update_dispatch_task_status(session, task_id: int):
    """Update parent DispatchTask status based on assignment states."""
    task = await session.get(DispatchTask, task_id)
    if not task:
        return
    result = await session.execute(
        select(DispatchAssignment.status)
        .where(DispatchAssignment.task_id == task_id)
    )
    statuses = [row[0] for row in result.all()]
    if not statuses:
        return
    terminal = {"completed", "failed", "rejected", "expired"}
    if all(s in terminal for s in statuses):
        completed = sum(1 for s in statuses if s == "completed")
        task.status = "completed" if completed > 0 else "failed"
        task.result_summary = f"{completed}/{len(statuses)} completed"
        task.updated_at = datetime.now(timezone.utc)


def _assignment_to_dict(a: DispatchAssignment) -> dict:
    return {
        "id": a.id, "agent_number": a.agent_number, "status": a.status,
        "profile_name": a.profile_name, "profile_source": a.profile_source,
        "orchestrator_task_id": a.orchestrator_task_id,
        "started_at": a.started_at.isoformat() if a.started_at else None,
        "completed_at": a.completed_at.isoformat() if a.completed_at else None,
        "result_summary": a.result_summary, "error_message": a.error_message,
    }


# ── User-mode endpoints (no admin_only, uses agent_number from auth) ──

@router.get("/my-tasks")
async def my_tasks(request: Request):
    """List dispatched tasks for the current user's agent (user mode)."""
    agent_number = getattr(request.state, "agent_id", None)
    if agent_number is None:
        raise HTTPException(403, "agent_id required")

    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(DispatchAssignment)
            .where(DispatchAssignment.agent_number == agent_number)
            .order_by(desc(DispatchAssignment.id))
            .limit(50)
        )
        assignments = result.scalars().all()
        if not assignments:
            return {"tasks": []}

        task_ids = list({a.task_id for a in assignments})
        task_result = await session.execute(
            select(DispatchTask).where(DispatchTask.id.in_(task_ids))
        )
        tasks_by_id = {t.id: t for t in task_result.scalars().all()}

        return {
            "tasks": [
                {
                    "assignment_id": a.id,
                    "task_id": a.task_id,
                    "title": tasks_by_id.get(a.task_id, DispatchTask(title="")).title,
                    "prompt": tasks_by_id.get(a.task_id, DispatchTask(prompt="")).prompt,
                    "instructions": tasks_by_id.get(a.task_id, DispatchTask(instructions="")).instructions,
                    "status": a.status,
                    "created_at": tasks_by_id.get(a.task_id, DispatchTask(created_at=None)).created_at.isoformat() if tasks_by_id.get(a.task_id) and tasks_by_id[a.task_id].created_at else None,
                    "result_summary": a.result_summary,
                    "completed_at": a.completed_at.isoformat() if a.completed_at else None,
                }
                for a in assignments
            ],
        }


@router.post("/my-tasks/{assignment_id}/confirm")
async def my_task_confirm(assignment_id: int, request: Request):
    """User confirms a dispatched task assignment."""
    agent_number = getattr(request.state, "agent_id", None)
    if agent_number is None:
        raise HTTPException(403, "agent_id required")

    async with AsyncSessionLocal() as session:
        assignment = await session.get(DispatchAssignment, assignment_id)
        if not assignment or assignment.agent_number != agent_number:
            raise HTTPException(404, "Assignment not found")
        if assignment.status not in ("pending", "notified"):
            raise HTTPException(409, f"Assignment in {assignment.status} state")
        assignment.status = "confirmed"
        assignment.user_confirmed_at = datetime.now(timezone.utc)
        # Fetch task info for the kanban dispatch
        task = await session.get(DispatchTask, assignment.task_id)
        await session.commit()

    # Dispatch to agent via kanban API so it auto-executes
    if task:
        body_text = f"用户已确认执行分派任务 #{task.id}: {task.title}\n\n{task.prompt}"
        if task.instructions:
            body_text += f"\n\n---\n{task.instructions}"
        kanban_task_id = await _kanban_create_and_dispatch(agent_number, task.title, body_text)
        if kanban_task_id:
            # Persist kanban_task_id for recovery after restart
            async with AsyncSessionLocal() as session:
                a = await session.get(DispatchAssignment, assignment_id)
                if a:
                    a.kanban_task_id = kanban_task_id
                    await session.commit()
            # Start background polling to sync kanban status back
            if assignment_id not in _active_pollers:
                asyncio.create_task(_poll_kanban_status(agent_number, kanban_task_id, assignment_id))

    return {"status": "confirmed"}


@router.post("/my-tasks/{assignment_id}/reject")
async def my_task_reject(assignment_id: int, request: Request):
    """User rejects a dispatched task assignment."""
    agent_number = getattr(request.state, "agent_id", None)
    if agent_number is None:
        raise HTTPException(403, "agent_id required")

    async with AsyncSessionLocal() as session:
        assignment = await session.get(DispatchAssignment, assignment_id)
        if not assignment or assignment.agent_number != agent_number:
            raise HTTPException(404, "Assignment not found")
        if assignment.status not in ("pending", "notified"):
            raise HTTPException(409, f"Assignment in {assignment.status} state")
        assignment.status = "rejected"
        assignment.user_confirmed_at = datetime.now(timezone.utc)
        await session.commit()
    return {"status": "rejected"}


# ── Kanban poller recovery (called on app startup) ────────────

async def recover_kanban_pollers():
    """Resume polling for assignments interrupted by server restart."""
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(DispatchAssignment)
            .where(
                DispatchAssignment.status.in_(["confirmed", "executing"]),
                DispatchAssignment.kanban_task_id.isnot(None),
            )
        )
        for a in result.scalars().all():
            if a.id not in _active_pollers:
                asyncio.create_task(_poll_kanban_status(a.agent_number, a.kanban_task_id, a.id))
                logger.info("Recovered kanban poller for assignment %d (task %s)", a.id, a.kanban_task_id)
