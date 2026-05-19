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

interface AutoInstallTask {
  taskId: string;
  skillName: string;
  status: "pending" | "running" | "completed" | "failed";
  phase: string;
  error?: string;
}

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
  const tRef = useRef(t);
  tRef.current = t;
  const [skills, setSkills] = useState<HubInstalledSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(true);
  const [auditModal, setAuditModal] = useState<AuditModal>(null);
  const [activeTask, setActiveTask] = useState<string | null>(null);
  const [taskPhase, setTaskPhase] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval>>(null);

  // Auto-install progress
  const [autoInstallTasks, setAutoInstallTasks] = useState<AutoInstallTask[]>([]);
  const [autoInstallVisible, setAutoInstallVisible] = useState(false);
  const autoInstallTasksRef = useRef<AutoInstallTask[]>([]);
  const autoPollRef = useRef<ReturnType<typeof setInterval>>(null);
  const autoHideTimerRef = useRef<ReturnType<typeof setTimeout>>(null);

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

  // Listen for hub-auto-install custom events (from create_agent flow)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ taskIds: string[]; skills: string[] }>).detail;
      if (!detail?.taskIds?.length) return;
      const tasks: AutoInstallTask[] = detail.taskIds.map((id, i) => ({
        taskId: id,
        skillName: detail.skills?.[i] ?? `Skill ${i + 1}`,
        status: "pending",
        phase: tRef.current.skillsInstalling,
      }));
      setAutoInstallTasks(tasks);
      setAutoInstallVisible(true);
    };
    window.addEventListener("hub-auto-install", handler);
    return () => window.removeEventListener("hub-auto-install", handler);
  }, []);

  // Keep ref in sync with autoInstallTasks state (for use inside polling closure)
  useEffect(() => {
    autoInstallTasksRef.current = autoInstallTasks;
  }, [autoInstallTasks]);

  // Auto-install polling — uses ref to read tasks so autoInstallTasks can be
  // removed from the dependency array, preventing the interval-rebuild loop.
  useEffect(() => {
    if (!autoInstallVisible) return;

    autoPollRef.current = setInterval(async () => {
      const tasks = autoInstallTasksRef.current;
      if (tasks.length === 0) return;

      const hasActive = tasks.some((t) => t.status === "pending" || t.status === "running");
      if (!hasActive) return;

      const updated = [...tasks];
      let changed = false;

      for (let i = 0; i < updated.length; i++) {
        const task = updated[i];
        if (task.status === "completed" || task.status === "failed") continue;
        try {
          const res = await adminApi.hubTaskStatus(agentId, task.taskId);
          const newStatus = res.status === "completed" ? "completed" : res.status === "failed" ? "failed" : "running";
          updated[i] = {
            ...task,
            status: newStatus,
            phase: res.phase || res.status,
            error: res.error,
          };
          changed = true;
        } catch {
          updated[i] = { ...task, status: "failed", phase: tRef.current.skillsFailed, error: tRef.current.errorGeneric };
          showToast("Failed to check task status", "error");
          changed = true;
        }
      }

      if (changed) {
        autoInstallTasksRef.current = updated;
        setAutoInstallTasks(updated);

        const allDone = updated.every((t) => t.status === "completed" || t.status === "failed");
        if (allDone) {
          clearInterval(autoPollRef.current!);
          await load();
          // Auto-hide panel after 3 seconds
          autoHideTimerRef.current = setTimeout(() => setAutoInstallVisible(false), 3000);
        }
      }
    }, 1500);

    return () => {
      if (autoPollRef.current) clearInterval(autoPollRef.current);
      if (autoHideTimerRef.current) clearTimeout(autoHideTimerRef.current);
    };
  }, [autoInstallVisible, agentId, load]);

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
          showToast(tRef.current.skillsCompleted);
          await load();
        } else if (task.status === "failed") {
          setActiveTask(null);
          showToast(task.error || tRef.current.skillsFailed, "error");
        }
      } catch {
        setActiveTask(null);
        showToast("Failed to check task status", "error");
      }
    }, 1500);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [activeTask, agentId, load]);

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

      {/* Auto-install progress panel */}
      {autoInstallVisible && autoInstallTasks.length > 0 && (
        <AutoInstallPanel tasks={autoInstallTasks} t={t} onDismiss={() => setAutoInstallVisible(false)} />
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
// AutoInstallPanel
// ---------------------------------------------------------------------------

interface AutoInstallPanelProps {
  tasks: AutoInstallTask[];
  t: Translations;
  onDismiss: () => void;
}

function AutoInstallPanel({ tasks, t, onDismiss }: AutoInstallPanelProps) {
  const done = tasks.filter((t) => t.status === "completed" || t.status === "failed").length;
  const total = tasks.length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const allDone = done === total;

  return (
    <div className="rounded-lg border border-accent-cyan/30 bg-accent-cyan/5 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-accent-cyan/20">
        <div className="flex items-center gap-2 text-xs text-accent-cyan font-medium">
          {!allDone && (
            <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          )}
          {allDone && (
            <svg className="h-3.5 w-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
          <span>{t.skillsAutoInstall}</span>
          <span className="text-text-secondary">
            ({t.skillsAutoInstallProgress.replace("{done}", String(done)).replace("{total}", String(total))})
          </span>
        </div>
        {allDone && (
          <button
            type="button"
            onClick={onDismiss}
            className="text-text-secondary hover:text-text-primary text-xs transition-colors"
            aria-label={t.close}
          >
            &times;
          </button>
        )}
      </div>

      {/* Task list */}
      <div className="divide-y divide-border/50">
        {tasks.map((task) => (
          <div key={task.taskId} className="flex items-center gap-2 px-3 py-1.5 text-xs">
            {task.status === "completed" && (
              <svg className="h-3.5 w-3.5 shrink-0 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
            {task.status === "failed" && (
              <svg className="h-3.5 w-3.5 shrink-0 text-accent-pink" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            )}
            {(task.status === "pending" || task.status === "running") && (
              <svg className="h-3.5 w-3.5 shrink-0 animate-spin text-accent-cyan" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            <span className="font-mono text-text-primary truncate">{task.skillName}</span>
            {task.status === "failed" && task.error && (
              <span className="text-accent-pink truncate ml-auto max-w-[50%]">{task.error}</span>
            )}
            {(task.status === "pending" || task.status === "running") && (
              <span className="text-text-secondary truncate ml-auto">{task.phase}</span>
            )}
          </div>
        ))}
      </div>

      {/* Footer summary */}
      {allDone && (
        <div className="px-3 py-1.5 border-t border-accent-cyan/20 text-xs">
          {failed === 0 ? (
            <span className="text-green-400">{t.skillsAutoInstallComplete}</span>
          ) : (
            <span className="text-accent-pink">
              {t.skillsAutoInstallComplete} ({t.skillsAutoInstallPartial.replace("{failed}", String(failed))})
            </span>
          )}
        </div>
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
  const tRef = useRef(t);
  tRef.current = t;
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
          showToast(tRef.current.skillsCompleted);
          window.dispatchEvent(new CustomEvent("hub-skill-changed"));
        } else if (task.status === "failed") {
          setActiveTask(null);
          showToast(task.error || tRef.current.skillsFailed, "error");
        }
      } catch {
        setActiveTask(null);
        showToast("Failed to check task status", "error");
      }
    }, 1500);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [activeTask, agentId]);

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
