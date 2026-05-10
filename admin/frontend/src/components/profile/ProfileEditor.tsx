import { useState, useEffect, useCallback } from "react";
import { adminFetch } from "../../lib/admin-api";
import { useI18n } from "../../hooks/useI18n";
import { showToast } from "../../lib/toast";
import { AgentProfileData, ProfileTemplateData } from "../../types/profile";

// ---------------------------------------------------------------------------
// ProfileEditor
// ---------------------------------------------------------------------------

interface ProfileEditorProps {
  agentId: number;
  profile: AgentProfileData | null; // null = create new
  templates: ProfileTemplateData[];
  onClose: () => void;
  onSaved: () => void;
}

export function ProfileEditor({
  agentId,
  profile,
  templates,
  onClose,
  onSaved,
}: ProfileEditorProps) {
  const { t } = useI18n();
  const isEdit = profile !== null;

  // Form state
  const [profileName, setProfileName] = useState(profile?.profile_name ?? "");
  const [displayName, setDisplayName] = useState(profile?.display_name ?? "");
  const [templateId, setTemplateId] = useState<string>(
    profile?.template_id != null ? String(profile.template_id) : ""
  );
  const [configJson, setConfigJson] = useState(
    JSON.stringify(profile?.config_overrides ?? {}, null, 2)
  );
  const [soulMd, setSoulMd] = useState(profile?.soul_md ?? "");

  // Resolved config preview
  const [resolvedYaml, setResolvedYaml] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [resolving, setResolving] = useState(false);

  // Soul MD preview
  const [showSoulPreview, setShowSoulPreview] = useState(false);

  // Submit state
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load resolved config on demand
  const loadResolved = useCallback(async () => {
    if (!isEdit || !profile) return;
    setResolving(true);
    try {
      const data = await adminFetch<{
        template_overrides: Record<string, unknown>;
        profile_overrides: Record<string, unknown>;
        resolved_config: Record<string, unknown>;
        soul_md: string | null;
      }>(
        `/agents/${agentId}/profiles/${encodeURIComponent(profile.profile_name)}/resolved-config`
      );
      const sections: string[] = [];
      if (Object.keys(data.template_overrides ?? {}).length > 0) {
        sections.push(`--- Template Overrides ---\n${JSON.stringify(data.template_overrides, null, 2)}`);
      }
      if (Object.keys(data.profile_overrides ?? {}).length > 0) {
        sections.push(`--- Profile Overrides ---\n${JSON.stringify(data.profile_overrides, null, 2)}`);
      }
      sections.push(`--- Resolved Config ---\n${JSON.stringify(data.resolved_config, null, 2)}`);
      if (data.soul_md) {
        sections.push(`--- SOUL.md ---\n${data.soul_md}`);
      }
      setResolvedYaml(sections.join("\n\n"));
    } catch {
      setResolvedYaml("// Failed to load resolved config");
    } finally {
      setResolving(false);
    }
  }, [agentId, isEdit, profile]);

  useEffect(() => {
    if (showResolved && resolvedYaml === null) {
      loadResolved();
    }
  }, [showResolved, resolvedYaml, loadResolved]);

  async function handleSave() {
    setSaving(true);
    setError(null);

    // Validate JSON
    let parsedConfig: Record<string, unknown>;
    try {
      parsedConfig = JSON.parse(configJson || "{}");
    } catch {
      setError("Invalid JSON in config overrides");
      setSaving(false);
      return;
    }

    try {
      const body: Record<string, unknown> = {
        display_name: displayName || null,
        template_id: templateId ? Number(templateId) : null,
        config_overrides: parsedConfig,
        soul_md: soulMd || null,
      };

      if (isEdit) {
        if (!profile) { setSaving(false); return; }
        await adminFetch(
          `/agents/${agentId}/profiles/${encodeURIComponent(profile.profile_name)}`,
          { method: "PUT", body: JSON.stringify(body) }
        );
      } else {
        if (!profileName.trim()) {
          setError("Profile name is required");
          setSaving(false);
          return;
        }
        body.profile_name = profileName.trim();
        await adminFetch(`/agents/${agentId}/profiles`, {
          method: "POST",
          body: JSON.stringify(body),
        });
      }

      showToast(isEdit ? t.profileEdit : t.profileCreate);
      // Invalidate resolved preview since config changed
      setResolvedYaml(null);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(t.errorSaveFailed));
    } finally {
      setSaving(false);
    }
  }

  async function handleSync() {
    if (!profile) return;
    setSyncing(true);
    try {
      await adminFetch(
        `/agents/${agentId}/profiles/${encodeURIComponent(profile.profile_name)}/sync`,
        { method: "POST" }
      );
      showToast(t.profileSyncSuccess);
    } catch (err) {
      showToast(
        `${t.profileSyncFailedMsg}: ${err instanceof Error ? err.message : ""}`,
        "error"
      );
    } finally {
      setSyncing(false);
    }
  }

  // ----- Render -----

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="modal-backdrop"
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        className="bg-surface border border-border rounded-lg w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h3 className="text-lg font-medium text-text-primary">
            {isEdit ? t.profileEdit : t.profileCreate}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-text-secondary hover:text-text-primary transition-colors"
            aria-label="Close"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {/* Profile name (only when creating) */}
          {!isEdit && (
            <div>
              <label className="text-xs text-text-secondary block mb-1">
                {t.profileName} <span className="text-accent-pink">*</span>
              </label>
              <input
                type="text"
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
                placeholder="e.g. researcher"
                className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm font-[family-name:var(--font-mono)] text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-accent-cyan"
              />
            </div>
          )}

          {/* Display name */}
          <div>
            <label className="text-xs text-text-secondary block mb-1">
              {t.profileTemplateDisplayName}
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t.displayNamePlaceholder}
              autoFocus
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-accent-cyan"
            />
          </div>

          {/* Template selector */}
          <div>
            <label className="text-xs text-text-secondary block mb-1">
              {t.profileTemplate}
            </label>
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent-cyan"
            >
              <option value="">-- {t.profileTemplate} --</option>
              {templates.map((tmpl) => (
                <option key={tmpl.id} value={String(tmpl.id)}>
                  {tmpl.display_name || tmpl.name}
                  {tmpl.is_builtin ? ` (${t.profileTemplateBuiltin})` : ""}
                </option>
              ))}
            </select>
            {templateId && (() => {
              const tmpl = templates.find((t) => String(t.id) === templateId);
              return tmpl?.description ? (
                <p className="mt-1 text-[10px] text-text-secondary">{tmpl.description}</p>
              ) : null;
            })()}
          </div>

          {/* Config overrides */}
          <div>
            <label className="text-xs text-text-secondary block mb-1">
              {t.profileConfig}
            </label>
            <textarea
              value={configJson}
              onChange={(e) => setConfigJson(e.target.value)}
              rows={8}
              spellCheck={false}
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm font-[family-name:var(--font-mono)] text-text-primary resize-y placeholder:text-text-secondary focus:outline-none focus:border-accent-cyan"
              placeholder='{"model": {"default": "glm-4.7"}}'
            />
          </div>

          {/* SOUL.md */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-text-secondary">
                {t.profileSoul}
              </label>
              {soulMd && (
                <button
                  type="button"
                  onClick={() => setShowSoulPreview((v) => !v)}
                  className="text-[10px] text-accent-cyan hover:text-accent-cyan/80"
                >
                  {showSoulPreview ? t.profileEdit : "Preview"}
                </button>
              )}
            </div>
            {showSoulPreview ? (
              <pre className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-text-primary whitespace-pre-wrap max-h-48 overflow-auto">
                {soulMd}
              </pre>
            ) : (
              <textarea
                value={soulMd}
                onChange={(e) => setSoulMd(e.target.value)}
                rows={6}
                className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-text-primary resize-y placeholder:text-text-secondary focus:outline-none focus:border-accent-cyan"
                placeholder="Custom SOUL.md content for this profile..."
              />
            )}
          </div>

          {/* Resolved config preview (edit mode only) */}
          {isEdit && (
            <div>
              <button
                type="button"
                onClick={() => setShowResolved((v) => !v)}
                className="flex items-center gap-1 text-xs text-accent-cyan hover:text-accent-cyan/80 transition-colors"
              >
                <svg
                  className={`h-3.5 w-3.5 transition-transform ${showResolved ? "rotate-180" : ""}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
                {t.profileResolvedConfig}
              </button>
              {showResolved && (
                <pre className="mt-2 bg-background border border-border rounded-md p-3 text-xs font-[family-name:var(--font-mono)] text-text-primary max-h-64 overflow-auto">
                  {resolving ? t.loading : resolvedYaml ?? "// No data"}
                </pre>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="p-2 rounded bg-accent-pink/10 text-accent-pink text-xs">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-2 justify-end px-6 py-4 border-t border-border shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-md text-text-secondary hover:text-text-primary border border-border-subtle transition-colors"
          >
            {t.cancel}
          </button>
          {isEdit && (
            <button
              type="button"
              onClick={handleSync}
              disabled={syncing}
              className="px-4 py-2 text-sm rounded-md border border-accent-cyan text-accent-cyan hover:bg-accent-cyan/10 disabled:opacity-50 transition-colors"
            >
              {syncing ? t.profileSyncing : t.profileSyncToPod}
            </button>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 text-sm rounded-md bg-accent-pink text-white hover:bg-accent-pink/90 disabled:opacity-50"
          >
            {saving ? t.loading : t.save}
          </button>
        </div>
      </div>
    </div>
  );
}
