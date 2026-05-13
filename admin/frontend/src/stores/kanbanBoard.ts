import { create } from "zustand";
import { adminFetch } from "../lib/admin-api";
import { showToast } from "../lib/toast";
import type { KanbanTask, KanbanComment, AssigneeProfile } from "../components/kanban/kanban-types";

interface KanbanBoardState {
  tasks: KanbanTask[];
  assignees: AssigneeProfile[];
  loading: boolean;
  error: string | null;
  fetchBoard: (agentId: number, silent?: boolean) => Promise<void>;
  fetchAssignees: (agentId: number) => Promise<void>;
  startPolling: (agentId: number) => void;
  stopPolling: () => void;
  createTask: (
    agentId: number,
    data: { title: string; body?: string; priority?: number; labels?: string[]; skills?: string[]; assignee?: string; parents?: string[] }
  ) => Promise<void>;
  updateTask: (
    agentId: number,
    taskId: string,
    data: Partial<KanbanTask>
  ) => Promise<void>;
  addComment: (
    agentId: number,
    taskId: string,
    commentBody: string
  ) => Promise<void>;
  moveTask: (
    agentId: number,
    taskId: string,
    newStatus: KanbanTask["status"]
  ) => Promise<void>;
}

let pollIntervalId: ReturnType<typeof setInterval> | null = null;
let _pollingAgentId: number | null = null;

function _handleVisibility() {
  if (document.hidden) {
    // stopPolling will be called, interval cleared
    if (pollIntervalId !== null) {
      clearInterval(pollIntervalId);
      pollIntervalId = null;
    }
  } else if (_pollingAgentId !== null) {
    // Resume: fetch immediately and restart interval
    const store = useKanbanBoard.getState();
    store.fetchBoard(_pollingAgentId);
    pollIntervalId = setInterval(() => store.fetchBoard(_pollingAgentId!, true), 15_000);
  }
}

export const useKanbanBoard = create<KanbanBoardState>((set, get) => ({
  tasks: [],
  assignees: [],
  loading: false,
  error: null,

  fetchBoard: async (agentId: number, silent = false) => {
    if (!silent) set({ loading: true, error: null });
    try {
      const board = await adminFetch<{ columns?: { tasks?: KanbanTask[] }[] }>(
        `/agents/${agentId}/kanban/tasks?include_archived=true`
      );
      const columns = board?.columns ?? [];
      const tasks = columns.flatMap((col) => col?.tasks ?? []);
      if (silent) {
        set({ tasks, error: null });
      } else {
        set({ tasks, loading: false, error: null });
      }
    } catch (e: unknown) {
      if (silent) {
        set({ error: e instanceof Error ? e.message : String(e) });
      } else {
        set({ error: e instanceof Error ? e.message : String(e), loading: false });
      }
    }
  },

  fetchAssignees: async (agentId: number) => {
    try {
      const data = await adminFetch<{ assignees: AssigneeProfile[] }>(
        `/agents/${agentId}/kanban/assignees`
      );
      set({ assignees: Array.isArray(data?.assignees) ? data.assignees : [] });
    } catch (e: unknown) {
      showToast("Failed to fetch assignees", "error");
    }
  },

  startPolling: (agentId: number) => {
    get().stopPolling();
    _pollingAgentId = agentId;
    get().fetchBoard(agentId);
    pollIntervalId = setInterval(() => get().fetchBoard(agentId, true), 15_000);
    document.removeEventListener('visibilitychange', _handleVisibility);
    document.addEventListener('visibilitychange', _handleVisibility);
  },

  stopPolling: () => {
    if (pollIntervalId !== null) {
      clearInterval(pollIntervalId);
      pollIntervalId = null;
    }
    _pollingAgentId = null;
    document.removeEventListener('visibilitychange', _handleVisibility);
  },

  createTask: async (agentId, data) => {
    await adminFetch<KanbanTask>(`/agents/${agentId}/kanban/tasks`, {
      method: "POST",
      body: JSON.stringify(data),
    });
    await get().fetchBoard(agentId);
    // Auto-dispatch after creating a task
    try {
      await adminFetch<{ spawned: unknown[] }>(`/agents/${agentId}/kanban/dispatch`, {
        method: "POST",
      });
    } catch (e) {
      showToast("Auto-dispatch failed", "error");
    }
  },

  updateTask: async (agentId, taskId, data) => {
    await adminFetch<KanbanTask>(
      `/agents/${agentId}/kanban/tasks/${taskId}`,
      {
        method: "PATCH",
        body: JSON.stringify(data),
      }
    );
    await get().fetchBoard(agentId);
  },

  addComment: async (agentId, taskId, commentBody) => {
    await adminFetch<KanbanComment>(
      `/agents/${agentId}/kanban/tasks/${taskId}/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body: commentBody }),
      }
    );
  },

  moveTask: async (agentId, taskId, newStatus) => {
    await adminFetch<KanbanTask>(
      `/agents/${agentId}/kanban/tasks/${taskId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ status: newStatus }),
      }
    );
    await get().fetchBoard(agentId);
  },
}));
