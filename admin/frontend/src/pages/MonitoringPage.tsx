import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { adminApi } from "../lib/admin-api";
import type {
  AgentListItem,
  ClusterStatus,
  AnomalyAgent,
  InspectionCheckResult,
  MonitorSummary,
} from "../lib/admin-api";
import { useI18n } from "../hooks/useI18n";
import { showToast } from "../lib/toast";
import { ClusterStatusBar } from "../components/ClusterStatusBar";
import { AnomalyAgentList } from "../components/monitoring/AnomalyAgentList";
import { ResourceBars } from "../components/monitoring/ResourceBars";
import { InspectionResults } from "../components/monitoring/InspectionResults";
import { AlertRulesTab } from "../components/monitoring/AlertRulesTab";
import { AlertRecordsTab } from "../components/monitoring/AlertRecordsTab";
import { LogSearchTab } from "../components/monitoring/LogSearchTab";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { ErrorDisplay } from "../components/ErrorDisplay";

type TabKey = "overview" | "anomaly" | "resources" | "inspection" | "alert_rules" | "alert_records" | "logs";

const VALID_TABS: TabKey[] = ["overview", "anomaly", "resources", "inspection", "alert_rules", "alert_records", "logs"];

export function MonitoringPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const rawTab = searchParams.get("tab") || "overview";
  const activeTab: TabKey = VALID_TABS.includes(rawTab as TabKey) ? (rawTab as TabKey) : "overview";

  // Data state
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [cluster, setCluster] = useState<ClusterStatus | null>(null);
  const [anomalyAgents, setAnomalyAgents] = useState<AnomalyAgent[]>([]);
  const [inspectionResults, setInspectionResults] = useState<InspectionCheckResult[]>([]);
  const [resourceAgents, setResourceAgents] = useState<{ agent_number: number; name: string; cpu_usage_pct: number | null; memory_usage_pct: number | null }[]>([]);
  const [summary, setSummary] = useState<MonitorSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inspectionLoading, setInspectionLoading] = useState(false);
  const [bootstrapLoading, setBootstrapLoading] = useState(false);

  const handleBootstrapWebui = useCallback(async () => {
    setBootstrapLoading(true);
    try {
      const res = await adminApi.bootstrapAllWebui();
      showToast(`WebUI bootstrap: ${res.bootstrapped}/${res.total} initialized`, "success");
    } catch (e: unknown) {
      showToast(`WebUI bootstrap failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBootstrapLoading(false);
    }
  }, []);

  const loadData = useCallback(async () => {
    try {
      // Fetch agents list + monitor summary + latest inspection in parallel
      const [agentsRes, summaryRes, inspectionRes] = await Promise.all([
        adminApi.listAgents(),
        adminApi.getMonitorSummary(),
        adminApi.getLatestInspection().catch(() => null),
      ]);

      setAgents(agentsRes.agents);
      setSummary(summaryRes);

      // Derive resource data from latest inspection snapshots
      if (inspectionRes?.results?.length) {
        // Convert flat backend results to frontend table rows
        const rows: InspectionCheckResult[] = [];
        for (const r of inspectionRes.results) {
          const name = agentsRes.agents.find((a) => a.id === r.agent_number)?.display_name || `Agent ${r.agent_number}`;
          rows.push({
            agent_number: r.agent_number,
            agent_name: name,
            check_name: "Health",
            status: r.health_ok ? "passed" : "failed",
            detail: r.health_ok ? `OK (${r.health_latency_ms?.toFixed(0) ?? "?"}ms)` : (r.error_message ?? "Failed"),
            cpu_usage_pct: r.cpu_usage_pct,
            memory_usage_pct: r.memory_usage_pct,
          });
          rows.push({
            agent_number: r.agent_number,
            agent_name: name,
            check_name: "Pod",
            status: r.pod_phase === "Running" ? "passed" : "failed",
            detail: r.pod_phase ?? "-",
          });
          if (r.cpu_usage_pct != null) {
            rows.push({
              agent_number: r.agent_number,
              agent_name: name,
              check_name: "CPU",
              status: r.cpu_usage_pct > 90 ? "warning" : "passed",
              detail: `${r.cpu_usage_pct.toFixed(1)}%`,
              cpu_usage_pct: r.cpu_usage_pct,
            });
          }
          if (r.memory_usage_pct != null) {
            rows.push({
              agent_number: r.agent_number,
              agent_name: name,
              check_name: "Memory",
              status: r.memory_usage_pct > 90 ? "warning" : "passed",
              detail: `${r.memory_usage_pct.toFixed(1)}%`,
              memory_usage_pct: r.memory_usage_pct,
            });
          }
        }
        setInspectionResults(rows);
        const resourceData = (inspectionRes.results as any[]).map((r: any) => ({
          agent_number: r.agent_number,
          name: r.agent_name ?? `Agent ${r.agent_number}`,
          cpu_usage_pct: r.cpu_usage_pct ?? null,
          memory_usage_pct: r.memory_usage_pct ?? null,
        }));
        setResourceAgents(resourceData);
      }

      // Derive data from summary
      if (summaryRes.cluster) {
        setCluster(summaryRes.cluster);
      }
      if (summaryRes.anomaly_agents) {
        setAnomalyAgents(summaryRes.anomaly_agents);
      }

      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errorLoadFailed);
    } finally {
      setLoading(false);
    }
  }, [t]);

  // Load inspection data when inspection tab is active
  const loadInspection = useCallback(async () => {
    try {
      const [res, agentsRes] = await Promise.all([
        adminApi.getLatestInspection(),
        adminApi.listAgents(),
      ]);
      if (res?.results?.length) {
        const rows: InspectionCheckResult[] = [];
        for (const r of res.results as any[]) {
          const name = agentsRes.agents.find((a: any) => a.id === r.agent_number)?.display_name || `Agent ${r.agent_number}`;
          rows.push({ agent_number: r.agent_number, agent_name: name, check_name: "Health", status: r.health_ok ? "passed" : "failed", detail: r.health_ok ? `OK (${r.health_latency_ms?.toFixed(0) ?? "?"}ms)` : (r.error_message ?? "Failed"), cpu_usage_pct: r.cpu_usage_pct, memory_usage_pct: r.memory_usage_pct });
          rows.push({ agent_number: r.agent_number, agent_name: name, check_name: "Pod", status: r.pod_phase === "Running" ? "passed" : "failed", detail: r.pod_phase ?? "-" });
          if (r.cpu_usage_pct != null) rows.push({ agent_number: r.agent_number, agent_name: name, check_name: "CPU", status: r.cpu_usage_pct > 90 ? "warning" : "passed", detail: `${r.cpu_usage_pct.toFixed(1)}%`, cpu_usage_pct: r.cpu_usage_pct });
          if (r.memory_usage_pct != null) rows.push({ agent_number: r.agent_number, agent_name: name, check_name: "Memory", status: r.memory_usage_pct > 90 ? "warning" : "passed", detail: `${r.memory_usage_pct.toFixed(1)}%`, memory_usage_pct: r.memory_usage_pct });
        }
        setInspectionResults(rows);
      } else {
        setInspectionResults([]);
      }
    } catch {
      // Inspection data is non-critical
    }
  }, []);

  // Initial load
  useEffect(() => {
    loadData();
  }, [loadData]);

  // Load inspection data when switching to that tab
  useEffect(() => {
    if (activeTab === "inspection") {
      loadInspection();
    }
  }, [activeTab, loadInspection]);

  // 30s polling with visibilityState pause
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        loadData();
        if (activeTab === "inspection") {
          loadInspection();
        }
      }
    }, 30_000);
    return () => {
      clearInterval(interval);
      if (triggerTimeoutRef.current) clearTimeout(triggerTimeoutRef.current);
    };
  }, [loadData, loadInspection, activeTab]);

  // Tab change handler
  function setTab(tab: TabKey) {
    setSearchParams({ tab });
  }

  // Acknowledge/ignore anomaly
  async function handleAck(id: number, action: string) {
    try {
      await adminApi.updateAnomaly(id, action);
      loadData();
    } catch {
      /* non-critical */
    }
  }

  // Navigate to agent detail
  function handleNavigate(agentId: number) {
    navigate(`/agents/${agentId}`);
  }

  // Ref for inspection trigger timeout cleanup
  const triggerTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Trigger manual inspection
  async function handleTriggerInspection() {
    setInspectionLoading(true);
    try {
      await adminApi.triggerInspection();
      showToast(t.monitorInspectionTriggered, "success");
      // Reload after a delay to let inspection complete
      triggerTimeoutRef.current = setTimeout(() => {
        loadInspection();
        loadData();
        setInspectionLoading(false);
      }, 5000);
    } catch {
      showToast(t.monitorInspectionTriggerFailed, "error");
      setInspectionLoading(false);
    }
  }

  if (loading) {
    return <LoadingSpinner />;
  }

  if (error && agents.length === 0 && !summary) {
    return <ErrorDisplay error={error} onRetry={loadData} />;
  }

  const tabs: { key: TabKey; label: string }[] = [
    { key: "overview", label: t.monitorOverview },
    { key: "anomaly", label: t.monitorAnomaly },
    { key: "resources", label: t.monitorResources },
    { key: "inspection", label: t.monitorInspection },
    { key: "alert_rules", label: t.alertRules },
    { key: "alert_records", label: t.alertRecords },
    { key: "logs", label: t.logSearch },
  ];

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold font-[family-name:var(--font-body)] text-text-primary">
            {t.monitorTitle}
          </h1>
          {summary?.last_inspection_at && (
            <p className="text-sm text-text-secondary mt-0.5">
              {t.monitorLastInspection}: {new Date(summary.last_inspection_at).toLocaleString()}
              {summary.inspection_healthy ? (
                <span className="ml-2 inline-block px-1.5 py-0.5 rounded text-[10px] bg-green-500/15 text-green-400">{t.monitorHealthyBadge}</span>
              ) : (
                <span className="ml-2 inline-block px-1.5 py-0.5 rounded text-[10px] bg-yellow-500/15 text-yellow-400">{t.monitorDegradedBadge}</span>
              )}
            </p>
          )}
        </div>
        <button
          onClick={handleBootstrapWebui}
          disabled={bootstrapLoading}
          className="px-3 py-1.5 text-sm rounded-lg bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
        >
          {bootstrapLoading ? "Initializing..." : "Init WebUI Users"}
        </button>
      </div>

      {/* Tab bar */}
      <div role="tablist" className="flex gap-1 mb-6 border-b border-border overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setTab(tab.key)}
            role="tab"
            aria-selected={activeTab === tab.key}
            className={[
              "px-4 py-2 text-sm transition-colors relative -mb-px border-b-2",
              activeTab === tab.key
                ? "border-accent-cyan text-accent-cyan font-medium"
                : "border-transparent text-text-secondary hover:text-text-primary",
            ].join(" ")}
          >
            {tab.label}
            {tab.key === "anomaly" && (summary?.anomaly_count ?? 0) > 0 && (
              <span className="ml-1.5 inline-block px-1.5 py-0.5 rounded-full text-[10px] bg-accent-pink/15 text-accent-pink font-medium">
                {summary?.anomaly_count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Error banner */}
      {error && (
        <div className="bg-surface border-l-[3px] border-l-accent-pink p-3 rounded-lg mb-4">
          <p className="text-sm text-accent-pink">{error}</p>
        </div>
      )}

      {/* Tab content */}
      {activeTab === "overview" && (
        <div role="tabpanel" className="space-y-6">
          {/* Cluster health — reuse ClusterStatusBar */}
          {cluster && <ClusterStatusBar cluster={cluster} />}

          {/* Anomaly quick view */}
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-text-primary">{t.monitorAnomaly}</h3>
              {(summary?.anomaly_count ?? 0) > 0 && (
                <button
                  onClick={() => setTab("anomaly")}
                  className="text-xs text-accent-cyan hover:underline"
                >
                  {t.monitorAnomalyNeedsAttention.replace("{n}", String(summary?.anomaly_count ?? 0))}
                </button>
              )}
            </div>
            <AnomalyAgentList
              agents={anomalyAgents}
              onAck={handleAck}
              onNavigate={handleNavigate}
            />
          </div>

          {/* Resource bars */}
          <div className="rounded-lg border border-border bg-card p-4">
            <h3 className="text-sm font-semibold text-text-primary mb-3">{t.monitorResourceUsage}</h3>
            <ResourceBars agents={agents} resourceAgents={resourceAgents} />
          </div>
        </div>
      )}

      {activeTab === "anomaly" && (
        <div role="tabpanel">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-text-primary">
              {t.monitorAnomaly} ({anomalyAgents.length})
            </h3>
          </div>
          <AnomalyAgentList
            agents={anomalyAgents}
            onAck={handleAck}
            onNavigate={handleNavigate}
          />
        </div>
      )}

      {activeTab === "resources" && (
        <div role="tabpanel" className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold text-text-primary mb-4">{t.monitorResourceUsage}</h3>
          <ResourceBars agents={agents} resourceAgents={resourceAgents} />
        </div>
      )}

      {activeTab === "inspection" && (
        <InspectionResults
          results={inspectionResults}
          onTrigger={handleTriggerInspection}
          loading={inspectionLoading}
        />
      )}

      {activeTab === "alert_rules" && <AlertRulesTab />}
      {activeTab === "alert_records" && <AlertRecordsTab />}
      {activeTab === "logs" && <LogSearchTab />}
    </div>
  );
}
