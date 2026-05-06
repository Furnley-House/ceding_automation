import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getProviders } from "@/services/api";
import {
  Search,
  CheckCircle,
  XCircle,
  Phone,
  Mail,
  MapPin,
  Loader2,
  FileText,
  Tag,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

interface Provider {
  id: string;
  name: string;
  phone_main?: string;
  phone_ceding_dept?: string;
  email_main?: string;
  email_ceding_dept?: string;
  postal_address?: string;
  loa_format: string;
  is_on_origo: boolean;
  accepted_sig_type?: string;
  plan_type_prefixes: string[];
  notes?: string;
  is_active: boolean;
  updated_at?: string;
}

const LOA_LABELS: Record<string, string> = {
  EITHER: "Either (wet or electronic)",
  ELECTRONIC: "Electronic only",
  WET_SIGNATURE: "Wet signature required",
};

const ProviderDirectory = () => {
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [origoFilter, setOrigoFilter] = useState<"all" | "origo" | "non_origo">("all");

  const { data: raw = [], isLoading } = useQuery({
    queryKey: ["providers"],
    queryFn: getProviders,
  });

  const providers = raw as Provider[];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return providers.filter((p) => {
      if (!p.is_active) return false;
      if (origoFilter === "origo" && !p.is_on_origo) return false;
      if (origoFilter === "non_origo" && p.is_on_origo) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.phone_main ?? "").includes(q) ||
        (p.email_main ?? "").toLowerCase().includes(q) ||
        (p.notes ?? "").toLowerCase().includes(q) ||
        p.plan_type_prefixes.some((x) => x.toLowerCase().includes(q))
      );
    });
  }, [providers, search, origoFilter]);

  // Auto-select first result when filtered list changes
  const active = providers.find((p) => p.id === selectedId) ?? filtered[0] ?? null;

  return (
    <div className="animate-slide-in">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold theme-heading text-foreground">Provider Directory</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isLoading ? "Loading…" : `${providers.filter((p) => p.is_active).length} providers configured`}
          </p>
        </div>
        {/* Origo filter tabs */}
        <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-1 text-xs">
          {(["all", "origo", "non_origo"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setOrigoFilter(v)}
              className={`px-3 py-1.5 rounded-md font-medium transition-colors ${
                origoFilter === v
                  ? "bg-card shadow-sm text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {v === "all" ? "All" : v === "origo" ? "On Origo" : "Non-Origo"}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px,1fr]">
        {/* ── Provider list ───────────────────────────────────────── */}
        <div className="rounded-xl border border-border bg-card overflow-hidden flex flex-col">
          <div className="p-3 border-b border-border">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search providers…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No providers match your search.
            </p>
          ) : (
            <div className="flex-1 overflow-y-auto max-h-[600px] scrollbar-thin">
              {filtered.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setSelectedId(p.id)}
                  className={`flex w-full items-center justify-between px-4 py-3 text-left transition-colors border-b border-border last:border-0 ${
                    active?.id === p.id ? "bg-primary/10" : "hover:bg-muted/40"
                  }`}
                >
                  <div className="min-w-0 pr-2">
                    <p className="text-sm font-medium text-foreground truncate">{p.name}</p>
                    {p.phone_main && (
                      <p className="text-[11px] text-muted-foreground truncate">{p.phone_main}</p>
                    )}
                  </div>
                  {p.is_on_origo ? (
                    <CheckCircle className="h-4 w-4 text-success shrink-0" title="On Origo" />
                  ) : (
                    <XCircle className="h-4 w-4 text-muted-foreground shrink-0" title="Not on Origo" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ── Provider detail ─────────────────────────────────────── */}
        {active ? (
          <div className="space-y-5">
            {/* Header card */}
            <div className="rounded-xl border border-border bg-card p-6">
              <div className="flex items-start justify-between gap-4 mb-5">
                <h2 className="text-xl font-bold text-foreground">{active.name}</h2>
                <Badge
                  variant={active.is_on_origo ? "default" : "secondary"}
                  className="shrink-0"
                >
                  {active.is_on_origo ? "Origo Supported" : "Non-Origo"}
                </Badge>
              </div>

              <div className="grid gap-5 sm:grid-cols-2">
                {/* Phone */}
                {(active.phone_main || active.phone_ceding_dept) && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                      <Phone className="h-3 w-3" /> Phone
                    </p>
                    {active.phone_main && (
                      <p className="text-sm font-medium text-foreground">{active.phone_main}</p>
                    )}
                    {active.phone_ceding_dept && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Ceding dept: {active.phone_ceding_dept}
                      </p>
                    )}
                  </div>
                )}

                {/* Email */}
                {(active.email_main || active.email_ceding_dept) && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                      <Mail className="h-3 w-3" /> Email
                    </p>
                    {active.email_main && (
                      <a
                        href={`mailto:${active.email_main}`}
                        className="text-sm font-medium text-primary hover:underline block"
                      >
                        {active.email_main}
                      </a>
                    )}
                    {active.email_ceding_dept && (
                      <a
                        href={`mailto:${active.email_ceding_dept}`}
                        className="text-xs text-muted-foreground hover:text-primary block mt-0.5"
                      >
                        {active.email_ceding_dept}
                      </a>
                    )}
                  </div>
                )}

                {/* LOA format */}
                <div>
                  <p className="text-xs text-muted-foreground mb-1">LOA Format</p>
                  <p className="text-sm text-foreground">
                    {LOA_LABELS[active.loa_format] ?? active.loa_format}
                  </p>
                  {active.accepted_sig_type && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Signature: {active.accepted_sig_type}
                    </p>
                  )}
                </div>

                {/* Last updated */}
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Last Updated</p>
                  <p className="text-sm text-foreground">
                    {active.updated_at
                      ? new Date(active.updated_at).toLocaleDateString("en-GB", {
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                        })
                      : "—"}
                  </p>
                </div>
              </div>

              {/* Postal address */}
              {active.postal_address && (
                <div className="mt-4 pt-4 border-t border-border">
                  <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                    <MapPin className="h-3 w-3" /> Postal Address
                  </p>
                  <p className="text-sm text-foreground whitespace-pre-line">
                    {active.postal_address}
                  </p>
                </div>
              )}
            </div>

            {/* Plan type prefixes */}
            {active.plan_type_prefixes?.length > 0 && (
              <div className="rounded-xl border border-border bg-card p-5">
                <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                  <Tag className="h-4 w-4 text-muted-foreground" /> Plan Number Prefixes
                </h3>
                <div className="flex flex-wrap gap-2">
                  {active.plan_type_prefixes.map((prefix) => (
                    <span
                      key={prefix}
                      className="inline-flex items-center px-2.5 py-1 rounded-md bg-muted text-xs font-mono font-semibold text-foreground"
                    >
                      {prefix}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Notes */}
            {active.notes && (
              <div className="rounded-xl border border-border bg-card p-5">
                <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                  <FileText className="h-4 w-4 text-muted-foreground" /> Notes
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line">
                  {active.notes}
                </p>
              </div>
            )}

            {/* Empty state for no contact details */}
            {!active.phone_main && !active.email_main && !active.postal_address && !active.notes && (
              <div className="rounded-xl border border-dashed border-border bg-muted/20 p-8 text-center">
                <p className="text-sm text-muted-foreground">
                  No contact details on file for this provider.
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Ask an admin to update this record.
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-border bg-muted/20 flex items-center justify-center p-12">
            <p className="text-sm text-muted-foreground">Select a provider to view details.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default ProviderDirectory;
