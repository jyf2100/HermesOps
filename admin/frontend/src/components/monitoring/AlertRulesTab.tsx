import { useState, useEffect, useCallback } from "react";
import { useI18n } from "../../hooks/useI18n";
import { adminApi } from "../../lib/admin-api";
import { showToast } from "../../lib/toast";
import { ConfirmDialog } from "../ConfirmDialog";
import type { AlertRule, AlertRuleCreateRequest, AgentListItem } from "../../lib/admin-api";

const ANOMALY_TYPE_VALUES = [
  "health_down",
  "pod_not_running",
  "high_cpu",
  "high_memory",
  "high_restarts",
] as const;

function getAnomalyI18nKey(value: string): string | null {
  switch (value) {
    case "health_down": return "monitorAnomalyHealthDown";
    case "pod_not_running": return "monitorAnomalyPodNotRunning";
    case "high_cpu": return "monitorAnomalyHighCpu";
    case "high_memory": return "monitorAnomalyHighMemory";
    case "high_restarts": return "monitorAnomalyHighRestarts";
    default: return null;
  }
}

const SEVERITY_OPTIONS = ["critical", "warning", "info"];

interface RuleFormData {
  name: string;
  enabled: boolean;
  anomaly_type: string;
  severity_filter: string[];
  agent_scope: "all" | "specific";
  agent_numbers: number[];
  action: "alert" | "restart_pod" | "scale_resources";
  cooldown_seconds: number;
  scale_cpu_millicores: string;
  scale_memory_mb: string;
}

const EMPTY_FORM: RuleFormData = {
  name: "",
  enabled: true,
  anomaly_type: "health_down",
  severity_filter: [],
  agent_scope: "all",
  agent_numbers: [],
  action: "alert",
  cooldown_seconds: 300,
  scale_cpu_millicores: "",
  scale_memory_mb: "",
};

