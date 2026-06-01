"""Shared utilities for profile template system.

Used by both profile_routes.py and kanban_routes.py to ensure
consistent config merging, hashing, and K8s sync behavior.
"""
from __future__ import annotations

import asyncio
import enum
import hashlib
import logging
import shlex
from datetime import datetime, timezone
from typing import Optional

import yaml
from sqlalchemy.ext.asyncio import AsyncSession

from db_models import AgentProfile, ProfileTemplate

logger = logging.getLogger(__name__)

NAMESPACE = "hermes-agent"

# Default model config used as the base layer in merge chain
DEFAULT_MODEL_CONFIG: dict = {
    "model": {"default": "glm-4.7", "provider": "custom"},
}

# Per-profile async locks to prevent concurrent sync races
_sync_locks: dict[tuple[int, str], asyncio.Lock] = {}


def get_sync_lock(agent_number: int, profile_name: str) -> asyncio.Lock:
    key = (agent_number, profile_name)
    return _sync_locks.setdefault(key, asyncio.Lock())


def cleanup_sync_locks():
    """Remove locks that are not currently held to prevent unbounded growth."""
    to_remove = [k for k, v in _sync_locks.items() if not v.locked()]
    for k in to_remove:
        del _sync_locks[k]


def deep_merge(base: dict, *overrides: dict) -> dict:
    """Recursively merge *overrides* into *base*, returning a new dict.

    None values in overrides remove the key from the result.
    """
    result = dict(base)
    for override in overrides:
        for k, v in override.items():
            if v is None:
                result.pop(k, None)
            elif isinstance(v, dict) and isinstance(result.get(k), dict):
                result[k] = deep_merge(result[k], v)
            else:
                result[k] = v
    return result


def build_resolved_config(
    profile: AgentProfile,
    template: Optional[ProfileTemplate],
) -> dict:
    """Build the fully-merged config: DEFAULT → template → profile."""
    template_overrides = template.config_overrides if template else {}
    profile_overrides = profile.config_overrides or {}
    return deep_merge(DEFAULT_MODEL_CONFIG, template_overrides, profile_overrides)


def get_resolved_soul_md(
    profile: AgentProfile,
    template: Optional[ProfileTemplate],
) -> Optional[str]:
    """Get the effective soul_md: profile > template > None."""
    if profile.soul_md is not None:
        return profile.soul_md
    if template is not None:
        return template.soul_md
    return None


def compute_config_hash(config: dict, soul_md: Optional[str]) -> str:
    """Compute SHA-256 hash of the resolved config + soul_md for idempotency."""
    payload = yaml.dump(
        {"config": config, "soul_md": soul_md},
        default_flow_style=False,
        sort_keys=True,
        Dumper=yaml.SafeDumper,
    )
    return hashlib.sha256(payload.encode()).hexdigest()[:32]


def sanitize_for_yaml(data: dict) -> dict:
    """Ensure enum values are converted to plain strings for yaml.dump."""
    out: dict = {}
    for k, v in data.items():
        if isinstance(v, enum.Enum):
            out[k] = v.value
        elif isinstance(v, dict):
            out[k] = sanitize_for_yaml(v)
        elif isinstance(v, list):
            out[k] = [
                item.value if isinstance(item, enum.Enum)
                else (sanitize_for_yaml(item) if isinstance(item, dict) else item)
                for item in v
            ]
        else:
            out[k] = v
    return out


# K8sClient singleton
_k8s_instance = None


def get_k8s():
    """Lazy singleton K8sClient for profile sync operations."""
    global _k8s_instance
    if _k8s_instance is None:
        from k8s_client import K8sClient
        _k8s_instance = K8sClient(namespace=NAMESPACE)
    return _k8s_instance


