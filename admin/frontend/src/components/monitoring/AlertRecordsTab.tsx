import { useState, useEffect, useCallback } from "react";
import { useI18n } from "../../hooks/useI18n";
import { adminApi } from "../../lib/admin-api";
import { showToast } from "../../lib/toast";
import type { AlertRecord, AlertRule, AgentListItem } from "../../lib/admin-api";

const PAGE_SIZE = 20;

const TIME_OPTIONS = [
  { value: "", labelKey: "alertFilterTime24h", hours: 24 },
  { value: "7d", labelKey: "alertFilterTime7d", hours: 168 },
  { value: "30d", labelKey: "alertFilterTime30d", hours: 720 },
];

const RESULT_STYLES: Record<string, string> = {
  success: "bg-green-500/15 text-green-400",
  error: "bg-accent-pink/15 text-accent-pink",
  skipped: "bg-text-secondary/15 text-text-secondary",
  cooldown: "bg-text-secondary/15 text-text-secondary",
  executing: "bg-accent-cyan/15 text-accent-cyan",
};

function getResultKey(record: AlertRecord): string {
  const result = record.action_result;
  if (!result) return "executing";
  const status = typeof result.status === "string" ? result.status : undefined;
  if (status === "success") return "success";
  if (status === "error") return "error";
  if (status === "skipped") return "skipped";
  if (status === "cooldown") return "cooldown";
  if (record.action_taken === "none") return "cooldown";
  return "executing";
}

export function AlertRecordsTab() {
  const { t } = useI18n();
  const [records, setRecords] = useState<AlertRecord[]>([]);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);

  // Filters
  const [agentFilter, setAgentFilter] = useState<number | "">("");
  const [ruleFilter, setRuleFilter] = useState<number | "">("");
  const [timeFilter, setTimeFilter] = useState("");

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const timeOpt = TIME_OPTIONS.find((o) => o.value === timeFilter) ?? TIME_OPTIONS[0];
      const since = new Date(Date.now() - timeOpt.hours * 3600_000).toISOString();

      const params: Record<string, unknown> = {
        since,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      };
      if (agentFilter !== "") params.agent_number = agentFilter;
      if (ruleFilter !== "") params.rule_id = ruleFilter;

      const res = await adminApi.listAlertRecords(params as Parameters<typeof adminApi.listAlertRecords>[0]);
      setRecords(res.records);
      setTotal(res.total);
    } catch {
      showToast(t.errorLoadFailed, "error");
    } finally {
      setLoading(false);
    }
  }, [agentFilter, ruleFilter, timeFilter, page]);

  useEffect(() => {
    adminApi.listAlertRules().then((res) => setRules(res.rules)).catch(() => {});
    adminApi.listAgents().then((res) => setAgents(res.agents)).catch(() => {});
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const ruleNameMap = new Map(rules.map((r) => [r.id, r.name]));

  const TIME_LABELS: Record<string, string> = {
      "alertFilterTime24h": t.alertFilterTime24h,
      "alertFilterTime7d": t.alertFilterTime7d,
      "alertFilterTime30d": t.alertFilterTime30d,
    };
    const RESULT_LABELS_MAP: Record<string, string> = {
      success: t.alertRecordSuccess,
      error: t.alertRecordError,
      skipped: t.alertRecordSkipped,
      cooldown: t.alertRecordCooldown,
      executing: t.alertRecordExecuting,
    };
    function getTimeLabel(key: string): string {
      return TIME_LABELS[key] ?? key;
    }
    function getResultLabel(key: string): string {
      return RESULT_LABELS_MAP[key] ?? key;
    }
  const agentNameMap = new Map(
    agents.map((a) => [a.id, a.display_name || a.name])
  );

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-text-primary">
          {t.alertRecords} ({total})
        </h3>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap gap-2 mb-4">
        {/* Agent filter */}
        <select
          value={agentFilter}
          onChange={(e) => {
            setAgentFilter(e.target.value ? Number(e.target.value) : "");
            setPage(0);
          }}
          className="h-8 px-3 text-xs rounded-lg bg-surface border border-border text-text-primary focus:outline-none focus:border-accent-cyan transition-colors"
        >
          <option value="">{t.alertFilterAllAgents}</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.display_name || a.name} (#{a.id})
            </option>
          ))}
        </select>

        {/* Rule filter */}
        <select
          value={ruleFilter}
          onChange={(e) => {
            setRuleFilter(e.target.value ? Number(e.target.value) : "");
            setPage(0);
          }}
          className="h-8 px-3 text-xs rounded-lg bg-surface border border-border text-text-primary focus:outline-none focus:border-accent-cyan transition-colors"
        >
          <option value="">{t.alertFilterAllRules}</option>
          {rules.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>

        {/* Time filter */}
        <select
          value={timeFilter}
          onChange={(e) => {
            setTimeFilter(e.target.value);
            setPage(0);
          }}
          className="h-8 px-3 text-xs rounded-lg bg-surface border border-border text-text-primary focus:outline-none focus:border-accent-cyan transition-colors"
        >
          {TIME_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {getTimeLabel(opt.labelKey)}
            </option>
          ))}
        </select>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="relative flex items-center justify-center">
            <div className="h-6 w-6 rounded-full border border-accent-cyan/20 animate-spin" style={{ animationDuration: "2s" }} />
            <div className="absolute h-6 w-6 rounded-full border-2 border-transparent border-t-accent-cyan animate-spin" />
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && records.length === 0 && (
        <div className="text-center py-12 text-sm text-text-secondary">
          {t.alertNoRecords}
        </div>
      )}

      {/* Records table */}
      {!loading && records.length > 0 && (
        <>
          <div className="bg-surface rounded-lg border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-text-secondary text-xs">
                  <th className="px-4 py-2 text-left">{t.alertRecordTime}</th>
                  <th className="px-4 py-2 text-left">{t.alertRecordAgent}</th>
                  <th className="px-4 py-2 text-left">{t.alertRecordRule}</th>
                  <th className="px-4 py-2 text-left">{t.alertRecordAction}</th>
                  <th className="px-4 py-2 text-left">{t.alertRecordResult}</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => {
                  const resultKey = getResultKey(record);
                  return (
                    <tr key={record.id} className="border-b border-border/50 hover:bg-surface/50">
                      <td className="px-4 py-2.5 text-text-secondary text-xs whitespace-nowrap">
                        {new Date(record.triggered_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-2.5 text-text-primary">
                        {agentNameMap.get(record.agent_number) ?? `Agent ${record.agent_number}`}
                      </td>
                      <td className="px-4 py-2.5 text-text-secondary">
                        {record.rule_id != null ? (ruleNameMap.get(record.rule_id) ?? `Rule ${record.rule_id}`) : "-"}
                      </td>
                      <td className="px-4 py-2.5 text-text-secondary">
                        {record.action_taken}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${RESULT_STYLES[resultKey] || RESULT_STYLES.executing}`}>
                          {getResultLabel(resultKey)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-3">
              <span className="text-xs text-text-secondary">
                {t.monitorPage.replace("{page}", String(page + 1)).replace("{total}", String(totalPages))}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="px-2.5 py-1 text-xs rounded border border-border text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors"
                >
                  {t.monitorPrevious}
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="px-2.5 py-1 text-xs rounded border border-border text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors"
                >
                  {t.monitorNext}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
