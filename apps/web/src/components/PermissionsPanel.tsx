import type { GlobalPermissionGrant, PreferencesPatch, RiskCategory, UserPreferences } from "@scc/shared";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  FileSearch,
  Globe2,
  LockKeyhole,
  PencilLine,
  RotateCcw,
  ShieldAlert,
  MessageCircle,
  SlidersHorizontal,
  TerminalSquare,
  X
} from "lucide-react";
import { getUiCopy } from "../i18n.js";
import { AccordionSelect } from "./AccordionSelect.js";
import type { PermissionPreset } from "./Composer.js";

const riskCategories: RiskCategory[] = ["host_observation", "workspace_read", "workspace_write", "shell", "network", "destructive"];
const readOnlyRiskCategories: RiskCategory[] = ["host_observation", "workspace_read"];
type PermissionSettingsMode = PermissionPreset | "custom";

export function PermissionsPanel({
  language,
  permissions,
  preferences,
  preferencesOnly = false,
  startCustom = false,
  onStartCustomConsumed,
  onGrant,
  onRevoke,
  onPermissionPresetChange,
  onPreference
}: {
  language?: string | null;
  permissions: GlobalPermissionGrant[];
  preferences: UserPreferences | null;
  preferencesOnly?: boolean;
  startCustom?: boolean;
  onStartCustomConsumed?: () => void;
  onGrant: (riskCategory: RiskCategory) => void;
  onRevoke: (riskCategory: RiskCategory) => void;
  onPermissionPresetChange?: (preset: PermissionPreset) => void;
  onPreference: (patch: PreferencesPatch) => void;
}) {
  const text = getUiCopy(language).permissions;
  const safePermissions = Array.isArray(permissions) ? permissions : [];
  const grants = new Map(safePermissions.map((permission) => [permission.riskCategory, permission]));
  const permissionMode = getPermissionMode(grants);
  const [customEditing, setCustomEditing] = useState(false);
  const [pendingMode, setPendingMode] = useState<PermissionSettingsMode | null>(null);
  const displayedMode: PermissionSettingsMode = pendingMode ?? (customEditing ? "custom" : permissionMode);

  useEffect(() => {
    if (pendingMode && pendingMode === permissionMode) {
      setPendingMode(null);
    }
  }, [permissionMode, pendingMode]);

  useEffect(() => {
    if (startCustom) {
      setCustomEditing(true);
      onStartCustomConsumed?.();
    }
  }, [startCustom, onStartCustomConsumed]);

  return (
    <section className="permissionsPanel">
      <div className="panelHero">
        <div>
          <h2>{preferencesOnly ? text.preferencesTitle : text.title}</h2>
          <p>{preferencesOnly ? text.preferencesSubtitle : text.subtitle}</p>
        </div>
      </div>

      {!preferencesOnly ? (
        <>
          <section className="permissionModePanel">
            <div className="permissionModeCopy">
              <span className={displayedMode === "all" ? "permissionModeIcon danger" : "permissionModeIcon"}>
                {getModeIcon(displayedMode, 19)}
              </span>
              <div>
                <h3>{text.modeTitle}</h3>
                <p>{displayedMode === "custom" ? text.modeCustomDescription : text.modeSubtitle}</p>
              </div>
            </div>
            <PermissionModeSwitch
              mode={displayedMode}
              labels={text.permissionModes}
              onSelect={(mode) => {
                setPendingMode(null);
                if (mode === "custom") {
                  setCustomEditing(true);
                } else {
                  applyPreset(mode);
                }
              }}
            />
            <button className="resetPermissionButton" type="button" onClick={() => applyPreset("ask")} disabled={safePermissions.length === 0}>
              <RotateCcw size={14} aria-hidden="true" />
              {text.resetAsk}
            </button>
          </section>

          <section className="permissionCoveragePanel">
            <div className="panelHeader">
              <div>
                <h3>{text.coverageTitle}</h3>
                <p>{text.coverageSubtitle}</p>
              </div>
            </div>
            <div className="permissionRows">
              {riskCategories.map((risk) => {
                const grant = grants.get(risk);
                const isDestructive = risk === "destructive";
                const riskCopy = text.risks[risk];
                const Icon = getRiskIcon(risk);
                return (
                  <article className={grant ? "permissionRow granted" : displayedMode === "custom" ? "permissionRow editable" : "permissionRow"} key={risk}>
                    <span className={isDestructive ? "permissionRowIcon danger" : "permissionRowIcon"}>
                      <Icon size={17} aria-hidden="true" />
                    </span>
                    <div className="permissionRowMain">
                      <div className="permissionRowTitle">
                        <h4>{riskCopy[0]}</h4>
                        <span className={grant ? "permissionStatus granted" : "permissionStatus"}>
                          {grant ? text.autoAllowed : text.approvalRequired}
                        </span>
                      </div>
                      <p>{riskCopy[1]}</p>
                      <small>
                        {grant ? (
                          <>
                            <CheckCircle2 size={12} aria-hidden="true" />
                            {text.grantedAt}: {formatDate(grant.grantedAt)}
                          </>
                        ) : (
                          <>
                            <LockKeyhole size={12} aria-hidden="true" />
                            {isDestructive ? text.destructiveNote : text.riskNote}
                          </>
                        )}
                      </small>
                    </div>
                    {displayedMode === "custom" ? (
                      <button
                        aria-label={grant ? text.disableRisk(riskCopy[0]) : text.enableRisk(riskCopy[0])}
                        aria-pressed={Boolean(grant)}
                        className="switchControl permissionSwitch"
                        onClick={() => (grant ? onRevoke(risk) : onGrant(risk))}
                        title={grant ? text.disableRisk(riskCopy[0]) : text.enableRisk(riskCopy[0])}
                        type="button"
                      >
                        <span aria-hidden="true" />
                      </button>
                    ) : (
                      <button
                        aria-label={text.revokeRisk(riskCopy[0])}
                        className="iconButton permissionRevokeButton"
                        disabled={!grant}
                        onClick={() => onRevoke(risk)}
                        title={grant ? text.revokeRisk(riskCopy[0]) : text.approvalRequired}
                        type="button"
                      >
                        <X size={15} aria-hidden="true" />
                      </button>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        </>
      ) : null}

      {preferencesOnly ? (
        <>
          <div className="prefSection">
            <div className="prefSectionHeader">
              <span className="prefSectionIcon">
                <SlidersHorizontal size={16} aria-hidden="true" />
              </span>
              <div>
                <h3>{text.personalizeTitle}</h3>
                <p>{text.personalizeSubtitle}</p>
              </div>
            </div>
            <div className="settingRows cols2">
              <PreferenceSelect
                label={text.language}
                value={preferences?.language ?? "zh-CN"}
                onChange={(value) => emitPreference({ language: value })}
                options={[
                  ["zh-CN", "中文"],
                  ["en-US", "English"]
                ]}
              />
              <PreferenceSelect
                label={text.theme}
                value={preferences?.theme ?? "dark"}
                onChange={(value) => emitPreference({ theme: value as UserPreferences["theme"] })}
                options={[
                  ["dark", text.themeOptions.dark],
                  ["light", text.themeOptions.light],
                  ["system", text.themeOptions.system]
                ]}
              />
              <PreferenceSelect
                label={text.agentTone}
                value={preferences?.agentTone ?? "balanced"}
                onChange={(value) => emitPreference({ agentTone: value as UserPreferences["agentTone"] })}
                options={[
                  ["concise", text.agentToneOptions.concise],
                  ["balanced", text.agentToneOptions.balanced],
                  ["warm", text.agentToneOptions.warm],
                  ["formal", text.agentToneOptions.formal]
                ]}
              />
              <PreferenceSelect
                label={text.responseDetail}
                value={preferences?.responseDetail ?? "normal"}
                onChange={(value) => emitPreference({ responseDetail: value as UserPreferences["responseDetail"] })}
                options={[
                  ["brief", text.responseDetailOptions.brief],
                  ["normal", text.responseDetailOptions.normal],
                  ["detailed", text.responseDetailOptions.detailed]
                ]}
              />
              <PreferenceInput
                label={text.agentRole}
                value={preferences?.agentRole ?? ""}
                onChange={(value) => emitPreference({ agentRole: value })}
              />
              <PreferenceInput
                label={text.maxInjectedSkills}
                type="number"
                value={String(preferences?.maxInjectedSkills ?? 3)}
                onChange={(value) => emitPreference({ maxInjectedSkills: Math.max(1, Number(value) || 1) })}
              />
              <div className="prefTogglesCell">
                <PreferenceToggle label={text.showThinking} value={preferences?.showThinking ?? true} onChange={(value) => emitPreference({ showThinking: value })} />
                <PreferenceToggle label={text.skillAutoInject} value={preferences?.skillAutoInject ?? true} onChange={(value) => emitPreference({ skillAutoInject: value })} />
              </div>
            </div>
          </div>

          <div className="prefSection">
            <div className="prefSectionHeader">
              <span className="prefSectionIcon warning">
                <ShieldAlert size={16} aria-hidden="true" />
              </span>
              <div>
                <h3>{text.behaviorTitle}</h3>
                <p>{text.modeSubtitle}</p>
              </div>
            </div>
            <div className="prefBehaviorList">
              <PreferenceSelect
                label={text.autoApprove}
                value={preferences?.autoApprove ?? "none"}
                onChange={(value) => emitPreference({ autoApprove: value as UserPreferences["autoApprove"] })}
                options={[
                  ["none", text.autoApproveOptions.none],
                  ["low", text.autoApproveOptions.low],
                  ["medium", text.autoApproveOptions.medium],
                  ["all", text.autoApproveOptions.all]
                ]}
              />
              <PreferenceSelect
                label={text.mcpApprovalMode}
                value={preferences?.mcpApprovalMode ?? "confirm_dangerous"}
                onChange={(value) => emitPreference({ mcpApprovalMode: value as UserPreferences["mcpApprovalMode"] })}
                options={[
                  ["confirm_each", text.mcpApprovalOptions.confirm_each],
                  ["confirm_dangerous", text.mcpApprovalOptions.confirm_dangerous],
                  ["auto", text.mcpApprovalOptions.auto]
                ]}
              />
              <PreferenceToggle label={text.sanitizeSensitiveData} value={preferences?.sanitizeSensitiveData ?? true} onChange={(value) => emitPreference({ sanitizeSensitiveData: value })} />
              <PreferenceToggle label={text.encryptStorage} value={preferences?.encryptStorage ?? false} onChange={(value) => emitPreference({ encryptStorage: value })} />
            </div>
          </div>
        </>
      ) : null}
    </section>
  );

  function emitPreference(patch: PreferencesPatch) {
    onPreference(patch);
  }

  function applyPreset(preset: PermissionPreset) {
    setCustomEditing(false);
    setPendingMode(preset);
    if (onPermissionPresetChange) {
      onPermissionPresetChange(preset);
      return;
    }
    const target = new Set<RiskCategory>(preset === "all" ? riskCategories : preset === "read_only" ? readOnlyRiskCategories : []);
    for (const risk of riskCategories) {
      const granted = grants.has(risk);
      if (target.has(risk) && !granted) onGrant(risk);
      if (!target.has(risk) && granted) onRevoke(risk);
    }
  }
}

function PermissionModeSwitch({
  mode,
  labels,
  onSelect
}: {
  mode: PermissionSettingsMode;
  labels: Record<PermissionSettingsMode, { label: string; description: string }>;
  onSelect: (preset: PermissionSettingsMode) => void;
}) {
  const options: PermissionSettingsMode[] = ["ask", "read_only", "custom", "all"];
  const selectedIndex = options.indexOf(mode);
  const switchRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = switchRef.current;
    if (!el) return;
    const index = selectedIndex >= 0 ? selectedIndex : 0;
    el.style.setProperty("--permission-mode-index", String(index));
  }, [selectedIndex]);

  return (
    <div ref={switchRef} className="permissionModeSwitch" role="radiogroup">
      <span className="permissionModeThumb" aria-hidden="true" />
      {options.map((option) => (
        <button aria-checked={mode === option} key={option} onClick={() => onSelect(option)} role="radio" type="button">
          <span className="modeOptionIcon" aria-hidden="true">{getModeIcon(option)}</span>
          <span>{labels[option].label}</span>
          <small>{labels[option].description}</small>
        </button>
      ))}
    </div>
  );
}

function getModeIcon(mode: PermissionSettingsMode, size = 14) {
  switch (mode) {
    case "ask":
      return <MessageCircle size={size} aria-hidden="true" />;
    case "read_only":
      return <Eye size={size} aria-hidden="true" />;
    case "custom":
      return <SlidersHorizontal size={size} aria-hidden="true" />;
    case "all":
      return <ShieldAlert size={size} aria-hidden="true" />;
  }
}

function PreferenceInput({
  label,
  type = "text",
  value,
  min,
  max,
  disabled,
  help,
  onChange
}: {
  label: string;
  type?: "text" | "number";
  value: string;
  min?: number;
  max?: number;
  disabled?: boolean;
  help?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="preferenceField">
      <span>{label}</span>
      <input type={type} value={value} min={min} max={max} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
      {help ? <small>{help}</small> : null}
    </label>
  );
}

function PreferenceSelect({
  label,
  value,
  disabled,
  options,
  onChange
}: {
  label: string;
  value: string;
  disabled?: boolean;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="preferenceField">
      <span>{label}</span>
      <AccordionSelect
        ariaLabel={label}
        disabled={disabled}
        value={value}
        options={options.map(([optionValue, optionLabel]) => ({ value: optionValue, label: optionLabel }))}
        onChange={onChange}
      />
    </div>
  );
}

function PreferenceToggle({
  label,
  value,
  onChange
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className={value ? "toggleField enabled" : "toggleField"}>
      <span>{label}</span>
      <button className="switchControl" type="button" onClick={() => onChange(!value)} aria-label={label} aria-pressed={value}>
        <span aria-hidden="true" />
      </button>
    </label>
  );
}

function getPermissionMode(grants: Map<RiskCategory, GlobalPermissionGrant>): PermissionPreset | "custom" {
  if (riskCategories.every((risk) => grants.has(risk))) return "all";
  if (riskCategories.every((risk) => readOnlyRiskCategories.includes(risk) === grants.has(risk))) return "read_only";
  if (riskCategories.every((risk) => !grants.has(risk))) return "ask";
  return "custom";
}

function getRiskIcon(risk: RiskCategory) {
  switch (risk) {
    case "host_observation":
      return Eye;
    case "workspace_read":
      return FileSearch;
    case "workspace_write":
      return PencilLine;
    case "shell":
      return TerminalSquare;
    case "network":
      return Globe2;
    case "destructive":
      return AlertTriangle;
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
