import { useMemo } from "react";
import { useI18n } from "../../hooks/useI18n";
import { statusDotColor } from "../../lib/utils";
import type { AnomalyAgent } from "../../lib/admin-api";

interface AnomalyAgentListProps {
  agents: AnomalyAgent[];
  onAck: (id: number, action: string) => void;
  onNavigate: (agentId: number) => void;
}

const TAG_COLORS: Record<string, string> = {
  health_down: "bg-accent-pink/20 text-accent-pink",
  health_fail: "bg-accent-pink/20 text-accent-pink",
  pod_not_running: "bg-accent-pink/20 text-accent-pink",
  high_memory: "bg-yellow-500/20 text-yellow-400",
  high_cpu: "bg-yellow-500/20 text-yellow-400",
  high_restarts: "bg-yellow-500/20 text-yellow-400",
  inspection_degraded: "bg-text-secondary/20 text-text-secondary",
};

const SEVERITY_BORDER: Record<string, string> = {
  critical: "border-l-accent-pink",
  warning: "border-l-yellow-500",
  info: "border-l-text-secondary",
};

function formatTimeAgo(isoStr: string | null, t: { timeJustNow: string; timeMinutesAgo: string; timeHoursAgo: string; timeDaysAgo: string }): string {
  if (!isoStr) return "-";
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t.timeJustNow;
  if (mins < 60) return t.timeMinutesAgo.replace("{n}", String(mins));
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t.timeHoursAgo.replace("{n}", String(hrs));
  const days = Math.floor(hrs / 24);
  return t.timeDaysAgo.replace("{n}", String(days));
}

export function AnomalyAgentList({ agents, onAck, onNavigate }: AnomalyAgentListProps) {
  const { t } = useI18n();

  // Anomaly type label mapping
  const ANOMALY_LABELS: Record<string, string> = {
    health_down: t.monitorAnomalyHealthDown || "Health Down",
    health_fail: t.monitorAnomalyHealthDown || "Health Down",
    pod_not_running: t.monitorAnomalyPodNotRunning || "Pod Not Running",
    high_cpu: t.monitorAnomalyHighCpu || "High CPU",
    high_memory: t.monitorAnomalyHighMemory || "High Memory",
    high_restarts: t.monitorAnomalyHighRestarts || "High Restarts",
    inspection_degraded: "Inspection Degraded",
  };

  // Group anomalies by agent_number
  const grouped = useMemo(() => {
    const map = new Map<number, typeof agents[0]>();
    for (const a of agents) {
      const existing = map.get(a.agent_number);
      if (existing) {
        const types = existing.anomaly_type.split(",");
        if (!types.includes(a.anomaly_type)) {
          map.set(a.agent_number, { ...existing, anomaly_type: [...types, a.anomaly_type].join(",") });
        }
      } else {
        map.set(a.agent_number, { ...a });
      }
    }
    return Array.from(map.values());
  }, [agents]);

  if (agents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-2">
        <svg className="h-10 w-10 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p className="text-sm text-green-500 font-medium">{t.monitorAllHealthy}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {grouped.map((agent) => {
        const anomalyTypes = agent.anomaly_type.split(",");
        const tagColor = (type: string) => TAG_COLORS[type] || "bg-text-secondary/20 text-text-secondary";

        return (
          <div
            key={agent.agent_number}
            className={`rounded-lg border border-border bg-card p-4 border-l-[3px] ${SEVERITY_BORDER[agent.severity] || "border-l-text-secondary"}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                {/* Header line: dot + name */}
                <div className="flex items-center gap-2 mb-2">
                  <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${statusDotColor(agent.pod_phase === "Running" ? "running" : agent.pod_phase === "Failed" ? "failed" : "stopped")}`} />
                  <span className="text-sm font-semibold text-text-primary truncate">{agent.agent_name}</span>
                  <span className="text-xs text-text-secondary">{t.monitorLastCheck}: {formatTimeAgo(agent.updated_at, t)}</span>
                </div>

                {/* Reason tags */}
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {anomalyTypes.map((type) => (
                    <span key={type} className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${tagColor(type)}`}>
                      {ANOMALY_LABELS[type] || type}
                    </span>
                  ))}
                </div>

                {/* Resource info */}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary mb-2">
                  {agent.cpu_usage_pct != null && (
                    <span>{t.monitorCpu}: {agent.cpu_usage_pct.toFixed(1)}%</span>
                  )}
                  {agent.memory_usage_pct != null && (
                    <span>{t.monitorMem}: {agent.memory_usage_pct.toFixed(1)}%</span>
                  )}
                  {agent.restart_count != null && agent.restart_count > 0 && (
                    <span>{t.monitorRestarts}: {agent.restart_count}</span>
                  )}
                </div>

                {/* Last event summary */}
                {agent.last_event_summary && (
                  <p className="text-xs text-text-secondary truncate" title={agent.last_event_summary}>
                    {t.monitorLastEvent}: {agent.last_event_summary}
                  </p>
                )}
              </div>

              {/* Actions */}
              <div className="flex flex-col gap-1.5 shrink-0">
                {agent.status === "active" && (
                  <>
                    <button
                      onClick={() => onAck(agent.id, "acknowledged")}
                      className="px-2.5 py-1 text-xs rounded bg-accent-cyan/15 text-accent-cyan hover:bg-accent-cyan/25 transition-colors"
                    >
                      {t.monitorAcknowledge}
                    </button>
                    <button
                      onClick={() => onAck(agent.id, "ignored")}
                      className="px-2.5 py-1 text-xs rounded bg-surface text-text-secondary hover:text-text-primary border border-border-subtle transition-colors"
                    >
                      {t.monitorIgnore}
                    </button>
                  </>
                )}
                {agent.status === "acknowledged" && (
                  <span className="px-2.5 py-1 text-xs rounded bg-accent-cyan/10 text-accent-cyan/70">{t.monitorAcknowledged}</span>
                )}
                {agent.status === "ignored" && (
                  <span className="px-2.5 py-1 text-xs rounded bg-surface text-text-secondary/70">{t.monitorIgnored}</span>
                )}
                <button
                  onClick={() => onNavigate(agent.agent_number)}
                  className="px-2.5 py-1 text-xs rounded bg-surface text-accent-cyan hover:underline transition-colors"
                >
                  {t.monitorViewDetails} &rarr;
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
