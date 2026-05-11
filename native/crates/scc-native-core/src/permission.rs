use scc_native_shared::{ApprovalDecision, PermissionMode, RiskCategory, UserPreferences};
use std::collections::BTreeSet;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionDecision {
    Allow { reason: String },
    Ask { reason: String },
    Deny { reason: String },
}

#[derive(Debug, Clone, Default)]
pub struct PermissionEngine {
    task_allowed: BTreeSet<RiskCategory>,
}

impl PermissionEngine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn allow_for_task(&mut self, risk: RiskCategory) {
        self.task_allowed.insert(risk);
    }

    pub fn apply_decision(&mut self, risk: RiskCategory, decision: ApprovalDecision) {
        if matches!(decision, ApprovalDecision::AllowForTask | ApprovalDecision::AllowOnce) {
            self.allow_for_task(risk);
        }
    }

    pub fn decide(&self, risk: RiskCategory, preferences: &UserPreferences) -> PermissionDecision {
        if self.task_allowed.contains(&risk) {
            return PermissionDecision::Allow { reason: "Allowed for this task.".to_string() };
        }

        match preferences.permission_mode {
            PermissionMode::Ask => PermissionDecision::Ask { reason: format!("{} requires approval.", risk.label()) },
            PermissionMode::ReadOnly => {
                if matches!(risk, RiskCategory::HostObservation | RiskCategory::WorkspaceRead) {
                    PermissionDecision::Allow { reason: "Read-only mode allows observation and file reads.".to_string() }
                } else {
                    PermissionDecision::Ask { reason: format!("Read-only mode asks before {}.", risk.label()) }
                }
            }
            PermissionMode::FullAccess => PermissionDecision::Allow { reason: "Full access mode allows every risk category, including destructive.".to_string() },
            PermissionMode::Custom => {
                if preferences.allowed_risks.contains(&risk) {
                    PermissionDecision::Allow { reason: format!("Custom mode globally allows {}.", risk.label()) }
                } else {
                    PermissionDecision::Ask { reason: format!("Custom mode asks before {}.", risk.label()) }
                }
            }
            PermissionMode::AutoApproval => {
                if risk == RiskCategory::Destructive {
                    PermissionDecision::Ask { reason: "Destructive tools are never rule-auto-approved.".to_string() }
                } else if preferences.auto_approval_risks.contains(&risk) {
                    PermissionDecision::Allow { reason: format!("Auto approval mode allows {} by rule.", risk.label()) }
                } else {
                    PermissionDecision::Ask { reason: format!("Auto approval mode asks before {}.", risk.label()) }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use scc_native_shared::UserPreferences;

    #[test]
    fn permission_modes_map_risks_without_language_intent() {
        let mut prefs = UserPreferences::default();
        prefs.permission_mode = PermissionMode::ReadOnly;
        assert!(matches!(PermissionEngine::new().decide(RiskCategory::WorkspaceRead, &prefs), PermissionDecision::Allow { .. }));
        assert!(matches!(PermissionEngine::new().decide(RiskCategory::WorkspaceWrite, &prefs), PermissionDecision::Ask { .. }));

        prefs.permission_mode = PermissionMode::FullAccess;
        assert!(matches!(PermissionEngine::new().decide(RiskCategory::Destructive, &prefs), PermissionDecision::Allow { .. }));

        prefs.permission_mode = PermissionMode::AutoApproval;
        prefs.auto_approval_risks = RiskCategory::ALL.into_iter().collect();
        assert!(matches!(PermissionEngine::new().decide(RiskCategory::Network, &prefs), PermissionDecision::Allow { .. }));
        assert!(matches!(PermissionEngine::new().decide(RiskCategory::Destructive, &prefs), PermissionDecision::Ask { .. }));
    }
}
