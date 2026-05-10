import { useState, useEffect, useCallback, useRef } from "react";
import { adminFetch } from "../../lib/admin-api";
import { useI18n } from "../../hooks/useI18n";
import { showToast } from "../../lib/toast";
import { ProfileEditor } from "./ProfileEditor";
import { AgentProfileData, ProfileTemplateData } from "../../types/profile";
import type { Translations } from "../../i18n/zh";

// ---------------------------------------------------------------------------
// ProfileList
// ---------------------------------------------------------------------------

interface ProfileListProps {
  agentId: number;
}

export function ProfileList({ agentId }: ProfileListProps) {
  const { t } = useI18n();

  const [profiles, setProfiles] = useState<AgentProfileData[]>([]);
  const [templates, setTemplates] = useState<ProfileTemplateData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"name" | "status" | "updated">("name");

  // Editor state: null = closed, {} = create new, {profile} = edit existing
  const [editingProfile, setEditingProfile] = useState<AgentProfileData | "create" | null>(null);

  // Sync state per profile
  const [syncing, setSyncing] = useState<Set<string>>(new Set());
  const [syncingAll, setSyncingAll] = useState(false);

  // Batch selection state
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);

  function toggleSelect(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selected.size === profiles.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(profiles.map((p) => p.profile_name)));
    }
  }

  async function handleBatchDelete() {
    if (selected.size === 0) return;
    if (!window.confirm(`Delete ${selected.size} profiles?`)) return;
    setBatchDeleting(true);
    const results = await Promise.allSettled(
      Array.from(selected).map((name) =>
        adminFetch(
          `/agents/${agentId}/profiles/${encodeURIComponent(name)}`,
          { method: "DELETE" }
        )
      )
    );
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;
    setSelected(new Set());
    setBatchDeleting(false);
    if (failed > 0) {
      showToast(`Deleted ${succeeded}, ${failed} failed`, "error");
    } else {
      showToast(`Deleted ${succeeded} profiles`);
    }
    await loadProfiles();
  }

  const loadProfiles = useCallback(async () => {
    try {
      const data = await adminFetch<AgentProfileData[]>(
        `/agents/${agentId}/profiles`
      );
      setProfiles(Array.isArray(data) ? data : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(t.errorLoadFailed));
    } finally {
      setLoading(false);
    }
  }, [agentId, t.errorLoadFailed]);

  const loadTemplates = useCallback(async () => {
    try {
      const data = await adminFetch<ProfileTemplateData[]>(
        `/profile-templates`
      );
      setTemplates(Array.isArray(data) ? data : []);
    } catch {
      // Templates are optional — editor falls back to empty list
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    loadProfiles();
    loadTemplates();
  }, [loadProfiles, loadTemplates]);

  // ----- Actions -----

  async function handleSync(profileName: string) {
    setSyncing((prev) => new Set(prev).add(profileName));
    try {
      await adminFetch(
        `/agents/${agentId}/profiles/${encodeURIComponent(profileName)}/sync`,
        { method: "POST" }
      );
      showToast(t.profileSyncSuccess);
      await loadProfiles();
    } catch (err) {
      showToast(
        `${t.profileSyncFailedMsg}: ${err instanceof Error ? err.message : ""}`,
        "error"
      );
    } finally {
      setSyncing((prev) => {
        const next = new Set(prev);
        next.delete(profileName);
        return next;
      });
    }
  }

  async function handleSyncAll() {
    setSyncingAll(true);
    try {
      const result = await adminFetch<{
        synced: number;
        results: Array<{ profile_name: string; sync_status: string; sync_error?: string }>;
      }>(`/agents/${agentId}/profiles/sync`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      const failed = result.results?.filter((r) => r.sync_status === "error") ?? [];
      if (failed.length > 0) {
        showToast(
          `${t.profileSyncSuccess} (${result.synced}) — ${failed.length} ${t.profileSyncFailed}`,
          "error"
        );
      } else {
        showToast(`${t.profileSyncSuccess} (${result.synced})`);
      }
      await loadProfiles();
    } catch (err) {
      showToast(
        `${t.profileSyncFailedMsg}: ${err instanceof Error ? err.message : ""}`,
        "error"
      );
    } finally {
      setSyncingAll(false);
    }
  }

  async function handleDelete(profileName: string) {
    if (!window.confirm(t.profileDeleteConfirm)) return;
    try {
      await adminFetch(
        `/agents/${agentId}/profiles/${encodeURIComponent(profileName)}`,
        { method: "DELETE" }
      );
      showToast(t.profileDelete);
      await loadProfiles();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(t.errorGeneric), "error");
    }
  }

  function handleEditorClose() {
    setEditingProfile(null);
  }

  function handleExport() {
    const data = JSON.stringify(profiles, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `profiles-agent-${agentId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 1024 * 1024) {
      showToast("File too large (max 1MB)", "error");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    try {
      const text = await file.text();
      const imported = JSON.parse(text);
      if (!Array.isArray(imported)) throw new Error("Invalid format: expected array");
      if (imported.length > 50) throw new Error("Too many profiles (max 50)");
      // Validate each item has required fields
      for (const p of imported) {
        if (!p.profile_name || typeof p.profile_name !== "string") {
          throw new Error("Each profile must have a valid profile_name");
        }
      }
      const results = await Promise.allSettled(
        imported.map((p) =>
          adminFetch(`/agents/${agentId}/profiles`, {
            method: "POST",
            body: JSON.stringify({
              profile_name: p.profile_name,
              display_name: p.display_name || "",
              template_id: p.template_id ?? null,
              config_overrides: p.config_overrides ?? {},
              soul_md: p.soul_md ?? null,
            }),
          })
        )
      );
      const created = results.filter((r) => r.status === "fulfilled").length;
      showToast(`Imported ${created}/${imported.length} profiles`);
      await loadProfiles();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Import failed", "error");
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleEditorSaved() {
    await loadProfiles();
    setEditingProfile(null);
  }

  // ----- Render -----

  if (loading) {
    return (
      <p className="text-sm text-text-secondary py-8 text-center">{t.loading}</p>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <p className="text-sm text-accent-pink">{error}</p>
        <button
          onClick={() => { setLoading(true); loadProfiles(); }}
          className="h-9 px-4 text-sm border border-accent-cyan text-accent-cyan hover:bg-accent-cyan/10 rounded"
        >
          {t.retry}
        </button>
      </div>
    );
  }

  const sortedProfiles = [...profiles].sort((a, b) => {
    if (sortBy === "status") return a.sync_status.localeCompare(b.sync_status);
    if (sortBy === "updated") return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
    return a.profile_name.localeCompare(b.profile_name);
  });

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-text-primary">{t.profileList}</h3>
          {profiles.length > 1 && (
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as "name" | "status" | "updated")}
              className="h-7 px-2 text-[10px] bg-background border border-border rounded text-text-secondary"
            >
              <option value="name">{t.profileSortName}</option>
              <option value="status">{t.profileSortStatus}</option>
              <option value="updated">{t.profileSortUpdated}</option>
            </select>
          )}
        </div>
        <div className="flex gap-2">
          {selected.size > 0 && (
            <button
              onClick={handleBatchDelete}
              disabled={batchDeleting}
              className="h-8 px-3 text-xs border border-accent-pink/30 text-accent-pink hover:bg-accent-pink/10 rounded disabled:opacity-50"
            >
              {batchDeleting ? "..." : `Delete (${selected.size})`}
            </button>
          )}
          {profiles.length > 0 && (
            <>
              <button
                onClick={handleExport}
                className="h-8 px-3 text-xs border border-border text-text-secondary hover:text-text-primary hover:border-accent-cyan/30 rounded"
              >
                Export
              </button>
              <button
                onClick={handleSyncAll}
                disabled={syncingAll}
                className="h-8 px-3 text-xs border border-accent-cyan text-accent-cyan hover:bg-accent-cyan/10 rounded disabled:opacity-50"
              >
                {syncingAll ? t.profileSyncing : t.profileSyncAll}
              </button>
            </>
          )}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="h-8 px-3 text-xs border border-border text-text-secondary hover:text-text-primary hover:border-accent-cyan/30 rounded"
          >
            Import
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleImport}
            className="hidden"
          />
          <button
            onClick={() => setEditingProfile("create")}
            className="h-8 px-3 text-xs rounded bg-accent-pink text-white hover:bg-accent-pink/90"
          >
            {t.profileCreate}
          </button>
        </div>
      </div>

      {/* Profile list */}
      {profiles.length === 0 ? (
        <div className="rounded-lg border border-border border-dashed bg-surface/50 p-8 text-center">
          <p className="text-sm text-text-secondary">{t.profileNoProfiles}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Select all row */}
          {sortedProfiles.length > 1 && (
            <div className="flex items-center gap-2 px-1">
              <input
                type="checkbox"
                checked={selected.size === profiles.length}
                onChange={toggleSelectAll}
                className="h-3.5 w-3.5 accent-accent-cyan"
              />
              <span className="text-[10px] text-text-secondary">
                {selected.size > 0 ? `${selected.size} selected` : "Select all"}
              </span>
            </div>
          )}
          {sortedProfiles.map((profile) => (
            <ProfileRow
              key={profile.profile_name}
              profile={profile}
              selected={selected.has(profile.profile_name)}
              syncing={syncing.has(profile.profile_name)}
              onToggleSelect={() => toggleSelect(profile.profile_name)}
              onEdit={() => setEditingProfile(profile)}
              onSync={() => handleSync(profile.profile_name)}
              onDelete={() => handleDelete(profile.profile_name)}
              t={t}
            />
          ))}
        </div>
      )}

      {/* Editor modal */}
      {editingProfile !== null && (
        <ProfileEditor
          agentId={agentId}
          profile={editingProfile === "create" ? null : editingProfile}
          templates={templates}
          onClose={handleEditorClose}
          onSaved={handleEditorSaved}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProfileRow
// ---------------------------------------------------------------------------

interface ProfileRowProps {
  profile: AgentProfileData;
  selected: boolean;
  syncing: boolean;
  onToggleSelect: () => void;
  onEdit: () => void;
  onSync: () => void;
  onDelete: () => void;
  t: Translations;
}

function ProfileRow({ profile, selected, syncing, onToggleSelect, onEdit, onSync, onDelete, t }: ProfileRowProps) {
  const syncColor =
    profile.sync_status === "synced"
      ? "bg-success"
      : profile.sync_status === "error"
        ? "bg-accent-pink"
        : "bg-text-secondary/50";

  const syncLabel =
    profile.sync_status === "synced"
      ? t.profileSyncSynced
      : profile.sync_status === "error"
        ? t.profileSyncFailed
        : t.profileSyncPending;

  return (
    <div className={`rounded-lg border bg-surface p-3 flex items-center gap-4 group hover:border-accent-cyan/30 transition-colors ${selected ? "border-accent-cyan/40 bg-accent-cyan/5" : "border-border"}`}>
      {/* Checkbox */}
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggleSelect}
        className="h-3.5 w-3.5 accent-accent-cyan shrink-0"
      />
      {/* Sync dot + name */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${syncColor}`} title={syncLabel} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary font-[family-name:var(--font-mono)] truncate">
              {profile.profile_name}
            </span>
            {profile.display_name && (
              <span className="text-xs text-text-secondary truncate">
                ({profile.display_name})
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            {profile.template_display_name && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/20">
                {profile.template_display_name}
              </span>
            )}
            <span className="text-[10px] text-text-secondary">{syncLabel}</span>
            {profile.last_synced_at && (
              <span className="text-[10px] text-text-muted">
                {t.profileLastSynced}: {formatTime(profile.last_synced_at)}
              </span>
            )}
          </div>
          {profile.sync_error && (
            <p className="text-[10px] text-accent-pink mt-0.5 truncate">{profile.sync_error}</p>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5 opacity-60 group-hover:opacity-100 transition-opacity shrink-0">
        <button
          onClick={onSync}
          disabled={syncing}
          className="h-7 px-2.5 text-[10px] border border-accent-cyan text-accent-cyan hover:bg-accent-cyan/10 rounded disabled:opacity-50"
        >
          {syncing ? "..." : t.profileSyncToPod}
        </button>
        <button
          onClick={onEdit}
          className="h-7 px-2.5 text-[10px] border border-border text-text-secondary hover:text-text-primary hover:border-accent-cyan/30 rounded"
        >
          {t.edit}
        </button>
        <button
          onClick={onDelete}
          className="h-7 px-2.5 text-[10px] border border-accent-pink/30 text-accent-pink hover:bg-accent-pink/10 rounded"
        >
          {t.profileDelete}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}
