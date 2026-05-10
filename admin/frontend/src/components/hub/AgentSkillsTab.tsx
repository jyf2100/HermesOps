import { useState, useEffect, useCallback, useRef } from "react";
import { adminApi } from "../../lib/admin-api";
import type { HubInstalledSkill, HubSkillMeta, HubTask, HubAuditResult } from "../../lib/admin-api";
import { useI18n } from "../../hooks/useI18n";
import type { Translations } from "../../i18n/zh";
import { showToast } from "../../lib/toast";
import { getApiError } from "../../lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SubTab = "installed" | "browse";
type AuditModal = { skill: string; result: HubAuditResult } | null;

// ---------------------------------------------------------------------------
// AgentSkillsTab
// ---------------------------------------------------------------------------

interface Props {
  agentId: number;
  isRunning: boolean;
}

export function AgentSkillsTab({ agentId, isRunning }: Props) {
  const { t } = useI18n();
  const [subTab, setSubTab] = useState<SubTab>("installed");

  return (
    <div className="space-y-4">
      {/* Sub-tab bar */}
      <div className="flex items-center gap-1 border-b border-border pb-0" role="tablist">
        <SubTabBtn active={subTab === "installed"} onClick={() => setSubTab("installed")} label={t.skillsInstalled} />
        <SubTabBtn active={subTab === "browse"} onClick={() => setSubTab("browse")} label={t.skillsBrowse} />
      </div>

      {/* Not-running warning */}
      {!isRunning && (
        <div className="flex items-center gap-2 px-3 py-2 rounded bg-warning/10 text-warning text-xs border border-warning/20">
          <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>{t.skillsNotRunning}</span>
        </div>
      )}

      {subTab === "installed" && <div role="tabpanel"><InstalledSubTab agentId={agentId} isRunning={isRunning} /></div>}
      {subTab === "browse" && <div role="tabpanel"><BrowseSubTab agentId={agentId} isRunning={isRunning} /></div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-tab button
// ---------------------------------------------------------------------------

function SubTabBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
        active ? "text-text-primary border-accent-cyan" : "text-text-secondary border-transparent hover:text-text-primary"
      }`}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// InstalledSubTab
// ---------------------------------------------------------------------------

function InstalledSubTab({ agentId, isRunning }: { agentId: number; isRunning: boolean }) {
  const { t } = useI18n();
  const [skills, setSkills] = useState<HubInstalledSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(true);
  const [auditModal, setAuditModal] = useState<AuditModal>(null);
  const [activeTask, setActiveTask] = useState<string | null>(null);
  const [taskPhase, setTaskPhase] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval>>(null);

  const load = useCallback(async () => {
    try {
      const res = await adminApi.hubListInstalled(agentId);
      setSkills(res.skills);
      setRunning(res.running);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to load skills", "error");
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { load(); }, [load]);

  // Listen for skill changes from BrowseSubTab
  useEffect(() => {
    const handler = () => { load(); };
    window.addEventListener("hub-skill-changed", handler);
    return () => window.removeEventListener("hub-skill-changed", handler);
  }, [load]);

  // Task polling
  useEffect(() => {
    if (!activeTask) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const task = await adminApi.hubTaskStatus(agentId, activeTask);
        setTaskPhase(task.phase || task.status);
        if (task.status === "completed") {
          setActiveTask(null);
          showToast(t.skillsCompleted);
          await load();
        } else if (task.status === "failed") {
          setActiveTask(null);
          showToast(task.error || t.skillsFailed, "error");
        }
      } catch {
        setActiveTask(null);
      }
    }, 1500);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [activeTask, agentId, load, t]);

  async function handleUninstall(name: string) {
    if (!window.confirm(t.skillsUninstallConfirm.replace("{name}", name))) return;
    try {
      await adminApi.hubUninstall(agentId, name);
      showToast(`${t.skillsUninstall} ${name} - OK`);
      await load();
    } catch (err) {
      showToast(getApiError(err, t.skillsFailed), "error");
    }
  }

  async function handleUpdate(name: string) {
    try {
      const task = await adminApi.hubUpdate(agentId, name);
      setActiveTask(task.task_id);
      setTaskPhase(t.skillsUpdating);
    } catch (err) {
      showToast(getApiError(err, t.skillsFailed), "error");
    }
  }

  async function handleCheckUpdates() {
    try {
      const res = await adminApi.hubCheckUpdates(agentId);
      if (res.updates_available > 0) {
        showToast(t.skillsUpdatesAvailable.replace("{count}", String(res.updates_available)));
      } else {
        showToast(t.skillsNoUpdates);
      }
    } catch (err) {
      showToast(getApiError(err, t.skillsFailed), "error");
    }
  }

  async function handleAudit(name: string) {
    try {
      const result = await adminApi.hubAudit(agentId, name);
      setAuditModal({ skill: name, result });
    } catch (err) {
      showToast(getApiError(err, t.skillsFailed), "error");
    }
  }

  if (loading) {
    return <div className="py-8 text-center text-sm text-text-secondary">{t.skillsFetching}</div>;
  }

  return (
    <div className="space-y-3">
      {/* Actions bar */}
      {isRunning && skills.length > 0 && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCheckUpdates}
            className="h-7 px-3 text-xs rounded border border-accent-cyan text-accent-cyan hover:bg-accent-cyan/10 transition-colors"
          >
            {t.skillsCheckUpdates}
          </button>
          <button type="button" onClick={load} className="h-7 px-3 text-xs text-text-secondary hover:text-text-primary transition-colors">
            {t.refresh}
          </button>
        </div>
      )}

      {/* Active task indicator */}
      {activeTask && (
        <div className="flex items-center gap-2 px-3 py-2 rounded bg-accent-cyan/10 border border-accent-cyan/20 text-xs text-accent-cyan">
          <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span>{taskPhase}</span>
        </div>
      )}

      {/* Skills list */}
      {skills.length === 0 ? (
        <div className="rounded-lg border border-border border-dashed bg-surface/50 p-8 text-center">
          <p className="text-sm text-text-secondary">{t.skillsEmpty}</p>
        </div>
      ) : (
        <div className="space-y-1">
          {skills.map((skill) => (
            <InstalledSkillRow
              key={skill.name}
              skill={skill}
              t={t}
              disabled={!isRunning || !!activeTask}
              onUninstall={() => handleUninstall(skill.name)}
              onUpdate={() => handleUpdate(skill.name)}
              onAudit={() => handleAudit(skill.name)}
            />
          ))}
        </div>
      )}

      {/* Audit modal */}
      {auditModal && (
        <AuditDialog result={auditModal} onClose={() => setAuditModal(null)} t={t} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// InstalledSkillRow
// ---------------------------------------------------------------------------

interface InstalledSkillRowProps {
  skill: HubInstalledSkill;
  t: Translations;
  disabled: boolean;
  onUninstall: () => void;
  onUpdate: () => void;
  onAudit: () => void;
}

function InstalledSkillRow({ skill, t, disabled, onUninstall, onUpdate, onAudit }: InstalledSkillRowProps) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded border border-border bg-surface/30 hover:bg-surface/60 transition-colors group">
      {/* Name */}
      <span className="text-sm font-mono text-text-primary truncate flex-1 min-w-0">
        {skill.name}
      </span>

      {/* Source badge */}
      <SourceBadge source={skill.source} t={t} />

      {/* Trust badge */}
      {skill.trust_level && <TrustBadge level={skill.trust_level} t={t} />}

      {/* Orphan badge */}
      {skill.orphan && (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning/10 text-warning border border-warning/20">
          {t.skillsOrphan}
        </span>
      )}

      {/* Actions — always visible on touch, hover-reveal on pointer */}
      <div className="flex items-center gap-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={onAudit}
          disabled={disabled}
          className="h-6 px-2 text-[11px] text-text-secondary hover:text-accent-cyan disabled:opacity-40 transition-colors"
        >
          {t.skillsAudit}
        </button>
        <button
          type="button"
          onClick={onUpdate}
          disabled={disabled}
          className="h-6 px-2 text-[11px] text-accent-cyan hover:bg-accent-cyan/10 rounded disabled:opacity-40 transition-colors"
        >
          {t.skillsUpdate}
        </button>
        <button
          type="button"
          onClick={onUninstall}
          disabled={disabled}
          className="h-6 px-2 text-[11px] text-accent-pink hover:bg-accent-pink/10 rounded disabled:opacity-40 transition-colors"
        >
          {t.skillsUninstall}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SourceBadge
// ---------------------------------------------------------------------------

function SourceBadge({ source, t }: { source: string; t: Translations }) {
  const config: Record<string, { label: string; cls: string }> = {
    hub: { label: t.skillsSourceHub, cls: "bg-accent-cyan/10 text-accent-cyan border-accent-cyan/20" },
    builtin: { label: t.skillsSourceBuiltin, cls: "bg-blue-500/10 text-blue-400 border-blue-500/20" },
  };
  const c = config[source] ?? { label: t.skillsSourceUnknown, cls: "bg-surface text-text-secondary border-border" };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${c.cls}`}>
      {c.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// TrustBadge
// ---------------------------------------------------------------------------

function TrustBadge({ level, t }: { level: string; t: Translations }) {
  const config: Record<string, { label: string; cls: string }> = {
    builtin: { label: t.skillsTrustBuiltin, cls: "bg-blue-500/10 text-blue-400 border-blue-500/20" },
    trusted: { label: t.skillsTrustTrusted, cls: "bg-green-500/10 text-green-400 border-green-500/20" },
    community: { label: t.skillsTrustCommunity, cls: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20" },
  };
  const c = config[level] ?? { label: level, cls: "bg-surface text-text-secondary border-border" };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${c.cls}`}>
      {c.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// BrowseSubTab
// ---------------------------------------------------------------------------

function BrowseSubTab({ agentId, isRunning }: { agentId: number; isRunning: boolean }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [results, setResults] = useState<HubSkillMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [browsed, setBrowsed] = useState(false);
  const [activeTask, setActiveTask] = useState<string | null>(null);
  const [taskPhase, setTaskPhase] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const pollRef = useRef<ReturnType<typeof setInterval>>(null);

  // Debounce search
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setDebouncedQuery(query), 300);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [query]);

  // Search or browse
  useEffect(() => {
    if (!browsed) return;
    setLoading(true);
    const fn = debouncedQuery
      ? () => adminApi.hubSearch(debouncedQuery)
      : () => adminApi.hubBrowse();
    fn()
      .then((res) => setResults(res.results))
      .catch((err) => {
        setResults([]);
        showToast(getApiError(err, t.skillsFailed), "error");
      })
      .finally(() => setLoading(false));
  }, [debouncedQuery, browsed]);

  // Auto-browse on first mount
  useEffect(() => { setBrowsed(true); }, []);

  // Task polling
  useEffect(() => {
    if (!activeTask) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const task = await adminApi.hubTaskStatus(agentId, activeTask);
        setTaskPhase(task.phase || task.status);
        if (task.status === "completed") {
          setActiveTask(null);
          showToast(t.skillsCompleted);
          window.dispatchEvent(new CustomEvent("hub-skill-changed"));
        } else if (task.status === "failed") {
          setActiveTask(null);
          showToast(task.error || t.skillsFailed, "error");
        }
      } catch {
        setActiveTask(null);
      }
    }, 1500);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [activeTask, agentId, t]);

  async function handleInstall(meta: HubSkillMeta) {
    if (!isRunning) {
      showToast(t.skillsStartAgent, "error");
      return;
    }
    if (!window.confirm(t.skillsInstallConfirm.replace("{name}", meta.name))) return;
    try {
      const task = await adminApi.hubInstall(agentId, meta.identifier || meta.name);
      setActiveTask(task.task_id);
      setTaskPhase(t.skillsInstalling);
    } catch (err) {
      const msg = getApiError(err, t.skillsFailed);
      // Handle 409 already installed
      if (msg.includes("already installed")) {
        if (window.confirm(t.skillsForceConfirm)) {
          try {
            const task = await adminApi.hubInstall(agentId, meta.identifier || meta.name, true);
            setActiveTask(task.task_id);
            setTaskPhase(t.skillsInstalling);
          } catch (err2) {
            showToast(getApiError(err2, t.skillsFailed), "error");
          }
        }
      } else {
        showToast(msg, "error");
      }
    }
  }

  return (
    <div className="space-y-3">
      {/* Search */}
      <div className="relative">
        <svg
          className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-secondary"
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.skillsSearchPlaceholder}
          className="h-8 pl-8 pr-3 w-full max-w-sm text-xs bg-background border border-border rounded text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-accent-cyan"
        />
      </div>

      {/* Active task */}
      {activeTask && (
        <div className="flex items-center gap-2 px-3 py-2 rounded bg-accent-cyan/10 border border-accent-cyan/20 text-xs text-accent-cyan">
          <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span>{taskPhase}</span>
        </div>
      )}

      {/* Results */}
      {loading ? (
        <div className="py-8 text-center text-sm text-text-secondary">{t.skillsFetching}</div>
      ) : results.length === 0 ? (
        <div className="rounded-lg border border-border border-dashed bg-surface/50 p-8 text-center">
          <p className="text-sm text-text-secondary">
            {debouncedQuery ? t.skillsNoResults : t.skillsBrowseEmpty}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {results.map((meta) => (
            <BrowseSkillCard
              key={`${meta.source}-${meta.identifier}`}
              meta={meta}
              t={t}
              disabled={!isRunning || !!activeTask}
              onInstall={() => handleInstall(meta)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BrowseSkillCard
// ---------------------------------------------------------------------------

interface BrowseSkillCardProps {
  meta: HubSkillMeta;
  t: Translations;
  disabled: boolean;
  onInstall: () => void;
}

function BrowseSkillCard({ meta, t, disabled, onInstall }: BrowseSkillCardProps) {
  return (
    <div className="rounded-lg border border-border bg-surface/30 p-3 hover:border-accent-cyan/50 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <span className="text-sm font-mono text-text-primary truncate block">
            {meta.name}
          </span>
          {meta.description && (
            <p className="text-xs text-text-secondary mt-0.5 line-clamp-2">{meta.description}</p>
          )}
          <div className="flex items-center gap-1.5 mt-1.5">
            <span className="text-[10px] text-text-secondary">
              {t.skillsFromSource.replace("{source}", meta.source)}
            </span>
            {meta.trust_level && <TrustBadge level={meta.trust_level} t={t} />}
          </div>
        </div>
        <button
          type="button"
          onClick={onInstall}
          disabled={disabled}
          className="h-7 px-3 text-xs rounded bg-accent-pink text-white hover:bg-accent-pink/90 disabled:opacity-40 transition-colors shrink-0"
        >
          {t.skillsInstall}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AuditDialog
// ---------------------------------------------------------------------------

interface AuditDialogProps {
  result: { skill: string; result: HubAuditResult };
  onClose: () => void;
  t: Translations;
}

function AuditDialog({ result, onClose, t }: AuditDialogProps) {
  const { skill, result: audit } = result;
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose} role="dialog" aria-modal="true" aria-label={`${t.skillsAuditTitle}: ${skill}`}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="bg-surface border border-border rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[80vh] overflow-y-auto outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-medium text-text-primary">
            {t.skillsAuditTitle}: {skill}
          </h3>
          <button type="button" onClick={onClose} className="text-text-secondary hover:text-text-primary text-lg" aria-label={t.close}>&times;</button>
        </div>

        <div className="p-4 space-y-3">
          {/* Trust level */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-secondary">{t.skillsAudit}:</span>
            {audit.trust_level && <TrustBadge level={audit.trust_level} t={t} />}
          </div>

          {/* Scan context */}
          <div className="text-xs text-text-secondary">
            {t.skillsAuditContext}: {audit.scan_context}
          </div>

          {/* Verdict */}
          {audit.has_critical ? (
            <div className="px-3 py-2 rounded bg-accent-pink/10 border border-accent-pink/20 text-xs text-accent-pink">
              {t.skillsAuditCritical}
            </div>
          ) : audit.findings_count === 0 ? (
            <div className="px-3 py-2 rounded bg-green-500/10 border border-green-500/20 text-xs text-green-400">
              {t.skillsAuditNoIssues}
            </div>
          ) : (
            <div className="px-3 py-2 rounded bg-warning/10 border border-warning/20 text-xs text-warning">
              {t.skillsAuditFindings.replace("{count}", String(audit.findings_count))}
            </div>
          )}

          {/* Findings list */}
          {audit.scan.findings.length > 0 && (
            <div className="space-y-1.5">
              {audit.scan.findings.map((f, i) => (
                <div key={i} className="px-3 py-2 rounded border border-border bg-background text-xs">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`font-medium ${f.severity === "CRITICAL" ? "text-accent-pink" : f.severity === "WARNING" ? "text-warning" : "text-text-secondary"}`}>
                      {f.severity}
                    </span>
                    <span className="text-text-secondary">{f.category}</span>
                    {f.file && <span className="text-text-secondary font-mono ml-auto">{f.file}</span>}
                  </div>
                  <p className="text-text-secondary">{f.description}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
