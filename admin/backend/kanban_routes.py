"""Kanban proxy routes -- forwards admin requests to agent Dashboard sidecars."""
import asyncio
import json
import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException, Path, Request
from sqlalchemy import select
from starlette.responses import Response as StarletteResponse

from auth import auth, get_effective_agent_id
from templates import deployment_name

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agents/{agent_id}/kanban", tags=["kanban"])

NAMESPACE = "hermes-agent"
_CLIENT_TIMEOUT = httpx.Timeout(15.0, connect=5.0)
_dashboard_cache: dict[str, httpx.AsyncClient] = {}
_cache_lock = asyncio.Lock()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_CLIENT_LIMITS = httpx.Limits(max_connections=10, max_keepalive_connections=5)
_MAX_BODY_SIZE = 1 << 20  # 1 MiB


def _dashboard_url(agent_id: int) -> str:
    svc = deployment_name(agent_id)
    return f"http://{svc}.{NAMESPACE}.svc.cluster.local:9119"


async def _get_client(base_url: str) -> httpx.AsyncClient:
    async with _cache_lock:
        if base_url not in _dashboard_cache:
            _dashboard_cache[base_url] = httpx.AsyncClient(
                base_url=base_url, timeout=_CLIENT_TIMEOUT, limits=_CLIENT_LIMITS,
            )
        return _dashboard_cache[base_url]


async def close_dashboard_clients():
    """Close all cached httpx clients. Call on app shutdown."""
    async with _cache_lock:
        for client in _dashboard_cache.values():
            await client.aclose()
        _dashboard_cache.clear()


