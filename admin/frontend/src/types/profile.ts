export interface AgentProfileData {
  id: number
  agent_number: number
  profile_name: string
  display_name: string
  template_id: number | null
  template_name: string | null
  template_display_name: string | null
  config_overrides: Record<string, unknown>
  soul_md: string | null
  sync_status: "pending" | "synced" | "error"
  sync_error: string | null
  config_hash: string | null
  last_synced_at: string | null
  created_at: string | null
  updated_at: string | null
}

export interface ProfileTemplateData {
  id: number
  name: string
  display_name: string
  description: string
  config_overrides: Record<string, unknown>
  soul_md: string | null
  is_builtin: boolean
  profile_count?: number
  created_at: string | null
  updated_at: string | null
}
