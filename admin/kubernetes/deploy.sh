#!/usr/bin/env bash
# ============================================================================
# Hermes Admin Panel - Deploy Script (Kustomize)
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAMESPACE="hermes-agent"

# Parse overlay argument
OVERLAY="${1:-}"
if [[ -z "$OVERLAY" ]]; then
    echo "Usage: $0 <overlay>"
    echo "  Available overlays:"
    for d in "$SCRIPT_DIR"/overlays/*/; do
        echo "    $(basename "$d")"
    done
    exit 1
fi

OVERLAY_DIR="$SCRIPT_DIR/overlays/$OVERLAY"
if [[ ! -d "$OVERLAY_DIR" ]]; then
    echo "ERROR: Overlay '$OVERLAY' not found at $OVERLAY_DIR"
    exit 1
fi

echo "============================================"
echo "  Hermes Admin Panel - Deploy ($OVERLAY)"
echo "============================================"

# --------------------------------------------------------------------------
# Preflight: Ensure namespace exists
# --------------------------------------------------------------------------
echo ""
echo "[Preflight] Ensuring namespace $NAMESPACE exists..."
kubectl get namespace "$NAMESPACE" > /dev/null 2>&1 || kubectl create namespace "$NAMESPACE"
echo "  Namespace ready."

# --------------------------------------------------------------------------
# Preflight: Show current cluster context
# --------------------------------------------------------------------------
CURRENT_CTX=$(kubectl config current-context 2>/dev/null || echo "unknown")
echo "  Current kubectl context: $CURRENT_CTX"

# --------------------------------------------------------------------------
# Step 1: Create admin secret if not exists
# --------------------------------------------------------------------------
echo ""
echo "[Step 1/8] Ensuring admin secret exists..."
if ! kubectl get secret hermes-admin-secret -n "$NAMESPACE" > /dev/null 2>&1; then
    ADMIN_KEY=$(openssl rand -hex 32)
    kubectl create secret generic hermes-admin-secret \
        -n "$NAMESPACE" \
        --from-literal=admin_key="$ADMIN_KEY"
    echo "  Admin key generated. Retrieve it with:"
    echo "    kubectl get secret hermes-admin-secret -n $NAMESPACE -o jsonpath='{.data.admin_key}' | base64 -d"
else
    echo "  Secret hermes-admin-secret already exists."
fi

# --------------------------------------------------------------------------
# Step 2: Create env secrets if not exists (ORCHESTRATOR_API_KEY, ADMIN_INTERNAL_TOKEN)
# --------------------------------------------------------------------------
echo ""
echo "[Step 2/8] Ensuring env secrets exist..."
if ! kubectl get secret hermes-admin-env-secrets -n "$NAMESPACE" > /dev/null 2>&1; then
    ORCH_KEY=$(openssl rand -hex 32)
    INT_TOKEN=$(openssl rand -hex 32)
    kubectl create secret generic hermes-admin-env-secrets \
        -n "$NAMESPACE" \
        --from-literal=orchestrator-api-key="$ORCH_KEY" \
        --from-literal=admin-internal-token="$INT_TOKEN"
    echo "  Created hermes-admin-env-secrets with random values."
    echo "  IMPORTANT: Update orchestrator-api-key to match your orchestrator deployment."
else
    echo "  Secret hermes-admin-env-secrets already exists."
fi

# --------------------------------------------------------------------------
# Step 3: Ensure database secret exists
# --------------------------------------------------------------------------
echo ""
echo "[Step 3/8] Ensuring database secret exists..."
if ! kubectl get secret hermes-database-secret -n "$NAMESPACE" > /dev/null 2>&1; then
    echo "  WARNING: hermes-database-secret not found."
    echo "  Create it with:"
    echo "    kubectl create secret generic hermes-database-secret -n $NAMESPACE --from-literal=database-url='postgresql://...'"
else
    echo "  Secret hermes-database-secret already exists."
fi

# --------------------------------------------------------------------------
# Step 4: Apply RBAC only (not full base)
# --------------------------------------------------------------------------
echo ""
echo "[Step 4/8] Applying RBAC resources..."
kubectl apply -f "$SCRIPT_DIR/base/rbac.yaml"
echo "  RBAC applied."

# --------------------------------------------------------------------------
# Step 5: Apply Hub Secret if not exists
# --------------------------------------------------------------------------
echo ""
echo "[Step 5/8] Ensuring Hub GitHub token secret exists..."
if ! kubectl get secret hub-github-token -n "$NAMESPACE" > /dev/null 2>&1; then
    kubectl create secret generic hub-github-token \
        -n "$NAMESPACE" \
        --from-literal=github-token=""
    echo "  Hub secret created (empty token — set via kubectl if needed)."
else
    echo "  Hub secret already exists."
fi

# --------------------------------------------------------------------------
# Step 6: Apply Kustomize overlay
# --------------------------------------------------------------------------
echo ""
echo "[Step 6/8] Applying deployment via Kustomize overlay: $OVERLAY..."
kubectl apply -k "$OVERLAY_DIR"
echo "  Deployment applied."

# --------------------------------------------------------------------------
# Step 7: Verify Ingress (read-only check)
# --------------------------------------------------------------------------
echo ""
echo "[Step 7/8] Verifying Ingress..."
if ! kubectl get ingress hermes-admin-ingress -n "$NAMESPACE" > /dev/null 2>&1; then
    echo "  WARNING: Ingress hermes-admin-ingress not found."
else
    echo "  Ingress hermes-admin-ingress exists."
    if kubectl get ingress hermes-admin-ingress -n "$NAMESPACE" -o jsonpath='{.spec.rules[0].http.paths[*].path}' | grep -q "/admin"; then
        echo "  /admin paths present."
    else
        echo "  WARNING: /admin paths not found in ingress."
    fi
fi
if ! kubectl get ingress hermes-webui-ingress -n "$NAMESPACE" > /dev/null 2>&1; then
    echo "  WARNING: Ingress hermes-webui-ingress not found."
else
    echo "  Ingress hermes-webui-ingress exists (catch-all /)."
fi

# --------------------------------------------------------------------------
# Step 8: Wait for rollout (with rollback on failure)
# --------------------------------------------------------------------------
echo ""
echo "[Step 8/8] Waiting for deployment rollout..."
if kubectl rollout status deployment/hermes-admin -n "$NAMESPACE" --timeout=120s; then
    echo ""
    echo "============================================"
    echo "  Deploy complete! ($OVERLAY)"
    echo "============================================"

    # Post-deploy: re-provision WebUI users to sync DC API keys
    echo ""
    echo "[Post-deploy] Syncing WebUI Direct Connection keys..."
    ADMIN_KEY=$(kubectl get secret hermes-admin-secret -n "$NAMESPACE" -o jsonpath='{.data.admin_key}' 2>/dev/null | base64 -d 2>/dev/null || true)
    if [[ -n "$ADMIN_KEY" ]]; then
        USER_LIST=$(kubectl exec -n "$NAMESPACE" deployment/hermes-admin -- \
            curl -sf http://localhost:48082/user/list -H "X-Admin-Key: $ADMIN_KEY" -H "Accept: application/json" 2>/dev/null || echo '{}')
        USER_COUNT=$(echo "$USER_LIST" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len([u for u in d.get('users',[]) if u.get('is_active') and u.get('agent_id')]))" 2>/dev/null || echo "0")
        if [[ "$USER_COUNT" -gt 0 ]]; then
            echo "  Re-provisioning $USER_COUNT active user(s)..."
            for uid in $(echo "$USER_LIST" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for u in d.get('users',[]):
    if u.get('is_active') and u.get('agent_id'):
        print(u['id'])
" 2>/dev/null); do
                kubectl exec -n "$NAMESPACE" deployment/hermes-admin -- \
                    curl -sf -X POST "http://localhost:48082/user/${uid}/retry-provision" \
                    -H "X-Admin-Key: $ADMIN_KEY" -H "Accept: application/json" > /dev/null 2>&1 && \
                    echo "    user $uid: OK" || echo "    user $uid: FAILED"
            done
        else
            echo "  No active users to re-provision."
        fi
    else
        echo "  WARNING: Could not retrieve admin key, skipping re-provision."
    fi
else
    echo ""
    echo "ERROR: Rollout failed. Rolling back..."
    kubectl rollout undo deployment/hermes-admin -n "$NAMESPACE"
    echo "  Rolled back to previous revision."
    exit 1
fi
