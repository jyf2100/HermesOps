"""Skills Hub REST API — search, browse, install, uninstall, update, audit.

Mounted at /admin/api/hub/* and /admin/api/agents/{id}/hub/* via
``app.include_router(hub_router)`` in main.py.

Read-only endpoints (search, browse, fetch, cache, sources) use standard auth.
Agent-level mutation endpoints (install, uninstall, update) require admin_only.
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import re
import tarfile
import time
from dataclasses import dataclass, field
from collections.abc import Coroutine
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from auth import AuthContext, get_current_user
from tools.skills_hub_core import (
    GitHubAuth,
    SkillBundle,
    SkillMeta,
    SkillSource,
    bundle_content_hash,
    create_source_router,
    parallel_search_sources,
    unified_search,
)
from tools.skills_guard import scan_skill

from hub_cache import get_cached, invalidate as cache_invalidate, store, store_files, cleanup
from k8s_client import K8sClient
from templates import deployment_name

logger = logging.getLogger("hermes-admin.hub_routes")

router = APIRouter(prefix="/hub", tags=["hub"])

SKILLS_ROOT = "/opt/data/skills"
LOCK_DIR = f"{SKILLS_ROOT}/.hub"
LOCK_FILE = f"{LOCK_DIR}/lock.json"
LOCK_LOCKFILE = f"{LOCK_DIR}/lock.lockfile"

# ---------------------------------------------------------------------------
# Auth dependency — uses centralized auth.py for dual-mode support
# ---------------------------------------------------------------------------

async def _verify_hub_auth(request: Request) -> AuthContext:
    """Authenticate using admin key, user token, or email token.

    Delegates to auth.get_current_user but passes headers manually since
    this is used as a Depends() and needs access to all three header types.
    """
    ctx = await get_current_user(
        x_admin_key=request.headers.get("X-Admin-Key", ""),
        x_user_token=request.headers.get("X-User-Token", ""),
        x_email_token=request.headers.get("X-Email-Token", ""),
        request=request,
    )
    # Store context so GET handlers can check agent scope later
    request.state.hub_auth = ctx
    if ctx.agent_id is not None:
        request.state.agent_id = ctx.agent_id
    return ctx


async def _verify_hub_mutation(
    request: Request,
    ctx: AuthContext = Depends(_verify_hub_auth),
) -> AuthContext:
    """Auth for mutation endpoints: admin OK, user must own the agent."""
    if not ctx.is_admin:
        if ctx.agent_id is None:
            raise HTTPException(status_code=403, detail="No agent association")
        try:
            url_agent_id = int(request.path_params["agent_id"])
        except (KeyError, ValueError):
            raise HTTPException(status_code=400, detail="Invalid agent_id")
        if ctx.agent_id != url_agent_id:
            raise HTTPException(status_code=403, detail="Access denied for this agent")
    return ctx


def _hub_check_agent_scope(request: Request, agent_id: int) -> None:
    """Verify the authenticated user has access to this agent_id.
    
    For GET endpoints that use _verify_hub_auth (not _verify_hub_mutation),
    this adds the same ownership check that mutation endpoints already have.
    """
    ctx: AuthContext | None = getattr(request.state, "hub_auth", None)
    if ctx is None:
        return
    if not ctx.is_admin and ctx.agent_id is not None and ctx.agent_id != agent_id:
        raise HTTPException(status_code=403, detail="Not authorized for this agent")

# ---------------------------------------------------------------------------
# K8s client accessor
# ---------------------------------------------------------------------------

def _k8s(request: Request) -> K8sClient:
    return request.app.state.k8s


async def _resolve_skill_dir(k8s: K8sClient, pod: str, agent_id: int, skill_name: str) -> str | None:
    """Find the actual directory for a skill on the pod.
    Checks DB first for the known path, then falls back to flat SKILLS_ROOT/{name}."""
    from database import AsyncSessionLocal
    from db_models import AgentSkill as AgentSkillORM
    from sqlalchemy import select
    try:
        async with AsyncSessionLocal() as session:
            row = (await session.execute(
                select(AgentSkillORM.skill_dir).where(
                    AgentSkillORM.agent_number == agent_id,
                    AgentSkillORM.skill_name == skill_name,
                )
            )).scalar_one_or_none()
            if row:
                return row
    except Exception:
        logger.warning("DB lookup failed for skill_dir (agent=%d, skill=%s)", agent_id, skill_name, exc_info=True)
    # Fallback: flat path
    fallback = f"{SKILLS_ROOT}/{skill_name}"
    entries = await k8s.list_dir(pod, fallback)
    return fallback if entries else None


def _validate_skill_path(path: str, skill_name: str) -> str:
    """Validate a skill directory path is safe for rm -rf.

    Must be under SKILLS_ROOT, no traversal, and match expected skill name.
    """
    if not path.startswith(SKILLS_ROOT):
        raise ValueError(f"Skill path {path!r} is outside {SKILLS_ROOT}")
    rel = path[len(SKILLS_ROOT):].lstrip("/")
    if not rel:
        raise ValueError("Refusing to delete SKILLS_ROOT itself")
    if ".." in rel.split("/"):
        raise ValueError(f"Path traversal in skill path: {path}")
    # The last path segment should match the skill name (or be a parent dir containing it)
    segments = rel.split("/")
    if skill_name not in segments:
        raise ValueError(f"Path {path!r} does not match skill {skill_name!r}")
    return path


# ---------------------------------------------------------------------------
# Lazy source initialization
# ---------------------------------------------------------------------------

_sources: Optional[list[SkillSource]] = None


def _get_sources() -> list[SkillSource]:
    global _sources
    if _sources is None:
        auth = GitHubAuth()
        _sources = create_source_router(auth=auth)
        logger.info("Initialized %d skill sources: %s", len(_sources), [s.source_id() for s in _sources])
    return _sources


# ---------------------------------------------------------------------------
# Per-pod async locks
# ---------------------------------------------------------------------------

_pod_locks: dict[str, asyncio.Lock] = {}


def _get_pod_lock(pod_name: str) -> asyncio.Lock:
    return _pod_locks.setdefault(pod_name, asyncio.Lock())


# ---------------------------------------------------------------------------
# HubTask — in-memory async task tracking
# ---------------------------------------------------------------------------

@dataclass
class HubTask:
    task_id: str
    agent_id: int
    status: str  # pending | fetching | scanning | writing | verifying | completed | failed
    progress: float = 0.0
    phase: str = ""
    result: Optional[dict] = None
    error: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    ttl: int = 3600

    def is_expired(self) -> bool:
        return time.time() - self.created_at > self.ttl


_tasks: dict[str, HubTask] = {}
_tasks_lock = asyncio.Lock()


def _purge_expired_tasks() -> None:
    expired = [tid for tid, t in _tasks.items() if t.is_expired()]
    for tid in expired:
        del _tasks[tid]


async def _create_task(agent_id: int, prefix: str = "install") -> HubTask:
    tid = f"{prefix}-{os.urandom(6).hex()}"
    task = HubTask(task_id=tid, agent_id=agent_id, status="pending", phase="Initializing")
    async with _tasks_lock:
        _purge_expired_tasks()
        _tasks[tid] = task
    return task


async def _get_task(task_id: str) -> Optional[HubTask]:
    async with _tasks_lock:
        _purge_expired_tasks()
        task = _tasks.get(task_id)
        if task and task.is_expired():
            del _tasks[task_id]
            return None
        return task


# ---------------------------------------------------------------------------
# Pod resolution helpers
# ---------------------------------------------------------------------------

async def _resolve_pod(k8s: K8sClient, agent_id: int) -> str:
    """Return the pod name for a running agent. Raises HTTPException if unavailable."""
    dname = deployment_name(agent_id)
    pods = await k8s.get_pods_for_deployment(dname)
    for p in pods:
        if p.status.phase == "Running":
            return p.metadata.name
    raise HTTPException(status_code=409, detail="Agent pod is not running")


def _validate_skill_name(name: str) -> str:
    """Reject path traversal and illegal characters in skill names."""
    if not name or not re.match(r'^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$', name):
        raise HTTPException(status_code=400, detail=f"Invalid skill name: {name}")
    if '..' in name or '/' in name:
        raise HTTPException(status_code=400, detail="Skill name must not contain '..' or '/'")
    return name


def _safe_rel_path(rel_path: str) -> str:
    """Validate a relative file path inside a skill bundle. Prevents zip-slip."""
    if not rel_path:
        raise ValueError("Empty file path")
    if rel_path.startswith("/") or ".." in rel_path.split("/") or "\x00" in rel_path:
        raise ValueError(f"Unsafe file path in bundle: {rel_path}")
    return rel_path


# ---------------------------------------------------------------------------
# Lock file operations on pod (via K8s exec)
# ---------------------------------------------------------------------------

async def _read_lock_json(k8s: K8sClient, pod: str) -> dict:
    """Read lock.json from pod. Returns empty dict if not found."""
    try:
        raw, _ = await k8s.run_command(pod, ["cat", LOCK_FILE])
        return json.loads(raw) if raw.strip() else {}
    except Exception:
        return {}


async def _ensure_lock_dir(k8s: K8sClient, pod: str) -> None:
    """Create .hub directory inside skills root on pod."""
    await k8s.run_command(pod, ["mkdir", "-p", LOCK_DIR])


async def _atomic_update_lock(k8s: K8sClient, pod: str, lock_data: dict) -> None:
    """Write lock.json atomically using flock on pod. Uses base64 to avoid shell injection."""
    await _ensure_lock_dir(k8s, pod)
    payload = json.dumps(lock_data, indent=2, ensure_ascii=False)
    b64 = base64.b64encode(payload.encode("utf-8")).decode("ascii")
    script = (
        f"flock {LOCK_LOCKFILE} -c \""
        f"echo '{b64}' | base64 -d > {LOCK_FILE}.tmp && "
        f"mv {LOCK_FILE}.tmp {LOCK_FILE}\""
    )
    stdout, stderr = await k8s.run_command(pod, ["sh", "-c", script])
    if stderr and "error" in stderr.lower():
        raise RuntimeError(f"Failed to update lock.json: {stderr}")


# ---------------------------------------------------------------------------
# Tar pipe batch write
# ---------------------------------------------------------------------------

async def _tar_write_to_pod(k8s: K8sClient, pod: str, skill_name: str, files: dict[str, bytes]) -> int:
    """Pack skill files into tar.gz and write to pod via single exec."""
    buf = io.BytesIO()
    safe_files = 0
    with tarfile.open(fileobj=buf, mode='w:gz') as tar:
        for fname, content in files.items():
            safe_fname = _safe_rel_path(fname)
            raw = content if isinstance(content, bytes) else content.encode("utf-8")
            info = tarfile.TarInfo(name=f"{skill_name}/{safe_fname}")
            info.size = len(raw)
            info.mtime = time.time()
            tar.addfile(info, io.BytesIO(raw))
            safe_files += 1
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    # Split into chunks to avoid shell argument length limits (~128KB)
    chunk_size = 60000
    if len(b64) <= chunk_size:
        cmd = ["sh", "-c", f"echo '{b64}' | base64 -d | tar -xzf - -C {SKILLS_ROOT}/"]
        stdout, stderr = await k8s.run_command(pod, cmd)
    else:
        # Write base64 to a temp file, then decode
        tmp_b64 = "/tmp/_hub_install.b64"
        for i in range(0, len(b64), chunk_size):
            chunk = b64[i:i + chunk_size]
            op = ">" if i == 0 else ">>"
            await k8s.run_command(pod, ["sh", "-c", f"printf '%s' '{chunk}' {op} {tmp_b64}"])
        cmd = ["sh", "-c", f"base64 -d {tmp_b64} | tar -xzf - -C {SKILLS_ROOT}/ && rm -f {tmp_b64}"]
        stdout, stderr = await k8s.run_command(pod, cmd)
    return safe_files


# ---------------------------------------------------------------------------
# Scan helpers
# ---------------------------------------------------------------------------

def _scan_bundle_in_tmpdir(bundle: SkillBundle) -> dict:
    """Run security scan on a skill bundle using a temp directory."""
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory(prefix="hub_scan_") as tmp_dir:
        tmp_path = Path(tmp_dir) / bundle.name
        tmp_path.mkdir(parents=True, exist_ok=True)
        for rel_path, content in bundle.files.items():
            safe_rel = _safe_rel_path(rel_path)
            fp = tmp_path / safe_rel
            fp.parent.mkdir(parents=True, exist_ok=True)
            fp.write_bytes(content) if isinstance(content, bytes) else fp.write_text(content, encoding="utf-8")
        result = scan_skill(tmp_path, source=bundle.source)
        return {
            "verdict": result.verdict,
            "findings": [
                {"pattern_id": f.pattern_id, "severity": f.severity, "category": f.category,
                 "file": f.file, "line": f.line, "description": f.description}
                for f in result.findings
            ],
            "summary": result.summary,
        }


# ---------------------------------------------------------------------------
# DB sync helper — refresh agent_skills after install/uninstall
# ---------------------------------------------------------------------------

async def _refresh_skills_db(k8s: K8sClient, agent_id: int, pod: str) -> None:
    """Re-scan pod skills and sync to DB."""
    from skill_scanner import scan_skills
    from database import AsyncSessionLocal
    from db_models import AgentSkill as AgentSkillORM, AgentMetadata as AgentMetadataORM
    from sqlalchemy import delete

    try:
        scanned = await scan_skills(k8s, pod)
        if scanned is None:
            return

        async with AsyncSessionLocal() as session:
            with session.no_autoflush:
                await session.execute(delete(AgentSkillORM).where(AgentSkillORM.agent_number == agent_id))
                for s in scanned:
                    row = AgentSkillORM(
                        agent_number=agent_id,
                        skill_name=s["name"],
                        description=s.get("description", ""),
                        version=s.get("version", ""),
                        tags=[t.lower() for t in s.get("tags", [])],
                        skill_dir=s.get("skill_dir", ""),
                        content_hash=s.get("content_hash", ""),
                    )
                    session.add(row)
                all_tags = sorted({t.lower() for s in scanned for t in s.get("tags", [])})
                meta = await session.get(AgentMetadataORM, agent_id)
                if meta is None:
                    meta = AgentMetadataORM(agent_number=agent_id, skills=all_tags)
                    session.add(meta)
                else:
                    meta.skills = all_tags
                await session.commit()
    except Exception as exc:
        logger.error("Failed to refresh skills DB for agent %d: %s", agent_id, exc)
        # Don't re-raise — install already succeeded on pod


# ---------------------------------------------------------------------------
# Routes: Global Hub operations (search, browse, fetch, cache, sources)
# ---------------------------------------------------------------------------

@router.get("/search")
async def search_skills(
    q: str = Query("", description="Search query"),
    source: str = Query("all", description="Source filter"),
    limit: int = Query(20, ge=1, le=100),
    _auth: str = Depends(_verify_hub_auth),
):
    sources = _get_sources()
    results = unified_search(q, sources, source_filter=source, limit=limit)
    return {"ok": True, "query": q, "source_filter": source, "count": len(results),
            "results": [_meta_dict(r) for r in results]}


@router.get("/browse")
async def browse_skills(
    source: str = Query("all"),
    limit: int = Query(50, ge=1, le=200),
    _auth: str = Depends(_verify_hub_auth),
):
    sources = _get_sources()
    all_results, source_counts, timed_out = parallel_search_sources(
        sources, query="", source_filter=source, overall_timeout=30)
    return {"ok": True, "source_filter": source, "count": len(all_results),
            "source_counts": source_counts, "timed_out": timed_out,
            "results": [_meta_dict(r) for r in all_results[:limit]]}


@router.get("/fetch/{skill_name:path}")
async def fetch_skill(
    skill_name: str,
    source: str = Query(""),
    identifier: str = Query(""),
    _auth: str = Depends(_verify_hub_auth),
):
    skill_name = _validate_skill_name(skill_name)
    cached_skill = await get_cached(skill_name)
    if cached_skill is not None:
        return {"ok": True, "cached": True, "name": cached_skill.name, "source": cached_skill.source,
                "identifier": cached_skill.identifier, "trust_level": cached_skill.trust_level,
                "file_count": cached_skill.file_count, "total_size": cached_skill.total_size,
                "content_hash": cached_skill.content_hash,
                "fetched_at": cached_skill.fetched_at.isoformat()}

    sources = _get_sources()
    bundle = None
    for src in sources:
        try:
            bundle = src.fetch(identifier or skill_name)
            if bundle is not None:
                break
        except Exception:
            continue

    if bundle is None:
        raise HTTPException(status_code=404, detail=f"Skill '{skill_name}' not found in any source")

    scan_result = await asyncio.to_thread(_scan_bundle_in_tmpdir, bundle)
    scan_info = {"verdict": scan_result.get("verdict", "unknown"),
                 "findings_count": len(scan_result.get("findings", [])),
                 "summary": scan_result.get("summary", "")}

    try:
        cached = await store(name=bundle.name, bundle=bundle, source=bundle.source, identifier=bundle.identifier)
        await cleanup()
        return {"ok": True, "cached": False, "name": cached.name, "source": cached.source,
                "identifier": cached.identifier, "trust_level": cached.trust_level,
                "file_count": cached.file_count, "total_size": cached.total_size,
                "content_hash": cached.content_hash, "fetched_at": cached.fetched_at.isoformat(),
                "scan": scan_info, "files": list(bundle.files.keys())}
    except Exception as exc:
        logger.error("Failed to cache skill %s: %s", skill_name, exc)
        raise HTTPException(status_code=500, detail="Cache write failed")


@router.get("/cache")
async def list_cache(_auth: str = Depends(_verify_hub_auth)):
    from hub_cache import CACHE_ROOT
    entries = []
    if CACHE_ROOT.is_dir():
        for child in CACHE_ROOT.iterdir():
            if not child.is_dir():
                continue
            mf = child / "manifest.json"
            if not mf.is_file():
                continue
            try:
                data = json.loads(mf.read_text(encoding="utf-8"))
                entries.append({
                    "name": data.get("name", child.name), "source": data.get("source", ""),
                    "identifier": data.get("identifier", ""), "trust_level": data.get("trust_level"),
                    "file_count": data.get("file_count", 0), "total_size": data.get("total_size", 0),
                    "content_hash": data.get("content_hash", ""), "fetched_at": data.get("fetched_at", ""),
                })
            except Exception:
                continue
    return {"ok": True, "count": len(entries), "entries": entries}


@router.delete("/cache/{skill_name}")
async def delete_cache_entry(skill_name: str, _auth: str = Depends(_verify_hub_auth)):
    skill_name = _validate_skill_name(skill_name)
    removed = await cache_invalidate(skill_name)
    if not removed:
        raise HTTPException(status_code=404, detail=f"Skill '{skill_name}' not in cache")
    return {"ok": True, "removed": skill_name}


@router.get("/sources")
async def list_sources(_auth: str = Depends(_verify_hub_auth)):
    sources = _get_sources()
    result = []
    for src in sources:
        info = {"id": src.source_id(), "trust_level": getattr(src, "trust_level_for", lambda _: "community")("")}
        if hasattr(src, "is_available"):
            info["available"] = src.is_available
        result.append(info)
    return {"ok": True, "sources": result}


# ===========================================================================
# Routes: Agent-level operations
# ===========================================================================

@router.get("/agents/{agent_id}/skills")
async def list_installed_skills(
    agent_id: int,
    request: Request,
    _auth: str = Depends(_verify_hub_auth),
    refresh: bool = False,
):
    """List skills for an agent. Serves from DB by default (fast).
    Pass ?refresh=true to force a live pod scan and update the DB cache."""
    _hub_check_agent_scope(request, agent_id)
    from database import AsyncSessionLocal
    from db_models import AgentSkill as AgentSkillORM
    from sqlalchemy import select

    # Fast path: serve from DB unless refresh requested
    if not refresh:
        async with AsyncSessionLocal() as session:
            rows = (await session.execute(
                select(AgentSkillORM).where(AgentSkillORM.agent_number == agent_id)
            )).scalars().all()
            if rows:
                return {"ok": True, "running": True, "skills": [
                    {"name": r.skill_name, "description": r.description, "version": r.version,
                     "tags": r.tags, "source": "db-cache", "trust_level": None,
                     "installed_at": None, "content_hash": r.content_hash, "orphan": False}
                    for r in rows]}

    # Slow path: live scan from pod, then upsert DB
    k8s = _k8s(request)
    try:
        pod = await _resolve_pod(k8s, agent_id)
    except HTTPException:
        # Pod not running — return whatever DB has (possibly empty)
        async with AsyncSessionLocal() as session:
            rows = (await session.execute(
                select(AgentSkillORM).where(AgentSkillORM.agent_number == agent_id)
            )).scalars().all()
            return {"ok": True, "running": False, "skills": [
                {"name": r.skill_name, "description": r.description, "version": r.version,
                 "tags": r.tags, "source": "db-cache", "trust_level": None,
                 "installed_at": None, "content_hash": r.content_hash, "orphan": False}
                for r in rows]}

    from skill_scanner import scan_skills
    scanned = await scan_skills(k8s, pod) or []
    lock_data = await _read_lock_json(k8s, pod)
    lock_skills = {s["name"]: s for s in lock_data.get("skills", [])}

    skills = []
    scanned_names = set()
    for s in scanned:
        scanned_names.add(s["name"])
        lock_entry = lock_skills.get(s["name"])
        skills.append({
            "name": s["name"], "description": s.get("description", ""),
            "version": s.get("version", ""), "tags": s.get("tags", []),
            "source": lock_entry.get("source", "unknown") if lock_entry else "unknown",
            "trust_level": lock_entry.get("trust_level") if lock_entry else None,
            "installed_at": lock_entry.get("installed_at") if lock_entry else None,
            "content_hash": s.get("content_hash", ""), "orphan": False,
        })

    for name, entry in lock_skills.items():
        if name not in scanned_names:
            skills.append({
                "name": name, "description": "", "version": "",
                "tags": [], "source": entry.get("source", "unknown"),
                "trust_level": entry.get("trust_level"),
                "installed_at": entry.get("installed_at"),
                "content_hash": entry.get("content_hash", ""), "orphan": True,
            })

    # Upsert scanned skills into DB for future fast reads
    try:
        async with AsyncSessionLocal() as session:
            existing = {r.skill_name: r for r in (
                await session.execute(
                    select(AgentSkillORM).where(AgentSkillORM.agent_number == agent_id)
                )).scalars().all()}
            for s in skills:
                if s["orphan"]:
                    continue
                row = existing.get(s["name"])
                if row:
                    row.description = s["description"]
                    row.version = s["version"]
                    row.tags = s["tags"]
                    row.content_hash = s["content_hash"]
                    row.skill_dir = s.get("skill_dir", "")
                else:
                    session.add(AgentSkillORM(
                        agent_number=agent_id, skill_name=s["name"],
                        description=s["description"], version=s["version"],
                        tags=s["tags"], content_hash=s["content_hash"],
                        skill_dir=s.get("skill_dir", ""),
                    ))
            await session.commit()
    except Exception:
        logger.warning("Failed to upsert skill cache for agent %s", agent_id, exc_info=True)

    return {"ok": True, "running": True, "skills": skills}


@router.post("/agents/{agent_id}/install")
async def install_skill(
    agent_id: int,
    request: Request,
    _auth: AuthContext = Depends(_verify_hub_mutation),
):
    """Install a skill from the hub onto an agent pod.

    Request body: { "identifier": "github:user/repo/skill-name", "force": false }
    Returns a HubTask that the client can poll.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    identifier = body.get("identifier", "")
    force = body.get("force", False)

    if not identifier:
        raise HTTPException(status_code=400, detail="Missing 'identifier'")
    if len(identifier) > 512:
        raise HTTPException(status_code=400, detail="Identifier too long (max 512 chars)")

    k8s = _k8s(request)
    pod = await _resolve_pod(k8s, agent_id)
    task = await _create_task(agent_id, "install")
    k8s_ref = k8s

    async def _run_install():
        try:
            task.status = "fetching"
            task.phase = "Checking cache"
            task.progress = 0.1

            # Try cache first
            cached = await get_cached(identifier.split("/")[-1] or identifier)
            if cached is None:
                task.phase = "Downloading from source"
                bundle = await asyncio.to_thread(_fetch_from_sources, identifier)
                if bundle is None:
                    task.status = "failed"
                    task.error = f"Skill '{identifier}' not found in any source"
                    return
                # Cache it
                cached = await store(name=bundle.name, bundle=bundle, source=bundle.source, identifier=bundle.identifier)

            task.status = "scanning"
            task.phase = "Security scanning"
            task.progress = 0.3

            # Load files from cache for scanning
            skill_name = _validate_skill_name(cached.name)

            # Build bundle for scan from cached files
            scan_bundle = SkillBundle(
                name=cached.name, source=cached.source, identifier=cached.identifier,
                trust_level=cached.trust_level or "community", files=cached.files,
            )
            scan_result = await asyncio.to_thread(_scan_bundle_in_tmpdir, scan_bundle)

            has_critical = any(f["severity"] == "CRITICAL" for f in scan_result.get("findings", []))
            if has_critical and scan_bundle.trust_level == "community":
                task.status = "failed"
                task.error = "Security scan found CRITICAL issues in community skill"
                task.result = {"scan": scan_result}
                return

            task.status = "writing"
            task.phase = "Writing to pod"
            task.progress = 0.5

            async with _get_pod_lock(pod):
                # Check if already installed
                lock_data = await _read_lock_json(k8s_ref, pod)
                existing = {s["name"] for s in lock_data.get("skills", [])}
                if skill_name in existing and not force:
                    task.status = "failed"
                    task.error = f"Skill '{skill_name}' already installed. Use force=true to overwrite."
                    return

                # Ensure skills root exists
                await k8s_ref.run_command(pod, ["mkdir", "-p", SKILLS_ROOT])

                # If force and already exists, remove old version first
                if skill_name in existing and force:
                    old_path = f"{SKILLS_ROOT}/{skill_name}"
                    await k8s_ref.run_command(pod, ["rm", "-rf", old_path])

                # Tar pipe write
                file_count = await _tar_write_to_pod(k8s_ref, pod, skill_name, cached.files)

                task.status = "verifying"
                task.phase = "Verifying installation"
                task.progress = 0.8

                # Verify write
                entries = await k8s_ref.list_dir(pod, f"{SKILLS_ROOT}/{skill_name}")
                if not entries:
                    task.status = "failed"
                    task.error = "Verification failed: skill directory is empty"
                    # Rollback
                    await k8s_ref.run_command(pod, ["rm", "-rf", f"{SKILLS_ROOT}/{skill_name}"])
                    return

                # Update lock.json
                now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                content_hash = cached.content_hash
                lock_skills = lock_data.get("skills", [])
                # Remove old entry if exists
                lock_skills = [s for s in lock_skills if s["name"] != skill_name]
                lock_skills.append({
                    "name": skill_name, "source": cached.source,
                    "identifier": cached.identifier,
                    "trust_level": cached.trust_level or "community",
                    "installed_at": now_iso, "content_hash": content_hash,
                    "file_count": file_count,
                })
                lock_data["skills"] = lock_skills
                try:
                    await _atomic_update_lock(k8s_ref, pod, lock_data)
                except Exception:
                    # Rollback files on lock update failure
                    await k8s_ref.run_command(pod, ["rm", "-rf", f"{SKILLS_ROOT}/{skill_name}"])
                    raise

            # Refresh DB
            await _refresh_skills_db(k8s_ref, agent_id, pod)

            task.status = "completed"
            task.progress = 1.0
            task.result = {
                "skill": skill_name, "files_written": file_count,
                "content_hash": content_hash, "installed_at": now_iso,
                "scan": {"verdict": scan_result.get("verdict"),
                         "findings_count": len(scan_result.get("findings", []))},
            }

        except Exception as exc:
            logger.exception("Install failed for agent %d", agent_id)
            task.status = "failed"
            task.error = "Install failed"

    _spawn_background(_run_install())
    return {"ok": True, "task_id": task.task_id, "status": task.status}


