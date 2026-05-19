# Profile Directory Ownership Auto-Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Permission denied crashes by auto-chowning files written via K8s exec to the hermes user.

**Architecture:** Two-layer fix — Layer 1 adds best-effort file chown inside the low-level `write_file_to_pod` primitive; Layer 2 adds a profile-directory-wide `chown -R` after all profile files are written in `sync_profile_to_pod`.

**Tech Stack:** Python 3.12, K8s exec API, asyncio

**Spec:** `docs/superpowers/specs/2026-05-13-profile-dir-ownership-fix-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `admin/backend/k8s_client.py:633` | Modify | Add chown to `write_file_to_pod` shell command |
| `admin/backend/profile_utils.py:1,174` | Modify | Add `shlex` import + `chown -R` call after file writes |

---

### Task 1: Add file-level chown to `write_file_to_pod`

**Files:**
- Modify: `admin/backend/k8s_client.py:633`

- [ ] **Step 1: Modify the shell command in `write_file_to_pod`**

In `admin/backend/k8s_client.py`, change line 633 from:

```python
        cmd = ["sh", "-c", f"mkdir -p $(dirname {safe}) && printf '%s' '{b64}' | base64 -d > {safe}"]
```

to:

```python
        cmd = ["sh", "-c",
            f"mkdir -p $(dirname {safe}) && "
            f"printf '%s' '{b64}' | base64 -d > {safe} && "
            f"chown $(id -u hermes):$(id -g hermes) {safe} 2>/dev/null || true"]
```

- [ ] **Step 2: Verify no syntax errors**

Run: `cd /mnt/disk01/workspaces/worksummary/hermes-agent/admin/backend && python -c "import k8s_client; print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
cd /mnt/disk01/workspaces/worksummary/hermes-agent
git add admin/backend/k8s_client.py
git commit -m "fix(admin): auto-chown files written via K8s exec to hermes user"
```

---

### Task 2: Add directory-level chown -R to `sync_profile_to_pod`

**Files:**
- Modify: `admin/backend/profile_utils.py` (import section + line 174)

- [ ] **Step 1: Add `shlex` import**

In `admin/backend/profile_utils.py`, add `shlex` to the import block after line 11 (`from typing import Optional`):

```python
import shlex
```

- [ ] **Step 2: Add `chown -R` call after file writes**

In `admin/backend/profile_utils.py`, insert after line 173 (`await k8s.write_file_to_pod(pod_name, soul_path, soul_md.encode("utf-8"))`), before the `# Update DB state` comment (line 175):

```python
        # Fix ownership of entire profile directory (mkdir -p creates dirs as root)
        profile_dir = f"/opt/data/profiles/{shlex.quote(profile.profile_name)}"
        await k8s.run_command(pod_name, [
            "sh", "-c",
            f"chown -R $(id -u hermes):$(id -g hermes) {profile_dir}",
        ])
```

Note: This must be inside the `try` block (indented at the same level as the `write_file_to_pod` calls above it), so any chown failure is caught by the existing `except Exception` handler and recorded in `profile.sync_error`.

- [ ] **Step 3: Verify no syntax errors**

Run: `cd /mnt/disk01/workspaces/worksummary/hermes-agent/admin/backend && python -c "import profile_utils; print('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
cd /mnt/disk01/workspaces/worksummary/hermes-agent
git add admin/backend/profile_utils.py
git commit -m "fix(admin): chown -R profile directory after sync to prevent Permission denied"
```

---

### Task 3: Build, deploy, and verify on 184 dev cluster

- [ ] **Step 1: Build Docker image**

```bash
cd /mnt/disk01/workspaces/worksummary/hermes-agent/admin
docker build -f backend/Dockerfile --build-context tools=../tools -t hermes-admin:latest .
```

Expected: `Successfully built <hash>`

- [ ] **Step 2: Import image into containerd**

```bash
docker save hermes-admin:latest | sudo ctr -n k8s.io images import -
```

Expected: `unpacking ... done`

- [ ] **Step 3: Restart admin pod**

```bash
kubectl rollout restart deployment/hermes-admin -n hermes-agent
kubectl rollout status deployment/hermes-admin -n hermes-agent --timeout=60s
```

Expected: `deployment "hermes-admin" successfully rolled out`

- [ ] **Step 4: Verify — sync a profile and check ownership**

```bash
# Get a gateway pod name
POD=$(kubectl get pods -n hermes-agent -l app=hermes-gateway -o jsonpath='{.items[0].metadata.name}')

# Check that profile directories are hermes-owned
kubectl exec -n hermes-agent $POD -- ls -la /opt/data/profiles/
```

Expected: Directories show `hermes hermes` ownership (or `10000 10000`).

- [ ] **Step 5: Commit deployment tag**

```bash
cd /mnt/disk01/workspaces/worksummary/hermes-agent
git tag -a admin-profile-chown-fix -m "Profile dir ownership auto-fix deployed to 184"
```
