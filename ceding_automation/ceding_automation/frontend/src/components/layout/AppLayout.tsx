import { useState } from "react";
import { Outlet } from "react-router-dom";
import { AppSidebar } from "./AppSidebar";
import { AppHeader } from "./AppHeader";

export function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="min-h-screen bg-background">
      <AppSidebar collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
      <div
        className={`transition-all duration-300 ${collapsed ? "ml-16" : "ml-60"}`}
      >
        <AppHeader />
        <main className="p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
