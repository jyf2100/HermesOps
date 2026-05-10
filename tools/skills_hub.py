#!/usr/bin/env python3
"""
Backward-compatible re-exports.

Prefer importing from skills_hub_core (no side effects, admin-safe) or
skills_hub_local (agent-only, depends on get_hermes_home) directly.
"""

# Import implementation modules so that patch targets like
# "tools.skills_hub.httpx" and "tools.skills_hub._write_index_cache"
# resolve correctly (patching works by attribute lookup on the module object).
from tools import skills_hub_core as _core  # noqa: F401
from tools import skills_hub_local as _local  # noqa: F401

# Core: data models, source adapters, search/fetch logic (no side effects)
from tools.skills_hub_core import (  # noqa: F401
    GitHubAuth,
    SkillMeta,
    SkillBundle,
    SkillSource,
    OptionalSkillSource,
    HermesIndexSource,
    GitHubSource,
    SkillsShSource,
    WellKnownSkillSource,
    UrlSource,
    ClawHubSource,
    ClaudeMarketplaceSource,
    LobeHubSource,
    TapsManager,
    HubLockFile,
    create_source_router,
    unified_search,
    parallel_search_sources,
    bundle_content_hash,
    _source_matches,
    _skill_meta_to_dict,
    _validate_skill_name,
    _validate_category_name,
    _validate_bundle_rel_path,
    _read_index_cache,
    _write_index_cache,
    INDEX_CACHE_TTL,
)

# Local: filesystem-bound operations (depends on get_hermes_home)
from tools.skills_hub_local import (  # noqa: F401
    quarantine_bundle,
    install_from_quarantine,
    uninstall_skill,
    check_for_skill_updates,
    ensure_hub_dirs,
    append_audit_log,
    create_source_router_local,
    SKILLS_DIR,
    HUB_DIR,
    LOCK_FILE,
    QUARANTINE_DIR,
    AUDIT_LOG,
    TAPS_FILE,
    INDEX_CACHE_DIR,
)

# Re-export submodules used as patch targets (httpx, json, etc.)
# After importing skills_hub_core as _core above, attribute lookups like
# tools.skills_hub.httpx will find it on the _core module object, but
# explicit re-export makes it more robust.
httpx = _core.httpx
