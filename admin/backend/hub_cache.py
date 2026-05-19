"""Hub skill bundle cache — stores downloaded skill bundles on the admin container.

Cache directory layout:
    /data/hermes/hub-cache/
      <skill_name>/
        SKILL.md           (and any other bundle files)
        manifest.json      (source, hash, fetched_at, trust_level, stats)

Integrity is verified on every cache read by recomputing the content hash and
comparing it against the manifest.  If the hash mismatches (corruption or
tampering), the entry is treated as a cache miss and removed automatically.

TTL, size, and count limits are enforced by ``cleanup()`` which should be
called periodically (or at least after every ``store``).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import shutil
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger("hermes-admin.hub_cache")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

CACHE_ROOT = Path(os.getenv("HUB_CACHE_DIR", "/data/hermes/hub-cache"))
MAX_CACHE_SKILLS = int(os.getenv("HUB_CACHE_MAX_SKILLS", "100"))
MAX_CACHE_SIZE_MB = int(os.getenv("HUB_CACHE_MAX_SIZE_MB", "50"))
TTL_HOURS = int(os.getenv("HUB_CACHE_TTL_HOURS", "24"))

_MANIFEST_FILENAME = "manifest.json"


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class CachedSkill:
    """Represents a skill bundle retrieved from the local cache."""

    name: str
    source: str
    identifier: str
    content_hash: str
    trust_level: str | None
    fetched_at: datetime
    file_count: int
    total_size: int
    cache_path: Path  # absolute path to the skill cache directory
    files: dict[str, bytes] = field(default_factory=dict, repr=False)


# ---------------------------------------------------------------------------
# Helpers (sync — run via asyncio.to_thread from async entry points)
# ---------------------------------------------------------------------------


def _ensure_cache_root() -> None:
    """Create the cache root directory if it does not exist."""
    CACHE_ROOT.mkdir(parents=True, exist_ok=True)


def _skill_dir(name: str) -> Path:
    """Return the cache directory for a given skill name, with path traversal protection."""
    resolved = (CACHE_ROOT / name).resolve()
    if not str(resolved).startswith(str(CACHE_ROOT.resolve())):
        raise ValueError(f"Path traversal detected in skill name: {name}")
    return resolved


def _compute_content_hash(files: dict[str, bytes]) -> str:
    """Deterministic content hash over sorted file entries.

    Uses SHA-256 truncated to 32 hex chars (128 bits) — sufficient for
    integrity checks without being unnecessarily long.
    """
    h = hashlib.sha256()
    for fname in sorted(files):
        h.update(fname.encode("utf-8"))
        content = files[fname]
        h.update(content if isinstance(content, bytes) else content.encode("utf-8"))
    return h.hexdigest()[:32]


def _read_manifest(skill_dir: Path) -> dict[str, Any] | None:
    """Read and parse manifest.json from a skill cache directory."""
    manifest_path = skill_dir / _MANIFEST_FILENAME
    if not manifest_path.is_file():
        return None
    try:
        text = manifest_path.read_text(encoding="utf-8")
        return json.loads(text)  # type: ignore[no-any-return]
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Failed to read manifest in %s: %s", skill_dir, exc)
        return None


def _write_manifest(skill_dir: Path, data: dict[str, Any]) -> None:
    """Atomically write manifest.json to a skill cache directory."""
    manifest_path = skill_dir / _MANIFEST_FILENAME
    tmp_path = manifest_path.with_suffix(".tmp")
    tmp_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp_path.replace(manifest_path)


def _load_files_from_disk(skill_dir: Path) -> dict[str, bytes]:
    """Load all non-manifest files from a skill cache directory."""
    files: dict[str, bytes] = {}
    for child in skill_dir.iterdir():
        if child.name == _MANIFEST_FILENAME:
            continue
        if child.is_file():
            files[child.name] = child.read_bytes()
        elif child.is_dir():
            # Include files in subdirectories with relative paths
            for fpath in child.rglob("*"):
                if fpath.is_file():
                    rel = str(fpath.relative_to(skill_dir))
                    files[rel] = fpath.read_bytes()
    return files


def _store_sync(
    name: str,
    files: dict[str, bytes],
    source: str,
    identifier: str,
    trust_level: str | None,
) -> CachedSkill:
    """Synchronous implementation of ``store``."""
    _ensure_cache_root()
    skill_dir = _skill_dir(name)

    # Remove stale cache if present
    if skill_dir.exists():
        shutil.rmtree(skill_dir)

    skill_dir.mkdir(parents=True, exist_ok=True)

    # Write bundle files
    for fname, content in files.items():
        # Prevent path traversal
        if fname.startswith("/") or ".." in fname.split("/") or "\x00" in fname:
            raise ValueError(f"Unsafe file path in skill bundle: {fname}")
        fpath = skill_dir / fname
        fpath.parent.mkdir(parents=True, exist_ok=True)
        fpath.write_bytes(content if isinstance(content, bytes) else content.encode("utf-8"))

    content_hash = _compute_content_hash(files)
    now = datetime.now(timezone.utc)

    manifest: dict[str, Any] = {
        "name": name,
        "source": source,
        "identifier": identifier,
        "content_hash": content_hash,
        "trust_level": trust_level,
        "fetched_at": now.isoformat(),
        "file_count": len(files),
        "total_size": sum(len(v.encode("utf-8")) if isinstance(v, str) else len(v) for v in files.values()),
    }
    _write_manifest(skill_dir, manifest)

    return CachedSkill(
        name=name,
        source=source,
        identifier=identifier,
        content_hash=content_hash,
        trust_level=trust_level,
        fetched_at=now,
        file_count=len(files),
        total_size=sum(len(v.encode("utf-8")) if isinstance(v, str) else len(v) for v in files.values()),
        cache_path=skill_dir.resolve(),
        files=files,
    )


def _get_cached_sync(name: str) -> CachedSkill | None:
    """Synchronous implementation of ``get_cached``."""
    skill_dir = _skill_dir(name)
    if not skill_dir.is_dir():
        return None

    manifest = _read_manifest(skill_dir)
    if manifest is None:
        logger.warning("Cache miss for %s: no valid manifest", name)
        return None

    # Load files and verify integrity
    files = _load_files_from_disk(skill_dir)
    actual_hash = _compute_content_hash(files)
    expected_hash = manifest.get("content_hash", "")

    if actual_hash != expected_hash:
        logger.warning(
            "Cache integrity failure for %s: expected hash %s, got %s — removing",
            name,
            expected_hash,
            actual_hash,
        )
        shutil.rmtree(skill_dir, ignore_errors=True)
        return None

    # Parse fetched_at
    fetched_at_str = manifest.get("fetched_at", "")
    try:
        fetched_at = datetime.fromisoformat(fetched_at_str)
    except (ValueError, TypeError):
        fetched_at = datetime.now(timezone.utc)

    # TTL check
    ttl = timedelta(hours=TTL_HOURS)
    if datetime.now(timezone.utc) - fetched_at > ttl:
        logger.info("Cache expired for %s (fetched %s)", name, fetched_at_str)
        shutil.rmtree(skill_dir, ignore_errors=True)
        return None

    return CachedSkill(
        name=name,
        source=manifest.get("source", ""),
        identifier=manifest.get("identifier", ""),
        content_hash=actual_hash,
        trust_level=manifest.get("trust_level"),
        fetched_at=fetched_at,
        file_count=manifest.get("file_count", len(files)),
        total_size=manifest.get("total_size", sum(len(v) for v in files.values())),
        cache_path=skill_dir.resolve(),
        files=files,
    )


def _invalidate_sync(name: str) -> bool:
    """Synchronous implementation of ``invalidate``."""
    skill_dir = _skill_dir(name)
    if not skill_dir.is_dir():
        return False
    shutil.rmtree(skill_dir)
    logger.info("Invalidated cache for %s", name)
    return True


def _cleanup_sync() -> int:
    """Synchronous implementation of ``cleanup``.

    LRU cleanup: remove oldest entries until under both count and size limits.
    Returns the number of entries removed.
    """
    _ensure_cache_root()

    # Collect all valid cached skills with their manifest metadata
    entries: list[dict[str, Any]] = []
    for child in CACHE_ROOT.iterdir():
        if not child.is_dir():
            continue
        manifest = _read_manifest(child)
        if manifest is None:
            # Corrupt entry — remove immediately
            shutil.rmtree(child, ignore_errors=True)
            continue
        # Calculate actual disk usage for this skill directory
        total_size = sum(f.stat().st_size for f in child.rglob("*") if f.is_file())
        entries.append({
            "name": manifest.get("name", child.name),
            "path": child,
            "fetched_at": manifest.get("fetched_at", ""),
            "total_size": total_size,
        })

    if not entries:
        return 0

    # Sort by fetched_at ascending (oldest first) for LRU eviction
    entries.sort(key=lambda e: e["fetched_at"])

    total_count = len(entries)
    total_size_bytes = sum(e["total_size"] for e in entries)
    max_size_bytes = MAX_CACHE_SIZE_MB * 1024 * 1024
    removed = 0

    # Evict oldest until under both limits
    for entry in entries:
        if total_count <= MAX_CACHE_SKILLS and total_size_bytes <= max_size_bytes:
            break
        shutil.rmtree(entry["path"], ignore_errors=True)
        logger.info(
            "LRU cleanup: removed %s (%d bytes, fetched %s)",
            entry["name"],
            entry["total_size"],
            entry["fetched_at"],
        )
        total_count -= 1
        total_size_bytes -= entry["total_size"]
        removed += 1

    if removed:
        logger.info("LRU cleanup: removed %d entries", removed)
    return removed


# ---------------------------------------------------------------------------
# Public async API
# ---------------------------------------------------------------------------


async def get_cached(name: str) -> CachedSkill | None:
    """Check cache for a skill bundle.

    Returns ``None`` if not cached, expired, or if the content hash does not
    match the manifest (corruption / tampering).
    """
    return await asyncio.to_thread(_get_cached_sync, name)


async def store(
    name: str,
    bundle: "SkillBundle",  # TODO: import from tools.skills_hub_core once available
    source: str,
    identifier: str,
) -> CachedSkill:
    """Store a skill bundle in the cache directory.

    Writes all files, generates a content hash, and persists a manifest.
    Returns the resulting ``CachedSkill``.
    """
    # Extract files from bundle — SkillBundle.files is dict[str, bytes]
    files = bundle.files  # type: ignore[union-attr]
    trust_level = getattr(bundle, "trust_level", None)

    return await asyncio.to_thread(
        _store_sync, name, files, source, identifier, trust_level
    )


async def store_files(
    name: str,
    files: dict[str, bytes],
    source: str,
    identifier: str,
    trust_level: str | None = None,
) -> CachedSkill:
    """Store raw file dicts in the cache (when SkillBundle is not available).

    This is a convenience wrapper that avoids depending on the SkillBundle
    type from ``tools.skills_hub_core``.
    """
    return await asyncio.to_thread(
        _store_sync, name, files, source, identifier, trust_level
    )


async def invalidate(name: str) -> bool:
    """Remove a skill from the cache.

    Returns ``True`` if the entry existed and was removed, ``False`` otherwise.
    """
    return await asyncio.to_thread(_invalidate_sync, name)


async def cleanup() -> int:
    """LRU cleanup — evict oldest entries until under count and size limits.

    Limits are read from environment variables at module load time:
      - ``HUB_CACHE_MAX_SKILLS`` (default 100)
      - ``HUB_CACHE_MAX_SIZE_MB`` (default 50)
      - ``HUB_CACHE_TTL_HOURS``   (default 24)

    Returns the number of entries removed.
    """
    return await asyncio.to_thread(_cleanup_sync)
