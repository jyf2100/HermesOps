/**
 * Mock API response data for E2E tests.
 *
 * These match the backend's Pydantic response models exactly.
 */

// -- Auth --
export const VALID_ADMIN_KEY = "test-admin-key-1234";

// -- Cluster --
export const mockClusterStatus = {
  nodes: [
    {
      name: "k8s-node-1",
      cpu_capacity: "4",
      memory_capacity: "8Gi",
      cpu_usage_percent: 35.2,
      memory_usage_percent: 42.1,
      disk_total_gb: 100.0,
      disk_used_gb: 45.3,
    },
  ],
  namespace: "hermes-agent",
  total_agents: 3,
  running_agents: 2,
};

// -- Agent List --
export const mockAgentList = {
  agents: [
    {
      id: 1,
      name: "hermes-gateway-1",
      status: "running",
      url_path: "/agent1",
      resources: {
        cpu_cores: 0.15,
        cpu_request_millicores: 250,
        cpu_limit_millicores: 1000,
        memory_bytes: 268435456,
        memory_request_bytes: 536870912,
        memory_limit_bytes: 1073741824,
      },
      restart_count: 0,
      created_at: "2026-04-15T10:00:00Z",
      age_human: "5d",
      health_ok: true,
    },
    {
      id: 2,
      name: "hermes-gateway-2",
      status: "stopped",
      url_path: "/agent2",
      resources: {
        cpu_cores: null,
        cpu_request_millicores: null,
        cpu_limit_millicores: null,
        memory_bytes: null,
        memory_request_bytes: null,
        memory_limit_bytes: null,
      },
      restart_count: 1,
      created_at: "2026-04-16T08:00:00Z",
      age_human: "4d",
      health_ok: null,
    },
    {
      id: 3,
      name: "hermes-gateway-3",
      status: "failed",
      url_path: "/agent3",
      resources: {
        cpu_cores: null,
        cpu_request_millicores: null,
        cpu_limit_millicores: null,
        memory_bytes: null,
        memory_request_bytes: null,
        memory_limit_bytes: null,
      },
      restart_count: 5,
      created_at: "2026-04-17T12:00:00Z",
      age_human: "3d",
      health_ok: false,
    },
  ],
  total: 3,
};

export const mockEmptyAgentList = {
  agents: [],
  total: 0,
};

// -- Agent Detail --
export const mockAgentDetail = {
  id: 1,
  name: "hermes-gateway-1",
  status: "running",
  url_path: "/agent1",
  namespace: "hermes-agent",
  labels: { app: "hermes-gateway" },
  created_at: "2026-04-15T10:00:00Z",
  pods: [
    {
      name: "hermes-gateway-1-abc123-xyz",
      phase: "Running",
      pod_ip: "10.244.0.5",
      node_name: "k8s-node-1",
      started_at: "2026-04-15T10:01:00Z",
      containers: [
        {
          ready: true,
          restart_count: 0,
          state: "running",
          reason: null,
          image: "hermes-agent:latest",
        },
      ],
    },
  ],
  resources: {
    cpu_cores: 0.15,
    cpu_request_millicores: 250,
    cpu_limit_millicores: 1000,
    memory_bytes: 268435456,
    memory_request_bytes: 536870912,
    memory_limit_bytes: 1073741824,
  },
  health_ok: true,
  health_last_check: "2026-04-20T08:00:00Z",
  ingress_path: "/agent1",
  restart_count: 0,
  age_human: "5d",
};

// -- Config --
export const mockEnvVars = {
  agent_number: 1,
  variables: [
    { key: "LLM_API_KEY", value: "****", masked: true, is_secret: true },
    { key: "LLM_MODEL", value: "anthropic/claude-sonnet-4-20250514", masked: false, is_secret: false },
    { key: "WEIXIN_ACCOUNT_ID", value: "wx_abc123", masked: false, is_secret: false },
    { key: "WEIXIN_TOKEN", value: "****", masked: true, is_secret: true },
  ],
};

export const mockConfigYaml = { content: "platforms:\n  weixin:\n    enabled: true\n" };
export const mockSoul = { content: "You are a helpful assistant.\n" };

// -- Health --
export const mockHealth = {
  status: "ok",
  platform: "hermes-agent",
  gateway_raw: { version: "1.0.0", uptime: 86400 },
  latency_ms: 45.3,
  checked_at: "2026-04-20T08:00:00Z",
};

