import { useState, useEffect, useCallback } from "react";
import type { MyDispatchTask } from "../lib/admin-api";
import { adminApi } from "../lib/admin-api";
import { useI18n } from "../hooks/useI18n";
import { showToast } from "../lib/toast";
import { getApiError } from "../lib/utils";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { StatusBadge } from "../components/StatusBadge";

export function MyTasksPage() {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<MyDispatchTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const [expandedTask, setExpandedTask] = useState<number | null>(null);

  const loadTasks = useCallback(async () => {
    try {
      const data = await adminApi.listMyTasks();
      setTasks(data.tasks || []);
    } catch (e) {
      showToast(getApiError(e, "Failed to load tasks"), "error");
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    loadTasks().finally(() => setLoading(false));
  }, [loadTasks]);

  // Auto-refresh every 15s
  useEffect(() => {
    const timer = setInterval(loadTasks, 15000);
    return () => clearInterval(timer);
  }, [loadTasks]);

  async function handleConfirm(assignmentId: number) {
    setActionLoading(assignmentId);
    try {
      await adminApi.confirmMyTask(assignmentId);
      showToast(t.dispatchConfirmSuccess || "已确认", "success");
      loadTasks();
    } catch (e) {
      showToast(getApiError(e, "Failed"), "error");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleReject(assignmentId: number) {
    setActionLoading(assignmentId);
    try {
      await adminApi.rejectMyTask(assignmentId);
      showToast(t.dispatchRejectSuccess || "已拒绝", "success");
      loadTasks();
    } catch (e) {
      showToast(getApiError(e, "Failed"), "error");
    } finally {
      setActionLoading(null);
    }
  }

  const pendingCount = tasks.filter((t) => t.status === "pending" || t.status === "notified").length;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-text-primary">{t.myTasks || "我的任务"}</h1>
          {pendingCount > 0 && (
            <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-yellow-500/20 text-yellow-400 animate-pulse">
              {pendingCount}
            </span>
          )}
        </div>
        <button
          onClick={() => loadTasks()}
          className="px-3 py-1.5 text-xs rounded-md bg-surface border border-border-subtle text-text-secondary hover:text-text-primary hover:border-accent-cyan/30 transition-colors"
        >
          {t.refresh || "刷新"}
        </button>
      </div>

      {tasks.length === 0 ? (
        <div className="text-center py-20 text-text-secondary">
          <svg className="w-12 h-12 mx-auto mb-4 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z" />
          </svg>
          <p>{t.noTasksYet || "暂无任务"}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tasks.map((task) => {
            const isPending = task.status === "pending" || task.status === "notified";
            const isExpanded = expandedTask === task.assignment_id;

            return (
              <div
                key={task.assignment_id}
                className={`bg-surface/80 border rounded-lg overflow-hidden transition-all duration-200 ${
                  isPending
                    ? "border-yellow-500/40 shadow-[0_0_20px_rgba(234,179,8,0.08)]"
                    : "border-border-subtle"
                }`}
              >
                <div className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-sm font-medium text-text-primary truncate">{task.title}</h3>
                        <StatusBadge status={task.status} />
                      </div>
                      <p className="text-xs text-text-secondary line-clamp-2">{task.prompt}</p>
                      <div className="flex items-center gap-3 mt-2 text-xs text-text-secondary">
                        <span>#{task.task_id}</span>
                        {task.created_at && <span>{new Date(task.created_at).toLocaleString()}</span>}
                        {task.result_summary && (
                          <span className="text-emerald-400 truncate max-w-[200px]">{task.result_summary}</span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {isPending && (
                        <>
                          <button
                            onClick={() => handleConfirm(task.assignment_id)}
                            disabled={actionLoading === task.assignment_id}
                            className="px-3 py-1.5 text-xs font-medium rounded-md bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/30 transition-colors disabled:opacity-50"
                          >
                            {actionLoading === task.assignment_id ? "..." : (t.confirm || "确认")}
                          </button>
                          <button
                            onClick={() => handleReject(task.assignment_id)}
                            disabled={actionLoading === task.assignment_id}
                            className="px-3 py-1.5 text-xs font-medium rounded-md bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors disabled:opacity-50"
                          >
                            {"拒绝"}
                          </button>
                        </>
                      )}
                      <button
                        onClick={() => setExpandedTask(isExpanded ? null : task.assignment_id)}
                        className="px-2 py-1.5 text-xs rounded-md bg-surface border border-border-subtle text-text-secondary hover:text-text-primary transition-colors"
                      >
                        {isExpanded ? "▲" : "▼"}
                      </button>
                    </div>
                  </div>

                  {isExpanded && task.instructions && (
                    <div className="mt-3 pt-3 border-t border-border-subtle">
                      <p className="text-xs text-text-secondary mb-1">{t.dispatchTaskInstructions || "详细说明"}</p>
                      <p className="text-xs text-text-primary whitespace-pre-wrap bg-surface/50 rounded-md p-3 border border-border-subtle max-h-48 overflow-auto">
                        {task.instructions}
                      </p>
                    </div>
                  )}

                  {isExpanded && task.completed_at && (
                    <div className="mt-3 pt-3 border-t border-border-subtle text-xs text-text-secondary">
                      {t.dispatchCompletedAt || "完成时间"}: {new Date(task.completed_at).toLocaleString()}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