@router.delete("/agents/{agent_id}/skills/{skill_name}")
async def uninstall_skill(
    agent_id: int,
    skill_name: str,
    request: Request,
    _auth: AuthContext = Depends(_verify_hub_mutation),
):
    """Uninstall a skill from an agent pod."""
    skill_name = _validate_skill_name(skill_name)
    k8s = _k8s(request)
    pod = await _resolve_pod(k8s, agent_id)

    async with _get_pod_lock(pod):
        lock_data = await _read_lock_json(k8s, pod)
        lock_skills = lock_data.get("skills", [])
        entry = next((s for s in lock_skills if s["name"] == skill_name), None)

        # Remove files — resolve actual path from DB
        skill_dir = await _resolve_skill_dir(k8s, pod, agent_id, skill_name)
        if skill_dir:
            _validate_skill_path(skill_dir, skill_name)
            await k8s.run_command(pod, ["rm", "-rf", skill_dir])

        # Update lock.json regardless (idempotent)
        lock_skills = [s for s in lock_skills if s["name"] != skill_name]
        lock_data["skills"] = lock_skills
        if lock_skills or lock_data:
            await _atomic_update_lock(k8s, pod, lock_data)

    await _refresh_skills_db(k8s, agent_id, pod)
    return {"ok": True, "skill": skill_name, "status": "uninstalled"}


