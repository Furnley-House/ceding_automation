import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Users,
  Loader2,
  Search,
  Plus,
  AlertTriangle,
} from "lucide-react";
import { usersApi } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

type UserRole = "CA_TEAM" | "ADVISER" | "PARAPLANNER" | "ADMIN";
type UserStatus = "ACTIVE" | "INACTIVE";

interface AppUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  ssoId: string | null;
  createdAt: string;
  updatedAt: string;
}

const ROLES: { value: UserRole; label: string; helper: string }[] = [
  { value: "CA_TEAM", label: "CA Team", helper: "Chennai · Data capture" },
  { value: "PARAPLANNER", label: "Paraplanner", helper: "UK · Review & approval" },
  { value: "ADVISER", label: "Adviser", helper: "UK · Final sign-off" },
  { value: "ADMIN", label: "Admin", helper: "Full access · user management" },
];

const ROLE_LABEL: Record<UserRole, string> = {
  CA_TEAM: "CA Team",
  PARAPLANNER: "Paraplanner",
  ADVISER: "Adviser",
  ADMIN: "Admin",
};

export function UserManagementPanel() {
  const qc = useQueryClient();
  const me = useAuthStore((s) => s.user);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | UserRole>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | UserStatus>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingRoleChange, setPendingRoleChange] = useState<{
    user: AppUser;
    nextRole: UserRole;
  } | null>(null);

  const { data: users = [], isLoading } = useQuery({
    queryKey: ["users"],
    queryFn: async () => {
      const res = await usersApi.list();
      return (res.data as AppUser[]) ?? [];
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: Partial<Pick<AppUser, "role" | "status" | "name">>;
    }) => {
      const res = await usersApi.update(id, updates);
      return res.data as AppUser;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (e: Error) => toast.error("Update failed", { description: e.message }),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users
      .filter((u) => {
        if (roleFilter !== "all" && u.role !== roleFilter) return false;
        if (statusFilter !== "all" && u.status !== statusFilter) return false;
        if (q) {
          return (
            u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
          );
        }
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [users, search, roleFilter, statusFilter]);

  const stats = useMemo(() => {
    const counts: Record<UserRole, number> = {
      CA_TEAM: 0,
      PARAPLANNER: 0,
      ADVISER: 0,
      ADMIN: 0,
    };
    let inactive = 0;
    for (const u of users) {
      if (u.status === "INACTIVE") inactive += 1;
      else counts[u.role] += 1;
    }
    return { ...counts, inactive, total: users.length };
  }, [users]);

  const handleRoleChange = (user: AppUser, nextRole: UserRole) => {
    if (nextRole === user.role) return;

    if (me?.id === user.id && user.role === "ADMIN" && nextRole !== "ADMIN") {
      toast.error("You can't demote your own admin account.", {
        description: "Ask another admin to do this.",
      });
      return;
    }

    if (user.role === "ADMIN" || nextRole === "ADMIN") {
      setPendingRoleChange({ user, nextRole });
      return;
    }

    updateMutation.mutate(
      { id: user.id, updates: { role: nextRole } },
      {
        onSuccess: () =>
          toast.success(`${user.name} is now ${ROLE_LABEL[nextRole]}`),
      },
    );
  };

  const handleStatusToggle = (user: AppUser) => {
    const nextStatus: UserStatus = user.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    if (me?.id === user.id && nextStatus === "INACTIVE") {
      toast.error("You can't deactivate your own account.");
      return;
    }
    updateMutation.mutate(
      { id: user.id, updates: { status: nextStatus } },
      {
        onSuccess: () =>
          toast.success(
            `${user.name} ${nextStatus === "ACTIVE" ? "activated" : "deactivated"}`,
          ),
      },
    );
  };

  const confirmRoleChange = () => {
    if (!pendingRoleChange) return;
    const { user, nextRole } = pendingRoleChange;
    updateMutation.mutate(
      { id: user.id, updates: { role: nextRole } },
      {
        onSuccess: () => {
          toast.success(`${user.name} is now ${ROLE_LABEL[nextRole]}`);
          setPendingRoleChange(null);
        },
      },
    );
  };

  return (
    <div className="theme-card theme-card-accent border border-border bg-card">
      <div className="flex items-start justify-between gap-4 mb-4 pb-4 border-b border-border flex-wrap">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-teal/15 text-teal shrink-0">
            <Users className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold theme-heading text-foreground">
              User Management
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5 max-w-md">
              Microsoft SSO auto-provisions new users with the{" "}
              <strong>CA Team</strong> role. Promote, demote, or deactivate
              accounts here.
            </p>
          </div>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="gap-2 shrink-0">
          <Plus className="h-4 w-4" /> Add user
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-4">
        <StatTile label="Total" value={stats.total} tone="muted" />
        <StatTile label="CA Team" value={stats.CA_TEAM} tone="teal" />
        <StatTile label="Paraplanners" value={stats.PARAPLANNER} tone="info" />
        <StatTile label="Admins" value={stats.ADMIN} tone="overdue" />
        <StatTile label="Inactive" value={stats.inactive} tone="muted" />
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or email…"
            className="h-9 pl-8"
          />
        </div>
        <Select
          value={roleFilter}
          onValueChange={(v) => setRoleFilter(v as "all" | UserRole)}
        >
          <SelectTrigger className="h-9 w-[170px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All roles</SelectItem>
            {ROLES.map((r) => (
              <SelectItem key={r.value} value={r.value}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as "all" | UserStatus)}
        >
          <SelectTrigger className="h-9 w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="ACTIVE">Active</SelectItem>
            <SelectItem value="INACTIVE">Inactive</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-muted/20 p-8 text-center">
          <Users className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm font-semibold text-foreground">No users match</p>
          <p className="text-xs text-muted-foreground mt-1">
            Adjust the filters above, or click <strong>Add user</strong> to
            create one.
          </p>
        </div>
      ) : (
        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/30 text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2 font-bold">Name & email</th>
                <th className="text-left px-3 py-2 font-bold">Role</th>
                <th className="text-left px-3 py-2 font-bold">Status</th>
                <th className="text-left px-3 py-2 font-bold">Sign-in</th>
                <th className="text-right px-3 py-2 font-bold">Joined</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((u) => {
                const isMe = me?.id === u.id;
                const cantDeactivate = isMe && u.status === "ACTIVE";
                return (
                  <tr key={u.id} className="hover:bg-muted/20 transition-colors">
                    <td className="px-3 py-2.5 align-top">
                      <div className="font-semibold text-foreground">
                        {u.name}
                        {isMe && (
                          <span className="text-[10px] font-normal text-muted-foreground italic ml-1.5">
                            (you)
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">{u.email}</div>
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      <Select
                        value={u.role}
                        onValueChange={(v) => handleRoleChange(u, v as UserRole)}
                        disabled={updateMutation.isPending}
                      >
                        <SelectTrigger className="h-8 w-[170px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ROLES.map((r) => (
                            <SelectItem key={r.value} value={r.value}>
                              <div className="flex flex-col text-left">
                                <span className="text-sm">{r.label}</span>
                                <span className="text-[10px] text-muted-foreground">
                                  {r.helper}
                                </span>
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      <button
                        type="button"
                        onClick={() => handleStatusToggle(u)}
                        disabled={updateMutation.isPending || cantDeactivate}
                        className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                          u.status === "ACTIVE"
                            ? "bg-success/15 text-success border-success/30 hover:bg-success/25"
                            : "bg-muted text-muted-foreground border-border hover:bg-muted/70"
                        }`}
                        title={
                          cantDeactivate
                            ? "You can't deactivate your own account"
                            : `Click to ${u.status === "ACTIVE" ? "deactivate" : "activate"}`
                        }
                      >
                        {u.status}
                      </button>
                    </td>
                    <td className="px-3 py-2.5 align-top text-xs">
                      {u.ssoId ? (
                        <span className="text-info font-medium">Microsoft SSO</span>
                      ) : (
                        <span className="text-muted-foreground italic">Email only</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 align-top text-xs text-muted-foreground text-right">
                      {new Date(u.createdAt).toLocaleDateString("en-GB", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                      })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />

      <Dialog
        open={!!pendingRoleChange}
        onOpenChange={(o) => !o && setPendingRoleChange(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-warning" />
              Confirm role change
            </DialogTitle>
            <DialogDescription>
              {pendingRoleChange ? (
                <>
                  You're about to change{" "}
                  <strong className="text-foreground">
                    {pendingRoleChange.user.name}
                  </strong>{" "}
                  from{" "}
                  <span className="font-mono text-foreground">
                    {ROLE_LABEL[pendingRoleChange.user.role]}
                  </span>{" "}
                  to{" "}
                  <span className="font-mono text-foreground">
                    {ROLE_LABEL[pendingRoleChange.nextRole]}
                  </span>
                  .{" "}
                  {pendingRoleChange.nextRole === "ADMIN"
                    ? "Admins have full access including user management and case sign-off."
                    : pendingRoleChange.user.role === "ADMIN"
                      ? "They will lose access to user management."
                      : ""}
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingRoleChange(null)}
              disabled={updateMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={confirmRoleChange}
              disabled={updateMutation.isPending}
              className="gap-2"
            >
              {updateMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CreateUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>("CA_TEAM");

  const create = useMutation({
    mutationFn: async () => {
      const res = await usersApi.create({
        name: name.trim(),
        email: email.trim().toLowerCase(),
        role,
        status: "ACTIVE",
      });
      return res.data as AppUser;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      toast.success(`${name} added`);
      setName("");
      setEmail("");
      setRole("CA_TEAM");
      onOpenChange(false);
    },
    onError: (e: unknown) => {
      const err = e as { response?: { data?: { error?: string } }; message?: string };
      toast.error("Failed to add user", {
        description:
          err?.response?.data?.error?.toString() ?? err?.message ?? "Unknown error",
      });
    },
  });

  const valid = name.trim().length > 0 && /\S+@\S+\.\S+/.test(email.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
          <DialogDescription>
            Manually create an app user (e.g. to assign a case in advance of
            their first sign-in). Microsoft SSO dedupes by email — when the
            same person later signs in via SSO, this account is reused.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <Label
              htmlFor="user-name"
              className="text-xs uppercase tracking-wider font-semibold"
            >
              Name
            </Label>
            <Input
              id="user-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Doe"
              className="mt-1"
              autoFocus
            />
          </div>
          <div>
            <Label
              htmlFor="user-email"
              className="text-xs uppercase tracking-wider font-semibold"
            >
              Email
            </Label>
            <Input
              id="user-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jane.doe@furnleyhouse.co.uk"
              className="mt-1"
            />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider font-semibold">
              Role
            </Label>
            <Select value={role} onValueChange={(v) => setRole(v as UserRole)}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    <div className="flex flex-col text-left">
                      <span>{r.label}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {r.helper}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={create.isPending || !valid}
            className="gap-2"
          >
            {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "muted" | "teal" | "info" | "overdue";
}) {
  const cls = {
    muted: "bg-muted/40 border-border text-muted-foreground",
    teal: "bg-teal/10 border-teal/30 text-teal",
    info: "bg-info/10 border-info/30 text-info",
    overdue: "bg-overdue/10 border-overdue/30 text-overdue",
  }[tone];
  return (
    <div className={`rounded-md border p-2.5 ${cls}`}>
      <span className="text-[10px] uppercase tracking-wider font-bold opacity-80">
        {label}
      </span>
      <p className="text-xl font-bold text-foreground mt-0.5">{value}</p>
    </div>
  );
}
