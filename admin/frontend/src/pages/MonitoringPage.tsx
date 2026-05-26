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
import { LoadingSpinner } from "../components/LoadingSpinner";
import { ErrorDisplay } from "../components/ErrorDisplay";

type TabKey = "overview" | "anomaly" | "resources" | "inspection";

const VALID_TABS: TabKey[] = ["overview", "anomaly", "resources", "inspection"];

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
  const [summary, setSummary] = useState<MonitorSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inspectionLoading, setInspectionLoading] = useState(false);

  const loadData = useCallback(async () => {
    try {
      // Fetch agents list + monitor summary in parallel
      const [agentsRes, summaryRes] = await Promise.all([
        adminApi.listAgents(),
        adminApi.getMonitorSummary(),
      ]);

      setAgents(agentsRes.agents);
      setSummary(summaryRes);

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
      const res = await adminApi.getLatestInspection();
      setInspectionResults(res?.results ?? []);
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
      // Silently retry on next poll
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
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 mb-6 border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setTab(tab.key)}
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
        <div className="space-y-6">
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
            <ResourceBars agents={agents} />
          </div>
        </div>
      )}

      {activeTab === "anomaly" && (
        <div>
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
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold text-text-primary mb-4">{t.monitorResourceUsage}</h3>
          <ResourceBars agents={agents} />
        </div>
      )}

      {activeTab === "inspection" && (
        <InspectionResults
          results={inspectionResults}
          onTrigger={handleTriggerInspection}
          loading={inspectionLoading}
        />
      )}
    </div>
  );
}