@router.post("/agents/{agent_id}/check")
async def check_updates(
    agent_id: int,
    request: Request,
    _auth: AuthContext = Depends(_verify_hub_mutation),
):
    """Check for skill updates by comparing installed hashes with upstream."""
    body = await request.json() if await request.body() else {}
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Request body must be a JSON object")
    target_name = body.get("name")
    if target_name is not None and (not isinstance(target_name, str) or len(target_name) > 128):
        raise HTTPException(status_code=400, detail="Invalid 'name' parameter")

    k8s = _k8s(request)
    pod = await _resolve_pod(k8s, agent_id)

    lock_data = await _read_lock_json(k8s, pod)
    lock_skills = lock_data.get("skills", [])

    if not lock_skills:
        return {"ok": True, "total": 0, "items": []}

    # Filter to target if specified
    if target_name:
        lock_skills = [s for s in lock_skills if s["name"] == target_name]

    items = []
    for entry in lock_skills:
        # Try fetching upstream to compare hash
        upstream_hash = None
        has_update = False
        try:
            cached = await get_cached(entry["name"])
            if cached is not None:
                upstream_hash = cached.content_hash
            else:
                # Try to fetch from source
                bundle = await asyncio.to_thread(_fetch_from_sources, entry.get("identifier", entry["name"]))
                if bundle:
                    upstream_hash = await asyncio.to_thread(bundle_content_hash, bundle.files)
        except Exception:
            pass

        if upstream_hash and upstream_hash != entry.get("content_hash", ""):
            has_update = True

        items.append({
            "name": entry["name"], "current_hash": entry.get("content_hash", ""),
            "upstream_hash": upstream_hash, "has_update": has_update,
        })

    updates_available = sum(1 for i in items if i["has_update"])
    return {"ok": True, "total": len(items), "updates_available": updates_available, "items": items}


