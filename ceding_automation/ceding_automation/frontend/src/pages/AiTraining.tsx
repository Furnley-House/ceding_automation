// Placeholder for the AI Training Hub. The permission plumbing
// (canAccessAiTraining on User, PermissionGuard route wrapper,
// UserManagementPanel toggle, USER_PERMISSION_CHANGED audit) lands in
// this pass; the actual page layout will be designed in a follow-up
// after the UI feasibility survey has been reviewed.
export default function AiTraining() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold theme-heading">AI Training Hub</h1>
      <p className="text-sm text-muted-foreground mt-2 max-w-lg">
        Placeholder. Layout to be designed in a follow-up pass — the permission
        gate, audit trail, and admin toggle are wired and ready.
      </p>
    </div>
  );
}