// -- Events --
export const mockEvents = {
  agent_number: 1,
  events: [
    {
      type: "Normal",
      reason: "Started",
      message: "Started container hermes-gateway",
      count: 1,
      source: "kubelet",
      first_timestamp: "2026-04-15T10:01:00Z",
      last_timestamp: "2026-04-15T10:01:00Z",
      age_human: "5d",
    },
  ],
};

// -- Settings --
export const mockSettings = {
  admin_key_masked: "tes****1234",
  default_resources: {
    cpu_request: "250m",
    cpu_limit: "1000m",
    memory_request: "512Mi",
    memory_limit: "1Gi",
  },
  templates: ["deployment", "env", "config", "soul"],
};

// -- Templates --
export const mockTemplate = (type: string) => ({
  type,
  content: `# ${type} template content`,
});

// -- WeChat --
export const mockWeixinStatusConnected = {
  agent_number: 1,
  connected: true,
  account_id: "wx_abc123xyz",
  user_id: "u456",
  base_url: "https://ilinkai.weixin.qq.com",
  dm_policy: "open",
  group_policy: "disabled",
  bound_at: "2026-04-18T10:30:00Z",
};

export const mockWeixinStatusNotConnected = {
  agent_number: 1,
  connected: false,
  account_id: "",
  user_id: "",
  base_url: "",
  dm_policy: "open",
  group_policy: "disabled",
  bound_at: null,
};

// -- Action responses --
export const mockActionResponse = (action: string) => ({
  agent_number: 1,
  action,
  success: true,
  message: `${action} OK`,
});

export const mockMessageResponse = (message: string) => ({ message });

// -- Create Agent --
export const mockCreateAgentResponse = {
  agent_number: 4,
  name: "hermes-gateway-4",
  created: true,
  steps: [
    { step: 1, label: "Creating Secret", status: "done", message: "" },
    { step: 2, label: "Init Data", status: "done", message: "" },
    { step: 3, label: "Create Deployment", status: "done", message: "" },
    { step: 4, label: "Update Ingress", status: "done", message: "" },
    { step: 5, label: "Wait Ready", status: "done", message: "" },
  ],
};

// -- Test LLM --
export const mockTestLlmResponse = {
  success: true,
  latency_ms: 312.5,
  model_used: "anthropic/claude-sonnet-4-20250514",
  error: null,
  response_preview: "Hello! How can I help?",
};

// -- Swarm Agents --
export const mockSwarmAgents = [
  {
    agent_id: 1,
    display_name: "Supervisor",
    capabilities: ["supervision", "routing"],
    status: "online",
    current_tasks: 0,
    max_concurrent_tasks: 5,
    last_heartbeat: Date.now() / 1000,
    model: "claude-sonnet",
  },
  {
    agent_id: 2,
    display_name: "Code Reviewer",
    capabilities: ["code-review", "refactoring"],
    status: "busy",
    current_tasks: 2,
    max_concurrent_tasks: 3,
    last_heartbeat: Date.now() / 1000,
    model: "claude-sonnet",
  },
  {
    agent_id: 3,
    display_name: "Translator",
    capabilities: ["translation"],
    status: "offline",
    current_tasks: 0,
    max_concurrent_tasks: 2,
    last_heartbeat: Date.now() / 1000 - 300,
    model: "gpt-4o",
  },
];

// -- Swarm Metrics --
export const mockSwarmMetrics = {
  timestamp: Date.now() / 1000,
  swarm_enabled: true,
  agents: [],
  agents_online: 1,
  agents_offline: 1,
  agents_busy: 1,
  queues: {
    streams: [{ name: "hermes:tasks", pending: 3 }],
    total_pending: 3,
  },
  redis_health: {
    connected: true,
    latency_ms: 1.2,
    memory_used_percent: 5.3,
    connected_clients: 3,
    uptime_seconds: 86400,
    aof_enabled: true,
    version: "7.2.0",
  },
  tasks_submitted_last_5m: 12,
  tasks_completed_last_5m: 10,
  tasks_failed_last_5m: 1,
};

export const mockSwarmMetricsNoQueue = {
  ...mockSwarmMetrics,
  queues: { streams: [], total_pending: 0 },
};

// -- SSE Token --
export const mockSseToken = { token: "sse-one-time-token-abc" };

// -- Swarm Capability --
export const mockSwarmEnabled = { enabled: true };
export const mockSwarmDisabled = { enabled: false };

