import type { GlobalPermissionGrant, PreferencesPatch, RiskCategory, UserPreferences } from "@scc/shared";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  FileSearch,
  Globe2,
  LockKeyhole,
  MessageCircle,
  PencilLine,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  TerminalSquare
} from "lucide-react";
import { getUiCopy } from "../i18n.js";
import { AccordionSelect } from "./AccordionSelect.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

const riskCategories: RiskCategory[] = ["host_observation", "workspace_read", "workspace_write", "shell", "network", "destructive"];
const readOnlyRiskCategories: RiskCategory[] = ["host_observation", "workspace_read"];
const nonDestructiveRiskCategories: UserPreferences["autoApproveRiskCategories"] = ["host_observation", "workspace_read", "workspace_write", "shell", "network"];
const defaultAutoApprovalRiskCategories: UserPreferences["autoApproveRiskCategories"] = ["host_observation", "workspace_read", "network"];
const modeOrder: UserPreferences["permissionMode"][] = ["ask", "read_only", "full_access", "custom", "auto_approval"];
type PermissionMode = UserPreferences["permissionMode"];

export function PermissionsPanel({
  language,
  permissions,
  preferences,
  preferencesOnly = false,
  startCustom = false,
  optimisticMode = null,
  optimisticRisks = null,
  onStartCustomConsumed,
  onPermissionModeChange,
  onPreference
}: {
  language?: string | null;
  permissions: GlobalPermissionGrant[];
  preferences: UserPreferences | null;
  preferencesOnly?: boolean;
  startCustom?: boolean;
  optimisticMode?: PermissionMode | null;
  optimisticRisks?: RiskCategory[] | null;
  onStartCustomConsumed?: () => void;
  onPermissionModeChange?: (mode: PermissionMode, selectedRisks: RiskCategory[]) => void;
  onPreference: (patch: PreferencesPatch) => void;
}) {
  const text = getUiCopy(language).permissions;
  const safePermissions = Array.isArray(permissions) ? permissions : [];
  const grants = new Set(safePermissions.map((permission) => permission.riskCategory));
  const savedRuleCategories = ruleCategoriesFromPreferences(preferences);
  const savedMode = derivePermissionMode(preferences, grants);
  const [pendingMode, setPendingMode] = useState<PermissionMode | null>(null);
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);
  const displayedMode = optimisticMode ?? pendingMode ?? savedMode;
  const selectedRisks = optimisticMode && optimisticRisks ? optimisticRisks : risksForMode(displayedMode, grants, savedRuleCategories);
  const selectedSet = new Set<RiskCategory>(selectedRisks);

  useEffect(() => {
    if (pendingMode && pendingMode === savedMode) setPendingMode(null);
  }, [pendingMode, savedMode]);

  useEffect(() => {
    if (!startCustom) return;
    const customRisks = riskCategories.filter((risk) => grants.has(risk));
    applyMode("custom", customRisks);
    onStartCustomConsumed?.();
  }, [startCustom]);

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
              <span className={displayedMode === "full_access" ? "permissionModeIcon danger" : "permissionModeIcon"}>
                {getModeIcon(displayedMode, 19)}
              </span>
              <div>
                <h3>{text.modeTitle}</h3>
                <p>{modeDescription(text, displayedMode)}</p>
              </div>
            </div>
            <PermissionModeSwitch
              mode={displayedMode}
              labels={text.permissionModes}
              onSelect={(mode) => {
                if (mode === "full_access") {
                  setConfirmFullAccess(true);
                  return;
                }
                applyMode(mode, risksForMode(mode, grants, savedRuleCategories));
              }}
            />
          </section>

          <section className="permissionCoveragePanel">
            <div className="panelHeader">
              <div>
                <h3>{text.coverageTitle}</h3>
                <p>{coverageDescription(text, displayedMode)}</p>
              </div>
            </div>
            <div className="permissionRows">
              {riskCategories.map((risk) => {
                const riskCopy = text.risks[risk];
                const Icon = getRiskIcon(risk);
                const selected = selectedSet.has(risk);
                const editable = displayedMode === "custom" || (displayedMode === "auto_approval" && isRuleRiskCategory(risk));
                const isDestructive = risk === "destructive";
                const status = permissionStatus(text, displayedMode, selected, isDestructive);
                return (
                  <article className={selected ? "permissionRow granted" : editable ? "permissionRow editable" : "permissionRow"} key={risk}>
                    <span className={isDestructive ? "permissionRowIcon danger" : "permissionRowIcon"}>
                      <Icon size={17} aria-hidden="true" />
                    </span>
                    <div className="permissionRowMain">
                      <div className="permissionRowTitle">
                        <h4>{riskCopy[0]}</h4>
                        <span className={selected ? "permissionStatus granted" : "permissionStatus"}>
                          {status}
                        </span>
                      </div>
                      <p>{riskCopy[1]}</p>
                      <small>
                        {selected ? <CheckCircle2 size={12} aria-hidden="true" /> : <LockKeyhole size={12} aria-hidden="true" />}
                        {permissionNote(text, displayedMode, selected, isDestructive)}
                      </small>
                    </div>
                    {editable ? (
                      <button
                        aria-label={selected ? text.disableRisk(riskCopy[0]) : text.enableRisk(riskCopy[0])}
                        aria-pressed={selected}
                        className="switchControl permissionSwitch"
                        onClick={() => toggleRisk(risk)}
                        title={selected ? text.disableRisk(riskCopy[0]) : text.enableRisk(riskCopy[0])}
                        type="button"
                      >
                        <span aria-hidden="true" />
                      </button>
                    ) : (
                      <span className="permissionModeLock" title={permissionNote(text, displayedMode, selected, isDestructive)}>
                        {isDestructive ? <ShieldAlert size={15} aria-hidden="true" /> : <LockKeyhole size={14} aria-hidden="true" />}
                      </span>
                    )}
                  </article>
                );
              })}
            </div>
            <div className="permissionInlinePolicies">
              <PreferenceSelect
                label={text.mcpApprovalMode}
                value={preferences?.mcpApprovalMode ?? "confirm_dangerous"}
                help={text.mcpApprovalHelp}
                onChange={(value) => emitPreference({ mcpApprovalMode: value as UserPreferences["mcpApprovalMode"] })}
                options={[
                  ["confirm_each", text.mcpApprovalOptions.confirm_each],
                  ["confirm_dangerous", text.mcpApprovalOptions.confirm_dangerous],
                  ["auto", text.mcpApprovalOptions.auto]
                ]}
              />
              {displayedMode === "auto_approval" ? (
                <PreferenceSelect
                  label={text.llmApprovalMode}
                  value={preferences?.llmApprovalMode ?? "off"}
                  help={text.llmApprovalHelp}
                  onChange={(value) => emitPreference({ llmApprovalMode: value as UserPreferences["llmApprovalMode"] })}
                  options={[
                    ["off", text.llmApprovalOptions.off],
                    ["non_destructive", text.llmApprovalOptions.non_destructive]
                  ]}
                />
              ) : (
                <div className="permissionPolicyNote">
                  <span>{text.llmApprovalMode}</span>
                  <small>{text.llmApprovalAutoOnly}</small>
                </div>
              )}
            </div>
          </section>

          <ConfirmDialog
            cancelLabel={text.fullAccessCancel}
            confirmLabel={text.fullAccessConfirm}
            open={confirmFullAccess}
            title={text.fullAccessTitle}
            tone="danger"
            onCancel={() => setConfirmFullAccess(false)}
            onConfirm={() => {
              setConfirmFullAccess(false);
              applyMode("full_access", riskCategories);
            }}
          >
            <p>{text.fullAccessBody}</p>
          </ConfirmDialog>
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
              <PreferenceSelect
                label={text.startupView}
                value={preferences?.startupView ?? "last_task"}
                onChange={(value) => emitPreference({ startupView: value as UserPreferences["startupView"] })}
                options={[
                  ["last_task", text.startupViewOptions.last_task],
                  ["last_folder", text.startupViewOptions.last_folder],
                  ["new_task", text.startupViewOptions.new_task]
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
                <p>{text.preferencesBehaviorSubtitle}</p>
              </div>
            </div>
            <div className="prefBehaviorList">
              <PreferenceToggle label={text.sanitizeSensitiveData} value={preferences?.sanitizeSensitiveData ?? true} onChange={(value) => emitPreference({ sanitizeSensitiveData: value })} />
              <PreferenceToggle label={text.encryptStorage} value={preferences?.encryptStorage ?? false} onChange={(value) => emitPreference({ encryptStorage: value })} />
            </div>
          </div>
        </>
      ) : null}
    </section>
  );

  function applyMode(mode: PermissionMode, risks: RiskCategory[]) {
    setPendingMode(mode);
    onPermissionModeChange?.(mode, risks);
  }

  function emitPreference(patch: PreferencesPatch) {
    onPreference(patch);
  }

  function toggleRisk(risk: RiskCategory) {
    const next = new Set(selectedRisks);
    if (next.has(risk)) next.delete(risk);
    else next.add(risk);
    const mode = displayedMode === "auto_approval" ? "auto_approval" : "custom";
    applyMode(mode, riskCategories.filter((category) => next.has(category)));
  }
}

