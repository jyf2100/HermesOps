import { useState, useEffect, useCallback } from "react";
import type {
  DispatchChannel,
  DispatchTaskItem,
  DispatchTaskDetail,
  DispatchAssignment,
  AgentListItem,
} from "../lib/admin-api";
import { adminApi } from "../lib/admin-api";
import { useI18n } from "../hooks/useI18n";
import { showToast } from "../lib/toast";
import { getApiError } from "../lib/utils";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { StatusBadge } from "../components/StatusBadge";

type Tab = "tasks" | "channels";

const STATUS_COLORS: Record<string, string> = {
  dispatching: "bg-yellow-500/20 text-yellow-400",
  dispatched: "bg-blue-500/20 text-blue-400",
  partial: "bg-orange-500/20 text-orange-400",
  pending: "bg-gray-500/20 text-gray-400",
  confirmed: "bg-green-500/20 text-green-400",
  executing: "bg-cyan-500/20 text-cyan-400",
  completed: "bg-emerald-500/20 text-emerald-400",
  failed: "bg-red-500/20 text-red-400",
  rejected: "bg-pink-500/20 text-pink-400",
  expired: "bg-amber-500/20 text-amber-400",
  cancelled: "bg-zinc-500/20 text-zinc-400",
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TaskDispatchPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("tasks");
  const [loading, setLoading] = useState(true);

  // Tasks state
  const [tasks, setTasks] = useState<DispatchTaskItem[]>([]);
  const [tasksTotal, setTasksTotal] = useState(0);
  const [taskOffset, setTaskOffset] = useState(0);
  const [statusFilter, setStatusFilter] = useState("");
  const [selectedTask, setSelectedTask] = useState<DispatchTaskDetail | null>(null);
  const [taskDetailOpen, setTaskDetailOpen] = useState(false);

  // Channels state
  const [channels, setChannels] = useState<DispatchChannel[]>([]);

  // Agents list (for creating tasks)
  const [agents, setAgents] = useState<AgentListItem[]>([]);

  // Create task modal
  const [showCreateTask, setShowCreateTask] = useState(false);

  // Create channel modal
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [editChannel, setEditChannel] = useState<DispatchChannel | null>(null);

  // Cancel confirm
  const [cancelTaskId, setCancelTaskId] = useState<number | null>(null);
  const [deleteChannelId, setDeleteChannelId] = useState<number | null>(null);

  // Subscriber modal
  const [subscriberChannelId, setSubscriberChannelId] = useState<number | null>(null);
  const [subscriberAgents, setSubscriberAgents] = useState<number[]>([]);

  const PAGE_SIZE = 20;

  const loadTasks = useCallback(async () => {
    try {
      const params: Record<string, unknown> = { limit: PAGE_SIZE, offset: taskOffset };
      if (statusFilter) params.status = statusFilter;
      const data = await adminApi.listDispatchTasks(params);
      setTasks(data.tasks);
      setTasksTotal(data.total);
    } catch (e) {
      showToast(getApiError(e, "Request failed"), "error");
    }
  }, [taskOffset, statusFilter]);

  const loadChannels = useCallback(async () => {
    try {
      const data = await adminApi.listDispatchChannels();
      setChannels(data);
    } catch (e) {
      showToast(getApiError(e, "Request failed"), "error");
    }
  }, []);

  const loadAgents = useCallback(async () => {
    try {
      const data = await adminApi.listAgents();
      setAgents(data.agents);
    } catch {
      // non-critical
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadChannels(), loadAgents()]).finally(() => setLoading(false));
  }, [loadChannels, loadAgents]);

  useEffect(() => {
    loadTasks();
  }, [taskOffset, statusFilter, loadTasks]);

  async function handleCancelTask(taskId: number) {
    try {
      await adminApi.cancelDispatchTask(taskId);
      showToast(t.dispatchCancelSuccess, "success");
      setCancelTaskId(null);
      loadTasks();
    } catch (e) {
      showToast(getApiError(e, "Request failed"), "error");
    }
  }

  async function handleViewTask(taskId: number) {
    try {
      const detail = await adminApi.getDispatchTask(taskId);
      setSelectedTask(detail);
      setTaskDetailOpen(true);
    } catch (e) {
      showToast(getApiError(e, "Request failed"), "error");
    }
  }

  async function handleDeleteChannel(channelId: number) {
    try {
      await adminApi.deleteDispatchChannel(channelId);
      showToast("Deleted", "success");
      setDeleteChannelId(null);
      loadChannels();
    } catch (e) {
      showToast(getApiError(e, "Request failed"), "error");
    }
  }

  async function loadSubscribers(channelId: number) {
    try {
      const data = await adminApi.getChannelSubscribers(channelId);
      setSubscriberAgents(data.agent_numbers);
      setSubscriberChannelId(channelId);
    } catch (e) {
      showToast(getApiError(e, "Request failed"), "error");
    }
  }

  async function saveSubscribers() {
    if (!subscriberChannelId) return;
    try {
      await adminApi.setChannelSubscribers(subscriberChannelId, subscriberAgents);
      showToast("Updated", "success");
      setSubscriberChannelId(null);
      loadChannels();
    } catch (e) {
      showToast(getApiError(e, "Request failed"), "error");
    }
  }

  const totalPages = Math.ceil(tasksTotal / PAGE_SIZE);
  const currentPage = Math.floor(taskOffset / PAGE_SIZE) + 1;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text-primary">{t.dispatchTitle}</h1>
        <div className="flex items-center gap-3">
          {tab === "tasks" && (
            <button
              onClick={() => setShowCreateTask(true)}
              className="px-4 py-2 text-sm font-medium rounded-md bg-accent-cyan/20 text-accent-cyan hover:bg-accent-cyan/30 transition-colors"
            >
              {t.dispatchNewTask}
            </button>
          )}
          {tab === "channels" && (
            <button
              onClick={() => setShowCreateChannel(true)}
              className="px-4 py-2 text-sm font-medium rounded-md bg-accent-cyan/20 text-accent-cyan hover:bg-accent-cyan/30 transition-colors"
            >
              {t.dispatchCreateChannel}
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-surface/50 rounded-lg p-1 w-fit">
        <button
          onClick={() => setTab("tasks")}
          className={`px-4 py-2 text-sm rounded-md transition-colors ${tab === "tasks" ? "bg-accent-cyan/20 text-accent-cyan font-medium" : "text-text-secondary hover:text-text-primary"}`}
        >
          {t.dispatchTasks}
        </button>
        <button
          onClick={() => setTab("channels")}
          className={`px-4 py-2 text-sm rounded-md transition-colors ${tab === "channels" ? "bg-accent-cyan/20 text-accent-cyan font-medium" : "text-text-secondary hover:text-text-primary"}`}
        >
          {t.dispatchChannels}
        </button>
      </div>

      {/* Tasks Tab */}
      {tab === "tasks" && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="flex items-center gap-3">
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setTaskOffset(0); }}
              className="px-3 py-2 text-sm rounded-md bg-surface border border-border-subtle text-text-primary focus:outline-none focus:border-accent-cyan"
            >
              <option value="">{t.dispatchTaskStatus}: All</option>
              <option value="dispatching">{t.dispatchStatusDispatching}</option>
              <option value="dispatched">{t.dispatchStatusDispatched}</option>
              <option value="partial">{t.dispatchStatusPartial}</option>
              <option value="completed">{t.dispatchStatusCompleted}</option>
              <option value="failed">{t.dispatchStatusFailed}</option>
              <option value="cancelled">{t.dispatchStatusCancelled}</option>
            </select>
          </div>

          {/* Task list */}
          {tasks.length === 0 ? (
            <div className="text-center py-16 text-text-secondary">{t.dispatchNoTasks}</div>
          ) : (
            <div className="space-y-2">
              {tasks.map((task) => (
                <div
                  key={task.id}
                  className="bg-surface/80 border border-border-subtle rounded-lg p-4 hover:border-accent-cyan/30 transition-colors"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-sm font-medium text-text-primary truncate">{task.title}</h3>
                        <StatusBadge status={task.status} />
                        <span className="text-xs text-text-secondary">#{task.id}</span>
                      </div>
                      <div className="flex items-center gap-4 text-xs text-text-secondary">
                        <span>{task.dispatch_type === "channel" ? t.dispatchTaskTypeChannel : t.dispatchTaskTypeDirect}</span>
                        <span>{t.dispatchTaskCreatedBy}: {task.created_by}</span>
                        <span>{task.created_at ? new Date(task.created_at).toLocaleString() : ""}</span>
                        {task.result_summary && <span className="text-emerald-400">{task.result_summary}</span>}
                      </div>
                      {/* Assignment pills */}
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {task.assignments.map((a) => (
                          <span
                            key={a.id}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-surface/50 border border-border-subtle"
                          >
                            <span className="text-text-primary font-medium">
                              {t.dispatchAgent.replace("{number}", String(a.agent_number))}
                            </span>
                            <StatusBadge status={a.status} />
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => handleViewTask(task.id)}
                        className="px-3 py-1.5 text-xs rounded-md bg-surface border border-border-subtle text-text-secondary hover:text-text-primary hover:border-accent-cyan/30 transition-colors"
                      >
                        {t.dispatchViewDetail}
                      </button>
                      {["dispatching", "dispatched", "partial"].includes(task.status) && (
                        <button
                          onClick={() => setCancelTaskId(task.id)}
                          className="px-3 py-1.5 text-xs rounded-md bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-colors"
                        >
                          {t.dispatchCancel}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <button
                disabled={currentPage <= 1}
                onClick={() => setTaskOffset(Math.max(0, taskOffset - PAGE_SIZE))}
                className="px-3 py-1.5 text-sm rounded-md bg-surface border border-border-subtle text-text-secondary disabled:opacity-50 hover:text-text-primary transition-colors"
              >
                Prev
              </button>
              <span className="text-sm text-text-secondary">
                {currentPage} / {totalPages}
              </span>
              <button
                disabled={currentPage >= totalPages}
                onClick={() => setTaskOffset(taskOffset + PAGE_SIZE)}
                className="px-3 py-1.5 text-sm rounded-md bg-surface border border-border-subtle text-text-secondary disabled:opacity-50 hover:text-text-primary transition-colors"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}

      {/* Channels Tab */}
      {tab === "channels" && (
        <div className="space-y-3">
          {channels.length === 0 ? (
            <div className="text-center py-16 text-text-secondary">{t.dispatchNoChannels}</div>
          ) : (
            channels.map((ch) => (
              <div
                key={ch.id}
                className="bg-surface/80 border border-border-subtle rounded-lg p-4 hover:border-accent-cyan/30 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-sm font-medium text-text-primary">{ch.display_name || ch.name}</h3>
                    {ch.description && <p className="text-xs text-text-secondary mt-1">{ch.description}</p>}
                    <p className="text-xs text-text-secondary mt-1">
                      {t.dispatchSubscriberCount.replace("{count}", String(ch.subscriber_count))} &middot; {ch.name}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => loadSubscribers(ch.id)}
                      className="px-3 py-1.5 text-xs rounded-md bg-surface border border-border-subtle text-text-secondary hover:text-text-primary hover:border-accent-cyan/30 transition-colors"
                    >
                      {t.dispatchSubscribers}
                    </button>
                    <button
                      onClick={() => setEditChannel(ch)}
                      className="px-3 py-1.5 text-xs rounded-md bg-surface border border-border-subtle text-text-secondary hover:text-text-primary hover:border-accent-cyan/30 transition-colors"
                    >
                      {t.dispatchEditChannel}
                    </button>
                    <button
                      onClick={() => setDeleteChannelId(ch.id)}
                      className="px-3 py-1.5 text-xs rounded-md bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-colors"
                    >
                      {t.dispatchDeleteChannel}
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Create Task Modal */}
      {showCreateTask && (
        <CreateTaskModal
          channels={channels}
          agents={agents}
          onClose={() => setShowCreateTask(false)}
          onCreated={() => { setShowCreateTask(false); loadTasks(); }}
        />
      )}

      {/* Create/Edit Channel Modal */}
      {(showCreateChannel || editChannel) && (
        <ChannelModal
          channel={editChannel}
          agents={agents}
          onClose={() => { setShowCreateChannel(false); setEditChannel(null); }}
          onSaved={() => { setShowCreateChannel(false); setEditChannel(null); loadChannels(); }}
        />
      )}

      {/* Task Detail Modal */}
      {taskDetailOpen && selectedTask && (
        <TaskDetailModal
          task={selectedTask}
          onClose={() => { setTaskDetailOpen(false); setSelectedTask(null); }}
        />
      )}

      {/* Subscriber Modal */}
      {subscriberChannelId !== null && (
        <SubscriberModal
          agents={agents}
          selected={subscriberAgents}
          onSelected={setSubscriberAgents}
          onSave={saveSubscribers}
          onClose={() => setSubscriberChannelId(null)}
        />
      )}

      {/* Cancel Task Confirm */}
      <ConfirmDialog
        open={cancelTaskId !== null}
        title={t.dispatchCancel}
        message={t.dispatchCancelConfirm}
        onConfirm={() => cancelTaskId && handleCancelTask(cancelTaskId)}
        onCancel={() => setCancelTaskId(null)}
      />

      {/* Delete Channel Confirm */}
      <ConfirmDialog
        open={deleteChannelId !== null}
        title={t.dispatchDeleteChannel}
        message={t.dispatchDeleteChannelConfirm.replace("{name}", channels.find(c => c.id === deleteChannelId)?.name || "")}
        onConfirm={() => deleteChannelId && handleDeleteChannel(deleteChannelId)}
        onCancel={() => setDeleteChannelId(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create Task Modal
// ---------------------------------------------------------------------------

function CreateTaskModal({
  channels,
  agents,
  onClose,
  onCreated,
}: {
  channels: DispatchChannel[];
  agents: AgentListItem[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [instructions, setInstructions] = useState("");
  const [dispatchType, setDispatchType] = useState<"direct" | "channel">("direct");
  const [targetAgents, setTargetAgents] = useState<number[]>([]);
  const [channelId, setChannelId] = useState<number | undefined>();
  const [priority, setPriority] = useState(5);
  const [timeoutSeconds, setTimeoutSeconds] = useState(300);
  const [confirmTimeoutHours, setConfirmTimeoutHours] = useState(1);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !prompt.trim()) return;
    if (dispatchType === "direct" && targetAgents.length === 0) {
      showToast(t.dispatchSelectAgents, "error");
      return;
    }
    if (dispatchType === "channel" && !channelId) {
      showToast(t.dispatchSelectChannel, "error");
      return;
    }
    setSubmitting(true);
    try {
      const result = await adminApi.createDispatchTask({
        title: title.trim(),
        prompt: prompt.trim(),
        instructions: instructions.trim() || undefined,
        dispatch_type: dispatchType,
        target_agents: dispatchType === "direct" ? targetAgents : undefined,
        channel_id: dispatchType === "channel" ? channelId : undefined,
        priority,
        timeout_seconds: timeoutSeconds,
        confirm_timeout_hours: confirmTimeoutHours,
      });
      const allOk = result.assignments.every((a) => a.status === "dispatched");
      showToast(allOk ? t.dispatchCreateSuccess : t.dispatchCreatePartial, allOk ? "success" : "error");
      onCreated();
    } catch (e) {
      showToast(getApiError(e, "Request failed"), "error");
    } finally {
      setSubmitting(false);
    }
  }

  function toggleAgent(agentNum: number) {
    setTargetAgents((prev) =>
      prev.includes(agentNum) ? prev.filter((n) => n !== agentNum) : [...prev, agentNum]
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-surface border border-border-subtle rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-text-primary mb-4">{t.dispatchNewTask}</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-text-secondary mb-1">{t.dispatchTaskTitle}</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              className="w-full px-3 py-2 text-sm rounded-md bg-surface/50 border border-border-subtle text-text-primary focus:outline-none focus:border-accent-cyan"
            />
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1">{t.dispatchTaskPrompt}</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              required
              rows={4}
              className="w-full px-3 py-2 text-sm rounded-md bg-surface/50 border border-border-subtle text-text-primary focus:outline-none focus:border-accent-cyan resize-none"
            />
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1">{t.dispatchTaskInstructions}</label>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 text-sm rounded-md bg-surface/50 border border-border-subtle text-text-primary focus:outline-none focus:border-accent-cyan resize-none"
            />
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1">{t.dispatchTaskType}</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setDispatchType("direct")}
                className={`flex-1 px-3 py-2 text-sm rounded-md border transition-colors ${dispatchType === "direct" ? "bg-accent-cyan/20 border-accent-cyan/40 text-accent-cyan" : "bg-surface/50 border-border-subtle text-text-secondary"}`}
              >
                {t.dispatchTaskTypeDirect}
              </button>
              <button
                type="button"
                onClick={() => setDispatchType("channel")}
                className={`flex-1 px-3 py-2 text-sm rounded-md border transition-colors ${dispatchType === "channel" ? "bg-accent-cyan/20 border-accent-cyan/40 text-accent-cyan" : "bg-surface/50 border-border-subtle text-text-secondary"}`}
              >
                {t.dispatchTaskTypeChannel}
              </button>
            </div>
          </div>

          {dispatchType === "direct" ? (
            <div>
              <label className="block text-xs text-text-secondary mb-1">{t.dispatchTaskTargetAgents}</label>
              <div className="flex flex-wrap gap-1.5">
                {agents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => toggleAgent(agent.id)}
                    className={`px-2.5 py-1 text-xs rounded-md border transition-colors text-left ${targetAgents.includes(agent.id) ? "bg-accent-cyan/20 border-accent-cyan/40 text-accent-cyan" : "bg-surface/50 border-border-subtle text-text-secondary hover:text-text-primary"}`}
                  >
                    {agent.display_name || agent.name}
                    {(agent.owner_display_name || agent.owner_email) && (
                      <span className="block text-[10px] opacity-70">{agent.owner_display_name || agent.owner_email}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-xs text-text-secondary mb-1">{t.dispatchTaskChannel}</label>
              <select
                value={channelId ?? ""}
                onChange={(e) => setChannelId(Number(e.target.value) || undefined)}
                className="w-full px-3 py-2 text-sm rounded-md bg-surface/50 border border-border-subtle text-text-primary focus:outline-none focus:border-accent-cyan"
              >
                <option value="">{t.dispatchSelectChannel}</option>
                {channels.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    {ch.display_name || ch.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-text-secondary mb-1">{t.dispatchTaskPriority}</label>
              <input
                type="number"
                min={1}
                max={10}
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm rounded-md bg-surface/50 border border-border-subtle text-text-primary focus:outline-none focus:border-accent-cyan"
              />
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">{t.dispatchTaskTimeout}</label>
              <input
                type="number"
                min={60}
                value={timeoutSeconds}
                onChange={(e) => setTimeoutSeconds(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm rounded-md bg-surface/50 border border-border-subtle text-text-primary focus:outline-none focus:border-accent-cyan"
              />
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">{t.dispatchTaskConfirmTimeout}</label>
              <input
                type="number"
                min={0.5}
                step={0.5}
                value={confirmTimeoutHours}
                onChange={(e) => setConfirmTimeoutHours(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm rounded-md bg-surface/50 border border-border-subtle text-text-primary focus:outline-none focus:border-accent-cyan"
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-md bg-surface border border-border-subtle text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !title.trim() || !prompt.trim()}
              className="px-4 py-2 text-sm rounded-md bg-accent-cyan/20 text-accent-cyan hover:bg-accent-cyan/30 transition-colors disabled:opacity-50"
            >
              {submitting ? "..." : t.dispatchNewTask}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channel Create/Edit Modal
// ---------------------------------------------------------------------------

function ChannelModal({
  channel,
  agents,
  onClose,
  onSaved,
}: {
  channel: DispatchChannel | null;
  agents: AgentListItem[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const isEdit = channel !== null;
  const [name, setName] = useState(isEdit ? channel.name : "");
  const [displayName, setDisplayName] = useState(isEdit ? channel.display_name : "");
  const [description, setDescription] = useState(isEdit ? channel.description : "");
  const [selectedAgents, setSelectedAgents] = useState<number[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [loadingSubs, setLoadingSubs] = useState(false);

  useEffect(() => {
    if (isEdit && channel) {
      setLoadingSubs(true);
      adminApi.getChannelSubscribers(channel.id)
        .then((res) => setSelectedAgents(res.agent_numbers))
        .catch(() => setSelectedAgents([]))
        .finally(() => setLoadingSubs(false));
    }
  }, [isEdit, channel]);

  function toggleAgent(id: number) {
    setSelectedAgents((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      let channelId: number;
      if (isEdit) {
        channelId = channel.id;
        await adminApi.updateDispatchChannel(channel.id, {
          display_name: displayName.trim() || undefined,
          description: description.trim() || undefined,
        });
      } else {
        const created = await adminApi.createDispatchChannel({
          name: name.trim(),
          display_name: displayName.trim() || undefined,
          description: description.trim() || undefined,
        });
        channelId = created.id;
      }
      await adminApi.setChannelSubscribers(channelId, selectedAgents);
      onSaved();
    } catch (e) {
      showToast(getApiError(e, "Request failed"), "error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-surface border border-border-subtle rounded-xl w-full max-w-md p-6 shadow-xl max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-text-primary mb-4">
          {isEdit ? t.dispatchEditChannel : t.dispatchCreateChannel}
        </h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-text-secondary mb-1">{t.dispatchChannelName}</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isEdit}
              required
              className="w-full px-3 py-2 text-sm rounded-md bg-surface/50 border border-border-subtle text-text-primary disabled:opacity-50 focus:outline-none focus:border-accent-cyan"
            />
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1">{t.dispatchChannelDisplayName}</label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-md bg-surface/50 border border-border-subtle text-text-primary focus:outline-none focus:border-accent-cyan"
            />
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1">{t.dispatchChannelDescription}</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 text-sm rounded-md bg-surface/50 border border-border-subtle text-text-primary focus:outline-none focus:border-accent-cyan resize-none"
            />
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1">
              {t.dispatchSubscribers}
              {selectedAgents.length > 0 && (
                <span className="ml-2 text-accent-cyan">({selectedAgents.length})</span>
              )}
            </label>
            {loadingSubs ? (
              <div className="text-xs text-text-secondary py-2">{t.dispatchLoading || "Loading..."}</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {agents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => toggleAgent(agent.id)}
                    className={`px-2.5 py-1 text-xs rounded-md border transition-colors text-left ${selectedAgents.includes(agent.id) ? "bg-accent-cyan/20 border-accent-cyan/40 text-accent-cyan" : "bg-surface/50 border-border-subtle text-text-secondary hover:text-text-primary"}`}
                  >
                    {agent.display_name || agent.name}
                    {(agent.owner_display_name || agent.owner_email) && (
                      <span className="block text-[10px] opacity-70">{agent.owner_display_name || agent.owner_email}</span>
                    )}
                  </button>
                ))}
                {agents.length === 0 && (
                  <span className="text-xs text-text-secondary">{t.dispatchNoSubscribers}</span>
                )}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-md bg-surface border border-border-subtle text-text-secondary hover:text-text-primary transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={submitting} className="px-4 py-2 text-sm rounded-md bg-accent-cyan/20 text-accent-cyan hover:bg-accent-cyan/30 transition-colors disabled:opacity-50">
              {submitting ? "..." : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Task Detail Modal
// ---------------------------------------------------------------------------

function TaskDetailModal({
  task,
  onClose,
}: {
  task: DispatchTaskDetail;
  onClose: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-surface border border-border-subtle rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-text-primary">{task.title}</h2>
          <StatusBadge status={task.status} />
        </div>

        <div className="space-y-3 text-sm">
          <div>
            <span className="text-text-secondary">{t.dispatchTaskPrompt}:</span>
            <p className="mt-1 text-text-primary whitespace-pre-wrap bg-surface/50 rounded-md p-3 border border-border-subtle">{task.prompt}</p>
          </div>
          {task.instructions && (
            <div>
              <span className="text-text-secondary">{t.dispatchTaskInstructions}:</span>
              <p className="mt-1 text-text-primary whitespace-pre-wrap">{task.instructions}</p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 text-xs text-text-secondary">
            <span>{t.dispatchTaskType}: {task.dispatch_type === "channel" ? t.dispatchTaskTypeChannel : t.dispatchTaskTypeDirect}</span>
            <span>{t.dispatchTaskPriority}: {task.priority}</span>
            <span>{t.dispatchTaskCreatedBy}: {task.created_by}</span>
            <span>{t.dispatchTaskCreatedAt}: {task.created_at ? new Date(task.created_at).toLocaleString() : ""}</span>
          </div>
        </div>

        {/* Assignments */}
        <div className="mt-4">
          <h3 className="text-sm font-medium text-text-primary mb-2">{t.dispatchTaskAssignments}</h3>
          <div className="space-y-2">
            {task.assignments.map((a: DispatchAssignment) => (
              <div key={a.id} className="flex items-center justify-between bg-surface/50 rounded-md p-3 border border-border-subtle">
                <div className="flex items-center gap-3">
                  <span className="text-sm text-text-primary font-medium">
                    {t.dispatchAgent.replace("{number}", String(a.agent_number))}
                  </span>
                  <StatusBadge status={a.status} />
                </div>
                <div className="flex items-center gap-4 text-xs text-text-secondary">
                  {a.profile_name && <span>{t.dispatchAssignmentProfile}: {a.profile_name}</span>}
                  {a.result_summary && <span className="text-emerald-400">{a.result_summary}</span>}
                  {a.error_message && <span className="text-red-400">{a.error_message}</span>}
                  {a.completed_at && <span>{a.completed_at}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-end mt-4">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-md bg-surface border border-border-subtle text-text-secondary hover:text-text-primary transition-colors">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subscriber Modal
// ---------------------------------------------------------------------------

function SubscriberModal({
  agents,
  selected,
  onSelected,
  onSave,
  onClose,
}: {
  agents: AgentListItem[];
  selected: number[];
  onSelected: (agents: number[]) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();

  function toggle(agentNum: number) {
    onSelected(selected.includes(agentNum) ? selected.filter((n) => n !== agentNum) : [...selected, agentNum]);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-surface border border-border-subtle rounded-xl w-full max-w-md max-h-[80vh] overflow-y-auto p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-text-primary mb-4">{t.dispatchSubscribers}</h2>
        <div className="space-y-1.5">
          {agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => toggle(agent.id)}
              className={`w-full text-left px-3 py-2 text-sm rounded-md border transition-colors ${selected.includes(agent.id) ? "bg-accent-cyan/20 border-accent-cyan/40 text-accent-cyan" : "bg-surface/50 border-border-subtle text-text-secondary hover:text-text-primary"}`}
            >
              {agent.display_name || agent.name}
              {(agent.owner_display_name || agent.owner_email) && (
                <span className="block text-[10px] opacity-70">{agent.owner_display_name || agent.owner_email}</span>
              )}
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-3 mt-4">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-md bg-surface border border-border-subtle text-text-secondary hover:text-text-primary transition-colors">
            Cancel
          </button>
          <button onClick={onSave} className="px-4 py-2 text-sm rounded-md bg-accent-cyan/20 text-accent-cyan hover:bg-accent-cyan/30 transition-colors">
            Save ({selected.length})
          </button>
        </div>
      </div>
    </div>
  );
}