// -- Crew --
export const mockCrews = {
  results: [
    {
      crew_id: "crew-1",
      name: "Review Team",
      description: "Code review crew",
      agents: [{ agent_id: 1, required_capability: "code-review" }],
      workflow: {
        type: "sequential",
        steps: [
          { id: "step_1", required_capability: "code-review", task_template: "Review: {input}", depends_on: [], input_from: {}, timeout_seconds: 120 },
        ],
        timeout_seconds: 300,
      },
      created_at: 1745700000,
      updated_at: 1745700000,
      created_by: "admin",
    },
  ],
  total: 1,
};

export const mockEmptyCrews = { results: [], total: 0 };

export const mockDagCrew = {
  crew_id: "crew-dag",
  name: "Pipeline Team",
  description: "Multi-stage DAG pipeline",
  agents: [
    { agent_id: 1, required_capability: "analysis" },
    { agent_id: 2, required_capability: "code-review" },
  ],
  workflow: {
    type: "dag",
    steps: [
      { id: "step_1", required_capability: "analysis", task_template: "Analyze: {input}", depends_on: [], input_from: {}, timeout_seconds: 120 },
      { id: "step_2", required_capability: "code-review", task_template: "Review: {step_1}", depends_on: ["step_1"], input_from: {}, timeout_seconds: 180 },
    ],
    timeout_seconds: 600,
  },
  created_at: 1745700200,
  updated_at: 1745700200,
  created_by: "admin",
};

export const mockCreatedCrew = {
  crew_id: "crew-new",
  name: "New Crew",
  description: "A new crew",
  agents: [],
  workflow: {
    type: "parallel",
    steps: [
      { id: "step_1", required_capability: "translation", task_template: "Translate", depends_on: [], input_from: {}, timeout_seconds: 120 },
    ],
    timeout_seconds: 300,
  },
  created_at: 1745700100,
  updated_at: 1745700100,
  created_by: "admin",
};

// -- Crew Execution --
export const mockExecutionPending = {
  exec_id: "exec-1",
  crew_id: "crew-1",
  status: "pending",
  started_at: Date.now() / 1000,
  completed_at: null,
  result: null,
  error: null,
};

export const mockExecutionRunning = {
  ...mockExecutionPending,
  status: "running",
};

export const mockExecutionCompleted = {
  exec_id: "exec-1",
  crew_id: "crew-1",
  status: "completed",
  started_at: Date.now() / 1000 - 30,
  completed_at: Date.now() / 1000,
  result: { summary: "All steps completed successfully" },
  error: null,
};

export const mockExecutionFailed = {
  exec_id: "exec-1",
  crew_id: "crew-1",
  status: "failed",
  started_at: Date.now() / 1000 - 10,
  completed_at: Date.now() / 1000,
  result: null,
  error: "Step step_1 timed out after 120s",
};

export const mockExecutionConflict = {
  detail: "Crew crew-1 is already executing",
};

export const mockExecutionRateLimit = {
  detail: "Max concurrent workflows reached (4)",
};

// -- Profile Templates --
export const mockProfileTemplates = [
  {
    id: 1,
    name: "researcher",
    display_name: "Researcher",
    description: "Deep research and analysis template",
    config_overrides: { model: { default: "glm-4.7", provider: "custom" } },
    soul_md: "You are a professional research analyst.",
    is_builtin: true,
    created_at: "2026-05-01T10:00:00Z",
    updated_at: "2026-05-01T10:00:00Z",
  },
  {
    id: 2,
    name: "writer",
    display_name: "Writer",
    description: "Content creation template",
    config_overrides: { model: { default: "glm-4.7", provider: "custom" } },
    soul_md: "You are a professional content writer.",
    is_builtin: true,
    created_at: "2026-05-01T10:00:00Z",
    updated_at: "2026-05-01T10:00:00Z",
  },
  {
    id: 3,
    name: "my-custom",
    display_name: "My Custom",
    description: "Custom template for testing",
    config_overrides: {},
    soul_md: null,
    is_builtin: false,
    created_at: "2026-05-10T10:00:00Z",
    updated_at: "2026-05-10T10:00:00Z",
  },
];

export const mockCreatedTemplate = {
  id: 10,
  name: "new-template",
  display_name: "New Template",
  description: "A brand new template",
  config_overrides: {},
  soul_md: null,
  is_builtin: false,
  created_at: "2026-05-10T12:00:00Z",
  updated_at: "2026-05-10T12:00:00Z",
};

