import { useEffect, useMemo, useState } from "react";
import { Bell, CheckCheck, Inbox, UserCheck, MessageSquare } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useRole } from "@/hooks/useRole";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { PARAPLANNERS } from "@/lib/paraplanners";
import type { Tables } from "@/integrations/supabase/types";

type Notification = Tables<"notifications">;

const TYPE_META: Record<string, { icon: React.ElementType; cls: string }> = {
  case_assigned: { icon: UserCheck, cls: "text-teal" },
  review_requested: { icon: MessageSquare, cls: "text-warning" },
};

/**
 * Map the active role to a stable recipient ID so notifications can be addressed and read.
 */
function recipientIdForRole(role: string | null): string | null {
  if (role === "paraplanner") return PARAPLANNERS[0].user_id;
  if (role === "adviser") return "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  if (role === "admin") return "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  if (role === "ca_team") return "cccccccc-cccc-cccc-cccc-cccccccccccc";
  return null;
}

export function NotificationBell() {
  const { role } = useRole();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const recipientId = useMemo(() => recipientIdForRole(role), [role]);

  const { data: notifications = [] } = useQuery({
    queryKey: ["notifications", recipientId],
    enabled: !!recipientId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("notifications")
        .select("*")
        .eq("recipient_user_id", recipientId!)
        .order("created_at", { ascending: false })
        .limit(30);
      if (error) throw error;
      return data ?? [];
    },
    refetchInterval: 30_000,
  });

  // Realtime — refetch on insert/update for this recipient
  useEffect(() => {
    if (!recipientId) return;
    const channel = supabase
      .channel(`notifications-${recipientId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "notifications",
          filter: `recipient_user_id=eq.${recipientId}`,
        },
        () => {
          qc.invalidateQueries({ queryKey: ["notifications", recipientId] });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [recipientId, qc]);

  const unread = notifications.filter((n) => !n.read);
  const unreadCount = unread.length;

  const markRead = async (n: Notification) => {
    if (!n.read) {
      await supabase
        .from("notifications")
        .update({ read: true, read_at: new Date().toISOString() })
        .eq("id", n.id);
      qc.invalidateQueries({ queryKey: ["notifications", recipientId] });
    }
    if (n.link) {
      setOpen(false);
      navigate(n.link);
    }
  };

  const markAllRead = async () => {
    if (unreadCount === 0 || !recipientId) return;
    await supabase
      .from("notifications")
      .update({ read: true, read_at: new Date().toISOString() })
      .eq("recipient_user_id", recipientId)
      .eq("read", false);
    qc.invalidateQueries({ queryKey: ["notifications", recipientId] });
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
            <span className="absolute -right-0.5 -top-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-overdue text-overdue-foreground text-[10px] font-bold flex items-center justify-center">
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
                You'll see assignments and review requests here.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {notifications.map((n) => {
                const meta = TYPE_META[n.type] ?? { icon: Bell, cls: "text-muted-foreground" };
                const Icon = meta.icon;
                return (
                  <li key={n.id}>
                    <button
                      onClick={() => markRead(n)}
                      className={`w-full text-left px-3 py-2.5 hover:bg-muted/50 transition-colors flex gap-3 ${
                        !n.read ? "bg-teal/5" : ""
                      }`}
                    >
                      <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${meta.cls}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start gap-2">
                          <p className="text-xs font-semibold text-foreground flex-1">
                            {n.title}
                          </p>
                          {!n.read && (
                            <span className="h-1.5 w-1.5 rounded-full bg-teal mt-1 shrink-0" />
                          )}
                        </div>
                        {n.body && (
                          <p className="text-[11px] text-muted-foreground mt-0.5 whitespace-pre-line line-clamp-3">
                            {n.body}
                          </p>
                        )}
                        <p className="text-[10px] text-muted-foreground/80 mt-1">
                          {new Date(n.created_at).toLocaleString("en-GB", {
                            day: "2-digit",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                          {n.actor_name && ` · ${n.actor_name}`}
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
