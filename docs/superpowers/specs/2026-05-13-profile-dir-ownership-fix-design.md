# Profile Directory Ownership Auto-Fix

## Problem

Files written via K8s exec (`write_file_to_pod`, `run_command`) run as root inside
the container. The agent process runs as user `hermes` (UID 10000, remappable via
`HERMES_UID`). When `ensure_hermes_home()` tries to create subdirectories inside a
root-owned profile directory (e.g. `cron/`, `kanban/`), it fails with Permission
denied, causing tasks to crash and get auto-blocked.

This has recurred multiple times across 5 gateway instances.

## Root Cause

`mkdir -p` in `write_file_to_pod` creates intermediate directories as root.
No chown is performed after writing. The hermes process cannot write into
these root-owned directories.

## Affected Callers

| Caller | Method | Path | Fix Layer |
|--------|--------|------|-----------|
| `profile_utils.py` (config.yaml) | `write_file_to_pod` | `/opt/data/profiles/{name}/` | Layer 1 + Layer 2 |
| `profile_utils.py` (SOUL.md) | `write_file_to_pod` | `/opt/data/profiles/{name}/` | Layer 1 + Layer 2 |
| `file_browser.py` (file upload) | `write_file_to_pod` | Various under `/opt/data/` | Layer 1 only |
| `hub_routes.py` (skill install) | `run_command` + tar | `/opt/data/skills/` | Separate follow-up |
| `hub_installer.py` (mkdir skills) | `run_command` | `/opt/data/skills/` | Separate follow-up |

## Solution: Two-Layer Fix

### Layer 1: File-level chown in `write_file_to_pod`

**File**: `admin/backend/k8s_client.py:633`

Append `chown $(id -u hermes):$(id -g hermes) {safe} 2>/dev/null || true` to the
shell command. This is best-effort and non-blocking:

- Uses `$(id -u hermes)` instead of hardcoded `10000` to respect `HERMES_UID` remapping
- `2>/dev/null || true` ensures failure doesn't block the write (e.g. hermes user
  doesn't exist in custom images — chown silently skipped)
- Only chowns the file itself, never parent directories (avoids shared-dir contamination)
- Benefits all `write_file_to_pod` callers: profile_utils.py (2), file_browser.py (1)

### Layer 2: Directory-level `chown -R` in `sync_profile_to_pod`

**File**: `admin/backend/profile_utils.py` (after line 173)

After writing config.yaml and SOUL.md, execute a single `chown -R` on the
entire profile directory using the existing `k8s.run_command` method:

```python
import shlex
dir_path = f"/opt/data/profiles/{shlex.quote(profile.profile_name)}"
await k8s.run_command(pod_name, [
    "sh", "-c",
    f"chown -R $(id -u hermes):$(id -g hermes) {dir_path}"
])
```

This covers all intermediate directories created by `mkdir -p`, not just the
leaf directory. `shlex.quote` provides defense-in-depth on top of the existing
Pydantic regex validation (`^[a-zA-Z0-9_-]{1,64}$`).

No new K8sClient method needed — the existing `run_command(pod_name, command: list[str])`
already provides exec-with-return functionality.

## Verification

1. Deploy to 184 dev cluster
2. Sync a profile via Admin panel
3. `kubectl exec` into pod, `ls -la /opt/data/profiles/{name}/` — all files and
   directories should be `hermes hermes`
4. Create a kanban task — should not get blocked due to Permission denied
5. Upload a file via file browser — uploaded file should be hermes-owned

## Scope

- `admin/backend/k8s_client.py` — modify `write_file_to_pod` shell command (1 line)
- `admin/backend/profile_utils.py` — add `chown -R` call after file writes (3 lines)
- No new K8sClient methods, no new dependencies
- No core hermes-agent code changes (admin-only)

## Out of Scope

- Fixing existing broken permissions on running pods (manual `kubectl exec` fix)
- Changing the K8s exec user from root to hermes (requires security context changes)
- Adding automated tests (K8s exec cannot be mocked in current test setup)
- Hub skills installation path (`_tar_write_to_pod`, `mkdir -p /opt/data/skills`) —
  uses `run_command` not `write_file_to_pod`, needs separate follow-up to add chown
  after tar extraction and directory creation
- `weixin.py` hardcoded `os.chown(accounts_dir, 10000, 10000)` — runs in admin
  backend, not in pod; known tech debt, unaffected by this change
