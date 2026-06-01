import { useState, useEffect, useCallback, useRef } from "react";
import { useI18n } from "../../hooks/useI18n";
import { adminApi } from "../../lib/admin-api";
import { showToast } from "../../lib/toast";
import type { LogSearchRequest, LogEntry, AgentListItem } from "../../lib/admin-api";
import { LogExportButton } from "./LogExportButton";

// ---------------------------------------------------------------------------
// HighlightText — safe keyword highlight using JSX <mark> (no innerHTML)
// ---------------------------------------------------------------------------

function HighlightText({ text, keyword }: { text: string; keyword: string }) {
  if (!keyword) return <>{text}</>;
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === keyword.toLowerCase() ? (
          <mark key={i} className="bg-yellow-500/30 text-text-primary rounded px-0.5">
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Time range helper
// ---------------------------------------------------------------------------

function getTimeFrom(range: string): string | null {
  const now = new Date();
  switch (range) {
    case "1h":
      now.setHours(now.getHours() - 1);
      return now.toISOString();
    case "6h":
      now.setHours(now.getHours() - 6);
      return now.toISOString();
    case "24h":
      now.setHours(now.getHours() - 24);
      return now.toISOString();
    case "7d":
      now.setDate(now.getDate() - 7);
      return now.toISOString();
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// LogSearchTab
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;

const TIME_RANGES = ["1h", "6h", "24h", "7d"] as const;
const LEVEL_OPTIONS = ["ERROR", "WARN", "INFO", "DEBUG"] as const;

export function LogSearchTab() {
  const { t } = useI18n();

  // Search state
  const [keywords, setKeywords] = useState("");
  const [debouncedKeywords, setDebouncedKeywords] = useState("");
  const [selectedAgents, setSelectedAgents] = useState<number[]>([]);
  const [level, setLevel] = useState<string>("");
  const [timeRange, setTimeRange] = useState<string>("24h");
  const [page, setPage] = useState(1);

  // Data state
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [loading, setLoading] = useState(false);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [showAgentDropdown, setShowAgentDropdown] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const agentDropdownRef = useRef<HTMLDivElement>(null);

  // Load agents list for dropdown
  useEffect(() => {
    adminApi.listAgents().then((res) => setAgents(res.agents)).catch(() => {});
  }, []);

  // Close agent dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (agentDropdownRef.current && !agentDropdownRef.current.contains(e.target as Node)) {
        setShowAgentDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Debounce keywords (300ms)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedKeywords(keywords);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [keywords]);

  // Build search params
  const buildParams = useCallback(
    (p: number): LogSearchRequest => ({
      keywords: debouncedKeywords,
      agents: selectedAgents,
      level: level || null,
      time_from: getTimeFrom(timeRange),
      time_to: null,
      page: p,
      page_size: PAGE_SIZE,
    }),
    [debouncedKeywords, selectedAgents, level, timeRange]
  );

  // Execute search
  const doSearch = useCallback(
    async (p: number) => {
      setLoading(true);
      try {
        const res = await adminApi.searchLogs(buildParams(p));
        setEntries(res.entries);
        setTotal(res.total);
        setElapsedMs(res.elapsed_ms);
        setPage(p);
      } catch (err) {
        showToast(err instanceof Error ? err.message : t.errorLoadFailed, "error");
        setEntries([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    },
    [buildParams, t]
  );

  // Auto-search when filters change
  useEffect(() => {
    doSearch(1);
  }, [doSearch]);

  // Agent toggle
  function toggleAgent(num: number) {
    setSelectedAgents((prev) =>
      prev.includes(num) ? prev.filter((n) => n !== num) : [...prev, num]
    );
  }

  function clearAgents() {
    setSelectedAgents([]);
  }

  // Time range label
  function timeRangeLabel(range: string): string {
    switch (range) {
      case "1h": return t.logTime1h;
      case "6h": return t.logTime6h;
      case "24h": return t.logTime24h;
      case "7d": return t.logTime7d;
      default: return range;
    }
  }

  // Level label
  function levelLabel(lvl: string): string {
    switch (lvl) {
      case "ERROR": return t.logLevelError;
      case "WARN": return t.logLevelWarn;
      case "INFO": return t.logLevelInfo;
      case "DEBUG": return t.logLevelDebug;
      default: return lvl;
    }
  }

  // Level border color
  function levelBorderClass(entry: LogEntry): string {
    if (entry.is_error) return "border-l-accent-pink";
    const lvl = (entry.level ?? "").toUpperCase();
    if (lvl === "WARN") return "border-l-yellow-500";
    return "border-l-border";
  }

  // Level badge
  function levelBadge(entry: LogEntry) {
    const lvl = (entry.level ?? "").toUpperCase();
    if (entry.is_error || lvl === "ERROR") {
      return (
        <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent-pink/15 text-accent-pink">
          {t.logError}
        </span>
      );
    }
    if (lvl === "WARN") {
      return (
        <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-yellow-500/15 text-yellow-400">
          {t.logWarn}
        </span>
      );
    }
    if (lvl === "INFO") {
      return (
        <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent-cyan/15 text-accent-cyan">
          {t.logInfo}
        </span>
      );
    }
    if (lvl === "DEBUG") {
      return (
        <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-text-secondary/15 text-text-secondary">
          {t.logDebug}
        </span>
      );
    }
    return null;
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Current export params (keep in sync with search params)
  const exportParams = buildParams(page);

  return (
    <div>
      {/* Search filters */}
      <div className="bg-card rounded-lg border border-border p-4 mb-4 space-y-3">
        {/* Row 1: Keywords + Agent dropdown + Level + Time range */}
        <div className="flex flex-wrap gap-2 items-end">
          {/* Keywords input */}
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs font-medium text-text-secondary mb-1">
              {t.logKeywords}
            </label>
            <input
              type="text"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder={t.logPlaceholder}
              className="w-full h-8 px-3 text-sm rounded-lg bg-surface border border-border text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent-cyan transition-colors"
            />
          </div>

          {/* Agent multi-select dropdown */}
          <div className="relative min-w-[160px]" ref={agentDropdownRef}>
            <label className="block text-xs font-medium text-text-secondary mb-1">
              {t.monitorAgent}
            </label>
            <button
              onClick={() => setShowAgentDropdown(!showAgentDropdown)}
              className="w-full h-8 px-3 text-sm rounded-lg bg-surface border border-border text-text-primary text-left flex items-center justify-between gap-1 hover:border-accent-cyan/50 transition-colors"
            >
              <span className="truncate">
                {selectedAgents.length === 0
                  ? t.logAllAgents
                  : t.logAgentCount.replace("{count}", String(selectedAgents.length))}
              </span>
              <svg className="w-3 h-3 text-text-secondary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {showAgentDropdown && (
              <div className="absolute z-20 mt-1 w-full bg-card border border-border rounded-lg shadow-lg max-h-48 overflow-y-auto">
                {agents.length === 0 && (
                  <div className="px-3 py-2 text-xs text-text-secondary">{t.logNoAgents}</div>
                )}
                {agents.map((agent) => {
                  const checked = selectedAgents.includes(agent.id);
                  return (
                    <label
                      key={agent.id}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs text-text-primary hover:bg-surface cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleAgent(agent.id)}
                        className="accent-accent-cyan"
                      />
                      <span className="truncate">
                        {agent.display_name || agent.name} (#{agent.id})
                      </span>
                    </label>
                  );
                })}
                {selectedAgents.length > 0 && (
                  <button
                    onClick={clearAgents}
                    className="w-full px-3 py-1.5 text-xs text-accent-pink hover:bg-accent-pink/10 border-t border-border text-left"
                  >
                    {t.logAllAgents}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Level dropdown */}
          <div className="min-w-[120px]">
            <label className="block text-xs font-medium text-text-secondary mb-1">
              {t.logLevel}
            </label>
            <select
              value={level}
              onChange={(e) => setLevel(e.target.value)}
              className="w-full h-8 px-3 text-sm rounded-lg bg-surface border border-border text-text-primary focus:outline-none focus:border-accent-cyan transition-colors"
            >
              <option value="">{t.logAllLevels}</option>
              {LEVEL_OPTIONS.map((lvl) => (
                <option key={lvl} value={lvl}>
                  {levelLabel(lvl)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Row 2: Time range pills + Search/Export buttons */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-text-secondary mr-1">{t.logTimeRange}</span>
            {TIME_RANGES.map((range) => (
              <button
                key={range}
                onClick={() => setTimeRange(range)}
                className={`px-2.5 py-1 text-xs rounded border transition-colors ${
                  timeRange === range
                    ? "bg-accent-cyan/20 text-accent-cyan border-accent-cyan/40"
                    : "bg-surface text-text-secondary border-border hover:text-text-primary"
                }`}
              >
                {timeRangeLabel(range)}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => doSearch(1)}
              disabled={loading}
              className="h-8 px-4 text-xs rounded-lg bg-accent-cyan/15 text-accent-cyan hover:bg-accent-cyan/25 disabled:opacity-50 transition-colors font-medium"
            >
              {loading ? t.loading : t.logSearchButton}
            </button>
            <LogExportButton params={exportParams} />
          </div>
        </div>
      </div>

      {/* Results info */}
      {!loading && total > 0 && (
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs text-text-secondary">
            {t.logResultCount
              .replace("{count}", String(total))
              .replace("{elapsed}", String(elapsedMs))}
          </p>
          <p className="text-xs text-text-secondary">
            {t.monitorPage
              .replace("{page}", String(page))
              .replace("{total}", String(totalPages))}
          </p>
        </div>
      )}

      {/* Loading spinner */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="relative flex items-center justify-center">
            <div
              className="h-6 w-6 rounded-full border border-accent-cyan/20 animate-spin"
              style={{ animationDuration: "2s" }}
            />
            <div className="absolute h-6 w-6 rounded-full border-2 border-transparent border-t-accent-cyan animate-spin" />
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && entries.length === 0 && (
        <div className="text-center py-12 text-sm text-text-secondary">
          {t.logNoResults}
        </div>
      )}

      {/* Log entries list */}
      {!loading && entries.length > 0 && (
        <div className="space-y-1">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className={`border-l-[3px] ${levelBorderClass(entry)} bg-card rounded-r-lg px-4 py-2.5 hover:bg-surface/50 transition-colors`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-mono text-accent-cyan">
                  Agent #{entry.agent_number}
                </span>
                {levelBadge(entry)}
                <span className="text-[10px] text-text-secondary ml-auto">
                  {new Date(entry.collected_at).toLocaleString()}
                </span>
              </div>
              <div className="text-sm text-text-primary font-mono whitespace-pre-wrap break-all leading-relaxed">
                <HighlightText text={entry.content} keyword={debouncedKeywords} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {!loading && totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-4">
          <button
            onClick={() => doSearch(page - 1)}
            disabled={page <= 1}
            className="h-8 px-3 text-xs rounded-lg bg-surface border border-border text-text-secondary hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {t.monitorPrevious}
          </button>
          <span className="text-xs text-text-secondary">
            {t.monitorPage
              .replace("{page}", String(page))
              .replace("{total}", String(totalPages))}
          </span>
          <button
            onClick={() => doSearch(page + 1)}
            disabled={page >= totalPages}
            className="h-8 px-3 text-xs rounded-lg bg-surface border border-border text-text-secondary hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {t.monitorNext}
          </button>
        </div>
      )}
    </div>
  );
}
