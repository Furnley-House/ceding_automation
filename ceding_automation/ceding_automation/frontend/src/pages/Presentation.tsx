import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronLeft, ChevronRight, Maximize, Minimize, X,
  FileText, Phone, Clock, Shield, Cpu, TrendingDown, ArrowDown, Users, CheckCircle, Zap
} from "lucide-react";

// Metrics
const manual = { callAvg: 45, pdfExtract: 15, transcriptReview: 7.5, contextSwitch: 7.5, repeatCalls: 3 };
const app = { callAvg: 45, pdfExtract: 2, transcriptReview: 0, contextSwitch: 0, repeatCalls: 1.2 };
const manualTotal = Math.round(manual.callAvg * manual.repeatCalls + manual.pdfExtract + manual.transcriptReview * manual.repeatCalls + manual.contextSwitch * manual.repeatCalls);
const appTotal = Math.round(app.callAvg * app.repeatCalls + app.pdfExtract + app.transcriptReview * app.repeatCalls + app.contextSwitch * app.repeatCalls);
const saved = manualTotal - appTotal;

const slides: React.FC[] = [
  // 1 — Title
  () => (
    <div className="flex flex-col items-center justify-center h-full bg-gradient-to-br from-[hsl(197,71%,20%)] to-[hsl(197,71%,10%)] text-white px-20">
      <div className="flex items-center gap-4 mb-8">
        <div className="w-16 h-16 rounded-2xl bg-white/10 backdrop-blur flex items-center justify-center">
          <Shield className="w-8 h-8 text-[hsl(173,58%,39%)]" />
        </div>
        <h1 className="text-7xl font-bold tracking-tight">ProviderHub</h1>
      </div>
      <h2 className="text-3xl font-light text-white/80 mb-4">AI-powered LOA → Ceding Automation</h2>
      <div className="flex gap-6 mt-8 text-lg text-white/60">
        <span className="flex items-center gap-2"><Cpu className="w-5 h-5" /> AI extraction</span>
        <span className="flex items-center gap-2"><Phone className="w-5 h-5" /> Fewer calls</span>
        <span className="flex items-center gap-2"><Shield className="w-5 h-5" /> Full audit trail</span>
      </div>
      <p className="mt-16 text-sm text-white/40">Production workflow · February 2026</p>
    </div>
  ),

  // 2 — The Problem
  () => (
    <div className="flex flex-col h-full bg-white px-20 py-16">
      <h2 className="text-4xl font-bold text-[hsl(197,71%,20%)] mb-2">The Problem</h2>
      <p className="text-lg text-gray-500 mb-10">Manual, call-heavy, no evidence trail</p>
      <div className="grid grid-cols-3 gap-8 flex-1">
        {[
          { icon: Phone, title: "Expensive Calls", items: ["30–60 min on-hold per call", "3 calls per case (missing data)", "5–10 min reviewing notes after each"], color: "hsl(0,72%,51%)" },
          { icon: FileText, title: "200+ PDF Formats", items: ["15 min manual extraction per doc", "Each provider uses different terms", "Tribal knowledge — new joiners struggle"], color: "hsl(38,92%,50%)" },
          { icon: Shield, title: "No Evidence Trail", items: ["Values copied without source links", "Adviser doubts → more calls", "5–10 min context switching per case"], color: "hsl(0,72%,51%)" },
        ].map(c => (
          <div key={c.title} className="rounded-xl border-2 border-gray-100 p-8">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${c.color}15` }}>
                <c.icon className="w-5 h-5" style={{ color: c.color }} />
              </div>
              <h3 className="text-xl font-bold text-gray-900">{c.title}</h3>
            </div>
            <ul className="space-y-3">
              {c.items.map((item, i) => (
                <li key={i} className="flex items-start gap-2 text-gray-600">
                  <span className="w-1.5 h-1.5 rounded-full mt-2 shrink-0" style={{ backgroundColor: c.color }} />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="mt-8 p-5 rounded-xl bg-red-50 border border-red-200">
        <p className="text-lg font-semibold text-red-800">Result: ~{manualTotal} min per case · {manual.repeatCalls} calls per case · 65–81 hrs/week for 20–25 cedings</p>
      </div>
    </div>
  ),

  // 3 — The Solution (pipeline + principles merged)
  () => (
    <div className="flex flex-col h-full bg-white px-20 py-16">
      <h2 className="text-4xl font-bold text-[hsl(197,71%,20%)] mb-2">The Solution</h2>
      <p className="text-lg text-gray-500 mb-10">From "chase & copy" to "extract & verify" — one pipeline, six steps</p>
      <div className="flex gap-4 mb-10">
        {[
          { n: "1", t: "Create Case", color: "hsl(197,71%,20%)" },
          { n: "2", t: "Track LOA", color: "hsl(197,71%,28%)" },
          { n: "3", t: "Ingest PDF", color: "hsl(173,58%,39%)" },
          { n: "4", t: "AI Extract", color: "hsl(173,58%,32%)" },
          { n: "5", t: "Resolve Gaps", color: "hsl(38,92%,50%)" },
          { n: "6", t: "Ceding Ready", color: "hsl(152,60%,40%)" },
        ].map((s, i) => (
          <div key={i} className="flex-1 flex flex-col items-center">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center text-white text-xl font-bold mb-3" style={{ backgroundColor: s.color }}>{s.n}</div>
            <p className="text-sm font-bold text-gray-900 text-center">{s.t}</p>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-6 flex-1">
        {[
          { icon: Cpu, title: "Standard output schema", desc: "Different PDFs → one data model. Every field stores value, confidence, and evidence link." },
          { icon: Zap, title: "Digital rails first", desc: "Portal / email before phone. Calls become last resort — shorter with structured scripts." },
          { icon: Shield, title: "Evidence & audit trail", desc: "Click any value → see PDF snippet or call transcript timestamp. Fewer 'confirm again' calls." },
          { icon: Users, title: "Provider intelligence", desc: "Correct numbers, departments, jargon mapping, plan-prefix rules — tribal knowledge captured once." },
        ].map(item => (
          <div key={item.title} className="flex items-start gap-4 p-5 rounded-xl border-2 border-gray-100">
            <div className="w-10 h-10 rounded-lg bg-[hsl(173,58%,39%)]/10 flex items-center justify-center shrink-0">
              <item.icon className="w-5 h-5 text-[hsl(173,58%,39%)]" />
            </div>
            <div>
              <p className="text-lg font-bold text-gray-900">{item.title}</p>
              <p className="text-sm text-gray-500 mt-1">{item.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  ),

  // 4 — AI in Action (all AI features on one slide)
  () => (
    <div className="flex flex-col h-full bg-white px-20 py-16">
      <h2 className="text-4xl font-bold text-[hsl(197,71%,20%)] mb-2">AI in Action</h2>
      <p className="text-lg text-gray-500 mb-10">Four AI capabilities that eliminate manual work</p>
      <div className="grid grid-cols-2 gap-6 flex-1">
        {[
          { icon: Cpu, title: "PDF → Checklist in 2 min", desc: `AI extracts all fields from provider PDFs with confidence scoring. Manual: ${manual.pdfExtract} min → AI: ~${app.pdfExtract} min per document. Evidence links back to exact page.`, accent: "hsl(173,58%,39%)", tag: "−87% time" },
          { icon: Clock, title: "Transcript Q&A", desc: `AI answers questions from call transcripts instantly — no manual review. Saves ${manual.transcriptReview} min per call. Ask "what's the transfer value?" and get the answer with timestamp.`, accent: "hsl(197,71%,20%)", tag: "−100% review" },
          { icon: FileText, title: "Smart Call Scripts", desc: `AI generates provider-specific questions for missing fields. Structured scripts ensure everything is captured in one call — cutting repeat calls from ${manual.repeatCalls} to ${app.repeatCalls}.`, accent: "hsl(38,92%,50%)", tag: "−60% calls" },
          { icon: Users, title: "Jargon Mapping", desc: "Each provider uses different terms for the same concept. AI auto-maps provider jargon to standard field names using the Provider Directory. Set up once, reused forever.", accent: "hsl(152,60%,40%)", tag: "Zero training" },
        ].map(item => (
          <div key={item.title} className="rounded-xl border-2 border-gray-100 p-6 flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${item.accent}15` }}>
                  <item.icon className="w-5 h-5" style={{ color: item.accent }} />
                </div>
                <h3 className="text-xl font-bold text-gray-900">{item.title}</h3>
              </div>
              <span className="text-xs font-bold px-3 py-1 rounded-full" style={{ backgroundColor: `${item.accent}15`, color: item.accent }}>{item.tag}</span>
            </div>
            <p className="text-gray-600 leading-relaxed flex-1">{item.desc}</p>
          </div>
        ))}
      </div>
    </div>
  ),

  // 5 — Measurable Impact (ROI + capacity merged)
  () => {
    const wLow = 20, wHigh = 25, wAvg = 22.5;
    const mhLow = Math.round((wLow * manualTotal) / 60);
    const mhHigh = Math.round((wHigh * manualTotal) / 60);
    const ahLow = Math.round((wLow * appTotal) / 60);
    const ahHigh = Math.round((wHigh * appTotal) / 60);
    const savedH = `${mhLow - ahLow}–${mhHigh - ahHigh}`;
    const newCap = Math.round((wAvg * manualTotal) / appTotal);
    const capInc = Math.round(((newCap - wAvg) / wAvg) * 100);

    return (
      <div className="flex flex-col h-full bg-gradient-to-br from-[hsl(197,71%,20%)] to-[hsl(197,71%,12%)] text-white px-20 py-16">
        <h2 className="text-4xl font-bold mb-2">Measurable Impact</h2>
        <p className="text-lg text-white/60 mb-8">Real numbers — manual vs ProviderHub</p>
        {/* Hero stat */}
        <div className="rounded-2xl bg-white/10 backdrop-blur p-8 flex items-center gap-6 mb-8">
          <div className="w-16 h-16 rounded-2xl bg-[hsl(152,60%,40%)]/20 flex items-center justify-center shrink-0">
            <ArrowDown className="w-8 h-8 text-[hsl(152,60%,40%)]" />
          </div>
          <div>
            <p className="text-4xl font-bold">~{saved} minutes saved per case</p>
            <p className="text-lg text-white/60 mt-1">{manualTotal} min → {appTotal} min ({Math.round(manualTotal / 60 * 10) / 10}h → {Math.round(appTotal / 60 * 10) / 10}h)</p>
          </div>
        </div>
        {/* KPIs row */}
        <div className="grid grid-cols-4 gap-6 mb-8">
          <ROICard label="PDF Extraction" value={`${Math.round((1 - app.pdfExtract / manual.pdfExtract) * 100)}%`} sub={`${manual.pdfExtract} → ${app.pdfExtract} min`} />
          <ROICard label="Transcript Review" value="100%" sub={`${manual.transcriptReview} → 0 min`} />
          <ROICard label="Context Switching" value="100%" sub={`${manual.contextSwitch} → 0 min`} />
          <ROICard label="Repeat Calls" value={`${Math.round((1 - app.repeatCalls / manual.repeatCalls) * 100)}%`} sub={`${manual.repeatCalls} → ${app.repeatCalls} calls`} />
        </div>
        {/* Capacity row */}
        <div className="grid grid-cols-3 gap-6">
          <div className="rounded-xl bg-white/10 p-5 text-center">
            <p className="text-3xl font-bold text-[hsl(152,60%,40%)]">{savedH} hrs</p>
            <p className="text-sm text-white/60 mt-1">freed per week (same workload)</p>
          </div>
          <div className="rounded-xl bg-white/10 p-5 text-center">
            <p className="text-3xl font-bold">~{newCap} cedings</p>
            <p className="text-sm text-white/60 mt-1">per week (+{capInc}%, same hours)</p>
          </div>
          <div className="rounded-xl bg-white/10 p-5 text-center">
            <p className="text-3xl font-bold">{Math.round(manualTotal / 60 * 10) / 10}h → {Math.round(appTotal / 60 * 10) / 10}h</p>
            <p className="text-sm text-white/60 mt-1">per case reduction</p>
          </div>
        </div>
      </div>
    );
  },

  // 6 — Security & Compliance (trimmed)
  () => (
    <div className="flex flex-col h-full bg-white px-20 py-16">
      <h2 className="text-4xl font-bold text-[hsl(197,71%,20%)] mb-2">Built for Regulated Ops</h2>
      <p className="text-lg text-gray-500 mb-10">Security, auditability, and human approvals baked in</p>
      <div className="grid grid-cols-2 gap-8 flex-1 content-center">
        {[
          { icon: Shield, title: "Evidence-first", desc: "Every value traceable to PDF page, call transcript timestamp, or manual entry with reviewer name." },
          { icon: Users, title: "Human-in-the-loop", desc: "AI suggests — humans approve. Confidence scoring flags items needing verification before submission." },
          { icon: CheckCircle, title: "Full audit trail", desc: "Who changed what, when, why. Supports internal QA and eliminates re-verification during compliance reviews." },
          { icon: FileText, title: "Data security", desc: "Role-based access, encryption at rest and in transit. Suitable for UK financial client data." },
        ].map(item => (
          <div key={item.title} className="flex items-start gap-5 p-6 rounded-xl border-2 border-gray-100">
            <div className="w-12 h-12 rounded-xl bg-[hsl(197,71%,20%)]/10 flex items-center justify-center shrink-0">
              <item.icon className="w-6 h-6 text-[hsl(197,71%,20%)]" />
            </div>
            <div>
              <h3 className="text-xl font-bold text-gray-900 mb-2">{item.title}</h3>
              <p className="text-gray-600 leading-relaxed">{item.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  ),

  // 7 — LOA Workflow Summary (NEW)
  () => (
    <div className="flex flex-col h-full bg-white px-20 py-16">
      <h2 className="text-4xl font-bold text-[hsl(197,71%,20%)] mb-2">LOA & Data Collection Workflow</h2>
      <p className="text-lg text-gray-500 mb-8">End-to-end flow: client signing → provider data → CRM sync</p>
      <div className="flex gap-2 mb-8 items-center">
        {[
          { n: "1", t: "LOA Created", sub: "CRM + Zoho Sign" },
          { n: "2", t: "Client Signs", sub: "E-signature" },
          { n: "3", t: "Sent to Provider", sub: "Email / ORIGO" },
          { n: "4", t: "Data Ingested", sub: "PDF / Email / ORIGO" },
          { n: "5", t: "AI Extraction", sub: "Auto-fill checklist" },
          { n: "6", t: "Ops Verify", sub: "Review & approve" },
          { n: "7", t: "Resolve Gaps", sub: "AI-assisted calls" },
          { n: "8", t: "CRM Sync", sub: "Final data pushed" },
        ].map((s, i, arr) => (
          <div key={i} className="flex items-center gap-2">
            <div className="flex flex-col items-center w-[100px]">
              <div className="w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-bold" style={{ backgroundColor: i < 3 ? "hsl(197,71%,20%)" : i < 6 ? "hsl(173,58%,39%)" : "hsl(152,60%,40%)" }}>{s.n}</div>
              <p className="text-[11px] font-bold text-gray-900 text-center mt-1.5 leading-tight">{s.t}</p>
              <p className="text-[9px] text-gray-400 text-center">{s.sub}</p>
            </div>
            {i < arr.length - 1 && <div className="w-4 h-px bg-gray-300" />}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-5 flex-1 content-start">
        <div className="rounded-xl border-2 border-gray-100 p-5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-8 h-8 rounded-lg bg-[hsl(197,71%,20%)]/10 flex items-center justify-center"><Clock className="w-4 h-4 text-[hsl(197,71%,20%)]" /></div>
            <h3 className="font-bold text-gray-900">Manual: 15–20 days</h3>
          </div>
          <p className="text-sm text-gray-500">Provider processing + data availability delays. Multiple follow-up calls required.</p>
        </div>
        <div className="rounded-xl border-2 border-[hsl(173,58%,39%)]/30 bg-[hsl(173,58%,39%)]/5 p-5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-8 h-8 rounded-lg bg-[hsl(173,58%,39%)]/10 flex items-center justify-center"><Zap className="w-4 h-4 text-[hsl(173,58%,39%)]" /></div>
            <h3 className="font-bold text-gray-900">With ORIGO: 3–5 days</h3>
          </div>
          <p className="text-sm text-gray-500">Digital LOA + automated tracking. Not all providers supported.</p>
        </div>
        <div className="rounded-xl border-2 border-gray-100 p-5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-8 h-8 rounded-lg bg-[hsl(152,60%,40%)]/10 flex items-center justify-center"><Cpu className="w-4 h-4 text-[hsl(152,60%,40%)]" /></div>
            <h3 className="font-bold text-gray-900">AI + Call Assist</h3>
          </div>
          <p className="text-sm text-gray-500">Auto-extract from PDFs & transcripts. AI scripts cut repeat calls by 60%.</p>
        </div>
      </div>
      <div className="mt-auto pt-4 p-4 rounded-xl bg-[hsl(197,71%,20%)]/5 border border-[hsl(197,71%,20%)]/10">
        <p className="text-sm text-gray-600 text-center"><span className="font-bold text-[hsl(197,71%,20%)]">Full workflow document available</span> — detailed breakdown of each step, systems involved, and integration points.</p>
      </div>
    </div>
  ),

  // 8 — Next Steps
  () => (
    <div className="flex flex-col items-center justify-center h-full bg-gradient-to-br from-[hsl(197,71%,20%)] to-[hsl(197,71%,10%)] text-white px-20">
      <h2 className="text-5xl font-bold mb-4">Next Steps</h2>
      <p className="text-xl text-white/60 mb-12">Phased pilot → prove impact → scale</p>
      <div className="grid grid-cols-3 gap-8 w-full max-w-4xl mb-8">
        {[
          { phase: "Phase 1 (MVP)", items: ["Case pipeline + LOA tracking", "AI PDF extraction + checklist auto-fill", "Evidence links + confidence scoring", "Top 10–20 providers"] },
          { phase: "Phase 2", items: ["Missing-fields workflow", "Provider Directory rules UI", "Chase automation templates", "Adviser review & comments"] },
          { phase: "Phase 3", items: ["RingCentral call assist", "Transcript → field auto-fill", "Analytics & Founder dashboard", "Origo integration (research)"] },
        ].map((p, i) => (
          <div key={i} className="rounded-xl bg-white/10 backdrop-blur p-6">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-lg bg-[hsl(173,58%,39%)] flex items-center justify-center text-sm font-bold">{i + 1}</div>
              <h3 className="text-lg font-bold">{p.phase}</h3>
            </div>
            <ul className="space-y-2">
              {p.items.map((item, j) => (
                <li key={j} className="flex items-start gap-2 text-sm text-white/80">
                  <CheckCircle className="w-4 h-4 text-[hsl(173,58%,39%)] mt-0.5 shrink-0" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="rounded-xl bg-white/5 border border-white/10 px-8 py-4 w-full max-w-4xl mb-6">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-lg bg-[hsl(38,92%,50%)]/20 flex items-center justify-center shrink-0">
            <Zap className="w-5 h-5 text-[hsl(38,92%,50%)]" />
          </div>
          <div>
            <p className="text-sm font-bold text-white">Origo — Digital LOA & Transfer Tracking <span className="text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded bg-[hsl(38,92%,50%)]/20 text-[hsl(38,92%,50%)] ml-2">Research</span></p>
            <p className="text-xs text-white/50 mt-1 leading-relaxed max-w-3xl">Could automate LOA submission and transfer tracking directly with providers — eliminating manual chasing. Phase 3 candidate if validated.</p>
          </div>
        </div>
      </div>
      <div className="rounded-xl bg-white/10 backdrop-blur px-8 py-5 text-center max-w-2xl">
        <p className="text-lg font-semibold">ProviderHub turns LOA & Ceding into a repeatable, auditable pipeline.</p>
        <p className="text-sm text-white/60 mt-2">Operational dashboard available</p>
      </div>
    </div>
  ),
];

function ROICard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl bg-white/10 backdrop-blur p-5 text-center">
      <p className="text-3xl font-bold text-[hsl(152,60%,40%)]">{value}</p>
      <p className="text-sm font-semibold text-white mt-1">{label}</p>
      <p className="text-xs text-white/50 mt-1">{sub}</p>
    </div>
  );
}

const Presentation = () => {
  const navigate = useNavigate();
  const [current, setCurrent] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const total = slides.length;

  const next = useCallback(() => setCurrent(c => Math.min(c + 1, total - 1)), [total]);
  const prev = useCallback(() => setCurrent(c => Math.max(c - 1, 0)), []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " ") { e.preventDefault(); next(); }
      if (e.key === "ArrowLeft") { e.preventDefault(); prev(); }
      if (e.key === "Escape") {
        if (document.fullscreenElement) document.exitFullscreen();
        else navigate("/");
      }
      if (e.key === "f" || e.key === "F5") { e.preventDefault(); document.documentElement.requestFullscreen?.(); }
    };
    window.addEventListener("keydown", handler);
    const fsHandler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", fsHandler);
    return () => { window.removeEventListener("keydown", handler); document.removeEventListener("fullscreenchange", fsHandler); };
  }, [next, prev, navigate]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  };

  const SlideComponent = slides[current];

  return (
    <div className="fixed inset-0 bg-black z-50 flex flex-col">
      <div className="flex-1 relative overflow-hidden flex items-center justify-center">
        <div className="relative w-full h-full" style={{ maxWidth: "177.78vh", maxHeight: "56.25vw" }}>
          <div className="absolute inset-0">
            <SlideComponent />
          </div>
        </div>
      </div>
      <div className="h-12 bg-black/90 flex items-center justify-between px-4 text-white/70 text-sm">
        <button onClick={() => navigate("/")} className="flex items-center gap-1 hover:text-white transition-colors">
          <X className="w-4 h-4" /> Exit
        </button>
        <div className="flex items-center gap-4">
          <button onClick={prev} disabled={current === 0} className="disabled:opacity-30 hover:text-white transition-colors"><ChevronLeft className="w-5 h-5" /></button>
          <span className="font-medium">{current + 1} / {total}</span>
          <button onClick={next} disabled={current === total - 1} className="disabled:opacity-30 hover:text-white transition-colors"><ChevronRight className="w-5 h-5" /></button>
        </div>
        <button onClick={toggleFullscreen} className="hover:text-white transition-colors">
          {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
};

export default Presentation;