async def sync_profile_to_pod(
    agent_number: int,
    profile: AgentProfile,
    template: Optional[ProfileTemplate],
    session: AsyncSession,
) -> dict:
    """Sync a single profile to the agent pod.

    Writes config.yaml and SOUL.md via K8s exec.
    Updates profile.sync_status and config_hash in DB.
    MUST be called within an async lock for (agent_number, profile_name).
    """
    from templates import deployment_name

    k8s = get_k8s()
    dname = deployment_name(agent_number)

    try:
        pod_name = await k8s.get_first_pod_name(dname)
        if not pod_name:
            profile.sync_status = "error"
            profile.sync_error = f"No running pod for deployment {dname}"
            await session.commit()
            await session.refresh(profile)
            return profile_to_dict(profile)

        # Build resolved config: DEFAULT → template → profile
        merged = build_resolved_config(profile, template)

        # Inherit providers from parent agent config if not already present
        if "providers" not in merged:
            try:
                parent_raw, _ = await k8s.read_file_from_pod(
                    pod_name, "/home/agent/.hermes/config.yaml",
                )
                if parent_raw:
                    parent_data = yaml.safe_load(parent_raw.decode("utf-8")) or {}
                    parent_providers = parent_data.get("providers")
                    if isinstance(parent_providers, dict) and parent_providers:
                        merged["providers"] = parent_providers
                    else:
                        # Fallback: try legacy custom_providers and convert
                        legacy_cp = parent_data.get("custom_providers")
                        if isinstance(legacy_cp, list) and legacy_cp:
                            providers = {}
                            for entry in legacy_cp:
                                if isinstance(entry, dict):
                                    name = entry.get("name", "default")
                                    p_entry = {}
                                    if entry.get("base_url"):
                                        p_entry["api"] = entry["base_url"].rstrip("/")
                                    if entry.get("model"):
                                        p_entry["default_model"] = entry["model"]
                                    if entry.get("api_key", "").strip():
                                        p_entry["api_key"] = entry["api_key"].strip()
                                    if p_entry:
                                        providers[name] = p_entry
                            if providers:
                                merged["providers"] = providers
            except Exception:
                logger.warning(
                    "Could not read parent config for agent %d, profiles may lack providers",
                    agent_number,
                    exc_info=True,
                )

        soul_md = get_resolved_soul_md(profile, template)

        # Idempotency check
        new_hash = compute_config_hash(merged, soul_md)
        if profile.config_hash == new_hash and profile.sync_status == "synced":
            return profile_to_dict(profile)

        # Write config.yaml
        sanitized = sanitize_for_yaml(merged)
        config_content = yaml.dump(
            sanitized, default_flow_style=False, Dumper=yaml.SafeDumper,
        )
        config_path = f"/home/agent/.hermes/profiles/{profile.profile_name}/config.yaml"
        await k8s.write_file_to_pod(pod_name, config_path, config_content.encode("utf-8"))

        # Copy parent .env to profile directory (for key_env resolution)
        profile_env_path = f"/home/agent/.hermes/profiles/{profile.profile_name}/.env"
        try:
            parent_env_raw, env_err = await k8s.read_file_from_pod(
                pod_name, "/home/agent/.hermes/.env",
            )
            if not env_err and parent_env_raw:
                await k8s.write_file_to_pod(pod_name, profile_env_path, parent_env_raw)
        except Exception:
            logger.warning(
                "Could not copy .env to profile dir for agent %d", agent_number,
                exc_info=True,
            )

        # Write SOUL.md
        if soul_md:
            soul_path = f"/home/agent/.hermes/profiles/{profile.profile_name}/SOUL.md"
            await k8s.write_file_to_pod(pod_name, soul_path, soul_md.encode("utf-8"))

        # Fix ownership of entire profile directory (mkdir -p creates dirs as root)
        profile_dir = f"/home/agent/.hermes/profiles/{shlex.quote(profile.profile_name)}"
        await k8s.run_command(pod_name, [
            "sh", "-c",
            f"chown -R $(id -u hermes):$(id -g hermes) {profile_dir}",
        ])

        # Update DB state
        profile.sync_status = "synced"
        profile.sync_error = None
        profile.config_hash = new_hash
        profile.last_synced_at = datetime.now(timezone.utc)

    except Exception as exc:
        logger.warning(
            "Sync failed for agent %s profile %s: %s",
            agent_number, profile.profile_name, exc,
        )
        profile.sync_status = "error"
        err = str(exc)
        profile.sync_error = err[:497] + "..." if len(err) > 500 else err

    await session.commit()
    await session.refresh(profile)

    # Post-hook: auto-install template skills (best-effort, non-blocking)
    try:
        install_list = (merged.get("skills") or {}).get("install") or []
        if install_list and profile.sync_status == "synced":
            from hub_installer import install_skills_for_template
            from hub_routes import _spawn_background
            k8s_ref = get_k8s()
            _spawn_background(install_skills_for_template(
                agent_number, install_list, k8s_ref,
            ))
            logger.info(
                "Triggered auto-install of %d skills for agent %d",
                len(install_list), agent_number,
            )
    except Exception as exc:
        logger.warning("Auto-install hook failed for agent %d: %s", agent_number, exc)

    return profile_to_dict(profile)


def profile_to_dict(
    p: AgentProfile,
    template_map: Optional[dict[int, ProfileTemplate]] = None,
) -> dict:
    d = {
        "id": p.id,
        "agent_number": p.agent_number,
        "profile_name": p.profile_name,
        "display_name": p.display_name or "",
        "template_id": p.template_id,
        "config_overrides": p.config_overrides or {},
        "soul_md": p.soul_md,
        "sync_status": p.sync_status or "pending",
        "sync_error": p.sync_error,
        "config_hash": p.config_hash,
        "last_synced_at": p.last_synced_at.isoformat() if p.last_synced_at else None,
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }
    if template_map and p.template_id and p.template_id in template_map:
        tmpl = template_map[p.template_id]
        d["template_name"] = tmpl.name
        d["template_display_name"] = tmpl.display_name or ""
    else:
        d["template_name"] = None
        d["template_display_name"] = None
    return d
