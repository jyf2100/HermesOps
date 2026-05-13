import { useState, useEffect, useRef } from "react";
import { useI18n } from "../../hooks/useI18n";
import type { KanbanTask, KanbanTaskDetail, KanbanComment, KanbanStatus } from "./kanban-types";
import { adminFetch, AdminApiError } from "../../lib/admin-api";
import { showToast } from "../../lib/toast";
import { useKanbanBoard } from "../../stores/kanbanBoard";

interface TaskDrawerProps {
  task: KanbanTask | null;
  agentId: number;
  onClose: () => void;
  onUpdate: () => void;
}

const STATUS_KEYS: { value: KanbanStatus; labelKey: keyof import("../../i18n/zh").Translations }[] = [
  { value: "triage", labelKey: "kanbanTriage" },
  { value: "todo", labelKey: "kanbanTodo" },
  { value: "ready", labelKey: "kanbanReady" },
  { value: "running", labelKey: "kanbanRunning" },
  { value: "done", labelKey: "kanbanDone" },
  { value: "blocked", labelKey: "kanbanBlocked" },
  { value: "archived", labelKey: "kanbanArchived" },
];

function formatTimestamp(ts: number | null | undefined): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleString();
}

export function TaskDrawer({ task, agentId, onClose, onUpdate }: TaskDrawerProps) {
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<KanbanStatus>("triage");
  const [priority, setPriority] = useState(2);
  const [assignee, setAssignee] = useState("");
  const [comments, setComments] = useState<KanbanComment[]>([]);
  const [commentInput, setCommentInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [taskDetailData, setTaskDetailData] = useState<KanbanTaskDetail | null>(null);

  const deleteBtnRef = useRef<HTMLButtonElement>(null);
  const cancelConfirmRef = useRef<HTMLButtonElement>(null);

  const assignees = useKanbanBoard((s) => s.assignees);
  const fetchAssignees = useKanbanBoard((s) => s.fetchAssignees);
  const boardTasks = useKanbanBoard((s) => s.tasks);

  useEffect(() => {
    if (!task) return;
    setTitle(task.title);
    setBody(task.body ?? "");
    setStatus(task.status);
    setPriority(task.priority ?? 2);
    setAssignee(task.assignee ?? "default");
    setTaskDetailData(null);

    let cancelled = false;
    setCommentsLoading(true);
    fetchAssignees(agentId);
    adminFetch<{ task: KanbanTaskDetail }>(
      `/agents/${agentId}/kanban/tasks/${task.id}`
    )
      .then((data) => {
        if (!cancelled) {
          const detail = data.task;
          setComments(Array.isArray(detail.comments) ? detail.comments : []);
          setTaskDetailData(detail);
        }
      })
      .catch(() => { if (!cancelled) setComments([]); })
      .finally(() => { if (!cancelled) setCommentsLoading(false); });
    return () => { cancelled = true; };
  }, [task, agentId]);

  const isOpen = task !== null;

  async function handleSave() {
    if (!task) return;
    setSaving(true);
    try {
      await adminFetch<KanbanTask>(
        `/agents/${agentId}/kanban/tasks/${task.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ title, body, status, priority, assignee: assignee.trim() || undefined }),
        }
      );
      showToast(t.kanbanTaskUpdated);
      onUpdate();
    } catch (e: unknown) {
      showToast(
        e instanceof Error ? e.message : t.kanbanUpdateFailed,
        "error"
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleAddComment() {
    if (!task || !commentInput.trim()) return;
    setSaving(true);
    try {
      await adminFetch<KanbanComment>(
        `/agents/${agentId}/kanban/tasks/${task.id}/comments`,
        {
          method: "POST",
          body: JSON.stringify({ body: commentInput.trim() }),
        }
      );
      setCommentInput("");
      const data = await adminFetch<{ task: KanbanTaskDetail }>(
        `/agents/${agentId}/kanban/tasks/${task.id}`
      );
      setComments(Array.isArray(data.task.comments) ? data.task.comments : []);
    } catch (e: unknown) {
      showToast(
        e instanceof Error ? e.message : t.kanbanCommentFailed,
        "error"
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleUnblock() {
    if (!task) return;
    setSaving(true);
    try {
      await adminFetch<KanbanTask>(
        `/agents/${agentId}/kanban/tasks/${task.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ status: "ready" }),
        }
      );
      showToast(t.kanbanTaskUnblocked);
      onUpdate();
      onClose();
    } catch (e: unknown) {
      showToast(
        e instanceof Error ? e.message : t.kanbanUnblockFailed,
        "error"
      );
    } finally {
      setSaving(false);
    }
  }

  function handleQuickStatus(newStatus: KanbanStatus) {
    setStatus(newStatus);
  }

  function handleDeleteClick() {
    setConfirmingDelete(true);
    requestAnimationFrame(() => cancelConfirmRef.current?.focus());
  }

  function handleCancelConfirm() {
    setConfirmingDelete(false);
    requestAnimationFrame(() => deleteBtnRef.current?.focus());
  }

  function getDeleteErrorMessage(error: unknown): string {
    if (error instanceof AdminApiError) {
      switch (error.status) {
        case 404: return t.kanbanDeleteNotFound;
        case 409: return t.kanbanDeleteConflict;
        case 502: case 504: return t.kanbanDeleteGatewayError;
        default: return error.message || t.kanbanDeleteFailed;
      }
    }
    return t.kanbanDeleteFailed;
  }

  async function handleConfirmDelete() {
    if (!task) return;
    setDeleting(true);
    try {
      await adminFetch<void>(
        `/agents/${agentId}/kanban/tasks/${task.id}`,
        { method: "DELETE" }
      );
      showToast(t.kanbanTaskDeleted);
      onUpdate();
      onClose();
    } catch (e: unknown) {
      showToast(getDeleteErrorMessage(e), "error");
      setConfirmingDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  const latestSummary = taskDetailData?.latest_summary ?? null;
  const taskResult = taskDetailData?.result ?? null;
  const lastFailureError = taskDetailData?.last_failure_error ?? null;
  const detailLinks = taskDetailData?.links;

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <div
        role="dialog"
        aria-modal="true"
        aria-label={task ? `${t.kanbanTaskDetail}: ${task.title}` : t.kanbanTaskDetail}
        className={`fixed top-0 right-0 z-50 h-full w-full max-w-md bg-surface border-l border-border shadow-xl transition-transform duration-300 ease-out ${
          isOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex flex-col h-full">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h2 className="text-sm font-medium text-text-primary truncate">
              {t.kanbanTaskDetail}
            </h2>
            <button
              onClick={onClose}
              className="text-text-secondary hover:text-text-primary transition-colors"
              aria-label="Close drawer"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {task ? (
            <div className="flex-1 overflow-y-auto p-4 space-y-5">
              <div>
                <label className="text-xs text-text-secondary block mb-1">{t.kanbanTitle}</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent-cyan"
                />
              </div>

              <div>
                <label className="text-xs text-text-secondary block mb-1">{t.kanbanDescription}</label>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={4}
                  className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-text-primary resize-y focus:outline-none focus:border-accent-cyan"
                />
              </div>

              <div>
                <label className="text-xs text-text-secondary block mb-1.5">{t.kanbanStatus}</label>
                <div className="flex flex-wrap gap-1.5">
                  {STATUS_KEYS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => handleQuickStatus(opt.value)}
                      className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                        status === opt.value
                          ? "bg-accent-pink/15 border-accent-pink/40 text-accent-pink"
                          : "border-border text-text-secondary hover:border-accent-cyan/40 hover:text-text-primary"
                      }`}
                    >
                      {t[opt.labelKey]}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs text-text-secondary block mb-1">{t.kanbanPriority}</label>
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
                <label className="text-xs text-text-secondary block mb-1">{t.kanbanAssignee}</label>
                <select
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                  className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent-cyan"
                >
                  <option value="default">default</option>
                  {assignees.map((a) => (
                    <option key={a.name} value={a.name} disabled={!a.on_disk}>
                      {a.name} {!a.on_disk ? "(not on disk)" : ""}
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-text-secondary mt-1">
                  {t.kanbanAssigneeHint}
                </p>
              </div>

              {task.skills && task.skills.length > 0 && (
                <div>
                  <label className="text-xs text-text-secondary block mb-1">{t.kanbanSkills}</label>
                  <div className="flex flex-wrap gap-1.5">
                    {task.skills.map((skill) => (
                      <span
                        key={skill}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-accent-pink/10 text-accent-pink border border-accent-pink/20"
                      >
                        {skill}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Dependencies */}
              {(() => {
                const parentItems = detailLinks?.parents?.length
                  ? detailLinks.parents
                  : (task.parents ?? []).map((id) => {
                      const bt = boardTasks.find((b) => b.id === id);
                      return { id, title: bt?.title ?? id, status: (bt?.status ?? "done") as KanbanStatus };
                    });
                const childItems = detailLinks?.children?.length
                  ? detailLinks.children
                  : (task.children ?? []).map((id) => {
                      const bt = boardTasks.find((b) => b.id === id);
                      return { id, title: bt?.title ?? id, status: (bt?.status ?? "done") as KanbanStatus };
                    });
                if (!parentItems.length && !childItems.length) return null;
                return (
                  <div>
                    <label className="text-xs text-text-secondary block mb-1.5">{t.kanbanDependencies}</label>
                    {parentItems.length > 0 && (
                      <div className="mb-2">
                        <span className="text-[10px] text-text-secondary">{t.kanbanUpstream}:</span>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {parentItems.map((p) => (
                            <span key={p.id} className={`text-[10px] px-1.5 py-0.5 rounded border ${p.status === "done" ? "bg-success/10 text-success border-success/20" : "bg-accent-cyan/10 text-accent-cyan border-accent-cyan/20"}`}>
                              {p.title}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {childItems.length > 0 && (
                      <div>
                        <span className="text-[10px] text-text-secondary">{t.kanbanDownstream}:</span>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {childItems.map((c) => (
                            <span key={c.id} className={`text-[10px] px-1.5 py-0.5 rounded border ${c.status === "done" ? "bg-success/10 text-success border-success/20" : "bg-accent-pink/10 text-accent-pink border-accent-pink/20"}`}>
                              {c.title}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              <div className="text-xs text-text-secondary space-y-1 border-t border-border pt-3">
                <p>{t.kanbanId}: {task.id}</p>
                <p>{t.kanbanCreated}: {formatTimestamp(task.created_at)}</p>
                {task.assignee && <p>{t.kanbanAssignee}: {task.assignee}</p>}
                {task.completed_at && <p>{t.kanbanCompleted}: {formatTimestamp(task.completed_at)}</p>}
                {task.block_reason && (
                  <p className="text-accent-pink">{t.kanbanBlockedReason}: {task.block_reason}</p>
                )}
              </div>

              {(latestSummary || taskResult || lastFailureError) && (
                <div className="border-t border-border pt-3">
                  <h3 className="text-xs font-medium text-text-secondary mb-2">{t.kanbanResult}</h3>
                  {latestSummary && (
                    <p className="text-xs text-text-primary bg-surface-secondary rounded-md p-2 mb-2">
                      {latestSummary}
                    </p>
                  )}
                  {taskResult && (
                    <p className="text-xs text-text-primary bg-surface-secondary rounded-md p-2 mb-2">
                      {taskResult}
                    </p>
                  )}
                  {lastFailureError && (
                    <p className="text-xs text-accent-pink bg-accent-pink/10 rounded-md p-2">
                      {lastFailureError}
                    </p>
                  )}
                </div>
              )}

              <div className="border-t border-border pt-3">
                <h3 className="text-xs font-medium text-text-secondary mb-2">
                  {t.kanbanComments} ({comments.length})
                </h3>
                {commentsLoading ? (
                  <p className="text-xs text-text-secondary">{t.loading}</p>
                ) : comments.length === 0 ? (
                  <p className="text-xs text-text-secondary">{t.kanbanNoComments}</p>
                ) : (
                  <div className="space-y-2 mb-3">
                    {comments.map((c) => (
                      <div key={c.id} className="bg-surface-secondary rounded-md p-2.5">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-medium text-accent-cyan">{c.author}</span>
                          <span className="text-[10px] text-text-secondary">{formatTimestamp(c.created_at)}</span>
                        </div>
                        <p className="text-xs text-text-primary leading-relaxed">{c.body}</p>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex gap-2">
                  <input
                    type="text"
                    value={commentInput}
                    onChange={(e) => setCommentInput(e.target.value)}
                    placeholder={t.kanbanAddComment}
                    className="flex-1 bg-background border border-border rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-accent-cyan"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleAddComment();
                      }
                    }}
                  />
                  <button
                    onClick={handleAddComment}
                    disabled={saving || !commentInput.trim()}
                    className="px-3 py-1.5 text-xs rounded-md bg-accent-pink text-white hover:bg-accent-pink/90 disabled:opacity-50"
                  >
                    {t.kanbanCommentSend}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1" />
          )}

          <div className="border-t border-border px-4 py-3">
            {confirmingDelete ? (
              <div
                role="alert"
                aria-live="assertive"
                className="bg-accent-pink/5 border border-accent-pink/20 rounded-md px-3 py-2.5 flex items-center justify-between gap-3"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    handleCancelConfirm();
                  }
                }}
              >
                <span className="text-xs text-accent-pink truncate">
                  {t.kanbanDeleteConfirm.replace("{title}", title).replace("{id}", task?.id ?? "")}
                </span>
                <div className="flex gap-2 shrink-0">
                  <button
                    ref={cancelConfirmRef}
                    onClick={handleCancelConfirm}
                    className="px-3 py-1.5 text-xs rounded-md text-text-secondary hover:text-text-primary border border-border-subtle transition-colors focus-visible:outline-2 focus-visible:outline-accent-cyan focus-visible:outline-offset-[-2px]"
                  >
                    {t.cancel}
                  </button>
                  <button
                    onClick={handleConfirmDelete}
                    disabled={deleting}
                    className="px-3 py-1.5 text-xs rounded-md bg-accent-pink text-white hover:bg-accent-pink/90 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent-cyan focus-visible:outline-offset-[-2px]"
                  >
                    {deleting ? t.kanbanDeleting : t.kanbanDeleteConfirmBtn}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex justify-between items-center">
                <div>
                  <button
                    ref={deleteBtnRef}
                    onClick={handleDeleteClick}
                    disabled={task?.status === "running" || deleting}
                    title={task?.status === "running" ? t.kanbanDeleteDisabledRunning : undefined}
                    className="px-3 py-1.5 text-xs rounded-md border border-accent-pink/40 text-accent-pink hover:bg-accent-pink/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-2 focus-visible:outline-accent-cyan focus-visible:outline-offset-[-2px]"
                  >
                    {t.kanbanDelete}
                  </button>
                </div>
                <div className="flex gap-2">
                  {status === "blocked" && (
                    <button
                      onClick={handleUnblock}
                      disabled={saving}
                      className="px-4 py-2 text-sm rounded-md bg-accent-cyan text-white hover:bg-accent-cyan/90 disabled:opacity-50"
                    >
                      {saving ? t.kanbanUnblocking : t.kanbanUnblockRetry}
                    </button>
                  )}
                  <button
                    onClick={onClose}
                    className="px-4 py-2 text-sm rounded-md text-text-secondary hover:text-text-primary border border-border-subtle transition-colors"
                  >
                    {t.kanbanCancel}
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="px-4 py-2 text-sm rounded-md bg-accent-pink text-white hover:bg-accent-pink/90 disabled:opacity-50"
                  >
                    {saving ? t.kanbanSaving : t.kanbanSave}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
