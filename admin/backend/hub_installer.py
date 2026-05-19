"""Template-driven skill auto-install -- extracted from hub_routes.py.

Provides ``install_skills_for_template()`` for profile sync and agent
creation hooks.  Imports are deferred to avoid circular dependencies with
hub_routes.py.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Optional

logger = logging.getLogger("hermes-admin.hub_installer")

# ---------------------------------------------------------------------------
# Identifier format validation (same regex as design doc)
# ---------------------------------------------------------------------------

IDENTIFIER_RE = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$')


def _validate_identifier(identifier: str) -> str:
    """Validate Hub skill identifier format."""
    if not IDENTIFIER_RE.match(identifier):
        raise ValueError(f"Invalid identifier format: {identifier}")
    return identifier


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

async def _get_installed_names(agent_id: int) -> set[str]:
    """Return skill names already recorded in the DB cache (AgentSkill table)."""
    from database import AsyncSessionLocal
    from db_models import AgentSkill
    from sqlalchemy import select

    async with AsyncSessionLocal() as session:
        rows = (await session.execute(
            select(AgentSkill.skill_name).where(AgentSkill.agent_number == agent_id)
        )).scalars().all()
        return set(rows)


# ---------------------------------------------------------------------------
# Audit log
# ---------------------------------------------------------------------------

async def _write_audit_log(agent_id: int, identifiers: list[str], task_ids: list[str]) -> None:
    """Write a profile_audit_log row for the auto-install batch."""
    from database import AsyncSessionLocal
    from sqlalchemy import text

    try:
        async with AsyncSessionLocal() as session:
            await session.execute(
                text("""
                    INSERT INTO profile_audit_log
                        (entity_type, entity_id, action, new_values, changed_by)
                    VALUES
                        ('profile', :agent_id, 'auto-install', CAST(:vals AS jsonb), 'system:auto-install')
                """),
                {
                    "agent_id": agent_id,
                    "vals": json.dumps({
                        "identifiers": identifiers,
                        "task_ids": task_ids,
                        "trigger": "template-sync",
                    }),
                },
            )
            await session.commit()
    except Exception as exc:
        logger.warning("Failed to write auto-install audit log: %s", exc)


# ---------------------------------------------------------------------------
# Single-skill install runner
# ---------------------------------------------------------------------------

async def _run_single_install(
    task,  # HubTask from hub_routes
    agent_id: int,
    pod: str,
    identifier: str,
    k8s,
) -> None:
    """Install one skill, mutating *task* in place with progress updates.

    On failure the task status is set to ``"failed"`` -- the caller
    continues with the next skill.
    """
    from hub_routes import (
        SKILLS_ROOT,
        _validate_skill_name,
        _scan_bundle_in_tmpdir,
        _tar_write_to_pod,
        _get_pod_lock,
        _read_lock_json,
        _atomic_update_lock,
        _refresh_skills_db,
        _resolve_skill_dir,
        _validate_skill_path,
    )
    from hub_cache import get_cached, store
    from tools.skills_hub_core import SkillBundle

    now_iso: str = ""  # will be set on success path

    try:
        task.status = "fetching"
        task.phase = "Fetching skill"
        task.progress = 0.1

        skill_name = identifier.split("/")[-1]
        skill_name = _validate_skill_name(skill_name)

        # Try cache first
        cached = await get_cached(skill_name)
        if cached is None:
            task.phase = "Downloading from source"
            from hub_routes import _fetch_from_sources
            bundle = await asyncio.to_thread(_fetch_from_sources, identifier)
            if bundle is None:
                task.status = "failed"
                task.error = f"Skill '{identifier}' not found in any source"
                return
            cached = await store(
                name=bundle.name, bundle=bundle,
                source=bundle.source, identifier=bundle.identifier,
            )

        # Security scan
        task.status = "scanning"
        task.phase = "Security scanning"
        task.progress = 0.3

        scan_bundle = SkillBundle(
            name=cached.name,
            source=cached.source,
            identifier=cached.identifier,
            trust_level=cached.trust_level or "community",
            files=cached.files,
        )
        scan_result = await asyncio.to_thread(_scan_bundle_in_tmpdir, scan_bundle)
        has_critical = any(
            f["severity"] == "CRITICAL" for f in scan_result.get("findings", [])
        )
        if has_critical and scan_bundle.trust_level == "community":
            task.status = "failed"
            task.error = "Security scan found CRITICAL issues"
            return

        # Write to pod (force=True -- skip existing check)
        task.status = "writing"
        task.phase = "Writing to pod"
        task.progress = 0.5

        async with _get_pod_lock(pod):
            # Remove old version if exists (force behaviour)
            lock_data = await _read_lock_json(k8s, pod)
            existing = {s["name"] for s in lock_data.get("skills", [])}
            if skill_name in existing:
                old_dir = await _resolve_skill_dir(k8s, pod, agent_id, skill_name)
                if old_dir:
                    old_dir = _validate_skill_path(old_dir, skill_name)
                    await k8s.run_command(pod, ["rm", "-rf", old_dir])

            await k8s.run_command(pod, ["mkdir", "-p", SKILLS_ROOT])
            file_count = await _tar_write_to_pod(k8s, pod, skill_name, cached.files)

            # Verify
            task.status = "verifying"
            task.phase = "Verifying"
            task.progress = 0.8
            entries = await k8s.list_dir(pod, f"{SKILLS_ROOT}/{skill_name}")
            if not entries:
                task.status = "failed"
                task.error = "Verification failed: empty skill directory"
                await k8s.run_command(pod, ["rm", "-rf", f"{SKILLS_ROOT}/{skill_name}"])
                return

            # Update lock.json
            now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            lock_skills = lock_data.get("skills", [])
            lock_skills = [s for s in lock_skills if s["name"] != skill_name]
            lock_skills.append({
                "name": skill_name,
                "source": cached.source,
                "identifier": cached.identifier,
                "trust_level": cached.trust_level or "community",
                "installed_at": now_iso,
                "content_hash": cached.content_hash,
                "file_count": file_count,
            })
            lock_data["skills"] = lock_skills
            try:
                await _atomic_update_lock(k8s, pod, lock_data)
            except Exception:
                await k8s.run_command(pod, ["rm", "-rf", f"{SKILLS_ROOT}/{skill_name}"])
                raise

        # Refresh DB cache
        await _refresh_skills_db(k8s, agent_id, pod)

        task.status = "completed"
        task.progress = 1.0
        task.result = {
            "skill": skill_name,
            "files_written": file_count,
            "content_hash": cached.content_hash,
            "installed_at": now_iso,
            "trigger": "template-auto-install",
        }

    except Exception as exc:
        logger.exception("Auto-install failed for agent %d skill %s", agent_id, identifier)
        task.status = "failed"
        task.error = f"Install failed: {exc}"


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

async def install_skills_for_template(
    agent_id: int,
    identifiers: list[str],
    k8s,
) -> list[str]:
    """Batch-install template-declared skills.

    * **Serial install** -- one at a time to avoid pod-lock contention.
    * **Delayed pod resolution** with retry (24 attempts x 5 s = 120 s).
    * **DB-cached diff** -- skips skills already recorded in AgentSkill.
    * **force=True** -- idempotent overwrites.
    * **Total timeout** -- 300 s hard ceiling.
    * Returns a list of ``task_id`` strings (one per skill).
    """
    from hub_routes import (
        _resolve_pod,
        _create_task,
    )

    if not identifiers:
        return []

    # Validate all identifiers upfront
    for ident in identifiers:
        _validate_identifier(ident)

    # ------------------------------------------------------------------
    # 1. Resolve pod with retry (120 s)
    # ------------------------------------------------------------------
    pod: Optional[str] = None
    for attempt in range(24):
        try:
            pod = await _resolve_pod(k8s, agent_id)
            if pod:
                break
        except Exception:
            pass
        await asyncio.sleep(5)

    if not pod:
        task_ids: list[str] = []
        for ident in identifiers:
            task = await _create_task(agent_id, "auto-install")
            task.status = "failed"
            task.error = f"Pod not ready after 120s for agent {agent_id}"
            task_ids.append(task.task_id)
        return task_ids

    # ------------------------------------------------------------------
    # 2. Diff: only install what is not already in the DB cache
    # ------------------------------------------------------------------
    installed = await _get_installed_names(agent_id)

    to_install: list[str] = []
    for ident in identifiers:
        skill_name = ident.split("/")[-1]
        if skill_name not in installed:
            to_install.append(ident)

    if not to_install:
        logger.info(
            "All %d skills already installed for agent %d",
            len(identifiers), agent_id,
        )
        return []

    # ------------------------------------------------------------------
    # 3. Serial install with 300 s total timeout
    # ------------------------------------------------------------------
    deadline = time.monotonic() + 300
    task_ids = []

    for ident in to_install:
        if time.monotonic() > deadline:
            # Timeout -- create failed task for remaining identifiers
            task = await _create_task(agent_id, "auto-install")
            task.status = "failed"
            task.error = "Total timeout (300s) exceeded"
            task_ids.append(task.task_id)
            continue

        task = await _create_task(agent_id, "auto-install")
        task_ids.append(task.task_id)
        await _run_single_install(task, agent_id, pod, ident, k8s)

    # ------------------------------------------------------------------
    # 4. Audit log (best-effort)
    # ------------------------------------------------------------------
    await _write_audit_log(agent_id, identifiers, task_ids)

    return task_ids
