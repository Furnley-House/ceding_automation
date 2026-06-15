import { useState } from "react";
import { Outlet } from "react-router-dom";
import { AppSidebar } from "./AppSidebar";
import { AppHeader } from "./AppHeader";

// Shape exposed to nested routes via <Outlet context=… />. Currently the
// only consumer is CaseDetail — Stage 4 (Extract & Fill Gaps) auto-collapses
// the sidebar so the PDF ↔ extraction comparison gets the full viewport.
export interface AppLayoutContext {
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (value: boolean) => void;
}

export function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);

  const context: AppLayoutContext = {
    sidebarCollapsed: collapsed,
    setSidebarCollapsed: setCollapsed,
  };

  return (
    <div className="min-h-screen bg-background">
      <AppSidebar collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
      <div
        className={`transition-all duration-300 ${collapsed ? "ml-16" : "ml-60"}`}
      >
        <AppHeader />
        <main className="p-6">
          <Outlet context={context} />
        </main>
      </div>
    </div>
  );
}
