import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { CaseRow } from "@/lib/caseHelpers";
import { providers as seedProviders, type Provider } from "@/data/seedData";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  Globe,
  Mail,
  Truck,
  ExternalLink,
  CheckCircle2,
  Copy,
  RotateCw,
} from "lucide-react";

type Method = "origo" | "email" | "courier";

interface Props {
  caseItem: CaseRow;
}

function findProvider(name: string): Provider | undefined {
  const n = name.trim().toLowerCase();
  return seedProviders.find(
    (p) =>
      p.name.toLowerCase() === n ||
      p.aliases.some((a) => a.toLowerCase() === n),
  );
}

function pickRoutingEmail(provider: Provider | undefined, planRef: string | null) {
  if (!provider) return { email: null as string | null, department: null as string | null };
  const ref = (planRef ?? "").toUpperCase().trim();
  if (ref) {
    const match = provider.routingRules.find((r) => ref.startsWith(r.planPrefix.toUpperCase()));
    if (match?.email) return { email: match.email, department: match.department };
  }
  return { email: provider.email, department: "General" };
}

const STATUS_LABEL: Record<string, string> = {
  not_sent: "Not sent",
  sent: "LOA sent — awaiting processing",
  processed: "Processed by provider",
  received: "LOA received & confirmed",
};

