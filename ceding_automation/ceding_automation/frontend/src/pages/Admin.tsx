import { useState } from "react";
import { ShieldCheck, Users, Building2, ListChecks } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UserManagementPanel } from "@/components/admin/UserManagementPanel";
import { ProviderManagementPanel } from "@/components/admin/ProviderManagementPanel";
import { ChecklistTemplatesPanel } from "@/components/admin/ChecklistTemplatesPanel";

type AdminTab = "users" | "providers" | "templates";

const Admin = () => {
  const [tab, setTab] = useState<AdminTab>("users");

  return (
    <div className="animate-slide-in space-y-6">
      <div>
        <h1 className="text-2xl font-bold theme-heading text-foreground flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-teal" /> Admin Panel
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage users, providers, and checklist templates.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as AdminTab)}>
        <TabsList className="grid w-full max-w-xl grid-cols-3">
          <TabsTrigger value="users" className="gap-2">
            <Users className="h-4 w-4" /> Users
          </TabsTrigger>
          <TabsTrigger value="providers" className="gap-2">
            <Building2 className="h-4 w-4" /> Providers
          </TabsTrigger>
          <TabsTrigger value="templates" className="gap-2">
            <ListChecks className="h-4 w-4" /> Checklist
          </TabsTrigger>
        </TabsList>

        <TabsContent value="users" className="mt-4">
          <UserManagementPanel />
        </TabsContent>
        <TabsContent value="providers" className="mt-4">
          <ProviderManagementPanel />
        </TabsContent>
        <TabsContent value="templates" className="mt-4">
          <ChecklistTemplatesPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default Admin;
