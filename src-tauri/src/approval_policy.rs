use crate::sessions::SessionKind;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalCategory { ReadFiles, EditFiles, FetchWebContent, ExecuteCommand, UseMcpServers }

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoApprovePolicy {
    pub read_files: bool,
    pub edit_files: bool,
    pub fetch_web_content: bool,
    pub execute_command: bool,
    pub use_mcp_servers: bool,
}

impl AutoApprovePolicy {
    pub fn prompt_all() -> Self {
        Self { read_files: false, edit_files: false, fetch_web_content: false, execute_command: false, use_mcp_servers: false }
    }

    pub fn for_new_session(kind: SessionKind) -> Self {
        if kind == SessionKind::Code { Self { read_files: true, edit_files: true, fetch_web_content: true, execute_command: true, use_mcp_servers: true } }
        else { Self { read_files: true, edit_files: true, fetch_web_content: true, execute_command: false, use_mcp_servers: false } }
    }
    pub fn legacy_default(kind: SessionKind) -> Self {
        Self::for_new_session(kind)
    }
    pub fn allows(self, category: ApprovalCategory) -> bool {
        match category { ApprovalCategory::ReadFiles => self.read_files, ApprovalCategory::EditFiles => self.edit_files, ApprovalCategory::FetchWebContent => self.fetch_web_content, ApprovalCategory::ExecuteCommand => self.execute_command, ApprovalCategory::UseMcpServers => self.use_mcp_servers }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn new_code_policy_enables_all_categories() { let p = AutoApprovePolicy::for_new_session(SessionKind::Code); assert!(p.read_files && p.edit_files && p.fetch_web_content && p.execute_command && p.use_mcp_servers); }
    #[test] fn code_defaults_enable_all_five_capabilities_for_new_and_existing_sessions() { for p in [AutoApprovePolicy::legacy_default(SessionKind::Code), AutoApprovePolicy::for_new_session(SessionKind::Code)] { assert!(p.read_files && p.edit_files && p.fetch_web_content && p.execute_command && p.use_mcp_servers); } }
}