export function SendLOAWorkspace({ caseItem }: Props) {
  const qc = useQueryClient();
  const provider = useMemo(() => findProvider(caseItem.Provider_group), [caseItem.Provider_group]);
  const planRef = (caseItem as any).plan_ref ?? caseItem.plan_number ?? null;
  const routing = useMemo(() => pickRoutingEmail(provider, planRef), [provider, planRef]);

  const initialMethod: Method =
    ((caseItem as any).loa_method as Method) ??
    (provider?.origoSupported ? "origo" : "email");
  const [method, setMethod] = useState<Method>(initialMethod);
  const [trackingRef, setTrackingRef] = useState<string>(
    (caseItem as any).loa_tracking_ref ?? "",
  );
  const [notes, setNotes] = useState<string>((caseItem as any).loa_notes ?? "");

  const status: string = (caseItem as any).loa_status ?? "not_sent";

  const updateMutation = useMutation({
    mutationFn: async (updates: Record<string, any>) => {
      await api.patch(`/cases/${caseItem.id}`, {
        ...updates,
        lastActivityAt: new Date().toISOString(),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["case", caseItem.id] });
      qc.invalidateQueries({ queryKey: ["cases"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const subject = `Letter of Authority - ${caseItem.client_name} - ${caseItem.plan_number}`;
  const initialBody = `Dear ${provider?.name ?? caseItem.Provider_group} Team,

Please find attached a signed Letter of Authority for the following client:

  Client name: ${caseItem.client_name}
  Plan / Policy reference: ${caseItem.plan_number}
  Plan type: ${caseItem.plan_type}
  Case reference: ${caseItem.case_ref}

Please provide a full policy information pack at your earliest convenience, including current valuation, charges, fund holdings, guarantees and any relevant benefits.

If you require any further information to process this request, please reply to this email.

Kind regards,
ProviderHub on behalf of the client`;

  const followUpBody = `Dear ${provider?.name ?? caseItem.Provider_group} Team,

I am following up on a Letter of Authority sent on behalf of ${caseItem.client_name} (Policy ref: ${caseItem.plan_number}, Case ref: ${caseItem.case_ref}).

Could you please confirm receipt and provide an expected turnaround for the policy information pack?

Kind regards,
ProviderHub`;

  // Use encodeURIComponent (not URLSearchParams) so spaces become %20 instead of "+".
  // Outlook Web's deeplink renders "+" literally in the body.
  const buildMailto = (body: string) => {
    const to = routing.email ?? provider?.email ?? "";
    return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  const buildOutlookWebUrl = (body: string) => {
    const to = routing.email ?? provider?.email ?? "";
    const qs =
      `path=${encodeURIComponent("/mail/action/compose")}` +
      `&to=${encodeURIComponent(to)}` +
      `&subject=${encodeURIComponent(subject)}` +
      `&body=${encodeURIComponent(body)}`;
    return `https://outlook.office.com/mail/deeplink/compose?${qs}`;
  };

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied`);
    } catch {
      toast.error("Copy failed");
    }
  };

  const markSent = () => {
    updateMutation.mutate(
      {
        loa_method: method,
        loa_status: "sent",
        loa_tracking_ref: trackingRef || null,
        loa_notes: notes || null,
        loa_sent_date: new Date().toISOString().slice(0, 10),
      },
      { onSuccess: () => toast.success("LOA marked as sent") },
    );
  };

  const markProcessed = () => {
    updateMutation.mutate(
      { loa_status: "processed", loa_notes: notes || null },
      { onSuccess: () => toast.success("LOA marked as processed") },
    );
  };

  const markReceived = () => {
    updateMutation.mutate(
      {
        loa_status: "received",
        loa_notes: notes || null,
        pdf_received_date: new Date().toISOString().slice(0, 10),
      },
      { onSuccess: () => toast.success("LOA received — ready for document upload") },
    );
  };

  const reset = () => {
    updateMutation.mutate(
      { loa_status: "not_sent", loa_sent_date: null },
      { onSuccess: () => toast.success("LOA send reset") },
    );
  };

  return (
    <div className="space-y-4">
      {/* Status banner */}
      <div className="rounded-md border border-border bg-muted/30 p-3 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 text-sm">
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full ${
              status === "received"
                ? "bg-success"
                : status === "processed"
                ? "bg-primary"
                : status === "sent"
                ? "bg-warning"
                : "bg-muted-foreground"
            }`}
          />
          <span className="font-semibold text-foreground">{STATUS_LABEL[status]}</span>
          {(caseItem as any).loa_method && (
            <span className="text-xs text-muted-foreground">
              · via {((caseItem as any).loa_method as string).toUpperCase()}
            </span>
          )}
        </div>
        {status !== "not_sent" && (
          <Button variant="ghost" size="sm" onClick={reset} className="gap-1 text-xs">
            <RotateCw className="h-3 w-3" /> Reset
          </Button>
        )}
      </div>

      {/* Method selector */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <MethodTile
          icon={Globe}
          title="Origo"
          subtitle={provider?.origoSupported ? "Recommended for this provider" : "Not supported by provider"}
          active={method === "origo"}
          disabled={!provider?.origoSupported}
          onClick={() => setMethod("origo")}
        />
        <MethodTile
          icon={Mail}
          title="Email"
          subtitle="Send via Outlook to provider"
          active={method === "email"}
          onClick={() => setMethod("email")}
        />
        <MethodTile
          icon={Truck}
          title="Courier"
          subtitle="Offline — track manually"
          active={method === "courier"}
          onClick={() => setMethod("courier")}
        />
      </div>

      {/* Method-specific panels */}
      {method === "origo" && (
        <OrigoPanel
          provider={provider}
          trackingRef={trackingRef}
          setTrackingRef={setTrackingRef}
          notes={notes}
          setNotes={setNotes}
          status={status}
          onSent={markSent}
          onReceived={markReceived}
          pending={updateMutation.isPending}
        />
      )}

      {method === "email" && (
        <EmailPanel
          provider={provider}
          routing={routing}
          planRef={planRef}
          subject={subject}
          initialBody={initialBody}
          followUpBody={followUpBody}
          buildMailto={buildMailto}
          buildOutlookWebUrl={buildOutlookWebUrl}
          copy={copy}
          notes={notes}
          setNotes={setNotes}
          status={status}
          onSent={markSent}
          onProcessed={markProcessed}
          onReceived={markReceived}
          pending={updateMutation.isPending}
        />
      )}

      {method === "courier" && (
        <CourierPanel
          trackingRef={trackingRef}
          setTrackingRef={setTrackingRef}
          notes={notes}
          setNotes={setNotes}
          status={status}
          onSent={markSent}
          onProcessed={markProcessed}
          onReceived={markReceived}
          pending={updateMutation.isPending}
        />
      )}
    </div>
  );
}

function MethodTile({
  icon: Icon,
  title,
  subtitle,
  active,
  disabled,
  onClick,
}: {
  icon: React.ElementType;
  title: string;
  subtitle: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`text-left rounded-md border p-3 transition-all ${
        active
          ? "border-teal bg-teal/10 ring-2 ring-teal/30"
          : "border-border bg-card hover:border-teal/40"
      } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      <div className="flex items-center gap-2 mb-1">
        <Icon className={`h-4 w-4 ${active ? "text-teal" : "text-muted-foreground"}`} />
        <p className="text-sm font-bold theme-heading text-foreground">{title}</p>
      </div>
      <p className="text-xs text-muted-foreground">{subtitle}</p>
    </button>
  );
}

function OrigoPanel({
  provider,
  trackingRef,
  setTrackingRef,
  notes,
  setNotes,
  status,
  onSent,
  onReceived,
  pending,
}: {
  provider: Provider | undefined;
  trackingRef: string;
  setTrackingRef: (v: string) => void;
  notes: string;
  setNotes: (v: string) => void;
  status: string;
  onSent: () => void;
  onReceived: () => void;
  pending: boolean;
}) {
  if (!provider?.origoSupported) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/20 p-6 text-center">
        <p className="text-sm text-foreground font-semibold">
          {provider?.name ?? "This provider"} does not support Origo
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          Switch to Email or Courier above.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3 rounded-md border border-border bg-card p-4">
      <div>
        <p className="text-[11px] uppercase tracking-widest font-bold text-muted-foreground mb-1">
          Origo portal
        </p>
        <p className="text-sm text-foreground">{provider.name}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            asChild
            size="sm"
            className="gap-1.5"
          >
            <a
              href="https://loa.unipass.co.uk/login"
              target="_blank"
              rel="noreferrer"
            >
              <Globe className="h-4 w-4" /> Proceed with Origo (Unipass)
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Button>
          {provider.portalUrl && (
            <a
              href={provider.portalUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-teal hover:underline"
            >
              Provider portal <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground mt-1">
          Submit the LOA on Unipass, then paste the Origo reference below.
        </p>
      </div>

      <div>
        <Label className="text-xs">Origo reference (after sending)</Label>
        <Input
          value={trackingRef}
          onChange={(e) => setTrackingRef(e.target.value)}
          placeholder="e.g. ORG-2026-018273"
          className="mt-1"
        />
      </div>

      <div>
        <Label className="text-xs">Notes</Label>
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional notes (date sent, name on case…)"
          rows={2}
          className="mt-1"
        />
      </div>

      <div className="flex flex-wrap gap-2 pt-1">
        {status === "not_sent" && (
          <Button onClick={onSent} disabled={pending} className="gap-1.5">
            <CheckCircle2 className="h-4 w-4" /> Mark LOA sent via Origo
          </Button>
        )}
        {status === "sent" && (
          <Button onClick={onReceived} disabled={pending} className="gap-1.5">
            <CheckCircle2 className="h-4 w-4" /> Mark response received
          </Button>
        )}
        {status === "received" && (
          <span className="inline-flex items-center gap-1.5 text-sm text-success font-semibold">
            <CheckCircle2 className="h-4 w-4" /> Response received — proceed to Document Upload
          </span>
        )}
      </div>
    </div>
  );
}

function EmailPanel({
  provider,
  routing,
  planRef,
  subject,
  initialBody,
  followUpBody,
  buildMailto,
  buildOutlookWebUrl,
  copy,
  notes,
  setNotes,
  status,
  onSent,
  onProcessed,
  onReceived,
  pending,
}: {
  provider: Provider | undefined;
  routing: { email: string | null; department: string | null };
  planRef: string | null;
  subject: string;
  initialBody: string;
  followUpBody: string;
  buildMailto: (body: string) => string;
  buildOutlookWebUrl: (body: string) => string;
  copy: (text: string, label: string) => void;
  notes: string;
  setNotes: (v: string) => void;
  status: string;
  onSent: () => void;
  onProcessed: () => void;
  onReceived: () => void;
  pending: boolean;
}) {
  const [body, setBody] = useState(initialBody);
  const [activeTab, setActiveTab] = useState<"initial" | "followup">("initial");

  const usingFallback = routing.department === "General" || !planRef;

  return (
    <div className="space-y-3 rounded-md border border-border bg-card p-4">
      {/* Recipient resolution */}
      <div className="rounded-md bg-muted/30 border border-border p-3">
        <p className="text-[11px] uppercase tracking-widest font-bold text-muted-foreground mb-2">
          Recipient (resolved from Provider Directory)
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
          <div>
            <p className="text-[10px] uppercase text-muted-foreground">Provider</p>
            <p className="text-foreground">{provider?.name ?? "Unknown — add to directory"}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase text-muted-foreground">Department</p>
            <p className="text-foreground">{routing.department ?? "—"}</p>
          </div>
          <div className="md:col-span-2">
            <p className="text-[10px] uppercase text-muted-foreground">To address</p>
            <div className="flex items-center gap-2">
              <p className="text-foreground font-mono text-xs">{routing.email ?? "—"}</p>
              {routing.email && (
                <button
                  type="button"
                  onClick={() => copy(routing.email!, "Email")}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Copy email"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {usingFallback && (
              <p className="text-[11px] text-warning mt-1">
                {planRef
                  ? "No routing rule matched the policy prefix — using general provider email."
                  : "No policy reference — using general provider email."}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        <TabBtn active={activeTab === "initial"} onClick={() => { setActiveTab("initial"); setBody(initialBody); }}>
          Initial LOA email
        </TabBtn>
        <TabBtn active={activeTab === "followup"} onClick={() => { setActiveTab("followup"); setBody(followUpBody); }}>
          Follow-up email
        </TabBtn>
      </div>

      <div>
        <Label className="text-xs">Subject</Label>
        <Input value={subject} readOnly className="mt-1 font-mono text-xs" />
      </div>

      <div>
        <Label className="text-xs">Body</Label>
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={10}
          className="mt-1 text-xs font-mono"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button asChild className="gap-1.5">
          <a href={buildOutlookWebUrl(body)} target="_blank" rel="noreferrer">
            <Mail className="h-4 w-4" /> Open in Outlook Web
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </Button>
        <Button asChild variant="outline" className="gap-1.5">
          <a href={buildMailto(body)}>
            <Mail className="h-4 w-4" /> Open in desktop mail
          </a>
        </Button>
        <Button variant="outline" onClick={() => copy(body, "Body")} className="gap-1.5">
          <Copy className="h-4 w-4" /> Copy body
        </Button>
      </div>

      <div>
        <Label className="text-xs">Notes</Label>
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional internal notes (who sent it, when, follow-up date…)"
          rows={2}
          className="mt-1"
        />
      </div>

      <div className="flex flex-wrap gap-2 pt-1 border-t border-border">
        {status === "not_sent" && activeTab === "initial" && (
          <Button onClick={onSent} disabled={pending} className="gap-1.5">
            <CheckCircle2 className="h-4 w-4" /> Mark LOA sent
          </Button>
        )}
        {status === "sent" && (
          <>
            <Button onClick={onProcessed} disabled={pending} variant="outline" className="gap-1.5">
              Mark provider acknowledged
            </Button>
            <Button onClick={onReceived} disabled={pending} className="gap-1.5">
              <CheckCircle2 className="h-4 w-4" /> Mark response received
            </Button>
          </>
        )}
        {status === "processed" && (
          <Button onClick={onReceived} disabled={pending} className="gap-1.5">
            <CheckCircle2 className="h-4 w-4" /> Mark response received
          </Button>
        )}
        {status === "received" && (
          <span className="inline-flex items-center gap-1.5 text-sm text-success font-semibold">
            <CheckCircle2 className="h-4 w-4" /> Response received — proceed to Document Upload
          </span>
        )}
      </div>
    </div>
  );
}

function CourierPanel({
  trackingRef,
  setTrackingRef,
  notes,
  setNotes,
  status,
  onSent,
  onProcessed,
  onReceived,
  pending,
}: {
  trackingRef: string;
  setTrackingRef: (v: string) => void;
  notes: string;
  setNotes: (v: string) => void;
  status: string;
  onSent: () => void;
  onProcessed: () => void;
  onReceived: () => void;
  pending: boolean;
}) {
  return (
    <div className="space-y-3 rounded-md border border-border bg-card p-4">
      <div className="rounded-md bg-warning/10 border border-warning/40 p-3 text-xs text-foreground">
        This provider only accepts <strong>physical / courier</strong> LOAs. Send the LOA pack
        via your courier of choice and track manually below — no automated submission is possible.
      </div>

      <div>
        <Label className="text-xs">Courier tracking number</Label>
        <Input
          value={trackingRef}
          onChange={(e) => setTrackingRef(e.target.value)}
          placeholder="e.g. RM-AB1234567GB"
          className="mt-1"
        />
      </div>

      <div>
        <Label className="text-xs">Notes</Label>
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Courier name, dispatch date, expected delivery…"
          rows={3}
          className="mt-1"
        />
      </div>

      <div className="flex flex-wrap gap-2 pt-1">
        {status === "not_sent" && (
          <Button onClick={onSent} disabled={pending} className="gap-1.5">
            <CheckCircle2 className="h-4 w-4" /> Mark LOA dispatched
          </Button>
        )}
        {status === "sent" && (
          <Button onClick={onProcessed} disabled={pending} variant="outline" className="gap-1.5">
            Mark delivered to provider
          </Button>
        )}
        {(status === "sent" || status === "processed") && (
          <Button onClick={onReceived} disabled={pending} className="gap-1.5">
            <CheckCircle2 className="h-4 w-4" /> Mark response received
          </Button>
        )}
        {status === "received" && (
          <span className="inline-flex items-center gap-1.5 text-sm text-success font-semibold">
            <CheckCircle2 className="h-4 w-4" /> Response received — proceed to Document Upload
          </span>
        )}
      </div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 text-xs font-semibold border-b-2 -mb-px transition-colors ${
        active
          ? "border-teal text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
