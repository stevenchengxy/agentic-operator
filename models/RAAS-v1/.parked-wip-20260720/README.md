# Parked in-flight RAAS manifest versions (2026-07-20, Kenny-merge integration)

workflow_v6..v11 reference tenant tools that the concurrent RAAS package
refactor removed/renamed (uploadResume, parseResume, extractResumeInfo,
generateMatchResult, sendInvitationEmail, evaluateWithModel,
probeRuntimeContext). With them in place the fail-closed boot gate
(assertManifestToolsResolvable) refuses to start the api for active tenant
raas. Content preserved verbatim — move a file back after aligning its
tool_use/action names with tenants/raas/src/index.ts registry keys.
