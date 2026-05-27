# GoDam Agent Instructions

This is Deepak's GoDam warehouse system workspace.

Act as a practical coding and operations agent. Do not behave like a passive chatbot.
When Deepak asks for work, inspect the project, diagnose, make a short plan, use tools, and complete the task safely.

Project context:
- Main system: GoDam warehouse system.
- Areas include backend, frontend, mobile app, database, AI plugin, Huawei matching module, SAP/logistics automation, notification flow, Hostinger VPS deployment, APK builds, and reports.

Working rules:
- Diagnose before fixing.
- Protect existing working code.
- Prefer safe incremental changes.
- Take backups before major risky changes.
- Show faults clearly and suggest better architecture when needed.
- Keep answers short, clear, and practical.
- Run available lint, build, test, or targeted checks after edits.

Safety rules:
- Never print secrets from `.env`, API keys, database passwords, tokens, or JWT secrets.
- Do not delete files without explicit approval.
- Do not move files without explicit approval.
- Do not overwrite important config without explicit approval and backup.
- Do not modify production database without backup and explicit approval.
- Do not change production VPS deployment without explicit approval.
- Do not run destructive commands.
- Do not commit, push, or deploy unless Deepak asks.
- Do not install global packages unless needed and approved.

Preferred final output:
- Summary
- Findings
- Faults / Risks
- Suggested Fix
- Files Checked
- Files Changed
- Commands Run
- Next Step

## Recent Agent Contributions & Handover (May 2026)

### 1. Delivery Note (DN) Generation & Box-Wise Sync
- **Files**: [huaweiDnPageService.js](file:///Users/deepak/Desktop/GAPP%20copy/backend/services/huaweiDnPageService.js) and [huaweiDnGappSyncService.js](file:///Users/deepak/Desktop/GAPP%20copy/backend/services/huaweiDnGappSyncService.js)
- **Contribution**: Fixed the sync process to retrieve detailed box line items directly from the staging tables (`huawei_dn_lines` using PO query fallbacks) instead of only using the aggregated `di` database model. This ensures a 100% accurate box-wise item presentation on the GAPP Delivery Note.
- **SAP Reference Lookup**: Automated lookup of customer PO references from the active SAP SO (`sap_po_lines` and `outbound_orders`) using parameter-safe lookup queries, resolving corresponding contract numbers cleanly.

### 2. Premium Printable DN Styles & Decimal Formatting
- **Files**: [DeliveryNote.jsx](file:///Users/deepak/Desktop/GAPP%20copy/frontend/src/pages/DeliveryNote.jsx)
- **Contribution**: 
  - Standardized gross weight and volume decimal precision by rounding them to exactly 2 decimal places (`toFixed(2)`), preventing floating-point overflow on printed sheets.
  - Revamped layout architecture: moved system PO and Huawei Contract boxes side-by-side inside a clean block, avoiding duplicate box cells and ensuring smooth, clean print views without blank pages.

### 3. Glow-Themed Follow-Ups & Notes Panel
- **Files**: [FollowUps.jsx](file:///Users/deepak/Desktop/GAPP%20copy/frontend/src/pages/FollowUps.jsx)
- **Contribution**: Upgraded the Follow-Ups interface to a modern, glowing dark-theme design. Added dynamic countdown badges ("Day X") highlighting high-priority alerts in bright neon red, and integrated secure access guard options (e.g., locks/visibility status tags) for client notes.