function PermissionModeSwitch({
  mode,
  labels,
  onSelect
}: {
  mode: PermissionMode;
  labels: Record<PermissionMode, { label: string; description: string }>;
  onSelect: (preset: PermissionMode) => void;
}) {
  const selectedIndex = modeOrder.indexOf(mode);
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
      {modeOrder.map((option) => (
        <button aria-checked={mode === option} key={option} onClick={() => onSelect(option)} role="radio" type="button">
          <span className="modeOptionIcon" aria-hidden="true">{getModeIcon(option)}</span>
          <span>{labels[option].label}</span>
          <small>{labels[option].description}</small>
        </button>
      ))}
    </div>
  );
}

function getModeIcon(mode: PermissionMode, size = 14) {
  switch (mode) {
    case "ask":
      return <MessageCircle size={size} aria-hidden="true" />;
    case "read_only":
      return <Eye size={size} aria-hidden="true" />;
    case "full_access":
      return <ShieldAlert size={size} aria-hidden="true" />;
    case "custom":
      return <SlidersHorizontal size={size} aria-hidden="true" />;
    case "auto_approval":
      return <Sparkles size={size} aria-hidden="true" />;
  }
}

function derivePermissionMode(preferences: UserPreferences | null, grants: Set<RiskCategory>): PermissionMode {
  if (preferences?.permissionMode === "auto_approval") return "auto_approval";
  if (riskCategories.every((risk) => grants.has(risk))) return "full_access";
  if (readOnlyRiskCategories.every((risk) => grants.has(risk)) && riskCategories.every((risk) => readOnlyRiskCategories.includes(risk) || !grants.has(risk))) {
    return "read_only";
  }
  if (riskCategories.every((risk) => !grants.has(risk))) return preferences?.permissionMode === "custom" ? "custom" : "ask";
  return "custom";
}