@router.post("/agents/{agent_id}/update/{skill_name}")
async def update_skill(
    agent_id: int,
    skill_name: str,
    request: Request,
    _auth: AuthContext = Depends(_verify_hub_mutation),
):
    """Update a skill (uninstall old + install new, under single pod lock)."""
    skill_name = _validate_skill_name(skill_name)
    k8s = _k8s(request)
    pod = await _resolve_pod(k8s, agent_id)
    task = await _create_task(agent_id, "update")
    k8s_ref = k8s

    async def _run_update():
        try:
            task.status = "fetching"
            task.phase = "Fetching latest version"
            task.progress = 0.1

            # Get identifier from lock
            lock_data = await _read_lock_json(k8s_ref, pod)
            entry = next((s for s in lock_data.get("skills", []) if s["name"] == skill_name), None)
            identifier = entry.get("identifier", skill_name) if entry else skill_name

            # Fetch latest
            cached = await get_cached(skill_name)
            if cached is None:
                bundle = await asyncio.to_thread(_fetch_from_sources, identifier)
                if bundle is None:
                    task.status = "failed"
                    task.error = f"Skill '{identifier}' not found in any source"
                    return
                cached = await store(name=bundle.name, bundle=bundle, source=bundle.source, identifier=bundle.identifier)

            # Scan
            task.status = "scanning"
            task.phase = "Security scanning"
            task.progress = 0.3
            scan_bundle = SkillBundle(
                name=cached.name, source=cached.source, identifier=cached.identifier,
                trust_level=cached.trust_level or "community", files=cached.files,
            )
            scan_result = await asyncio.to_thread(_scan_bundle_in_tmpdir, scan_bundle)
            has_critical = any(f["severity"] == "CRITICAL" for f in scan_result.get("findings", []))
            if has_critical and scan_bundle.trust_level == "community":
                task.status = "failed"
                task.error = "Security scan found CRITICAL issues"
                task.result = {"scan": scan_result}
                return

            # Uninstall old + install new under same lock
            task.status = "writing"
            task.phase = "Updating on pod"
            task.progress = 0.5

            async with _get_pod_lock(pod):
                # Remove old — resolve actual path from DB
                old_dir = await _resolve_skill_dir(k8s_ref, pod, agent_id, skill_name)
                if old_dir:
                    _validate_skill_path(old_dir, skill_name)
                    await k8s_ref.run_command(pod, ["rm", "-rf", old_dir])
                await k8s_ref.run_command(pod, ["mkdir", "-p", SKILLS_ROOT])

                # Write new
                file_count = await _tar_write_to_pod(k8s_ref, pod, skill_name, cached.files)

                # Update lock
                now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                lock_data = await _read_lock_json(k8s_ref, pod)
                lock_skills = [s for s in lock_data.get("skills", []) if s["name"] != skill_name]
                lock_skills.append({
                    "name": skill_name, "source": cached.source,
                    "identifier": cached.identifier,
                    "trust_level": cached.trust_level or "community",
                    "installed_at": now_iso, "content_hash": cached.content_hash,
                    "file_count": file_count,
                })
                lock_data["skills"] = lock_skills
                await _atomic_update_lock(k8s_ref, pod, lock_data)

            await _refresh_skills_db(k8s_ref, agent_id, pod)

            task.status = "completed"
            task.progress = 1.0
            task.result = {"skill": skill_name, "files_written": file_count,
                           "content_hash": cached.content_hash, "updated_at": now_iso}

        except Exception as exc:
            logger.exception("Update failed for agent %d skill %s", agent_id, skill_name)
            task.status = "failed"
            task.error = "Update failed"

    _spawn_background(_run_update())
    return {"ok": True, "task_id": task.task_id, "status": task.status}


