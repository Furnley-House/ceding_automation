import { Search, ChevronDown, LogOut, RefreshCw, Settings, BarChart3 } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getCases } from "@/services/api";
import { useRole, ROLE_LABELS } from "@/hooks/useRole";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NotificationBell } from "./NotificationBell";

export function AppHeader() {
  const [searchQuery, setSearchQuery] = useState("");
  const [showResults, setShowResults] = useState(false);
  const navigate = useNavigate();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { role, userName, clearRole } = useRole();

  const { data: cases = [] } = useQuery({ queryKey: ["cases"], queryFn: getCases });

  // Weekly throughput: cases completed this calendar week
  const weeklyThroughput = (() => {
    const now = new Date();
    const day = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((day + 6) % 7));
    monday.setHours(0, 0, 0, 0);
    return cases.filter((c) => c.status === "complete" && new Date(c.updated_at) >= monday).length;
  })();

  const filtered =
    searchQuery.trim().length >= 2
      ? cases
          .filter((c) => {
            const q = searchQuery.toLowerCase();
            return (
              c.client_name.toLowerCase().includes(q) ||
              c.provider_name.toLowerCase().includes(q) ||
              c.plan_number.toLowerCase().includes(q) ||
              c.case_ref.toLowerCase().includes(q)
            );
          })
          .slice(0, 8)
      : [];

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setShowResults(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleSelect = (id: string) => {
    setSearchQuery("");
    setShowResults(false);
    navigate(`/cases/${id}`);
  };

  return (
    <header className="app-header sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-card px-6">
      {/* Left: app context (logo is already in the sidebar) */}
      <div className="flex items-center mr-6">
        <div className="hidden md:block">
          <p className="text-sm font-bold theme-heading text-foreground leading-tight">Ceding Application</p>
          <p className="text-[10px] text-muted-foreground leading-tight">Furnley House Financial Planning Partners</p>
        </div>
      </div>

      {/* Search */}
      <div className="relative flex-1 max-w-md" ref={wrapperRef}>
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search clients, providers, plan numbers…"
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setShowResults(true);
          }}
          onFocus={() => setShowResults(true)}
          className="h-10 w-full border border-input bg-background pl-10 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring rounded-md"
        />
        {showResults && searchQuery.trim().length >= 2 && (
          <div className="absolute top-full left-0 right-0 mt-1 rounded-lg border border-border bg-card shadow-lg overflow-hidden z-50">
            {filtered.length > 0 ? (
              filtered.map((c) => (
                <button
                  key={c.id}
                  onClick={() => handleSelect(c.id)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/50 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{c.client_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {c.provider_name} · {c.plan_number}
                    </p>
                  </div>
                  <span className="text-[10px] font-mono text-muted-foreground">{c.case_ref}</span>
                </button>
              ))
            ) : (
              <p className="px-4 py-3 text-sm text-muted-foreground">No results found</p>
            )}
          </div>
        )}
      </div>

      {/* Right side */}
      <div className="flex items-center gap-3 ml-6">
        {/* Weekly throughput */}
        <div className="hidden lg:flex items-center gap-2 px-3 py-1.5 rounded-md bg-muted/50 border border-border">
          <BarChart3 className="h-3.5 w-3.5 text-teal" />
          <div className="leading-tight">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">This week</p>
            <p className="text-xs font-bold text-foreground">{weeklyThroughput} completed</p>
          </div>
        </div>

        <NotificationBell />

        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-3 px-3 py-1.5 rounded-md hover:bg-muted transition-colors">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
              {(userName ?? "?")
                .split(" ")
                .map((s) => s[0])
                .slice(0, 2)
                .join("")}
            </div>
            <div className="hidden sm:block text-left">
              <p className="text-sm font-medium text-foreground leading-tight">{userName}</p>
              <p className="text-[10px] text-teal font-semibold uppercase tracking-wider leading-tight">
                {role ? ROLE_LABELS[role] : ""}
              </p>
            </div>
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Signed in as</DropdownMenuLabel>
            <DropdownMenuItem disabled className="opacity-100">
              <div>
                <p className="font-medium">{userName}</p>
                <p className="text-xs text-muted-foreground">{role ? ROLE_LABELS[role] : ""}</p>
              </div>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate("/admin")} disabled={role !== "admin"}>
              <Settings className="mr-2 h-4 w-4" /> Admin Panel
            </DropdownMenuItem>
            <DropdownMenuItem onClick={clearRole}>
              <RefreshCw className="mr-2 h-4 w-4" /> Switch role
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={clearRole}>
              <LogOut className="mr-2 h-4 w-4" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