async def _proxy(
    request: Request,
    agent_id: int,
    path: str,
) -> StarletteResponse:
    """Forward a request to the dashboard sidecar.

    Preserves method, query params, body, and content-type.
    Returns 502 JSON when the sidecar is unreachable.
    """
    base_url = _dashboard_url(agent_id)
    client = await _get_client(base_url)

    body = await request.body()
    if len(body) > _MAX_BODY_SIZE:
        raise HTTPException(status_code=413, detail="Request body too large")
    resp: httpx.Response | None = None
    try:
        resp = await client.request(
            method=request.method,
            url=path,
            params=dict(request.query_params),
            content=body or None,
            headers={
                k: v
                for k, v in request.headers.items()
                if k.lower() in ("content-type", "accept")
            },
        )
    except httpx.ConnectError as exc:
        logger.warning("Kanban dashboard unreachable for agent %s: %s", agent_id, exc)
        raise HTTPException(
            status_code=502,
            detail=f"Kanban dashboard unavailable for agent {agent_id}",
        )
    except httpx.TimeoutException as exc:
        logger.warning("Kanban dashboard timeout for agent %s: %s", agent_id, exc)
        raise HTTPException(
            status_code=504,
            detail=f"Kanban dashboard timed out for agent {agent_id}",
        )
    except httpx.HTTPError as exc:
        logger.error("Unexpected httpx error for agent %s: %s", agent_id, exc)
        raise HTTPException(
            status_code=502,
            detail=f"Kanban dashboard error for agent {agent_id}",
        )

    return StarletteResponse(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type"),
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/board", dependencies=[auth])
async def kanban_board(request: Request, agent_id: int) -> StarletteResponse:
    """Proxy: GET board state."""
    return await _proxy(request, get_effective_agent_id(request, agent_id), "/api/plugins/kanban/board")


@router.get("/tasks", dependencies=[auth])
async def kanban_list_tasks(request: Request, agent_id: int) -> StarletteResponse:
    """Proxy: GET all tasks (flattened from board columns)."""
    return await _proxy(request, get_effective_agent_id(request, agent_id), "/api/plugins/kanban/board")


@router.get("/tasks/{task_id}", dependencies=[auth])
async def kanban_get_task(request: Request, agent_id: int, task_id: str = Path(..., pattern=r"^[a-zA-Z0-9_-]{1,128}$")) -> StarletteResponse:
    """Proxy: GET single task."""
    return await _proxy(request, get_effective_agent_id(request, agent_id), f"/api/plugins/kanban/tasks/{task_id}")


@router.post("/tasks", dependencies=[auth])
async def kanban_create_task(request: Request, agent_id: int) -> StarletteResponse:
    """Proxy: POST create task."""
    return await _proxy(request, get_effective_agent_id(request, agent_id), "/api/plugins/kanban/tasks")


@router.patch("/tasks/{task_id}", dependencies=[auth])
async def kanban_update_task(request: Request, agent_id: int, task_id: str = Path(..., pattern=r"^[a-zA-Z0-9_-]{1,128}$")) -> StarletteResponse:
    """Proxy: PATCH update task."""
    return await _proxy(request, get_effective_agent_id(request, agent_id), f"/api/plugins/kanban/tasks/{task_id}")


@router.delete("/tasks/{task_id}", dependencies=[auth])
async def kanban_delete_task(request: Request, agent_id: int, task_id: str = Path(..., pattern=r"^[a-zA-Z0-9_-]{1,128}$")) -> StarletteResponse:
    """Proxy: DELETE task."""
    return await _proxy(request, get_effective_agent_id(request, agent_id), f"/api/plugins/kanban/tasks/{task_id}")


@router.post("/tasks/{task_id}/comments", dependencies=[auth])
async def kanban_add_comment(request: Request, agent_id: int, task_id: str = Path(..., pattern=r"^[a-zA-Z0-9_-]{1,128}$")) -> StarletteResponse:
    """Proxy: POST add comment to task."""
    return await _proxy(request, get_effective_agent_id(request, agent_id), f"/api/plugins/kanban/tasks/{task_id}/comments")


@router.get("/stats", dependencies=[auth])
async def kanban_stats(request: Request, agent_id: int) -> StarletteResponse:
    """Proxy: GET kanban statistics."""
    return await _proxy(request, get_effective_agent_id(request, agent_id), "/api/plugins/kanban/stats")


@router.get("/assignees", dependencies=[auth])
async def kanban_assignees(request: Request, agent_id: int) -> StarletteResponse:
    """Proxy: GET known assignee profiles and their task counts.

    Auto-discovers profiles reported by the sidecar, syncing them with the
    DB agent_profiles table and provisioning missing config files on the pod.
    """
    eff_id = get_effective_agent_id(request, agent_id)
    resp = await _proxy(request, eff_id, "/api/plugins/kanban/assignees")

    if resp.status_code != 200:
        return resp

    # Parse sidecar response
    try:
        data = json.loads(resp.body)
        assignees = data.get("assignees", []) if isinstance(data, dict) else []
    except (json.JSONDecodeError, AttributeError):
        return resp

    # Auto-discover: sync sidecar assignees with DB agent_profiles
    try:
        await _auto_discover_profiles(eff_id, assignees)
        # Re-fetch to get updated on_disk status after sync
        return await _proxy(request, eff_id, "/api/plugins/kanban/assignees")
    except Exception as exc:
        logger.warning("Auto-discover failed for agent %s: %s", eff_id, exc)
        return resp


async def _auto_discover_profiles(agent_number: int, assignees: list[dict]):
    """Sync sidecar assignees with DB agent_profiles table."""
    import re

    from database import AsyncSessionLocal
    from db_models import AgentProfile, ProfileTemplate
    from profile_utils import get_sync_lock, sync_profile_to_pod

    async with AsyncSessionLocal() as session:
        # Get existing profiles for this agent
        result = await session.execute(
            select(AgentProfile).where(AgentProfile.agent_number == agent_number)
        )
        existing = {p.profile_name: p for p in result.scalars().all()}

        # Get all templates for matching
        tmpl_result = await session.execute(select(ProfileTemplate))
        templates = {t.name: t for t in tmpl_result.scalars().all()}

        need_sync = []  # profile IDs to sync after commit

        for a in assignees:
            name = a.get("name") if isinstance(a, dict) else None
            if not name or name == "default":
                continue
            if not re.match(r"^[a-zA-Z0-9_-]{1,64}$", name):
                logger.warning("Skipping assignee with invalid name: %s", name)
                continue

            on_disk = a.get("on_disk", False) if isinstance(a, dict) else False

            if name in existing:
                # DB record exists — re-sync if pod doesn't have the files
                profile = existing[name]
                needs_resync = not on_disk
                if needs_resync:
                    need_sync.append(profile.id)
            else:
                # No DB record — create one
                template = templates.get(name)
                profile = AgentProfile(
                    agent_number=agent_number,
                    profile_name=name,
                    template_id=template.id if template else None,
                    display_name=template.display_name if template else "",
                    config_overrides=template.config_overrides if template else {},
                    soul_md=template.soul_md if template else None,
                    sync_status="pending",
                )
                session.add(profile)
                await session.flush()  # Get the ID without committing
                if not on_disk:
                    need_sync.append(profile.id)

        # Single commit for all new profiles
        await session.commit()

    # Sync outside the transaction to avoid holding DB session during K8s I/O
    for profile_id in need_sync:
        # Look up profile_name for lock key (short-lived session, no heavy I/O)
        async with AsyncSessionLocal() as lookup:
            r = await lookup.execute(
                select(AgentProfile.profile_name).where(AgentProfile.id == profile_id)
            )
            row = r.fetchone()
            if row is None:
                continue
            p_name = row[0]

        # Acquire per-profile lock BEFORE opening sync session
        lock = get_sync_lock(agent_number, p_name)
        async with lock:
            async with AsyncSessionLocal() as session:
                result = await session.execute(
                    select(AgentProfile).where(AgentProfile.id == profile_id)
                )
                fresh = result.scalar_one_or_none()
                if fresh is None:
                    continue

                # Re-fetch template in fresh session
                template = None
                if fresh.template_id is not None:
                    template = await session.get(ProfileTemplate, fresh.template_id)

                await sync_profile_to_pod(agent_number, fresh, template, session)


@router.post("/dispatch", dependencies=[auth])
async def kanban_dispatch(request: Request, agent_id: int) -> StarletteResponse:
    """Proxy: POST dispatch task assignment."""
    return await _proxy(request, get_effective_agent_id(request, agent_id), "/api/plugins/kanban/dispatch")