@router.get("/agents/{agent_id}/audit/{skill_name}")
async def audit_skill(
    agent_id: int,
    skill_name: str,
    request: Request,
    _auth: str = Depends(_verify_hub_auth),
):
    """Run security audit on an installed skill."""
    _hub_check_agent_scope(request, agent_id)
    skill_name = _validate_skill_name(skill_name)
    k8s = _k8s(request)
    pod = await _resolve_pod(k8s, agent_id)

    # Resolve skill directory from DB first, fallback to flat path
    skill_dir = await _resolve_skill_dir(k8s, pod, agent_id, skill_name)
    if skill_dir is None:
        raise HTTPException(status_code=404, detail=f"Skill '{skill_name}' not found on pod")

    # Verify skill exists
    entries = await k8s.list_dir(pod, skill_dir)
    if not entries:
        raise HTTPException(status_code=404, detail=f"Skill '{skill_name}' not found on pod")

    # Try admin cache first
    cached = await get_cached(skill_name)
    if cached is not None and cached.files:
        scan_bundle = SkillBundle(
            name=cached.name, source=cached.source, identifier=cached.identifier,
            trust_level=cached.trust_level or "community", files=cached.files,
        )
        scan_result = await asyncio.to_thread(_scan_bundle_in_tmpdir, scan_bundle)
        context = "admin-cache"
    else:
        # Read files from pod and scan
        files: dict[str, bytes] = {}
        for entry in entries:
            if entry.get("type") == "f":
                fname = entry["name"]
                raw, err = await k8s.read_file_from_pod(pod, f"{skill_dir}/{fname}")
                if err or not raw:
                    logger.warning("Skipping %s in audit: %s", fname, err or "empty")
                    continue
                files[fname] = raw

        if not files:
            raise HTTPException(status_code=404, detail="No files found for skill")

        scan_bundle = SkillBundle(
            name=skill_name, source="pod", identifier="",
            trust_level="community", files=files,
        )
        scan_result = await asyncio.to_thread(_scan_bundle_in_tmpdir, scan_bundle)
        context = "pod-remote"

    # Get trust level from lock.json
    lock_data = await _read_lock_json(k8s, pod)
    lock_entry = next((s for s in lock_data.get("skills", []) if s["name"] == skill_name), None)

    return {
        "ok": True, "skill": skill_name,
        "trust_level": lock_entry.get("trust_level") if lock_entry else None,
        "installed_at": lock_entry.get("installed_at") if lock_entry else None,
        "scan": scan_result,
        "scan_context": context,
        "findings_count": len(scan_result.get("findings", [])),
        "has_critical": any(f["severity"] == "CRITICAL" for f in scan_result.get("findings", [])),
    }


