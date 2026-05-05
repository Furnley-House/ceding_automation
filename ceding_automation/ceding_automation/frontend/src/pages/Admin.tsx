import { ShieldCheck, Users, Building2, ListChecks, Sparkles } from "lucide-react";

const Admin = () => {
  return (
    <div className="animate-slide-in">
      <div className="mb-6">
        <h1 className="text-2xl font-bold theme-heading text-foreground flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-teal" /> Admin Panel
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage users, providers, and checklist templates.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <AdminCard
          icon={Users}
          title="User Management"
          description="View all users, assign roles, and activate/deactivate accounts. (In production, role assignment will sync from SSO.)"
          status="Coming in Phase 9"
        />
        <AdminCard
          icon={Building2}
          title="Provider Directory"
          description="Add, edit, and remove providers. Configure routing rules and jargon mappings."
          status="Coming in Phase 9"
        />
        <AdminCard
          icon={ListChecks}
          title="Checklist Templates"
          description="Add, reorder, or deactivate fields per plan type (ISA / GIA / Pension / Bond / DB / Protection)."
          status="Coming in Phase 9"
        />
      </div>
    </div>
  );
};

function AdminCard({
  icon: Icon,
  title,
  description,
  status,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  status: string;
}) {
  return (
    <div className="theme-card theme-card-accent border border-border bg-card">
      <div className="flex h-10 w-10 items-center justify-center rounded-md bg-teal/15 text-teal mb-3">
        <Icon className="h-5 w-5" />
      </div>
      <h3 className="text-base font-bold theme-heading text-foreground mb-1">{title}</h3>
      <p className="text-xs text-muted-foreground mb-3 leading-relaxed">{description}</p>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold text-teal uppercase tracking-wider">
        <Sparkles className="h-3 w-3" /> {status}
      </div>
    </div>
  );
}

export default Admin;
