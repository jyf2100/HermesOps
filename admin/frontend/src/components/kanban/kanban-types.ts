export type KanbanStatus =
  | "triage"
  | "todo"
  | "ready"
  | "running"
  | "done"
  | "blocked"
  | "archived";

export interface KanbanTask {
  id: string;
  title: string;
  body?: string;
  status: KanbanStatus;
  priority?: number;
  assignee?: string;
  labels?: string[];
  skills?: string[];
  created_at: number;
  completed_at?: number | null;
  block_reason?: string;
  comment_count?: number;
  link_counts?: { parents: number; children: number };
  parents?: string[];
  children?: string[];
  progress?: { done: number; total: number };
}

export interface KanbanTaskDetail extends KanbanTask {
  comments: KanbanComment[];
  latest_summary?: string | null;
  result?: string | null;
  last_failure_error?: string | null;
  worker_pid?: number | null;
  consecutive_failures?: number;
  links?: {
    parents: { id: string; title: string; status: KanbanStatus }[];
    children: { id: string; title: string; status: KanbanStatus }[];
  };
}

export interface KanbanBoard {
  slug: string;
  name: string;
  description?: string;
}

export interface KanbanStats {
  total: number;
  by_status: Record<string, number>;
}

export interface KanbanComment {
  id: string;
  task_id: string;
  author: string;
  body: string;
  created_at: number;
}

export interface AssigneeProfile {
  name: string;
  on_disk: boolean;
  counts: Record<KanbanStatus, number>;
}
