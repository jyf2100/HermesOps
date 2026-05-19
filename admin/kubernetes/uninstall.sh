#!/usr/bin/env bash
# ============================================================================
# Hermes Admin Panel - Uninstall Script
# Remove admin panel resources, preserve agent deployments
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAMESPACE="hermes-agent"

echo "============================================"
echo "  Hermes Admin Panel - Uninstall"
echo "============================================"

# --------------------------------------------------------------------------
# Step 1: Delete admin ingress (WebUI ingress preserved)
# --------------------------------------------------------------------------
echo ""
echo "[Step 1/4] Removing admin ingress..."

if kubectl get ingress hermes-admin-ingress -n "$NAMESPACE" > /dev/null 2>&1; then
    kubectl delete ingress hermes-admin-ingress -n "$NAMESPACE"
    echo "  Ingress hermes-admin-ingress deleted."
else
    echo "  Ingress hermes-admin-ingress not found, skipping."
fi

# --------------------------------------------------------------------------
# Step 2: Delete Service
# --------------------------------------------------------------------------
echo ""
echo "[Step 2/4] Deleting Service..."
if kubectl get service hermes-admin -n "$NAMESPACE" > /dev/null 2>&1; then
    kubectl delete service hermes-admin -n "$NAMESPACE"
    echo "  Service deleted."
else
    echo "  Service not found, skipping."
fi

# --------------------------------------------------------------------------
# Step 3: Delete Deployment
# --------------------------------------------------------------------------
echo ""
echo "[Step 3/4] Deleting Deployment..."
if kubectl get deployment hermes-admin -n "$NAMESPACE" > /dev/null 2>&1; then
    kubectl delete deployment hermes-admin -n "$NAMESPACE"
    echo "  Deployment deleted."
else
    echo "  Deployment not found, skipping."
fi

# --------------------------------------------------------------------------
# Step 4: Delete RBAC and Secret
# --------------------------------------------------------------------------
echo ""
echo "[Step 4/4] Deleting RBAC resources and Secret..."

kubectl delete -f "$SCRIPT_DIR/base/rbac.yaml" --ignore-not-found=true

if kubectl get secret hermes-admin-secret -n "$NAMESPACE" > /dev/null 2>&1; then
    kubectl delete secret hermes-admin-secret -n "$NAMESPACE"
    echo "  Secret deleted."
else
    echo "  Secret not found, skipping."
fi

echo ""
echo "============================================"
echo "  Hermes Admin Panel uninstalled."
echo "  Agent deployments are preserved."
echo "============================================"
