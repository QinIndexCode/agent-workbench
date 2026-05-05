import type { GlobalPermissionGrant, RiskCategory, UserPreferences } from "@scc/shared";

const riskCategories: RiskCategory[] = ["host_observation", "workspace_read", "workspace_write", "shell", "network", "destructive"];

export function PermissionsPanel({
  permissions,
  preferences,
  onGrant,
  onRevoke,
  onPreference
}: {
  permissions: GlobalPermissionGrant[];
  preferences: UserPreferences | null;
  onGrant: (riskCategory: RiskCategory) => void;
  onRevoke: (riskCategory: RiskCategory) => void;
  onPreference: (patch: Partial<UserPreferences>) => void;
}) {
  const safePermissions = Array.isArray(permissions) ? permissions : [];
  const granted = new Set(safePermissions.map((permission) => permission.riskCategory));

  return (
    <section className="permissionsPanel">
      <h2>Permissions</h2>
      <p className="muted">Global grants skip approval UI for matching risk categories.</p>
      <div className="permissionRows">
        {riskCategories.map((risk) => (
          <div className={risk === "destructive" ? "permissionRow danger" : "permissionRow"} key={risk}>
            <span>{risk.replace("_", " ")}</span>
            {granted.has(risk) ? (
              <button className="subtleButton" onClick={() => onRevoke(risk)}>
                Revoke
              </button>
            ) : (
              <button className="subtleButton" onClick={() => onGrant(risk)}>
                Allow globally
              </button>
            )}
          </div>
        ))}
      </div>
      <section className="compactList">
        <h3>Preferences</h3>
        <label className="fieldRow">
          <span>Language</span>
          <select value={preferences?.language ?? "zh-CN"} onChange={(event) => onPreference({ language: event.target.value })}>
            <option value="zh-CN">zh-CN</option>
            <option value="en-US">en-US</option>
          </select>
        </label>
        <label className="fieldRow">
          <span>Skill injection</span>
          <select
            value={preferences?.skillAutoInject === false ? "off" : "on"}
            onChange={(event) => onPreference({ skillAutoInject: event.target.value === "on" })}
          >
            <option value="on">on</option>
            <option value="off">off</option>
          </select>
        </label>
      </section>
    </section>
  );
}
