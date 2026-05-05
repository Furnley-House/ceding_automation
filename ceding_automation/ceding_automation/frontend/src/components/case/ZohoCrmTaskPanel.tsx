import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Loader2, AlertCircle, ClipboardList, RefreshCw } from "lucide-react";
import { crmApi } from "@/lib/api";

interface ZohoTask {
  id: string;
  Subject?: string;
  Status?: string;
  Priority?: string;
  Due_Date?: string;
  Owner?: { name?: string; email?: string };
  Description?: string;
  Related_To?: { name?: string };
  Contact_Name?: { name?: string };
  Created_Time?: string;
  Modified_Time?: string;
}

interface Props {
  taskId: string;
  deepLink?: string;
}

const PRIORITY_STYLES: Record<string, string> = {
  High: "text-red-600 bg-red-50 dark:bg-red-950 dark:text-red-400",
  Medium: "text-amber-600 bg-amber-50 dark:bg-amber-950 dark:text-amber-400",
  Low: "text-emerald-600 bg-emerald-50 dark:bg-emerald-950 dark:text-emerald-400",
};

const STATUS_STYLES: Record<string, string> = {
  "Completed": "text-emerald-600 bg-emerald-50 dark:bg-emerald-950 dark:text-emerald-400",
  "In Progress": "text-blue-600 bg-blue-50 dark:bg-blue-950 dark:text-blue-400",
  "Not Started": "text-muted-foreground bg-muted",
  "Deferred": "text-amber-600 bg-amber-50 dark:bg-amber-950 dark:text-amber-400",
  "Waiting on someone else": "text-amber-600 bg-amber-50 dark:bg-amber-950 dark:text-amber-400",
};

export function ZohoCrmTaskPanel({ taskId, deepLink }: Props) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["crm-task", taskId],
    queryFn: async () => {
      const res = await crmApi.getTask(taskId);
      const raw = res.data as { data?: ZohoTask[] };
      return raw.data?.[0] ?? null;
    },
    staleTime: 60_000,
    retry: 1,
  });

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-teal shrink-0" />
          <span className="text-sm font-semibold text-foreground">Zoho CRM Task</span>
          <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
            {taskId}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            className="text-muted-foreground hover:text-foreground transition-colors"
            title="Refresh from Zoho"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          {deepLink && (
            <a
              href={deepLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-teal hover:underline"
            >
              View in Zoho <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading task from Zoho CRM…
        </div>
      )}

      {isError && (
        <div className="flex items-center gap-2 text-sm text-destructive py-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          Could not load task from Zoho CRM. Check that the server is running and the refresh token is set.
        </div>
      )}

      {!isLoading && !isError && !data && (
        <p className="text-sm text-muted-foreground py-2">No task found for ID {taskId}.</p>
      )}

      {data && (
        <div className="space-y-3">
          {/* Subject + badges */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">{data.Subject ?? "—"}</span>
            {data.Status && (
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded ${STATUS_STYLES[data.Status] ?? "bg-muted text-muted-foreground"}`}>
                {data.Status}
              </span>
            )}
            {data.Priority && (
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded ${PRIORITY_STYLES[data.Priority] ?? "bg-muted text-muted-foreground"}`}>
                {data.Priority}
              </span>
            )}
          </div>

          {/* Fields grid */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-2.5">
            <TaskField label="Assigned to" value={data.Owner?.name} />
            <TaskField
              label="Due date"
              value={
                data.Due_Date
                  ? new Date(data.Due_Date).toLocaleDateString("en-GB", {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                    })
                  : undefined
              }
            />
            <TaskField label="Contact" value={data.Contact_Name?.name} />
            <TaskField label="Related to" value={data.Related_To?.name} />
            {data.Modified_Time && (
              <TaskField
                label="Last modified"
                value={new Date(data.Modified_Time).toLocaleDateString("en-GB", {
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                })}
              />
            )}
          </div>

          {data.Description && (
            <div className="flex flex-col gap-0.5 pt-1 border-t border-border">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                Description
              </span>
              <p className="text-xs text-foreground whitespace-pre-wrap leading-relaxed">
                {data.Description}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TaskField({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        {label}
      </span>
      <span className="text-xs text-foreground truncate">{value}</span>
    </div>
  );
}