export function AlertRulesTab() {
  const { t } = useI18n();
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDialog, setShowDialog] = useState(false);
  const [editingRule, setEditingRule] = useState<AlertRule | null>(null);
  const [form, setForm] = useState<RuleFormData>({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const ACTION_OPTIONS = [
    { value: "alert", label: t.alertActionAlert },
    { value: "restart_pod", label: t.alertActionRestart },
    { value: "scale_resources", label: t.alertActionScale },
  ];

  const loadRules = useCallback(async () => {
    try {
      const res = await adminApi.listAlertRules();
      setRules(res.rules);
    } catch {
      showToast(t.errorLoadFailed, "error");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAgents = useCallback(async () => {
    try {
      const res = await adminApi.listAgents();
      setAgents(res.agents);
    } catch {
      // non-critical
    }
  }, []);

  useEffect(() => {
    loadRules();
    loadAgents();
  }, [loadRules, loadAgents]);

  function openCreateDialog() {
    setEditingRule(null);
    setForm({ ...EMPTY_FORM });
    setShowDialog(true);
    window.scrollTo(0, 0);
  }

  function openEditDialog(rule: AlertRule) {
    setEditingRule(rule);
    setForm({
      name: rule.name,
      enabled: rule.enabled,
      anomaly_type: rule.anomaly_type,
      severity_filter: rule.severity_filter,
      agent_scope: rule.agent_numbers.length === 0 ? "all" : "specific",
      agent_numbers: rule.agent_numbers,
      action: rule.action,
      cooldown_seconds: rule.cooldown_seconds,
      scale_cpu_millicores: rule.scale_cpu_millicores != null ? String(rule.scale_cpu_millicores) : "",
      scale_memory_mb: rule.scale_memory_mb != null ? String(rule.scale_memory_mb) : "",
    });
    setShowDialog(true);
    window.scrollTo(0, 0);
  }

  async function handleSave() {
    if (!form.name.trim()) {
      showToast(t.validationRequired, "error");
      return;
    }

    setSaving(true);
    try {
      const payload: AlertRuleCreateRequest = {
        name: form.name.trim(),
        enabled: form.enabled,
        anomaly_type: form.anomaly_type,
        severity_filter: form.severity_filter,
        agent_numbers: form.agent_scope === "all" ? [] : form.agent_numbers,
        action: form.action,
        cooldown_seconds: form.cooldown_seconds,
        scale_cpu_millicores: form.action === "scale_resources" && form.scale_cpu_millicores ? Number(form.scale_cpu_millicores) || null : null,
        scale_memory_mb: form.action === "scale_resources" && form.scale_memory_mb ? Number(form.scale_memory_mb) || null : null,
      };

      if (editingRule) {
        await adminApi.updateAlertRule(editingRule.id, payload);
      } else {
        await adminApi.createAlertRule(payload);
      }

      showToast(editingRule ? t.alertEditRule : t.alertNewRule, "success");
      setShowDialog(false);
      loadRules();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t.errorSaveFailed, "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(rule: AlertRule) {
    try {
      await adminApi.updateAlertRule(rule.id, { enabled: !rule.enabled });
      setRules((prev) =>
        prev.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r))
      );
    } catch {
      showToast(t.errorSaveFailed, "error");
    }
  }

  async function handleDelete(id: number) {
    setDeletingId(id);
    try {
      await adminApi.deleteAlertRule(id);
      setRules((prev) => prev.filter((r) => r.id !== id));
      showToast(t.alertDeleteRule, "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : t.errorGeneric, "error");
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  }

  function toggleSeverity(sev: string) {
    setForm((prev) => ({
      ...prev,
      severity_filter: prev.severity_filter.includes(sev)
        ? prev.severity_filter.filter((s) => s !== sev)
        : [...prev.severity_filter, sev],
    }));
  }

  function toggleAgent(num: number) {
    setForm((prev) => ({
      ...prev,
      agent_numbers: prev.agent_numbers.includes(num)
        ? prev.agent_numbers.filter((n) => n !== num)
        : [...prev.agent_numbers, num],
    }));
  }

  const anomalyLabel = (value: string): string => {
    const key = getAnomalyI18nKey(value);
    if (key) return t[key as keyof typeof t] as string;
    return value;
  };

  const actionLabel = (value: string) =>
    ACTION_OPTIONS.find((a) => a.value === value)?.label ?? value;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="relative flex items-center justify-center">
          <div className="h-6 w-6 rounded-full border border-accent-cyan/20 animate-spin" style={{ animationDuration: "2s" }} />
          <div className="absolute h-6 w-6 rounded-full border-2 border-transparent border-t-accent-cyan animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-text-primary">
          {t.alertRulesTitle} ({rules.length})
        </h3>
        <button
          onClick={openCreateDialog}
          className="h-8 px-3 text-xs rounded-lg bg-accent-cyan/15 text-accent-cyan hover:bg-accent-cyan/25 transition-colors"
        >
          + {t.alertNewRule}
        </button>
      </div>

      {/* Empty state */}
      {rules.length === 0 && (
        <div className="text-center py-12 text-sm text-text-secondary">
          {t.alertNoRules}
        </div>
      )}

      {/* Rules table */}
      {rules.length > 0 && (
        <div className="bg-surface rounded-lg border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-text-secondary text-xs">
                <th className="px-4 py-2 text-left">{t.alertRuleName}</th>
                <th className="px-4 py-2 text-left">{t.alertAnomalyType}</th>
                <th className="px-4 py-2 text-left">{t.alertSeverity}</th>
                <th className="px-4 py-2 text-left">{t.alertAction}</th>
                <th className="px-4 py-2 text-left">{t.alertCooldown}</th>
                <th className="px-4 py-2 text-left">{t.alertEnabled}</th>
                <th className="px-4 py-2 text-right">{t.agentActions}</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className="border-b border-border/50 hover:bg-surface/50">
                  <td className="px-4 py-2.5 text-text-primary font-medium">{rule.name}</td>
                  <td className="px-4 py-2.5 text-text-secondary">{anomalyLabel(rule.anomaly_type)}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex gap-1 flex-wrap">
                      {rule.severity_filter.map((sev) => {
                        const color =
                          sev === "critical"
                            ? "bg-accent-pink/15 text-accent-pink"
                            : sev === "warning"
                              ? "bg-yellow-500/15 text-yellow-400"
                              : "bg-text-secondary/15 text-text-secondary";
                        const label =
                          sev === "critical"
                            ? t.alertSeverityCritical
                            : sev === "warning"
                              ? t.alertSeverityWarning
                              : t.alertSeverityInfo;
                        return (
                          <span key={sev} className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${color}`}>
                            {label}
                          </span>
                        );
                      })}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-text-secondary">{actionLabel(rule.action)}</td>
                  <td className="px-4 py-2.5 text-text-secondary">{rule.cooldown_seconds}s</td>
                  <td className="px-4 py-2.5">
                    <button
                      onClick={() => handleToggle(rule)}
                      role="switch"
                      aria-checked={rule.enabled}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                        rule.enabled ? "bg-accent-cyan" : "bg-border"
                      }`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                          rule.enabled ? "translate-x-[18px]" : "translate-x-[3px]"
                        }`}
                      />
                    </button>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => openEditDialog(rule)}
                        className="px-2 py-1 text-xs rounded bg-surface text-accent-cyan hover:underline transition-colors"
                      >
                        {t.edit}
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(rule.id)}
                        disabled={deletingId === rule.id}
                        className="px-2 py-1 text-xs rounded bg-accent-pink/10 text-accent-pink hover:bg-accent-pink/20 disabled:opacity-50 transition-colors"
                      >
                        {t.alertDelete}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={confirmDeleteId !== null}
        title={t.alertDelete}
        message={t.alertDeleteConfirm}
        confirmLabel={t.alertDelete}
        variant="destructive"
        onConfirm={() => {
          if (confirmDeleteId !== null) handleDelete(confirmDeleteId);
        }}
        onCancel={() => setConfirmDeleteId(null)}
        loading={deletingId !== null}
      />

      {/* Dialog overlay */}
      {showDialog && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="alert-rule-dialog-heading"
          className="fixed inset-0 z-50 flex items-start justify-center pt-16 overflow-y-auto pb-8 bg-black/60"
          onClick={(e) => { if (e.target === e.currentTarget) setShowDialog(false); }}
          onKeyDown={(e) => { if (e.key === "Escape") setShowDialog(false); }}
        >
          <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
            {/* Dialog header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
              <h2 id="alert-rule-dialog-heading" className="text-sm font-semibold text-text-primary">
                {editingRule ? t.alertEditRule : t.alertNewRule}
              </h2>
              <button
                onClick={() => setShowDialog(false)}
                className="text-text-secondary hover:text-text-primary transition-colors"
                aria-label={t.close}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Dialog body — scrollable */}
            <div className="px-5 py-4 space-y-4 overflow-y-auto flex-1 min-h-0">
              {/* Name */}
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">{t.alertRuleName}</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                  className="w-full h-8 px-3 text-sm rounded-lg bg-surface border border-border text-text-primary focus:outline-none focus:border-accent-cyan transition-colors"
                  placeholder={t.alertRuleName}
                />
              </div>

              {/* Anomaly type */}
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">{t.alertAnomalyType}</label>
                <select
                  value={form.anomaly_type}
                  onChange={(e) => setForm((prev) => ({ ...prev, anomaly_type: e.target.value }))}
                  className="w-full h-8 px-3 text-sm rounded-lg bg-surface border border-border text-text-primary focus:outline-none focus:border-accent-cyan transition-colors"
                >
                  {ANOMALY_TYPE_VALUES.map((value) => (
                    <option key={value} value={value}>{anomalyLabel(value)}</option>
                  ))}
                </select>
              </div>

              {/* Severity filter */}
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">{t.alertSeverity}</label>
                <div className="flex gap-2">
                  {SEVERITY_OPTIONS.map((sev) => {
                    const active = form.severity_filter.includes(sev);
                    const color = active
                      ? sev === "critical"
                        ? "bg-accent-pink/20 text-accent-pink border-accent-pink/40"
                        : sev === "warning"
                          ? "bg-yellow-500/20 text-yellow-400 border-yellow-500/40"
                          : "bg-text-secondary/20 text-text-secondary border-text-secondary/40"
                      : "bg-surface text-text-secondary border-border";
                    const label =
                      sev === "critical"
                        ? t.alertSeverityCritical
                        : sev === "warning"
                          ? t.alertSeverityWarning
                          : t.alertSeverityInfo;
                    return (
                      <button
                        key={sev}
                        type="button"
                        onClick={() => toggleSeverity(sev)}
                        className={`px-2.5 py-1 text-xs rounded border transition-colors ${color}`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Target agents */}
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">{t.alertTargetAgents}</label>
                <div className="flex gap-2 mb-2">
                  <button
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, agent_scope: "all" }))}
                    className={`px-2.5 py-1 text-xs rounded border transition-colors ${
                      form.agent_scope === "all"
                        ? "bg-accent-cyan/20 text-accent-cyan border-accent-cyan/40"
                        : "bg-surface text-text-secondary border-border"
                    }`}
                  >
                    {t.alertAllAgents}
                  </button>
                  <button
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, agent_scope: "specific" }))}
                    className={`px-2.5 py-1 text-xs rounded border transition-colors ${
                      form.agent_scope === "specific"
                        ? "bg-accent-cyan/20 text-accent-cyan border-accent-cyan/40"
                        : "bg-surface text-text-secondary border-border"
                    }`}
                  >
                    {t.alertSpecifyAgents}
                  </button>
                </div>
                {form.agent_scope === "specific" && (
                  <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto p-2 rounded-lg bg-surface border border-border">
                    {agents.map((agent) => {
                      const selected = form.agent_numbers.includes(agent.id);
                      return (
                        <button
                          key={agent.id}
                          type="button"
                          onClick={() => toggleAgent(agent.id)}
                          className={`px-2 py-0.5 text-xs rounded transition-colors ${
                            selected
                              ? "bg-accent-cyan/20 text-accent-cyan"
                              : "bg-card text-text-secondary hover:text-text-primary"
                          }`}
                        >
                          {agent.display_name || agent.name} (#{agent.id})
                        </button>
                      );
                    })}
                    {agents.length === 0 && (
                      <span className="text-xs text-text-secondary">{t.alertNoAgents}</span>
                    )}
                  </div>
                )}
              </div>

              {/* Action */}
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">{t.alertAction}</label>
                <select
                  value={form.action}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === "alert" || val === "restart_pod" || val === "scale_resources") {
                      setForm((prev) => ({ ...prev, action: val }));
                    }
                  }}
                  className="w-full h-8 px-3 text-sm rounded-lg bg-surface border border-border text-text-primary focus:outline-none focus:border-accent-cyan transition-colors"
                >
                  {ACTION_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              {/* Scale settings (conditional) */}
              {form.action === "scale_resources" && (
                <div className="space-y-3 p-3 rounded-lg bg-surface border border-border">
                  <h4 className="text-xs font-medium text-text-secondary">{t.alertScaleSection}</h4>
                  <div>
                    <label className="block text-xs text-text-secondary mb-1">{t.alertScaleCPU}</label>
                    <input
                      type="number"
                      value={form.scale_cpu_millicores}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, scale_cpu_millicores: e.target.value }))
                      }
                      min={0}
                      max={4000}
                      placeholder={t.alertScaleHintCPU}
                      className="w-full h-8 px-3 text-sm rounded-lg bg-card border border-border text-text-primary focus:outline-none focus:border-accent-cyan transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-text-secondary mb-1">{t.alertScaleMemory}</label>
                    <input
                      type="number"
                      value={form.scale_memory_mb}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, scale_memory_mb: e.target.value }))
                      }
                      min={0}
                      max={8192}
                      placeholder={t.alertScaleHintMemory}
                      className="w-full h-8 px-3 text-sm rounded-lg bg-card border border-border text-text-primary focus:outline-none focus:border-accent-cyan transition-colors"
                    />
                  </div>
                </div>
              )}

              {/* Cooldown */}
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">{t.alertCooldownSeconds}</label>
                <input
                  type="number"
                  value={form.cooldown_seconds}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, cooldown_seconds: Number(e.target.value) || 0 }))
                  }
                  min={0}
                  className="w-full h-8 px-3 text-sm rounded-lg bg-surface border border-border text-text-primary focus:outline-none focus:border-accent-cyan transition-colors"
                />
              </div>

              {/* Enabled toggle */}
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-text-secondary">
                  {form.enabled ? t.alertEnabled : t.alertDisabled}
                </label>
                <button
                  type="button"
                  onClick={() => setForm((prev) => ({ ...prev, enabled: !prev.enabled }))}
                  role="switch"
                  aria-checked={form.enabled}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                    form.enabled ? "bg-accent-cyan" : "bg-border"
                  }`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                      form.enabled ? "translate-x-[18px]" : "translate-x-[3px]"
                    }`}
                  />
                </button>
              </div>
            </div>

            {/* Dialog footer */}
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border shrink-0">
              <button
                onClick={() => setShowDialog(false)}
                className="px-3 py-1.5 text-xs rounded-lg bg-surface border border-border text-text-secondary hover:text-text-primary transition-colors"
              >
                {t.alertCancel}
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-3 py-1.5 text-xs rounded-lg bg-accent-cyan/15 text-accent-cyan hover:bg-accent-cyan/25 disabled:opacity-50 transition-colors"
              >
                {saving ? t.loading : t.alertSave}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
