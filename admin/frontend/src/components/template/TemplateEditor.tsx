import { useState, useRef, useEffect, useCallback } from "react";
import { adminApi, adminFetch } from "../../lib/admin-api";
import { useI18n } from "../../hooks/useI18n";
import { showToast } from "../../lib/toast";
import type { ProfileTemplateData } from "../../types/profile";
import { ModalOverlay } from "../shared/ModalOverlay";
import { JsonEditor } from "../shared/JsonEditor";
import { SoulMdEditor } from "../shared/SoulMdEditor";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------------
// TemplateEditor
// ---------------------------------------------------------------------------

interface TemplateEditorProps {
  mode: "create" | "edit" | "clone";
  template?: ProfileTemplateData | null;
  existingNames: string[];
  onClose: () => void;
  onSaved: () => void;
}

export function TemplateEditor({
  mode,
  template,
  existingNames,
  onClose,
  onSaved,
}: TemplateEditorProps) {
  const { t } = useI18n();
  const isEdit = mode === "edit";
  const isClone = mode === "clone";
  const isBuiltin = template?.is_builtin === true;

  // Derive initial form values based on mode
  const initialName = isClone
    ? `${template?.name ?? ""}-copy`
    : template?.name ?? "";
  const initialDisplayName = isClone
    ? `${template?.display_name ?? template?.name ?? ""}${t.templateCloneSuffix}`
    : template?.display_name ?? "";
  const initialDescription = template?.description ?? "";
  const initialConfig = template?.config_overrides ?? {};
  const initialSoulMd = template?.soul_md ?? "";

  // Form state
  const [name, setName] = useState(initialName);
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [description, setDescription] = useState(initialDescription);
  const [configJson, setConfigJson] = useState(
    JSON.stringify(initialConfig, null, 2)
  );
  const [soulMd, setSoulMd] = useState(initialSoulMd);

  // Submit state
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Validation
  const [nameTouched, setNameTouched] = useState(false);
  const [configTouched, setConfigTouched] = useState(false);

  // Skills install search state
  const [skillSearch, setSkillSearch] = useState("");
  const [skillResults, setSkillResults] = useState<Array<{ identifier: string; name: string; description?: string }>>([]);
  const [skillSearching, setSkillSearching] = useState(false);
  const skillSearchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const skillSearchRef = useRef<HTMLDivElement>(null);

  // AI soul generation state
  const [showGenDialog, setShowGenDialog] = useState(false);
  const [genAgentNumber, setGenAgentNumber] = useState<number | null>(null);
  const [genAgents, setGenAgents] = useState<Array<{ id: number; display_name?: string }>>([]);
  const [genLoading, setGenLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const genAbortRef = useRef<AbortController | null>(null);

  // Close search dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (skillSearchRef.current && !skillSearchRef.current.contains(e.target as Node)) {
        setSkillResults([]);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // ----- AI soul generation helpers -----

  const handleOpenGenDialog = useCallback(async () => {
    setShowGenDialog(true);
    setGenAgentNumber(null);
    setGenLoading(true);
    try {
      const res = await adminApi.listAgents();
      setGenAgents(res.agents.map((a) => ({ id: a.id, display_name: a.display_name })));
    } catch {
      setGenAgents([]);
    } finally {
      setGenLoading(false);
    }
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!genAgentNumber) return;
    if (soulMd.trim()) {
      if (!window.confirm(t.templateGenerateSoulOverwriteWarning)) return;
    }
    setGenerating(true);
    const controller = new AbortController();
    genAbortRef.current = controller;
    try {
      const result = await adminApi.generateSoulFromAgent({
        agent_number: genAgentNumber,
        name: displayName || name,
        description,
      });
      setSoulMd(result.soul_md);
      showToast(t.templateGenerateSoulSuccess);
      setShowGenDialog(false);
    } catch (err) {
      showToast(
        `${t.templateGenerateSoulFailed}: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    } finally {
      setGenerating(false);
      genAbortRef.current = null;
    }
  }, [genAgentNumber, soulMd, displayName, name, description, t]);

  const handleCancelGen = useCallback(() => {
    genAbortRef.current?.abort();
    setGenerating(false);
  }, []);

  // ----- Derived: install list from config JSON -----

  function parseConfig(json: string): Record<string, unknown> {
    try {
      return JSON.parse(json || "{}");
    } catch {
      return {};
    }
  }

  function getInstallList(): string[] {
    const config = parseConfig(configJson);
    const skills = config?.skills as Record<string, unknown> | undefined;
    const install = skills?.install;
    if (!Array.isArray(install)) return [];
    return install.filter((s): s is string => typeof s === "string");
  }

  function addInstallSkill(identifier: string) {
    const config = parseConfig(configJson);
    if (!config.skills) config.skills = {};
    if (!Array.isArray((config.skills as Record<string, unknown>).install)) {
      (config.skills as Record<string, unknown>).install = [];
    }
    const install = (config.skills as Record<string, unknown>).install as string[];
    if (!install.includes(identifier)) {
      install.push(identifier);
      setConfigJson(JSON.stringify(config, null, 2));
    }
    setSkillSearch("");
    setSkillResults([]);
  }

  function removeInstallSkill(identifier: string) {
    const config = parseConfig(configJson);
    const skills = config?.skills as Record<string, unknown> | undefined;
    if (skills && Array.isArray(skills.install)) {
      skills.install = skills.install.filter((s: string) => s !== identifier);
      setConfigJson(JSON.stringify(config, null, 2));
    }
  }

  function handleSkillSearch(q: string) {
    setSkillSearch(q);
    if (skillSearchTimer.current) clearTimeout(skillSearchTimer.current);
    if (!q.trim()) {
      setSkillResults([]);
      return;
    }
    skillSearchTimer.current = setTimeout(async () => {
      setSkillSearching(true);
      try {
        const res = await adminFetch<{ results: Array<{ identifier: string; name: string; description?: string }> }>(
          `/hub/search?q=${encodeURIComponent(q)}&limit=10`
        );
        setSkillResults(res.results || []);
      } catch {
        setSkillResults([]);
      } finally {
        setSkillSearching(false);
      }
    }, 300);
  }

  // ----- Derived validation state -----

  const nameError = getNameError(name, nameTouched, existingNames, isEdit, t);
  const configError = getConfigError(configJson, configTouched, t);
  const hasErrors = !!nameError || !!configError;

  // ----- Title -----

  const title = isEdit
    ? t.templateEdit
    : isClone
      ? t.templateClone
      : t.templateCreate;

  // ----- Handlers -----

  function handleNameBlur() {
    setNameTouched(true);
  }

  function handleConfigBlur() {
    setConfigTouched(true);
  }

  async function handleSave() {
    // Force validation on submit
    setNameTouched(true);
    setConfigTouched(true);

    // Validate name
    if (!isEdit) {
      const nameErr = getNameError(name, true, existingNames, false, t);
      if (nameErr) {
        setError(nameErr);
        return;
      }
    }

    // Validate JSON
    let parsedConfig: Record<string, unknown>;
    try {
      parsedConfig = JSON.parse(configJson || "{}");
    } catch {
      setError(t.templateJsonInvalid);
      return;
    }

    // Confirm when editing a template with linked profiles
    if (isEdit && template && (template.profile_count ?? 0) > 0) {
      const confirmed = window.confirm(
        t.templateConfirmEdit.replace("{count}", String(template.profile_count))
      );
      if (!confirmed) return;
    }

    setSaving(true);
    setError(null);

    try {
      if (isClone && template) {
        await adminApi.cloneProfileTemplate(template.id, {
          name: name.trim(),
          display_name: displayName.trim() || undefined,
        });
        showToast(t.templateCreateSuccess);
      } else if (isEdit && template) {
        const result = await adminApi.updateProfileTemplate(template.id, {
          display_name: displayName.trim() || undefined,
          description: description.trim() || undefined,
          config_overrides: isBuiltin ? undefined : parsedConfig,
          soul_md: isBuiltin ? undefined : (soulMd || undefined),
        });
        const affected = result.affected_profiles ?? 0;
        showToast(
          t.templateAffectedProfiles.replace("{count}", String(affected))
        );
      } else {
        // Create mode
        await adminApi.createProfileTemplate({
          name: name.trim(),
          display_name: displayName.trim() || undefined,
          description: description.trim() || undefined,
          config_overrides: parsedConfig,
          soul_md: soulMd || undefined,
        });
        showToast(t.templateCreateSuccess);
      }

      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(t.errorSaveFailed));
    } finally {
      setSaving(false);
    }
  }

  // ----- Render -----

  return (
    <>
    <ModalOverlay onClose={onClose} className="w-full max-w-2xl max-h-[85vh]">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <h3 id="template-editor-title" className="text-lg font-medium text-text-primary">
          {title}
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
        {/* Name */}
        <div>
          <label className="text-xs text-text-secondary block mb-1">
            {t.templateName} {!isEdit && <span className="text-accent-pink">*</span>}
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={handleNameBlur}
            readOnly={isEdit}
            placeholder={t.templateNamePlaceholder}
            className={`w-full bg-background border rounded-md px-3 py-2 text-sm font-[family-name:var(--font-mono)] text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-accent-cyan ${
              isEdit ? "opacity-60 cursor-not-allowed border-border" : "border-border"
            }`}
          />
          {nameError && (
            <p className="mt-1 text-xs text-accent-pink">{nameError}</p>
          )}
        </div>

        {/* Display name */}
        <div>
          <label className="text-xs text-text-secondary block mb-1">
            {t.templateDisplayName}
          </label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t.templateDisplayNamePlaceholder}
            autoFocus
            className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-accent-cyan"
          />
        </div>

        {/* Description */}
        <div>
          <label className="text-xs text-text-secondary block mb-1">
            {t.templateDescription}
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t.templateDescriptionPlaceholder}
            rows={2}
            className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-text-primary resize-y placeholder:text-text-secondary focus:outline-none focus:border-accent-cyan"
          />
        </div>

        {/* Config overrides */}
        <JsonEditor
          value={configJson}
          onChange={setConfigJson}
          error={configError}
          label={t.profileTemplateConfig}
          rows={8}
          disabled={isEdit && isBuiltin}
        />

        {/* Skills to Install */}
        <div className="border border-border rounded-lg p-3 space-y-2">
          <div>
            <span className="text-xs font-medium text-text-primary">
              {t.templateSkillsInstall}
            </span>
            <p className="text-[10px] text-text-secondary mt-0.5">
              {t.templateSkillsInstallDesc}
            </p>
          </div>

          {/* Installed list */}
          {(() => {
            const installList = getInstallList();
            return installList.length > 0 ? (
            <ul className="space-y-1">
              {installList.map((id) => (
                <li
                  key={id}
                  className="flex items-center gap-2 text-xs bg-background rounded px-2 py-1.5 border border-border"
                >
                  <span className="font-[family-name:var(--font-mono)] text-text-primary truncate flex-1">
                    {id}
                  </span>
                  {!(isEdit && isBuiltin) && (
                    <button
                      type="button"
                      onClick={() => removeInstallSkill(id)}
                      className="text-text-secondary hover:text-accent-pink transition-colors shrink-0"
                      aria-label={`${t.templateSkillsInstallRemove} ${id}`}
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[10px] text-text-secondary italic">
              {t.templateSkillsInstallEmpty}
            </p>
          );
          })()}

          {/* Search + add (not for builtin) */}
          {!(isEdit && isBuiltin) && (
            <div className="relative" ref={skillSearchRef}>
              <input
                type="text"
                value={skillSearch}
                onChange={(e) => handleSkillSearch(e.target.value)}
                placeholder={t.templateSkillsInstallSearch}
                className="w-full bg-background border border-border rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-accent-cyan"
              />
              {skillSearching && (
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-text-secondary">
                  ...
                </span>
              )}

              {/* Search results dropdown */}
              {skillResults.length > 0 && (
                <ul className="absolute z-20 left-0 right-0 mt-1 max-h-40 overflow-y-auto bg-background border border-border rounded-md shadow-lg">
                  {skillResults.map((r) => (
                    <li key={r.identifier}>
                      <button
                        type="button"
                        onClick={() => addInstallSkill(r.identifier)}
                        className="w-full text-left px-3 py-2 text-xs hover:bg-accent-cyan/10 transition-colors"
                      >
                        <span className="font-[family-name:var(--font-mono)] text-text-primary">
                          {r.identifier}
                        </span>
                        {r.description && (
                          <span className="block text-[10px] text-text-secondary mt-0.5 truncate">
                            {r.description}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* SOUL.md */}
        <SoulMdEditor
          value={soulMd}
          onChange={setSoulMd}
          label={t.profileTemplateSoul}
          previewLabel="Preview"
          editLabel={t.edit}
          rows={6}
          disabled={isEdit && isBuiltin}
          placeholder={t.templateSoulPlaceholder}
          actions={!(isEdit && isBuiltin) ? (
            <button
              type="button"
              onClick={handleOpenGenDialog}
              className="text-[10px] text-accent-cyan hover:text-accent-cyan/80 transition-colors"
            >
              {t.templateGenerateSoul}
            </button>
          ) : undefined}
        />

        {/* Builtin notice */}
        {isEdit && isBuiltin && (
          <p className="text-[10px] text-text-secondary border border-border/50 rounded p-2">
            {t.templateBuiltinReadonly}
          </p>
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
          className="px-4 py-2 text-sm rounded-md text-text-secondary hover:text-text-primary border border-border transition-colors"
        >
          {t.cancel}
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || hasErrors}
          className="px-4 py-2 text-sm rounded-md bg-accent-pink text-white hover:bg-accent-pink/90 disabled:opacity-50 transition-colors"
        >
          {saving ? t.loading : t.save}
        </button>
      </div>
    </ModalOverlay>

    {/* AI Soul Generation Dialog */}
    {showGenDialog && (
      <ModalOverlay onClose={() => { handleCancelGen(); setShowGenDialog(false); }} className="w-full max-w-md">
        <div className="px-6 py-4 border-b border-border">
          <h3 className="text-base font-medium text-text-primary">
            {t.templateGenerateSoulDialogTitle}
          </h3>
        </div>
        <div className="px-6 py-4 space-y-3">
          {/* Agent selection */}
          <div>
            <label className="text-xs text-text-secondary block mb-1">
              {t.templateGenerateSoulSelectAgent}
            </label>
            {genLoading ? (
              <p className="text-xs text-text-secondary">{t.loading}</p>
            ) : genAgents.length === 0 ? (
              <p className="text-xs text-amber-500">{t.templateGenerateSoulNoAgents}</p>
            ) : (
              <select
                value={genAgentNumber ?? ""}
                onChange={(e) => setGenAgentNumber(Number(e.target.value) || null)}
                className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent-cyan"
              >
                <option value="">{t.templateGenerateSoulSelectAgent}</option>
                {genAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    Agent {a.id}{a.display_name ? ` — ${a.display_name}` : ""}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Overwrite warning */}
          {soulMd.trim() && (
            <p className="text-[10px] text-amber-500">
              {t.templateGenerateSoulOverwriteWarning}
            </p>
          )}
        </div>
        <div className="flex gap-2 justify-end px-6 py-4 border-t border-border">
          <button
            type="button"
            onClick={() => { handleCancelGen(); setShowGenDialog(false); }}
            className="px-4 py-2 text-sm rounded-md text-text-secondary hover:text-text-primary border border-border transition-colors"
          >
            {t.templateGenerateSoulCancel}
          </button>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating || !genAgentNumber}
            className="px-4 py-2 text-sm rounded-md bg-accent-cyan text-white hover:bg-accent-cyan/90 disabled:opacity-50 transition-colors"
          >
            {generating ? t.templateGenerateSoulGenerating : t.templateGenerateSoulGenerate}
          </button>
        </div>
      </ModalOverlay>
    )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function getNameError(
  name: string,
  touched: boolean,
  existingNames: string[],
  isEdit: boolean,
  t: import("../../i18n/zh").Translations
): string | null {
  if (!touched || isEdit) return null;
  if (!name.trim()) return t.templateNameRequired;
  if (!NAME_REGEX.test(name.trim())) return t.templateNameInvalid;
  if (existingNames.includes(name.trim())) return t.templateNameExists;
  return null;
}

function getConfigError(
  json: string,
  touched: boolean,
  t: import("../../i18n/zh").Translations
): string | null {
  if (!touched) return null;
  try {
    JSON.parse(json || "{}");
    return null;
  } catch {
    return t.templateJsonInvalid;
  }
}
