import { automationRules } from "@/data/seedData";
import { SectionHeader } from "@/components/shared/StatusComponents";
import { useState } from "react";
import { Zap, Clock, Mail, AlertCircle, Bell } from "lucide-react";

const iconMap: Record<string, typeof Zap> = {
  'auto-1': Clock,
  'auto-2': Mail,
  'auto-3': AlertCircle,
  'auto-4': Bell,
  'auto-5': AlertCircle,
};

const Automations = () => {
  const [rules, setRules] = useState(automationRules);

  const toggle = (id: string) => {
    setRules(prev => prev.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r));
  };

  return (
    <div className="animate-slide-in">
      <SectionHeader
        title="Automations"
        subtitle="Rules, templates, and SLA timers"
        action={
          <button className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
            + New Rule
          </button>
        }
      />

      <div className="space-y-4">
        {rules.map(rule => {
          const Icon = iconMap[rule.id] || Zap;
          return (
            <div key={rule.id} className={`rounded-xl border bg-card p-5 transition-colors ${rule.enabled ? 'border-border' : 'border-border opacity-60'}`}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${rule.enabled ? 'bg-primary/10' : 'bg-muted'}`}>
                    <Icon className={`h-4 w-4 ${rule.enabled ? 'text-primary' : 'text-muted-foreground'}`} />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">{rule.name}</p>
                    <div className="mt-1 flex flex-col gap-0.5">
                      <p className="text-xs text-muted-foreground"><span className="font-medium">IF</span> {rule.trigger}</p>
                      <p className="text-xs text-muted-foreground"><span className="font-medium">THEN</span> {rule.action}</p>
                    </div>
                    {rule.lastTriggered && (
                      <p className="mt-1 text-xs text-muted-foreground">Last triggered: {rule.lastTriggered}</p>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => toggle(rule.id)}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${rule.enabled ? 'bg-primary' : 'bg-border'}`}
                >
                  <span className={`inline-block h-4 w-4 rounded-full bg-card shadow transition-transform ${rule.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Email Templates */}
      <div className="mt-10">
        <h2 className="mb-4 text-lg font-semibold text-foreground">Email Templates</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {['LOA Chase — Day 14', 'LOA Chase — Day 21 (Escalation)', 'Missing Fields Request'].map(name => (
            <div key={name} className="rounded-xl border border-border bg-card p-4 hover:bg-muted/30 transition-colors cursor-pointer">
              <Mail className="mb-2 h-5 w-5 text-primary" />
              <p className="text-sm font-medium text-foreground">{name}</p>
              <p className="mt-1 text-xs text-muted-foreground">Professional, FCA-compliant template</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default Automations;
