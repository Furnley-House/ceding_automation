import { providers } from "@/data/seedData";
import { SectionHeader } from "@/components/shared/StatusComponents";
import { useState } from "react";
import { Search, ExternalLink, CheckCircle, XCircle } from "lucide-react";

const ProviderDirectory = () => {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(providers[0].id);

  const filtered = providers.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    p.aliases.some(a => a.toLowerCase().includes(search.toLowerCase()))
  );

  const active = providers.find(p => p.id === selected);

  return (
    <div className="animate-slide-in">
      <SectionHeader title="Provider Directory" subtitle={`${providers.length} providers configured`} />

      <div className="grid gap-6 lg:grid-cols-3">
        {/* List */}
        <div className="rounded-xl border border-border bg-card">
          <div className="p-3 border-b border-border">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                placeholder="Search providers…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="h-9 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
          <div className="max-h-[500px] overflow-y-auto scrollbar-thin">
            {filtered.map(p => (
              <button
                key={p.id}
                onClick={() => setSelected(p.id)}
                className={`flex w-full items-center justify-between px-4 py-3 text-left transition-colors ${selected === p.id ? 'bg-primary/10' : 'hover:bg-muted/50'}`}
              >
                <div>
                  <p className="text-sm font-medium text-foreground">{p.name}</p>
                  <p className="text-xs text-muted-foreground">{p.aliases.join(', ')}</p>
                </div>
                {p.origoSupported ? (
                  <CheckCircle className="h-4 w-4 text-success shrink-0" />
                ) : (
                  <XCircle className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Detail */}
        {active && (
          <div className="lg:col-span-2 space-y-6">
            <div className="rounded-xl border border-border bg-card p-6">
              <h2 className="mb-4 text-lg font-semibold text-foreground">{active.name}</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <div><p className="text-xs text-muted-foreground">Phone</p><p className="text-sm font-medium text-foreground">{active.phone}</p></div>
                <div><p className="text-xs text-muted-foreground">Email</p><p className="text-sm font-medium text-foreground">{active.email}</p></div>
                <div><p className="text-xs text-muted-foreground">Origo Supported</p><p className="text-sm font-medium text-foreground">{active.origoSupported ? 'Yes' : 'No'}</p></div>
                <div><p className="text-xs text-muted-foreground">Avg Turnaround</p><p className="text-sm font-medium text-foreground">{active.avgTurnaround} days</p></div>
                <div><p className="text-xs text-muted-foreground">Aliases</p><p className="text-sm text-foreground">{active.aliases.join(', ')}</p></div>
                <div><p className="text-xs text-muted-foreground">Last Verified</p><p className="text-sm text-foreground">{active.lastVerified}</p></div>
                {active.portalUrl && (
                  <div className="sm:col-span-2">
                    <p className="text-xs text-muted-foreground">Portal</p>
                    <a href={active.portalUrl} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                      {active.portalUrl} <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                )}
              </div>
            </div>

            {/* Routing Rules */}
            <div className="rounded-xl border border-border bg-card p-6">
              <h3 className="mb-3 text-sm font-semibold text-foreground">Routing Rules</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="pb-2 text-left text-xs font-medium text-muted-foreground">Plan Prefix</th>
                    <th className="pb-2 text-left text-xs font-medium text-muted-foreground">Department</th>
                    <th className="pb-2 text-left text-xs font-medium text-muted-foreground">Phone</th>
                    <th className="pb-2 text-left text-xs font-medium text-muted-foreground">Email</th>
                  </tr>
                </thead>
                <tbody>
                  {active.routingRules.map((r, i) => (
                    <tr key={i} className="border-b border-border last:border-0">
                      <td className="py-2 font-mono text-foreground">{r.planPrefix}</td>
                      <td className="py-2 text-foreground">{r.department}</td>
                      <td className="py-2 text-muted-foreground">{r.phone}</td>
                      <td className="py-2 text-muted-foreground">{r.email || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Jargon Map */}
            {active.jargonMap.length > 0 && (
              <div className="rounded-xl border border-border bg-card p-6">
                <h3 className="mb-3 text-sm font-semibold text-foreground">Common Jargon Map</h3>
                <div className="space-y-2">
                  {active.jargonMap.map((j, i) => (
                    <div key={i} className="flex items-center gap-3 text-sm">
                      <span className="text-muted-foreground">"{j.providerTerm}"</span>
                      <span className="text-muted-foreground">→</span>
                      <span className="font-medium text-foreground">{j.standardTerm}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ProviderDirectory;