export const mockClonedTemplate = {
  id: 11,
  name: "researcher-copy",
  display_name: "Researcher",
  description: "Deep research and analysis template",
  config_overrides: { model: { default: "glm-4.7", provider: "custom" } },
  soul_md: "You are a professional research analyst.",
  is_builtin: false,
  created_at: "2026-05-10T12:01:00Z",
  updated_at: "2026-05-10T12:01:00Z",
};

// -- Agent Profiles --
export const mockProfileList = [
  {
    id: 101,
    agent_number: 1,
    profile_name: "default",
    display_name: "Default",
    template_id: null,
    template_name: null,
    template_display_name: null,
    config_overrides: {},
    soul_md: null,
    sync_status: "synced",
    sync_error: null,
    config_hash: "abc123",
    last_synced_at: "2026-05-10T11:00:00Z",
    created_at: "2026-05-10T10:00:00Z",
    updated_at: "2026-05-10T11:00:00Z",
  },
  {
    id: 102,
    agent_number: 1,
    profile_name: "research-mode",
    display_name: "Research Mode",
    template_id: 1,
    template_name: "researcher",
    template_display_name: "Researcher",
    config_overrides: { model: { default: "glm-4.7" } },
    soul_md: "You are a professional research analyst.",
    sync_status: "pending",
    sync_error: null,
    config_hash: "def456",
    last_synced_at: null,
    created_at: "2026-05-10T10:30:00Z",
    updated_at: "2026-05-10T10:30:00Z",
  },
  {
    id: 103,
    agent_number: 1,
    profile_name: "broken",
    display_name: "Broken Profile",
    template_id: null,
    template_name: null,
    template_display_name: null,
    config_overrides: {},
    soul_md: null,
    sync_status: "error",
    sync_error: "Pod not found",
    config_hash: "ghi789",
    last_synced_at: null,
    created_at: "2026-05-10T10:45:00Z",
    updated_at: "2026-05-10T10:45:00Z",
  },
];

export const mockEmptyProfileList: unknown[] = [];

export const mockCreatedProfile = {
  id: 104,
  agent_number: 1,
  profile_name: "new-profile",
  display_name: "New Profile",
  template_id: 1,
  config_overrides: { model: { default: "glm-4.7" } },
  soul_md: "You are a professional research analyst.",
  sync_status: "pending",
  sync_error: null,
  config_hash: "jkl012",
  last_synced_at: null,
  created_at: "2026-05-10T12:00:00Z",
  updated_at: "2026-05-10T12:00:00Z",
};

export const mockSyncResult = {
  profile_name: "default",
  status: "synced",
  message: "Config synced to pod",
};

export const mockBatchSyncResult = {
  synced: 2,
  results: [
    { profile_name: "default", status: "synced", message: "OK" },
    { profile_name: "research-mode", status: "synced", message: "OK" },
  ],
};

export const mockResolvedConfig = {
  profile_name: "research-mode",
  template_id: 1,
  template_overrides: { model: { default: "glm-4.7", provider: "custom" } },
  profile_overrides: { model: { default: "glm-4.7" } },
  resolved_config: { model: { default: "glm-4.7", provider: "custom" } },
  soul_md: "You are a professional research analyst.",
};

export const mockAuditLog = {
  total: 5,
  items: [
    {
      id: 1,
      entity_type: "template",
      entity_id: 1,
      action: "update",
      old_values: { id: 1, name: "researcher", display_name: "Researcher" },
      new_values: { id: 1, name: "researcher", display_name: "Senior Researcher" },
      changed_by: "admin-ui",
      created_at: "2026-05-10T10:00:00Z",
    },
    {
      id: 2,
      entity_type: "profile",
      entity_id: 101,
      action: "create",
      old_values: null,
      new_values: { id: 101, profile_name: "default" },
      changed_by: "admin-ui",
      created_at: "2026-05-10T09:00:00Z",
    },
  ],
};

// -- Skills Summary --
export const mockSkillsSummary = {
  skills: [
    { name: "web-search", template_ids: [1, 2], template_count: 2 },
    { name: "code-interpreter", template_ids: [1], template_count: 1 },
    { name: "file-upload", template_ids: [3], template_count: 1 },
  ],
};

export const mockEmptySkillsSummary = { skills: [] };
