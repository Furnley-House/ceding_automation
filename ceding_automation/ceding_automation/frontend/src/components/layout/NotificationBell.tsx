import { useState } from "react";
import { Bell, CheckCheck, Inbox, UserCheck, MessageSquare } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/lib/store";

interface Notification {
  id: string;
  title: string;
  message?: string;
  deepLink?: string;
  isRead: boolean;
  createdAt: string;
  type?: string;
}

const TYPE_META: Record<string, { icon: React.ElementType; cls: string }> = {
  case_assigned:    { icon: UserCheck,     cls: "text-primary" },
  review_requested: { icon: MessageSquare, cls: "text-yellow-500" },
};

export function NotificationBell() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: raw = [] } = useQuery<Notification[]>({
    queryKey: ["notifications"],
    enabled: !!user,
    queryFn: async () => {
      const res = await api.get("/notifications");
      return (res.data as Notification[]) ?? [];
    },
    refetchInterval: 60_000, // poll every 60 s — not hammering the server
    retry: false,            // don't retry on 401 (handled by interceptor)
  });

  const notifications = raw;
  const unreadCount = notifications.filter((n) => !n.isRead).length;

  const markRead = async (n: Notification) => {
    if (!n.isRead) {
      await api.patch(`/notifications/${n.id}/read`).catch(() => {});
      qc.invalidateQueries({ queryKey: ["notifications"] });
    }
    if (n.deepLink) {
      setOpen(false);
      navigate(n.deepLink);
    }
  };

  const markAllRead = async () => {
    if (unreadCount === 0) return;
    await api.patch("/notifications/read-all").catch(() => {});
    qc.invalidateQueries({ queryKey: ["notifications"] });
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
          className="relative p-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors rounded-md"
        >
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-[360px] p-0">
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
          <p className="text-sm font-bold text-foreground">Notifications</p>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-[11px]"
              onClick={markAllRead}
            >
              <CheckCheck className="h-3 w-3" /> Mark all read
            </Button>
          )}
        </div>

        <div className="max-h-[480px] overflow-y-auto">
          {notifications.length === 0 ? (
            <div className="p-6 text-center">
              <Inbox className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm font-semibold text-foreground">All caught up</p>
              <p className="text-[11px] text-muted-foreground mt-1">
                Assignments and review requests will appear here.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {notifications.map((n) => {
                const meta = TYPE_META[n.type ?? ""] ?? {
                  icon: Bell,
                  cls: "text-muted-foreground",
                };
                const Icon = meta.icon;
                return (
                  <li key={n.id}>
                    <button
                      onClick={() => markRead(n)}
                      className={`w-full text-left px-3 py-2.5 hover:bg-muted/50 transition-colors flex gap-3 ${
                        !n.isRead ? "bg-primary/5" : ""
                      }`}
                    >
                      <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${meta.cls}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start gap-2">
                          <p className="text-xs font-semibold text-foreground flex-1">
                            {n.title}
                          </p>
                          {!n.isRead && (
                            <span className="h-1.5 w-1.5 rounded-full bg-primary mt-1 shrink-0" />
                          )}
                        </div>
                        {n.message && (
                          <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-3">
                            {n.message}
                          </p>
                        )}
                        <p className="text-[10px] text-muted-foreground/80 mt-1">
                          {new Date(n.createdAt).toLocaleString("en-GB", {
                            day: "2-digit",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </p>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
