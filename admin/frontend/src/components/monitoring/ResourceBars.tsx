import { useI18n } from "../../hooks/useI18n";
import { getBarColor, formatBytes } from "../../lib/utils";
import type { AgentListItem } from "../../lib/admin-api";

interface ResourceAgentData {
  agent_number: number;
  name: string;
  display_name?: string | null;
  status?: string;
  cpu_usage_pct?: number | null;
  memory_usage_pct?: number | null;
}

interface ResourceBarsProps {
  agents: AgentListItem[];
  resourceAgents?: ResourceAgentData[];
}

interface ResourceRow {
  id: number;
  name: string;
  displayName: string;
  status: string;
  cpuPct: number | null;
  memPct: number | null;
}

export function ResourceBars({ agents, resourceAgents }: ResourceBarsProps) {
  const { t } = useI18n();

  // Build lookup from backend-computed resource data
  const resourceMap = new Map<number, ResourceAgentData>();
  if (resourceAgents) {
    for (const ra of resourceAgents) {
      resourceMap.set(ra.agent_number, ra);
    }
  }

  // Compute resource data from agent list
  const rows: ResourceRow[] = agents
    .map((agent) => {
      const ra = resourceMap.get(agent.id);
      // Use backend-computed pct if available, fallback to memory_bytes/memory_limit_bytes ratio
      let cpuPct: number | null = ra?.cpu_usage_pct ?? null;
      let memPct: number | null = ra?.memory_usage_pct ?? null;

      // Fallback: compute from raw usage/limit if no backend data
      if (memPct == null) {
        const memLimit = agent.resources.memory_limit_bytes;
        const memUsed = agent.resources.memory_bytes;
        memPct = memLimit && memLimit > 0 && memUsed != null
          ? Math.round((memUsed / memLimit) * 100)
          : null;
      }

      return {
        id: agent.id,
        name: agent.name,
        displayName: agent.display_name || agent.name,
        status: ra?.status || agent.status,
        cpuPct: cpuPct != null ? Math.round(cpuPct) : null,
        memPct,
      };
    })
    // Sort by CPU usage descending, stopped agents last
    .sort((a, b) => {
      if (a.status === "stopped" && b.status !== "stopped") return 1;
      if (b.status === "stopped" && a.status !== "stopped") return -1;
      return (b.cpuPct ?? -1) - (a.cpuPct ?? -1);
    });

  if (rows.length === 0) {
    return (
      <div className="text-center py-8 text-sm text-text-secondary">
        {t.monitorNoData}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map((row) => {
        const isStopped = row.status === "stopped" || row.status === "unknown";

        return (
          <div key={row.id} className="flex items-center gap-3 group">
            {/* Agent name */}
            <span className="text-xs text-text-primary font-medium w-32 shrink-0 truncate" title={row.displayName}>
              {row.displayName}
            </span>

            {/* CPU bar */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-text-secondary w-8 shrink-0">CPU</span>
                <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${isStopped ? "bg-text-secondary/30" : getBarColor(row.cpuPct ?? 0)}`}
                    style={{ width: `${Math.min(row.cpuPct ?? 0, 100)}%` }}
                  />
                </div>
                <span className="text-[10px] text-text-secondary w-10 text-right shrink-0">
                  {isStopped ? "-" : row.cpuPct != null ? `${row.cpuPct}%` : "-"}
                </span>
              </div>
            </div>

            {/* Memory bar */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-text-secondary w-8 shrink-0">MEM</span>
                <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${isStopped ? "bg-text-secondary/30" : getBarColor(row.memPct ?? 0)}`}
                    style={{ width: `${Math.min(row.memPct ?? 0, 100)}%` }}
                  />
                </div>
                <span className="text-[10px] text-text-secondary w-10 text-right shrink-0">
                  {isStopped ? "-" : row.memPct != null ? `${row.memPct}%` : "-"}
                </span>
              </div>
            </div>

            {/* Stopped badge */}
            {isStopped && (
              <span className="text-[10px] text-text-secondary bg-surface px-1.5 py-0.5 rounded shrink-0">
                {t.monitorStopped}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
