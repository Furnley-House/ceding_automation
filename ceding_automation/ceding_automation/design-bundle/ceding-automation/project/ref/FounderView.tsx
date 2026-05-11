import { SectionHeader } from "@/components/shared/StatusComponents";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { TrendingDown, Clock, Phone, Shield, FileText, Cpu, ArrowDown, Users } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { getCases } from "@/services/api";

// Real-world baseline metrics (manual process)
const manualProcess = {
  callTimePerPlanMin: 30,    // minimum mins per plan call (waiting + dept changes)
  callTimePerPlanMax: 60,    // maximum mins per plan call
  callTimePerPlanAvg: 45,    // average
  pdfExtractionPerDoc: 15,   // mins to manually extract each PDF into checklist
  transcriptReviewTime: 7.5, // avg 5-10 mins reviewing transcript/notes after call
  contextSwitchingTime: 7.5, // avg 5-10 mins moving between documents, systems
  repeatCallsPerCase: 3,     // avg repeat calls needed
};

// With ProviderHub AI
const appProcess = {
  callTimePerPlanMin: 30,    // call duration stays same (waiting + dept changes)
  callTimePerPlanMax: 60,    // still 30-60 mins
  callTimePerPlanAvg: 45,    // same call duration
  pdfExtractionPerDoc: 2,    // AI auto-extraction takes ~2 mins
  transcriptReviewTime: 0,   // AI transcript Q&A eliminates manual review
  contextSwitchingTime: 0,   // everything in one place — no switching
  repeatCallsPerCase: 1.2,   // AI Q&A resolves most queries in first call
};

// Per-case totals
const manualPerCase = manualProcess.callTimePerPlanAvg + manualProcess.pdfExtractionPerDoc + manualProcess.transcriptReviewTime + manualProcess.contextSwitchingTime; // 75 min
const appPerCase = appProcess.callTimePerPlanAvg + appProcess.pdfExtractionPerDoc + appProcess.transcriptReviewTime + appProcess.contextSwitchingTime; // 47 min
// With repeat calls factored in
const manualTotalPerCase = manualProcess.callTimePerPlanAvg * manualProcess.repeatCallsPerCase + manualProcess.pdfExtractionPerDoc + manualProcess.transcriptReviewTime * manualProcess.repeatCallsPerCase + manualProcess.contextSwitchingTime * manualProcess.repeatCallsPerCase; // 315 min
const appTotalPerCase = Math.round(appProcess.callTimePerPlanAvg * appProcess.repeatCallsPerCase + appProcess.pdfExtractionPerDoc + appProcess.transcriptReviewTime * appProcess.repeatCallsPerCase + appProcess.contextSwitchingTime * appProcess.repeatCallsPerCase); // 56 min

const comparisonData = [
  { metric: 'PDF → Checklist (min)', before: manualProcess.pdfExtractionPerDoc, after: appProcess.pdfExtractionPerDoc },
  { metric: 'Transcript Review (min)', before: manualProcess.transcriptReviewTime, after: appProcess.transcriptReviewTime },
  { metric: 'Context Switching (min)', before: manualProcess.contextSwitchingTime, after: appProcess.contextSwitchingTime },
  { metric: 'Repeat Calls', before: manualProcess.repeatCallsPerCase, after: appProcess.repeatCallsPerCase },
];