function risksForMode(mode: PermissionMode, grants: Set<RiskCategory>, ruleCategories: UserPreferences["autoApproveRiskCategories"]): RiskCategory[] {
  if (mode === "ask") return [];
  if (mode === "read_only") return readOnlyRiskCategories;
  if (mode === "full_access") return riskCategories;
  if (mode === "auto_approval") return ruleCategories.length > 0 ? ruleCategories : defaultAutoApprovalRiskCategories;
  return riskCategories.filter((risk) => grants.has(risk));
}

function ruleCategoriesFromPreferences(preferences: UserPreferences | null): UserPreferences["autoApproveRiskCategories"] {
  const categories = Array.isArray(preferences?.autoApproveRiskCategories) ? preferences.autoApproveRiskCategories : [];
  const selected = categories.filter(isRuleRiskCategory);
  if (preferences?.permissionMode === "auto_approval") {
    return selected.length > 0 ? selected : defaultAutoApprovalRiskCategories;
  }
  if (preferences?.autoApprove === "low") return ["host_observation", "workspace_read"];
  if (preferences?.autoApprove === "medium") return defaultAutoApprovalRiskCategories;
  if (preferences?.autoApprove === "all") return nonDestructiveRiskCategories;
  return selected;
}

function isRuleRiskCategory(risk: RiskCategory): risk is UserPreferences["autoApproveRiskCategories"][number] {
  return risk !== "destructive";
}

function modeDescription(text: ReturnType<typeof getUiCopy>["permissions"], mode: PermissionMode): string {
  if (mode === "custom") return text.modeCustomDescription;
  if (mode === "auto_approval") return text.modeAutoApprovalDescription;
  if (mode === "full_access") return text.modeFullAccessDescription;
  return text.modeSubtitle;
}

function coverageDescription(text: ReturnType<typeof getUiCopy>["permissions"], mode: PermissionMode): string {
  if (mode === "custom") return text.coverageCustomSubtitle;
  if (mode === "auto_approval") return text.coverageAutoSubtitle;
  if (mode === "full_access") return text.coverageFullAccessSubtitle;
  return text.coverageSubtitle;
}

function permissionStatus(text: ReturnType<typeof getUiCopy>["permissions"], mode: PermissionMode, selected: boolean, destructive: boolean): string {
  if (mode === "auto_approval") return selected ? text.autoAllowed : text.approvalRequired;
  if (mode === "full_access") return text.granted;
  if (mode === "custom") return selected ? text.granted : text.notGranted;
  if (mode === "read_only" && selected) return text.autoAllowed;
  if (destructive) return text.approvalRequired;
  return selected ? text.autoAllowed : text.approvalRequired;
}

function permissionNote(text: ReturnType<typeof getUiCopy>["permissions"], mode: PermissionMode, selected: boolean, destructive: boolean): string {
  if (mode === "full_access") return destructive ? text.destructiveFullAccessNote : text.globalGrantNote;
  if (mode === "custom") return selected ? text.customGrantedNote : text.riskNote;
  if (mode === "auto_approval") return destructive ? text.destructiveAutoNote : selected ? text.ruleAutoAllowedNote : text.riskNote;
  if (mode === "read_only") return selected ? text.readOnlyNote : destructive ? text.destructiveNote : text.riskNote;
  return destructive ? text.destructiveNote : text.riskNote;
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
  help,
  options,
  onChange
}: {
  label: string;
  value: string;
  disabled?: boolean;
  help?: string;
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
      {help ? <small>{help}</small> : null}
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
