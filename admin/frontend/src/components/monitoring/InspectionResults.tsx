import { useState } from "react";
import { useI18n } from "../../hooks/useI18n";
import type { InspectionCheckResult } from "../../lib/admin-api";

interface InspectionResultsProps {
  results: InspectionCheckResult[];
  onTrigger: () => void;
  loading: boolean;
}

const STATUS_STYLES: Record<string, string> = {
  passed: "bg-green-500/15 text-green-400",
  warning: "bg-yellow-500/15 text-yellow-400",
  failed: "bg-accent-pink/15 text-accent-pink",
  skipped: "bg-text-secondary/15 text-text-secondary",
};

const STATUS_LABELS: Record<string, string> = {
  passed: "monitorPassed",
  warning: "monitorWarning",
  failed: "monitorFailed",
  skipped: "monitorSkipped",
};

const PAGE_SIZE = 20;

export function InspectionResults({ results, onTrigger, loading }: InspectionResultsProps) {
  const { t } = useI18n();
  const [page, setPage] = useState(0);

  const totalPages = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
  const start = page * PAGE_SIZE;
  const pageResults = results.slice(start, start + PAGE_SIZE);

  if (results.length === 0 && !loading) {
    return (
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-text-primary">{t.monitorInspection}</h3>
          <button
            onClick={onTrigger}
            disabled={loading}
            className="h-8 px-3 text-xs rounded-lg bg-accent-cyan/15 text-accent-cyan hover:bg-accent-cyan/25 disabled:opacity-50 transition-colors"
          >
            {loading ? t.monitorInspectionRunning : t.monitorRunInspection}
          </button>
        </div>
        <div className="text-center py-12 text-sm text-text-secondary">
          {t.monitorNoInspection}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-text-primary">
          {t.monitorInspection} ({results.length})
        </h3>
        <button
          onClick={onTrigger}
          disabled={loading}
          className="h-8 px-3 text-xs rounded-lg bg-accent-cyan/15 text-accent-cyan hover:bg-accent-cyan/25 disabled:opacity-50 transition-colors"
        >
          {loading ? t.monitorInspectionRunning : t.monitorRunInspection}
        </button>
      </div>

      {loading && results.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <div className="relative flex items-center justify-center">
            <div className="h-6 w-6 rounded-full border border-accent-cyan/20 animate-spin" style={{ animationDuration: "2s" }} />
            <div className="absolute h-6 w-6 rounded-full border-2 border-transparent border-t-accent-cyan animate-spin" />
          </div>
        </div>
      ) : (
        <>
          <div className="bg-surface rounded-lg border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-text-secondary text-xs">
                  <th className="px-4 py-2 text-left">{t.monitorAgent}</th>
                  <th className="px-4 py-2 text-left">{t.monitorCheck}</th>
                  <th className="px-4 py-2 text-left">{t.monitorStatus}</th>
                  <th className="px-4 py-2 text-left">{t.monitorDetail}</th>
                </tr>
              </thead>
              <tbody>
                {pageResults.map((result, idx) => (
                  <tr key={`${result.agent_number}-${result.check_name}-${idx}`} className="border-b border-border/50 hover:bg-surface/50">
                    <td className="px-4 py-2.5 text-text-primary">{result.agent_name}</td>
                    <td className="px-4 py-2.5 text-text-secondary">{result.check_name}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[result.status] || STATUS_STYLES.skipped}`}>
                        {t[STATUS_LABELS[result.status] as keyof typeof t] || result.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-text-secondary text-xs max-w-xs truncate" title={result.detail}>
                      {result.detail || "-"}
                    </td>
                  </tr>
                ))}
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
