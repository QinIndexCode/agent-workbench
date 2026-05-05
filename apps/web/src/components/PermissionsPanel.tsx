import type { GlobalPermissionGrant, PreferencesPatch, RiskCategory, UserPreferences } from "@scc/shared";
import { AlertTriangle, CheckCircle2, LockKeyhole, ShieldCheck, ShieldQuestion } from "lucide-react";
import { getUiCopy } from "../i18n.js";

const riskCategories: RiskCategory[] = ["host_observation", "workspace_read", "workspace_write", "shell", "network", "destructive"];

export function PermissionsPanel({
  language,
  permissions,
  preferences,
  onGrant,
  onRevoke,
  onPreference
}: {
  language?: string | null;
  permissions: GlobalPermissionGrant[];
  preferences: UserPreferences | null;
  onGrant: (riskCategory: RiskCategory) => void;
  onRevoke: (riskCategory: RiskCategory) => void;
  onPreference: (patch: PreferencesPatch) => void;
}) {
  const text = getUiCopy(language).permissions;
  const safePermissions = Array.isArray(permissions) ? permissions : [];
  const grants = new Map(safePermissions.map((permission) => [permission.riskCategory, permission]));

  return (
    <section className="permissionsPanel">
      <div className="panelHero">
        <div>
          <h2>{text.title}</h2>
          <p>{text.subtitle}</p>
        </div>
      </div>

      <div className="permissionGrid">
        {riskCategories.map((risk) => {
          const grant = grants.get(risk);
          const isDestructive = risk === "destructive";
          const Icon = grant ? ShieldCheck : isDestructive ? AlertTriangle : ShieldQuestion;
          const riskCopy = text.risks[risk];
          return (
            <article className={grant ? "permissionCard granted" : isDestructive ? "permissionCard danger" : "permissionCard"} key={risk}>
              <div className="permissionCardHeader">
                <span className={isDestructive ? "permissionIcon danger" : "permissionIcon"}>
                  <Icon size={17} aria-hidden="true" />
                </span>
                <div>
                  <h3>{riskCopy[0]}</h3>
                  <small>{grant ? text.granted : text.notGranted}</small>
                </div>
              </div>
              <p>{riskCopy[1]}</p>
              <div className="permissionMeta">
                {grant ? (
                  <>
                    <span>
                      <CheckCircle2 size={13} aria-hidden="true" />
                      {text.grantedAt}: {formatDate(grant.grantedAt)}
                    </span>
                    <span>{text.reason}: {grant.reason || text.noReason}</span>
                  </>
                ) : (
                  <span>
                    <LockKeyhole size={13} aria-hidden="true" />
                    {isDestructive ? text.destructiveNote : text.riskNote}
                  </span>
                )}
              </div>
              <button
                className={grant ? "subtleButton" : isDestructive ? "dangerButton" : "primarySoftButton"}
                onClick={() => (grant ? onRevoke(risk) : onGrant(risk))}
                type="button"
              >
                {grant ? text.revoke : text.allow}
              </button>
            </article>
          );
        })}
      </div>

      <section className="preferencesMatrix">
        <div className="panelHeader">
          <h3>{text.preferencesTitle}</h3>
        </div>
        <div className="preferenceGrid">
          <PreferenceSelect
            label={text.language}
            value={preferences?.language ?? "zh-CN"}
            onChange={(value) => onPreference({ language: value })}
            options={[
              ["zh-CN", "中文"],
              ["en-US", "English"]
            ]}
          />
          <PreferenceInput
            label={text.defaultModel}
            value={preferences?.defaultModel ?? ""}
            onChange={(value) => onPreference({ defaultModel: value })}
          />
          <PreferenceInput
            label={text.maxTokens}
            type="number"
            value={String(preferences?.maxTokensPerRequest ?? 128000)}
            onChange={(value) => onPreference({ maxTokensPerRequest: Math.max(1, Number(value) || 1) })}
          />
          <PreferenceSelect
            label={text.autoApprove}
            value={preferences?.autoApprove ?? "none"}
            onChange={(value) => onPreference({ autoApprove: value as UserPreferences["autoApprove"] })}
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
            onChange={(value) => onPreference({ mcpApprovalMode: value as UserPreferences["mcpApprovalMode"] })}
            options={[
              ["confirm_each", text.mcpApprovalOptions.confirm_each],
              ["confirm_dangerous", text.mcpApprovalOptions.confirm_dangerous],
              ["auto", text.mcpApprovalOptions.auto]
            ]}
          />
          <PreferenceInput
            label={text.reflectionSchedule}
            value={preferences?.reflectionSchedule ?? "02:00"}
            onChange={(value) => onPreference({ reflectionSchedule: value })}
          />
          <PreferenceInput
            label={text.maxInjectedSkills}
            type="number"
            value={String(preferences?.maxInjectedSkills ?? 3)}
            onChange={(value) => onPreference({ maxInjectedSkills: Math.max(1, Number(value) || 1) })}
          />
        </div>
      </section>

      <section className="preferencesMatrix">
        <div className="panelHeader">
          <h3>{text.behaviorTitle}</h3>
        </div>
        <div className="toggleGrid">
          <PreferenceToggle label={text.showThinking} value={preferences?.showThinking ?? true} onChange={(value) => onPreference({ showThinking: value })} onText={text.on} offText={text.off} />
          <PreferenceToggle label={text.reflectionEnabled} value={preferences?.reflectionEnabled ?? true} onChange={(value) => onPreference({ reflectionEnabled: value })} onText={text.on} offText={text.off} />
          <PreferenceToggle label={text.skillAutoInject} value={preferences?.skillAutoInject ?? true} onChange={(value) => onPreference({ skillAutoInject: value })} onText={text.on} offText={text.off} />
          <PreferenceToggle label={text.sanitizeSensitiveData} value={preferences?.sanitizeSensitiveData ?? true} onChange={(value) => onPreference({ sanitizeSensitiveData: value })} onText={text.on} offText={text.off} />
          <PreferenceToggle label={text.encryptStorage} value={preferences?.encryptStorage ?? false} onChange={(value) => onPreference({ encryptStorage: value })} onText={text.on} offText={text.off} />
        </div>
      </section>
    </section>
  );
}

function PreferenceInput({
  label,
  type = "text",
  value,
  onChange
}: {
  label: string;
  type?: "text" | "number";
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="preferenceField">
      <span>{label}</span>
      <input type={type} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function PreferenceSelect({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="preferenceField">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  );
}

function PreferenceToggle({
  label,
  value,
  onChange,
  onText,
  offText
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  onText: string;
  offText: string;
}) {
  return (
    <label className={value ? "toggleField enabled" : "toggleField"}>
      <span>{label}</span>
      <button type="button" onClick={() => onChange(!value)} aria-pressed={value}>
        {value ? onText : offText}
      </button>
    </label>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
