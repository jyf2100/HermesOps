import { useState, useEffect, useMemo } from "react";
import { useKanbanBoard } from "../../stores/kanbanBoard";
import { showToast } from "../../lib/toast";
import { adminFetch } from "../../lib/admin-api";
import { useI18n } from "../../hooks/useI18n";
import { ModalOverlay } from "../shared/ModalOverlay";
import { AgentProfileData } from "../../types/profile";

interface SkillEntry {
  name: string;
  description: string;
  tags?: string[];
}

type ProfileData = Pick<AgentProfileData, "profile_name" | "display_name" | "sync_status">;

interface CreateTaskModalProps {
  agentId: number;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function CreateTaskModal({
  agentId,
  open,
  onClose,
  onCreated,
}: CreateTaskModalProps) {
  const createTask = useKanbanBoard((s) => s.createTask);
  const boardTasks = useKanbanBoard((s) => s.tasks);
  const assignees = useKanbanBoard((s) => s.assignees);
  const fetchAssignees = useKanbanBoard((s) => s.fetchAssignees);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState(2);
  const [labelsInput, setLabelsInput] = useState("");
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [availableSkills, setAvailableSkills] = useState<SkillEntry[]>([]);
  const [skillsFilter, setSkillsFilter] = useState("");
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [assignee, setAssignee] = useState("default");
  const [assigneeFilter, setAssigneeFilter] = useState("");
  const [selectedParents, setSelectedParents] = useState<string[]>([]);
  const [parentsFilter, setParentsFilter] = useState("");
  const [orchestrate, setOrchestrate] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [profileMap, setProfileMap] = useState<Map<string, ProfileData>>(new Map());
  const { t } = useI18n();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSkillsLoading(true);
    adminFetch<SkillEntry[]>(`/agents/${agentId}/skills`)
      .then((skills) => {
        if (!cancelled) setAvailableSkills(skills);
      })
      .catch(() => {
        if (!cancelled) setAvailableSkills([]);
      })
      .finally(() => {
        if (!cancelled) setSkillsLoading(false);
      });
    if (!cancelled) fetchAssignees(agentId);
    // Fetch profile metadata for display_name + sync status
    adminFetch<ProfileData[]>(`/agents/${agentId}/profiles`)
      .then((profiles) => {
        if (!cancelled) {
          const m = new Map<string, ProfileData>();
          for (const p of Array.isArray(profiles) ? profiles : []) {
            m.set(p.profile_name, p);
          }
          setProfileMap(m);
        }
      })
      .catch(() => {
        // Profile data is optional — fallback to raw names
      });
    return () => { cancelled = true; };
  }, [open, agentId]);

  const suggestedSkills = useMemo(() => {
    const text = `${title} ${body}`.toLowerCase();
    if (!text.trim() || availableSkills.length === 0) return new Set<string>();
    const tokens = text.match(/[a-z]{2,}|[一-鿿぀-ゟ゠-ヿ]+/g) ?? [];
    const matched = new Set<string>();
    for (const skill of availableSkills) {
      if (skill.name === "kanban-worker") continue;
      const skillText = `${skill.name} ${(skill.tags ?? []).join(" ")} ${skill.description}`.toLowerCase();
      for (const token of tokens) {
        if (skillText.includes(token)) {
          matched.add(skill.name);
          break;
        }
      }
    }
    return matched;
  }, [title, body, availableSkills]);

  const advancedConfigCount = useMemo(() => {
    let n = 0;
    if (assignee !== "default") n++;
    if (selectedSkills.length > 0) n++;
    if (selectedParents.length > 0) n++;
    if (orchestrate) n++;
    return n;
  }, [assignee, selectedSkills, selectedParents, orchestrate]);

  function applySuggestions() {
    setSelectedSkills((prev) => {
      const merged = new Set(prev);
      for (const s of suggestedSkills) merged.add(s);
      return [...merged];
    });
  }

  if (!open) return null;

  function toggleSkill(name: string) {
    setSelectedSkills((prev) =>
      prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name]
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;

    setSubmitting(true);
    setError(null);
    try {
      const labels = labelsInput.trim()
        ? labelsInput.split(",").map((l: string) => l.trim()).filter(Boolean)
        : undefined;
      await createTask(agentId, {
        title: title.trim(),
        body: body.trim() || undefined,
        priority,
        labels,
        skills: (selectedSkills.length > 0 || orchestrate)
          ? [...selectedSkills, ...(orchestrate ? ["kanban-orchestrator"] : [])]
          : undefined,
        assignee: assignee.trim() || "default",
        parents: selectedParents.length > 0 ? selectedParents : undefined,
      });
      showToast(t.kanbanTaskCreated);
      resetForm();
      onCreated();
      onClose();
    } catch (e: unknown) {
      setError(
        e instanceof Error ? e.message : t.kanbanCreateFailed
      );
    } finally {
      setSubmitting(false);
    }
  }

  function resetForm() {
    setTitle("");
    setBody("");
    setPriority(2);
    setLabelsInput("");
    setSelectedSkills([]);
    setSkillsFilter("");
    setAssignee("default");
    setAssigneeFilter("");
    setSelectedParents([]);
    setParentsFilter("");
    setOrchestrate(false);
    setError(null);
    setAdvancedOpen(false);
  }

  function handleClose() {
    resetForm();
    onClose();
  }

  return (
    <ModalOverlay
      onClose={handleClose}
      className="w-full max-w-lg max-h-[90vh]"
      aria-labelledby="create-task-title"
    >
        {/* Fixed header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h3
            id="create-task-title"
            className="text-lg font-medium text-text-primary"
          >
            {t.kanbanCreateTask}
          </h3>
          <button
            type="button"
            onClick={handleClose}
            className="text-text-secondary hover:text-text-primary transition-colors"
            aria-label="Close"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable form body */}
        <form id="create-task-form" onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {/* Title */}
          <div>
            <label className="text-xs text-text-secondary block mb-1">
              {t.kanbanTitle} <span className="text-accent-pink">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              autoFocus
              placeholder={t.kanbanTitlePlaceholder}
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-accent-cyan"
            />
          </div>

          {/* Description */}
          <div>
            <label className="text-xs text-text-secondary block mb-1">
              {t.kanbanDescription}
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              placeholder={t.kanbanDescPlaceholder}
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-text-primary resize-y placeholder:text-text-secondary focus:outline-none focus:border-accent-cyan"
            />
          </div>

          {/* Priority + Labels in 2-col grid */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-text-secondary block mb-1">
                {t.kanbanPriority}
              </label>
              <select
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent-cyan"
              >
                <option value={1}>{t.kanbanPriorityLow}</option>
                <option value={2}>{t.kanbanPriorityNormal}</option>
                <option value={3}>{t.kanbanPriorityHigh}</option>
                <option value={4}>{t.kanbanPriorityCritical}</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-text-secondary block mb-1">
                {t.kanbanLabels}
              </label>
              <input
                type="text"
                value={labelsInput}
                onChange={(e) => setLabelsInput(e.target.value)}
                placeholder={t.kanbanLabelsPlaceholder}
                className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-accent-cyan"
              />
            </div>
          </div>
          <p className="text-[10px] text-text-secondary -mt-2">{t.kanbanLabelsHint}</p>

          {/* Divider */}
          <div className="border-t border-border" />

          {/* Collapsible advanced section */}
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="w-full flex items-center justify-between py-2 group"
          >
            <div className="flex items-center gap-2">
              <span className="text-sm text-text-primary font-medium">
                {t.kanbanAdvanced || "Advanced"}
              </span>
              {advancedConfigCount > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/30">
                  {(t.kanbanAdvancedCount || "{n}").replace("{n}", String(advancedConfigCount))}
                </span>
              )}
            </div>
            <svg
              className={`h-4 w-4 text-text-secondary transition-transform ${advancedOpen ? "rotate-180" : ""}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {/* Configured items summary when collapsed */}
          {!advancedOpen && advancedConfigCount > 0 && (
            <div className="flex flex-wrap gap-1 -mt-2 pb-1">
              {assignee !== "default" && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/20">
                  {t.kanbanAssignee}: {assignee}
                </span>
              )}
              {selectedSkills.length > 0 && selectedSkills.map((s) => (
                <span key={s} className="text-[10px] px-1.5 py-0.5 rounded bg-accent-pink/10 text-accent-pink border border-accent-pink/20">
                  {s}
                </span>
              ))}
              {selectedParents.length > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/20">
                  {(t.kanbanParentBadge || "upstream").replace("{n}", String(selectedParents.length))}
                </span>
              )}
              {orchestrate && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-pink/10 text-accent-pink border border-accent-pink/20">
                  {t.kanbanOrchestrate || "Auto Decompose"}
                </span>
              )}
            </div>
          )}

          {/* Expanded advanced fields */}
          {advancedOpen && (
            <div className="space-y-4">
              {/* Assignee */}
              <div>
                <label className="text-xs text-text-secondary block mb-1">
                  {t.kanbanAssignee || "Assignee"}
                </label>
                {assignees.length > 0 ? (
                  <>
                    <input
                      type="text"
                      value={assigneeFilter}
                      onChange={(e) => setAssigneeFilter(e.target.value)}
                      placeholder={t.kanbanAssigneeSelect || "Select assignee..."}
                      className="w-full bg-background border border-border rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-accent-cyan mb-1.5"
                    />
                    <div className="flex flex-wrap gap-1 max-h-28 overflow-y-auto">
                      <button
                        type="button"
                        onClick={() => setAssignee("default")}
                        className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
                          assignee === "default"
                            ? "bg-accent-cyan/15 border-accent-cyan/40 text-accent-cyan"
                            : "border-border text-text-secondary hover:border-accent-cyan/30"
                        }`}
                      >
                        default
                      </button>
                      {assignees
                        .filter((a) => {
                          const profile = profileMap.get(a.name);
                          const displayName = profile?.display_name;
                          const q = assigneeFilter.trim().toLowerCase();
                          if (!q) return true;
                          if (a.name.toLowerCase().includes(q)) return true;
                          if (displayName && displayName.toLowerCase().includes(q)) return true;
                          return false;
                        })
                        .map((a) => {
                          const profile = profileMap.get(a.name);
                          const displayName = profile?.display_name;
                          const syncDot =
                            profile?.sync_status === "synced"
                              ? "bg-success"
                              : profile?.sync_status === "error"
                                ? "bg-accent-pink"
                                : "bg-text-secondary/50";
                          return (
                            <button
                              key={a.name}
                              type="button"
                              onClick={() => setAssignee(a.name)}
                              title={`${t.kanbanAssigneeLoad || "Load"}: ${Object.values(a.counts).reduce((s, c) => s + c, 0)}`}
                              className={`px-2 py-0.5 text-[10px] rounded border transition-colors inline-flex items-center gap-1 ${
                                assignee === a.name
                                  ? "bg-accent-cyan/15 border-accent-cyan/40 text-accent-cyan"
                                  : !a.on_disk
                                  ? "border-border/50 text-text-secondary/50"
                                  : "border-border text-text-secondary hover:border-accent-cyan/30"
                              }`}
                            >
                              {profile && <span className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${syncDot}`} />}
                              {displayName || a.name}
                              {!a.on_disk && " (?)"}
                            </button>
                          );
                        })}
                    </div>
                  </>
                ) : (
                  <input
                    type="text"
                    value={assignee}
                    onChange={(e) => setAssignee(e.target.value)}
                    placeholder="default"
                    className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-accent-cyan"
                  />
                )}
                <p className="text-[10px] text-text-secondary mt-1">
                  {t.kanbanAssigneeHint || "Profile to execute this task"}
                </p>
              </div>

              {/* Skills */}
              <div>
                <label className="text-xs text-text-secondary block mb-1.5">
                  {t.kanbanSkills}
                </label>
                {selectedSkills.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {selectedSkills.map((name) => (
                      <span
                        key={name}
                        className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-md bg-accent-pink/15 border border-accent-pink/30 text-accent-pink"
                      >
                        {name}
                        <button
                          type="button"
                          onClick={() => toggleSkill(name)}
                          className="hover:text-white"
                          aria-label={`Remove ${name}`}
                        >
                          &times;
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {suggestedSkills.size > 0 && (
                  <div className="flex items-center gap-2 mb-2 px-2 py-1.5 rounded-md bg-accent-cyan/5 border border-accent-cyan/20">
                    <span className="text-[10px] text-accent-cyan">
                      {t.kanbanSkillsSuggested.replace("{n}", String(suggestedSkills.size))}
                    </span>
                    {[...suggestedSkills].slice(0, 5).map((name) => (
                      <span key={name} className="text-[10px] px-1 py-0.5 rounded bg-accent-cyan/10 text-accent-cyan">
                        {name}
                      </span>
                    ))}
                    {suggestedSkills.size > 5 && (
                      <span className="text-[10px] text-accent-cyan">+{suggestedSkills.size - 5}</span>
                    )}
                    <button
                      type="button"
                      onClick={applySuggestions}
                      className="text-[10px] px-2 py-0.5 rounded bg-accent-cyan/20 text-accent-cyan hover:bg-accent-cyan/30 ml-auto"
                    >
                      {t.kanbanSkillsApply}
                    </button>
                  </div>
                )}
                {skillsLoading ? (
                  <p className="text-xs text-text-secondary">{t.loading}</p>
                ) : availableSkills.length > 0 ? (
                  <>
                    <input
                      type="text"
                      value={skillsFilter}
                      onChange={(e) => setSkillsFilter(e.target.value)}
                      placeholder={t.kanbanSkillsPlaceholder}
                      className="w-full bg-background border border-border rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-accent-cyan mb-1.5"
                    />
                    <div className="flex flex-wrap gap-1 max-h-28 overflow-y-auto">
                      {availableSkills
                        .filter((s) => s.name !== "kanban-worker")
                        .filter((s) =>
                          !skillsFilter.trim() ||
                          s.name.toLowerCase().includes(skillsFilter.toLowerCase()) ||
                          s.description.toLowerCase().includes(skillsFilter.toLowerCase())
                        )
                        .map((skill) => {
                          const isSelected = selectedSkills.includes(skill.name);
                          return (
                            <button
                              key={skill.name}
                              type="button"
                              onClick={() => toggleSkill(skill.name)}
                              title={skill.description}
                              className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
                                isSelected
                                  ? "bg-accent-pink/15 border-accent-pink/40 text-accent-pink"
                                  : "border-border text-text-secondary hover:border-accent-pink/30 hover:text-text-primary"
                              }`}
                            >
                              {skill.name}
                            </button>
                          );
                        })}
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-text-secondary">{t.noInstalledSkills}</p>
                )}
                <p className="text-[10px] text-text-secondary mt-1.5">
                  {t.kanbanSkillsHint}
                </p>
              </div>

              {/* Parents */}
              <div>
                <label className="text-xs text-text-secondary block mb-1.5">
                  {t.kanbanParents || "Upstream Tasks"}
                </label>
                {selectedParents.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {selectedParents.map((id) => {
                      const task = boardTasks.find((bt) => bt.id === id);
                      return (
                        <span
                          key={id}
                          className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-md bg-accent-cyan/15 border border-accent-cyan/30 text-accent-cyan"
                        >
                          {task?.title ?? id}
                          <button
                            type="button"
                            onClick={() => setSelectedParents((p) => p.filter((x) => x !== id))}
                            className="hover:text-white"
                            aria-label={`Remove parent ${id}`}
                          >
                            &times;
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}
                {boardTasks.length > 0 && (
                  <>
                    <input
                      type="text"
                      value={parentsFilter}
                      onChange={(e) => setParentsFilter(e.target.value)}
                      placeholder={t.kanbanParentsPlaceholder || "Search tasks..."}
                      className="w-full bg-background border border-border rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-accent-cyan mb-1.5"
                    />
                    <div className="flex flex-wrap gap-1 max-h-28 overflow-y-auto">
                      {boardTasks
                        .filter((bt) => bt.status !== "done" && bt.status !== "archived")
                        .filter((bt) =>
                          !parentsFilter.trim() ||
                          bt.title.toLowerCase().includes(parentsFilter.toLowerCase()) ||
                          bt.id.toLowerCase().includes(parentsFilter.toLowerCase())
                        )
                        .slice(0, 20)
                        .map((task) => {
                          const isSelected = selectedParents.includes(task.id);
                          return (
                            <button
                              key={task.id}
                              type="button"
                              onClick={() =>
                                setSelectedParents((prev) =>
                                  isSelected ? prev.filter((x) => x !== task.id) : [...prev, task.id]
                                )
                              }
                              className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
                                isSelected
                                  ? "bg-accent-cyan/15 border-accent-cyan/40 text-accent-cyan"
                                  : "border-border text-text-secondary hover:border-accent-cyan/30"
                              }`}
                            >
                              {task.title}
                            </button>
                          );
                        })}
                    </div>
                  </>
                )}
                <p className="text-[10px] text-text-secondary mt-1.5">
                  {t.kanbanParentsHint || "This task starts after all upstream tasks complete"}
                </p>
              </div>

              {/* Auto Orchestrate */}
              <div className="flex items-start gap-2">
                <input
                  type="checkbox"
                  id="orchestrate-toggle"
                  checked={orchestrate}
                  onChange={(e) => setOrchestrate(e.target.checked)}
                  className="mt-0.5 accent-accent-pink"
                />
                <div>
                  <label htmlFor="orchestrate-toggle" className="text-xs text-text-primary cursor-pointer">
                    {t.kanbanOrchestrate || "Auto Decompose"}
                  </label>
                  <p className="text-[10px] text-text-secondary mt-0.5">
                    {t.kanbanOrchestrateHint || "System will auto-generate sub-tasks and assign to different profiles"}
                  </p>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="p-2 rounded bg-accent-pink/10 text-accent-pink text-xs">
              {error}
            </div>
          )}
        </form>

        {/* Fixed footer */}
        <div className="flex gap-2 justify-end px-6 py-4 border-t border-border shrink-0">
          <button
            type="button"
            onClick={handleClose}
            className="px-4 py-2 text-sm rounded-md text-text-secondary hover:text-text-primary border border-border-subtle transition-colors"
          >
            {t.kanbanCancel}
          </button>
          <button
            type="button"
            disabled={submitting || !title.trim()}
            onClick={() => {
              const form = document.getElementById("create-task-form") as HTMLFormElement | null;
              if (form) form.requestSubmit();
            }}
            className="px-4 py-2 text-sm rounded-md bg-accent-pink text-white hover:bg-accent-pink/90 disabled:opacity-50"
          >
            {submitting ? t.kanbanCreating : t.kanbanCreateTask}
          </button>
        </div>
      </ModalOverlay>
  );
}