@router.get("/agents/{agent_id}/tasks/{task_id}")
async def get_task_status(
    agent_id: int,
    task_id: str,
    request: Request,
    _auth: str = Depends(_verify_hub_auth),
):
    """Poll async task status."""
    _hub_check_agent_scope(request, agent_id)
    task = await _get_task(task_id)
    if task is None or task.agent_id != agent_id:
        raise HTTPException(status_code=404, detail="Task not found or expired")

    resp = {
        "ok": True, "task_id": task.task_id, "status": task.status,
        "progress": task.progress, "phase": task.phase,
    }
    if task.result:
        resp["result"] = task.result
    if task.error:
        resp["error"] = task.error
    return resp


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _meta_dict(meta: SkillMeta) -> dict:
    return {
        "name": meta.name, "description": meta.description, "source": meta.source,
        "identifier": meta.identifier, "trust_level": meta.trust_level,
        "repo": meta.repo, "path": meta.path, "tags": meta.tags, "extra": meta.extra,
    }


def _fetch_from_sources(identifier: str) -> Optional[SkillBundle]:
    """Try to fetch a skill bundle from all configured sources (sync)."""
    sources = _get_sources()
    for src in sources:
        try:
            bundle = src.fetch(identifier)
            if bundle is not None:
                return bundle
        except Exception:
            continue
    return None


# Background task tracking to prevent GC
_bg_tasks: set[asyncio.Task] = set()


def _spawn_background(coro: Coroutine[Any, Any, Any]) -> asyncio.Task:
    """Create a background task with proper reference tracking."""
    t = asyncio.create_task(coro)
    _bg_tasks.add(t)
    t.add_done_callback(_bg_tasks.discard)
    return t