const FounderView = () => {
  const { data: cases = [] } = useQuery({ queryKey: ["cases"], queryFn: getCases });

  const extractionSaving = Math.round((1 - appProcess.pdfExtractionPerDoc / manualProcess.pdfExtractionPerDoc) * 100);
  const transcriptSaving = Math.round((1 - appProcess.transcriptReviewTime / manualProcess.transcriptReviewTime) * 100);
  const switchingSaving = Math.round((1 - appProcess.contextSwitchingTime / manualProcess.contextSwitchingTime) * 100);
  const repeatSaving = Math.round((1 - appProcess.repeatCallsPerCase / manualProcess.repeatCallsPerCase) * 100);

  const minsPerCaseSaved = manualTotalPerCase - appTotalPerCase;
  const totalCases = cases.length;
  const projectedHoursSaved = Math.round((minsPerCaseSaved * Math.max(totalCases, 50)) / 60);

  return (
    <div className="animate-slide-in">
      <SectionHeader title="Founder View" subtitle="Measurable impact — ProviderHub vs manual workflow" />

      {/* Top KPIs */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 mb-6">
        <MetricCard
          icon={FileText} label="PDF Extraction Speed"
          value={`${extractionSaving}%`}
          detail={`${manualProcess.pdfExtractionPerDoc} min → ${appProcess.pdfExtractionPerDoc} min per document`}
          accent="success"
        />
        <MetricCard
          icon={Clock} label="Transcript Review"
          value={`${transcriptSaving}%`}
          detail={`${manualProcess.transcriptReviewTime} min → ${appProcess.transcriptReviewTime} min (AI Q&A)`}
          accent="success"
        />
        <MetricCard
          icon={Cpu} label="Context Switching"
          value={`${switchingSaving}%`}
          detail={`${manualProcess.contextSwitchingTime} min → ${appProcess.contextSwitchingTime} min (all-in-one)`}
          accent="success"
        />
        <MetricCard
          icon={TrendingDown} label="Fewer Repeat Calls"
          value={`${repeatSaving}%`}
          detail={`${manualProcess.repeatCallsPerCase} → ${appProcess.repeatCallsPerCase} calls per case`}
          accent="success"
        />
      </div>

      {/* Projected savings banner */}
      <div className="rounded-xl border border-success/30 bg-success/5 p-5 mb-6 flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-success/15 shrink-0">
          <ArrowDown className="h-6 w-6 text-success" />
        </div>
        <div>
          <p className="text-lg font-bold text-foreground">
            ~{minsPerCaseSaved} minutes saved per case
          </p>
          <p className="text-sm text-muted-foreground">
            Projected <strong className="text-foreground">{projectedHoursSaved} hours</strong> saved across {Math.max(totalCases, 50)} cases — freeing the CA team to handle {Math.round(minsPerCaseSaved / appTotalPerCase)}x more cases per day
          </p>
        </div>
      </div>

      {/* Team Weekly Capacity */}
      {(() => {
        const weeklyLow = 20;
        const weeklyHigh = 25;
        const weeklyAvg = 22.5;

        // Current: hours spent on 20-25 cedings
        const manualHoursLow = Math.round((weeklyLow * manualTotalPerCase) / 60);
        const manualHoursHigh = Math.round((weeklyHigh * manualTotalPerCase) / 60);

        // With ProviderHub: hours for same 20-25 cedings
        const appHoursLow = Math.round((weeklyLow * appTotalPerCase) / 60);
        const appHoursHigh = Math.round((weeklyHigh * appTotalPerCase) / 60);

        // Hours freed up
        const savedHoursLow = manualHoursLow - appHoursLow;
        const savedHoursHigh = manualHoursHigh - appHoursHigh;

        // If they use the same hours, how many cedings can they do?
        const manualMinsPerWeek = weeklyAvg * manualTotalPerCase;
        const newCapacity = Math.round(manualMinsPerWeek / appTotalPerCase);
        const capacityIncrease = Math.round(((newCapacity - weeklyAvg) / weeklyAvg) * 100);

        return (
          <div className="rounded-xl border border-border bg-card overflow-hidden mb-6">
            <div className="border-b border-border bg-muted/30 px-5 py-3 flex items-center gap-2">
              <Users className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">Team Weekly Capacity</h2>
            </div>
            <div className="p-5">
              <p className="text-xs text-muted-foreground mb-5">Based on current workload of {weeklyLow}–{weeklyHigh} cedings per week (whole team)</p>

              <div className="grid gap-4 sm:grid-cols-3 mb-6">
                <div className="rounded-lg border border-border p-4 text-center">
                  <p className="text-xs text-muted-foreground mb-1">Same workload, less time</p>
                  <p className="text-2xl font-bold text-success">{savedHoursLow}–{savedHoursHigh} hrs</p>
                  <p className="text-xs text-muted-foreground mt-1">freed up per week</p>
                </div>
                <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-center">
                  <p className="text-xs text-muted-foreground mb-1">Same hours, more output</p>
                  <p className="text-2xl font-bold text-primary">~{newCapacity} cedings</p>
                  <p className="text-xs text-muted-foreground mt-1">per week (+{capacityIncrease}%)</p>
                </div>
                <div className="rounded-lg border border-border p-4 text-center">
                  <p className="text-xs text-muted-foreground mb-1">Time per ceding</p>
                  <p className="text-2xl font-bold text-foreground">{Math.round(manualTotalPerCase / 60 * 10) / 10}h → {Math.round(appTotalPerCase / 60 * 10) / 10}h</p>
                  <p className="text-xs text-muted-foreground mt-1">per case reduction</p>
                </div>
              </div>

              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="py-2 text-left font-medium text-muted-foreground">Scenario</th>
                    <th className="py-2 text-right font-medium text-muted-foreground">Manual</th>
                    <th className="py-2 text-right font-medium text-muted-foreground">ProviderHub</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-border">
                    <td className="py-2.5 text-foreground">Weekly hours for {weeklyLow}–{weeklyHigh} cedings</td>
                    <td className="py-2.5 text-right text-overdue font-semibold">{manualHoursLow}–{manualHoursHigh} hrs</td>
                    <td className="py-2.5 text-right text-success font-semibold">{appHoursLow}–{appHoursHigh} hrs</td>
                  </tr>
                  <tr className="border-b border-border">
                    <td className="py-2.5 text-foreground">Cedings possible in {manualHoursLow}–{manualHoursHigh} hrs</td>
                    <td className="py-2.5 text-right text-muted-foreground">{weeklyLow}–{weeklyHigh}</td>
                    <td className="py-2.5 text-right text-primary font-semibold">~{newCapacity}</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 text-foreground font-semibold">Hours saved per week</td>
                    <td className="py-2.5 text-right text-muted-foreground">—</td>
                    <td className="py-2.5 text-right text-success font-bold">{savedHoursLow}–{savedHoursHigh} hrs ↓</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Before vs After Chart */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="border-b border-border bg-muted/30 px-5 py-3">
            <h2 className="text-sm font-semibold text-foreground">Before vs After ProviderHub</h2>
          </div>
          <div className="p-5">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={comparisonData}>
                <XAxis dataKey="metric" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip contentStyle={{ borderRadius: '8px', border: '1px solid hsl(214, 20%, 90%)', fontSize: '12px' }} />
                <Legend />
                <Bar dataKey="before" fill="hsl(0, 72%, 51%)" radius={[4, 4, 0, 0]} name="Manual Process" barSize={28} />
                <Bar dataKey="after" fill="hsl(152, 60%, 40%)" radius={[4, 4, 0, 0]} name="With ProviderHub" barSize={28} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Key Benefits */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="border-b border-border bg-muted/30 px-5 py-3">
            <h2 className="text-sm font-semibold text-foreground">How ProviderHub Saves Time</h2>
          </div>
          <div className="p-5 space-y-4">
            {[
              {
                icon: Cpu,
                title: 'AI PDF Extraction',
                desc: `Manual extraction takes ${manualProcess.pdfExtractionPerDoc} mins per document — reading, locating fields, and typing values into the checklist. ProviderHub AI does this in ~${appProcess.pdfExtractionPerDoc} mins with confidence scoring.`,
              },
              {
                icon: Phone,
                title: 'Call Duration Unchanged',
                desc: `Provider calls still take ${manualProcess.callTimePerPlanMin}–${manualProcess.callTimePerPlanMax} mins due to hold times and department transfers — but with structured scripts and a live checklist, agents capture everything in the first call.`,
              },
              {
                icon: Clock,
                title: 'No More Transcript Review',
                desc: `After each call, agents spend ${manualProcess.transcriptReviewTime} mins reviewing notes. AI transcript Q&A answers questions instantly — saving 5–10 mins per call.`,
              },
              {
                icon: ArrowDown,
                title: 'Zero Context Switching',
                desc: `RingCentral, provider directory, checklist, and plan extraction all in one place — eliminates ${manualProcess.contextSwitchingTime} mins of switching between documents and systems.`,
              },
              {
                icon: TrendingDown,
                title: 'Fewer Follow-up Calls',
                desc: `Teams currently make ~${manualProcess.repeatCallsPerCase} calls per case due to missed data. AI transcript analysis and structured resolution cuts this to ~${appProcess.repeatCallsPerCase} calls.`,
              },
              {
                icon: Shield,
                title: 'Audit-Ready Evidence',
                desc: 'Every field links to its source — PDF page, call transcript, or manual entry — eliminating re-verification during compliance reviews.',
              },
            ].map(item => (
              <div key={item.title} className="flex items-start gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 shrink-0">
                  <item.icon className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">{item.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Process Breakdown Table */}
      <div className="rounded-xl border border-border bg-card overflow-hidden mt-6">
        <div className="border-b border-border bg-muted/30 px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">Per-Case Time Breakdown</h2>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="px-5 py-2.5 text-left font-medium text-muted-foreground">Activity</th>
              <th className="px-5 py-2.5 text-right font-medium text-muted-foreground">Manual</th>
              <th className="px-5 py-2.5 text-right font-medium text-muted-foreground">ProviderHub</th>
              <th className="px-5 py-2.5 text-right font-medium text-muted-foreground">Saved</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border">
              <td className="px-5 py-3 text-foreground">Provider call (per plan)</td>
              <td className="px-5 py-3 text-right text-muted-foreground">{manualProcess.callTimePerPlanMin}–{manualProcess.callTimePerPlanMax} min</td>
              <td className="px-5 py-3 text-right text-foreground font-medium">{appProcess.callTimePerPlanMin}–{appProcess.callTimePerPlanMax} min</td>
              <td className="px-5 py-3 text-right text-muted-foreground">Same</td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-5 py-3 text-foreground">PDF extraction → checklist</td>
              <td className="px-5 py-3 text-right text-muted-foreground">{manualProcess.pdfExtractionPerDoc} min</td>
              <td className="px-5 py-3 text-right text-foreground font-medium">~{appProcess.pdfExtractionPerDoc} min</td>
              <td className="px-5 py-3 text-right text-success font-semibold">{manualProcess.pdfExtractionPerDoc - appProcess.pdfExtractionPerDoc} min</td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-5 py-3 text-foreground">Transcript review (per call)</td>
              <td className="px-5 py-3 text-right text-muted-foreground">5–10 min</td>
              <td className="px-5 py-3 text-right text-foreground font-medium">0 min (AI Q&A)</td>
              <td className="px-5 py-3 text-right text-success font-semibold">~{manualProcess.transcriptReviewTime} min</td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-5 py-3 text-foreground">Context switching</td>
              <td className="px-5 py-3 text-right text-muted-foreground">5–10 min</td>
              <td className="px-5 py-3 text-right text-foreground font-medium">0 min (all-in-one)</td>
              <td className="px-5 py-3 text-right text-success font-semibold">~{manualProcess.contextSwitchingTime} min</td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-5 py-3 text-foreground">Repeat/follow-up calls</td>
              <td className="px-5 py-3 text-right text-muted-foreground">{manualProcess.repeatCallsPerCase} calls</td>
              <td className="px-5 py-3 text-right text-foreground font-medium">{appProcess.repeatCallsPerCase} calls</td>
              <td className="px-5 py-3 text-right text-success font-semibold">{(manualProcess.repeatCallsPerCase - appProcess.repeatCallsPerCase).toFixed(1)} fewer</td>
            </tr>
            <tr className="bg-muted/20">
              <td className="px-5 py-3 text-foreground font-semibold">Total per case (with repeats)</td>
              <td className="px-5 py-3 text-right text-overdue font-bold">{manualTotalPerCase} min</td>
              <td className="px-5 py-3 text-right text-success font-bold">{appTotalPerCase} min</td>
              <td className="px-5 py-3 text-right text-success font-bold">{minsPerCaseSaved} min ↓</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ── Sub-component ──

function MetricCard({ icon: Icon, label, value, detail, accent }: {
  icon: React.ElementType; label: string; value: string; detail: string;
  accent: 'success' | 'primary' | 'warning';
}) {
  const iconBg = accent === 'success' ? 'bg-success/10 text-success'
    : accent === 'primary' ? 'bg-primary/10 text-primary'
    : 'bg-warning/10 text-warning';

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-3">
        <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${iconBg}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <p className="text-2xl font-bold text-foreground">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">{detail}</p>
    </div>
  );
}

export default FounderView;
