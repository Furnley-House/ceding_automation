import { NavLink, useLocation, useNavigate, useParams, matchPath } from "react-router-dom";
import {
  LayoutDashboard,
  Briefcase,
  Building2,
  ShieldCheck,
  History,
  CheckCircle2,
  Circle,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useRole } from "@/hooks/useRole";
import { getCaseById } from "@/services/api";
import { CEDING_STAGES } from "@/lib/caseHelpers";
import logoWhite from "@/assets/logo-white.png";
import lionIcon from "@/assets/lion-icon.png";

export function AppSidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { isAdmin, isAdviser, isParaplanner } = useRole();

  // Detect active case from URL
  const caseMatch = matchPath("/cases/:id", location.pathname);
  const activeCaseId = caseMatch?.params?.id;

  const { data: activeCase } = useQuery({
    queryKey: ["case", activeCaseId],
    queryFn: () => getCaseById(activeCaseId!),
    enabled: !!activeCaseId,
  });

  // "My Inbox" removed — no role actually used it (CA never had one,
  // paraplanner/adviser/admin work from /cases directly). The /inbox route
  // and MyInbox page have been unwired in App.tsx; the page file is left
  // in place for now in case it's revived later.
  const navItems = [
    { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard, show: true },
    { title: "Cases", url: "/cases", icon: Briefcase, show: true },
    { title: "Provider Directory", url: "/providers", icon: Building2, show: true },
    { title: "Audit Trail", url: "/audit", icon: History, show: isAdmin || isAdviser || isParaplanner },
    { title: "Admin Panel", url: "/admin", icon: ShieldCheck, show: isAdmin },
  ].filter((i) => i.show);

  const currentStage: number = (activeCase as any)?.current_stage ?? 1;
  const stagesCompleted: number[] = (activeCase as any)?.stages_completed ?? [];

  return (
    <aside
      className={`fixed left-0 top-0 z-40 h-screen bg-sidebar transition-all duration-300 flex flex-col ${
        collapsed ? "w-16" : "w-60"
      }`}
    >
      <div
        className={`flex items-center border-b border-sidebar-border shrink-0 ${
          collapsed ? "h-16 justify-center px-2" : "h-20 justify-start px-4"
        }`}
      >
        {collapsed ? (
          <img
            src={lionIcon}
            alt="Furnley House"
            className="h-9 w-9 object-contain"
            style={{ filter: "brightness(0) invert(1)" }}
          />
        ) : (
          <img
            src={logoWhite}
            alt="Furnley House — Financial Planning Partners"
            className="h-12 w-auto max-w-full object-contain"
          />
        )}
      </div>

      <nav className="flex-1 overflow-y-auto py-4 scrollbar-thin">
        <ul className="space-y-1 px-2">
          {navItems.map((item) => {
            const isActive =
              location.pathname === item.url || (item.url !== "/dashboard" && location.pathname.startsWith(item.url));
            const isCasesItem = item.url === "/cases";
            const showProgress = isCasesItem && !!activeCase && !collapsed;

            return (
              <li key={item.url}>
                <NavLink
                  to={item.url}
                  className={`flex items-center gap-3 theme-sidebar-item px-3 py-2.5 text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-sidebar-accent text-sidebar-primary"
                      : "text-sidebar-foreground hover:bg-sidebar-muted hover:text-sidebar-accent-foreground"
                  }`}
                >
                  <item.icon className="h-[18px] w-[18px] shrink-0" />
                  {!collapsed && <span>{item.title}</span>}
                </NavLink>

                {/* Progress sub-navigation under Cases */}
                {showProgress && (
                  <div className="mt-1 ml-3 pl-3 border-l border-sidebar-border/60">
                    <div className="flex items-center justify-between px-2 pt-2 pb-1">
                      <span className="text-[10px] uppercase tracking-wider text-sidebar-foreground/60 font-semibold">
                        Progress
                      </span>
                      <span className="text-[10px] text-sidebar-foreground/60">
                        {stagesCompleted.length}/{CEDING_STAGES.length}
                      </span>
                    </div>
                    <ol className="space-y-0.5">
                      {CEDING_STAGES.map((s) => {
                        const isDone = stagesCompleted.includes(s.num);
                        const isCurrent = currentStage === s.num;
                        const maxReachable = Math.max(
                          currentStage,
                          Math.min(
                            CEDING_STAGES.length,
                            (stagesCompleted.length > 0 ? Math.max(...stagesCompleted) : 0) + 1,
                          ),
                        );
                        const isLocked = s.num > maxReachable;
                        return (
                          <li key={s.num}>
                            <button
                              disabled={isLocked}
                              onClick={() =>
                                navigate(`/cases/${activeCaseId}`, {
                                  state: { goToStage: s.num },
                                })
                              }
                              title={isLocked ? "Complete previous steps first" : s.label}
                              className={`flex w-full items-center gap-2 text-left text-[11px] px-2 py-1 rounded-md transition-colors ${
                                isCurrent
                                  ? "bg-sidebar-accent text-sidebar-primary font-semibold"
                                  : "text-sidebar-foreground/80 hover:bg-sidebar-muted hover:text-sidebar-accent-foreground"
                              } ${isLocked ? "opacity-40 cursor-not-allowed hover:bg-transparent" : ""}`}
                            >
                              {isDone ? (
                                <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" />
                              ) : (
                                <Circle className="h-3.5 w-3.5 text-sidebar-foreground/40 shrink-0" />
                              )}
                              <span className="flex-1 truncate">
                                {s.num}. {s.label}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      {!collapsed && (
        <div className="px-4 py-3 border-t border-sidebar-border text-[10px] text-sidebar-foreground/60 leading-relaxed">
          Data retained for 12 months per FH policy
        </div>
      )}

      <button
        onClick={onToggle}
        className="flex h-12 items-center justify-center border-t border-sidebar-border text-sidebar-foreground hover:text-sidebar-accent-foreground transition-colors"
      >
        <svg
          className={`h-4 w-4 transition-transform ${collapsed ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
        </svg>
      </button>
    </aside>
  );
}
