import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import logoDark from "@/assets/logo-dark.png";
import {
  ArrowLeft,
  FileText,
  Send,
  Clock,
  Phone,
  Cpu,
  CheckCircle,
  AlertTriangle,
  PhoneCall,
  BrainCircuit,
  RefreshCw,
  ExternalLink,
  Mail,
  Shield,
  Zap,
  Users,
  Download,
  Loader2,
} from "lucide-react";

const steps = [
  {
    number: 1,
    title: "LOA Creation & Client Signing",
    icon: FileText,
    systems: ["CRM", "Zoho Sign"],
    description:
      "The process begins when a new client is onboarded. A Letter of Authority (LOA) is generated through the CRM and sent to the client via Zoho Sign for electronic signature.",
    details: [
      "LOA is auto-generated from client data in CRM",
      "Sent to the client via Zoho Sign for e-signature",
      "Once signed, we are authorised to request plan/pension details from providers",
      "Signed LOA is stored and linked to the client record",
    ],
  },
  {
    number: 2,
    title: "Sending LOA to Providers",
    icon: Send,
    systems: ["Email / Portal", "Provider"],
    description:
      "The signed LOA is forwarded to the relevant pension or plan providers. Processing timelines vary, and proactive follow-up is required to avoid delays.",
    details: [
      "LOA sent to providers via email or provider portal",
      "Typical processing time: 10–15 business days",
      "Data availability may take an additional 4–5 days after processing",
      "Ops team proactively calls providers to collect information sooner",
    ],
    callout: {
      type: "warning" as const,
      text: "Without proactive follow-up, total wait time can exceed 20 days per provider.",
    },
  },
  {
    number: 3,
    title: "ORIGO Alternative (Accelerated Path)",
    icon: Zap,
    systems: ["ORIGO Unipass"],
    description:
      "For supported providers, the ORIGO Unipass LOA service can be used to significantly accelerate the LOA submission and data retrieval process.",
    details: [
      "Total processing time reduced to 3–5 days (vs 15–20 days)",
      "Digital LOA submission and automated tracking",
      "Direct integration with participating providers",
    ],
    callout: {
      type: "info" as const,
      text: "Limitation: ORIGO does not support all providers. Must be used selectively.",
    },
    link: { url: "https://origo.com/unipass-services/unipass-letter-of-authority", label: "ORIGO Unipass LOA Service" },
  },
  {
    number: 4,
    title: "Data Ingestion & AI Extraction",
    icon: Cpu,
    systems: ["ProviderHub", "Outlook", "Zoho WorkDrive"],
    description:
      "Our internal application receives tasks from the CRM and creates cases. Provider data arrives through multiple channels and is processed using AI extraction.",
    details: [
      "CRM tasks automatically create cases in the application",
      "Data arrives via: provider PDFs, ORIGO responses, or email attachments",
      "Outlook workflow rules can auto-capture incoming emails and extract attachments",
      "Attachments are routed to Zoho WorkDrive or directly into the application",
      "AI-based extraction parses PDFs and maps data against a predefined checklist",
      "Each field receives a confidence score and evidence link to the source document",
    ],
  },
  {
    number: 5,
    title: "Operations Verification & Review",
    icon: CheckCircle,
    systems: ["ProviderHub"],
    description:
      "The Ops team verifies AI-extracted data against the checklist. Advisers and paraplanners can review, approve, or comment on individual fields.",
    details: [
      "Ops team reviews each extracted field against expected values",
      "Confidence scores highlight fields needing attention",
      "Advisers / paraplanners can approve, reject, or add comments",
      "Full audit trail of who reviewed what and when",
    ],
  },
  {
    number: 6,
    title: "Resolving Missing & Low-Confidence Data",
    icon: AlertTriangle,
    systems: ["ProviderHub", "Phone"],
    description:
      "For fields where data is missing or the AI confidence is low, the Ops team contacts the provider directly. AI-generated call scripts ensure efficient, targeted calls.",
    details: [
      "Missing fields and low-confidence items are flagged automatically",
      "AI generates provider-specific call scripts covering only unresolved fields",
      "Structured scripts reduce call time and eliminate repeat calls",
      "Resolved fields are updated with source attribution (call transcript)",
    ],
  },
  {
    number: 7,
    title: "Telephony Integration (RingCentral)",
    icon: PhoneCall,
    systems: ["RingCentral", "ProviderHub"],
    description:
      "RingCentral integration enables direct calling from within the application, reducing context switching and providing access to the provider directory.",
    details: [
      "Click-to-call directly from the case or provider record",
      "Provider directory with verified numbers and department routing",
      "Reduced context switching — no need to leave the application",
      "Call transcripts are automatically stored against the case",
    ],
  },
  {
    number: 8,
    title: "AI Transcript Analysis",
    icon: BrainCircuit,
    systems: ["ProviderHub AI"],
    description:
      "After each call, AI analyses the transcript and automatically extracts relevant information discussed during the conversation.",
    details: [
      "AI processes the full call transcript",
      "Relevant data points are identified and extracted",
      "Extracted values are matched to missing or uncertain checklist fields",
      "Fields are updated with evidence links to the transcript timestamp",
    ],
  },
  {
    number: 9,
    title: "Final Data Sync to CRM",
    icon: RefreshCw,
    systems: ["ProviderHub", "CRM"],
    description:
      "Once all fields are verified and approved, the final validated data is synced back to the CRM, completing the end-to-end workflow.",
    details: [
      "All checklist fields verified and approved",
      "Data is pushed back to the CRM automatically",
      "Case is marked as complete with full audit trail",
      "Advisers can proceed with client recommendations",
    ],
  },
];

const benefits = [
  {
    icon: Clock,
    title: "Faster Turnaround",
    desc: "Reduce per-case processing from 15–20 days to 3–5 days with ORIGO, and from hours of manual work to minutes with AI extraction.",
  },
  {
    icon: Cpu,
    title: "Intelligent Automation",
    desc: "AI extracts data from PDFs and call transcripts, generates call scripts, and maps provider jargon — eliminating repetitive manual work.",
  },
  {
    icon: Shield,
    title: "Full Audit Trail",
    desc: "Every value is traceable to its source — PDF page, call transcript timestamp, or manual entry — supporting compliance and QA.",
  },
  {
    icon: Users,
    title: "Reduced Manual Effort",
    desc: "Fewer calls, less context switching, and structured workflows mean the Ops team can handle more cases in less time.",
  },
];

const flowSteps = [
  { label: "CRM", sub: "LOA Created" },
  { label: "Zoho Sign", sub: "Client Signs" },
  { label: "Provider / ORIGO", sub: "LOA Sent" },
  { label: "ProviderHub", sub: "Data Ingested" },
  { label: "AI Extraction", sub: "Fields Mapped" },
  { label: "Ops Verification", sub: "Review & Approve" },
  { label: "Call Assist", sub: "Resolve Gaps" },
  { label: "AI Transcript", sub: "Auto-fill Fields" },
  { label: "CRM Sync", sub: "Data Updated" },
];

export default function LOAWorkflow() {
  const navigate = useNavigate();
  const contentRef = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    if (!contentRef.current) return;
    setDownloading(true);
    try {
      const canvas = await html2canvas(contentRef.current, {
        scale: 2,
        useCORS: true,
        windowWidth: 1100,
        backgroundColor: "#ffffff",
      });

      const imgWidth = 210; // A4 mm
      const pageHeight = 297;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;
      const pdf = new jsPDF("p", "mm", "a4");

      // Find page-break markers
      const markers = contentRef.current.querySelectorAll(".break-before-page");
      const splitYs: number[] = [];
      markers.forEach((el) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const containerRect = contentRef.current!.getBoundingClientRect();
        const offsetY = rect.top - containerRect.top;
        const ratio = imgWidth / canvas.width;
        splitYs.push((offsetY * 2) * ratio); // scale=2
      });
      splitYs.sort((a, b) => a - b);

      // Load logo for header
      const logoImg = new Image();
      logoImg.src = logoDark;
      await new Promise((resolve) => { logoImg.onload = resolve; logoImg.onerror = resolve; });

      const logoH = 8; // mm
      const logoW = (logoImg.naturalWidth / logoImg.naturalHeight) * logoH;
      const headerH = 14; // mm reserved for logo header

      const addLogoHeader = (doc: jsPDF) => {
        doc.addImage(logoImg, "PNG", 10, 3, logoW, logoH);
        doc.setDrawColor(220, 220, 220);
        doc.line(10, headerH - 1, 200, headerH - 1);
      };

      const usablePageH = pageHeight - headerH;
      const canvasDataUrl = canvas.toDataURL("image/png");

      const drawClippedPage = (doc: jsPDF, yStart: number, clipHeight: number) => {
        addLogoHeader(doc);
        // Save state, clip to usable area, draw image, restore
        (doc.internal as any).write('q');
        const clipY = headerH;
        (doc.internal as any).write(
          `${(0 * 2.835).toFixed(2)} ${((pageHeight - clipY) * 2.835).toFixed(2)} ${(imgWidth * 2.835).toFixed(2)} ${(-clipHeight * 2.835).toFixed(2)} re W n`
        );
        doc.addImage(canvasDataUrl, "PNG", 0, headerH - yStart, imgWidth, imgHeight);
        (doc.internal as any).write('Q');
      };

      if (splitYs.length === 0) {
        let position = 0;
        let pageNum = 0;
        while (position < imgHeight) {
          if (pageNum > 0) pdf.addPage();
          const remaining = imgHeight - position;
          drawClippedPage(pdf, position, Math.min(usablePageH, remaining));
          position += usablePageH;
          pageNum++;
        }
      } else {
        const allSplits = [0, ...splitYs, imgHeight];
        let pageNum = 0;
        for (let i = 0; i < allSplits.length - 1; i++) {
          const startY = allSplits[i];
          const endY = allSplits[i + 1];
          const sectionHeight = endY - startY;

          let innerPos = 0;
          while (innerPos < sectionHeight) {
            if (pageNum > 0) pdf.addPage();
            const remaining = sectionHeight - innerPos;
            drawClippedPage(pdf, startY + innerPos, Math.min(usablePageH, remaining));
            innerPos += usablePageH;
            pageNum++;
          }
        }
      }

      pdf.save("LOA-Workflow.pdf");
    } catch (err) {
      console.error("PDF generation failed:", err);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-card border-b border-border backdrop-blur print:hidden">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center gap-4">
          <button
            onClick={() => navigate("/")}
            className="p-2 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground print:hidden"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1">
            <h1 className="text-xl font-bold text-foreground">LOA & Ceding Data Collection Workflow</h1>
            <p className="text-sm text-muted-foreground">Stakeholder Reference Document</p>
          </div>
          <button
            onClick={handleDownload}
            disabled={downloading}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {downloading ? "Generating…" : "Download PDF"}
          </button>
        </div>
      </header>

      <div ref={contentRef}>
        <main className="max-w-5xl mx-auto px-6 py-10 space-y-16">
          {/* Executive Summary */}
          <section>
            <h2 className="text-2xl font-bold text-foreground mb-4">LOA & Ceding Data Collection Workflow</h2>
            <div className="rounded-xl border border-border bg-card p-6">
              <p className="text-foreground/80 leading-relaxed">
                This document outlines the end-to-end process for collecting pension and plan data from providers
                following new client onboarding. The workflow spans multiple systems — CRM, Zoho Sign, provider portals,
                ORIGO, and our internal ProviderHub application — and covers every step from LOA creation to final data
                synchronisation with CRM.
              </p>
              <p className="text-foreground/80 leading-relaxed mt-3">
                By combining AI-powered data extraction, intelligent call assistance, and automated integrations, we
                significantly reduce manual effort, processing time, and the risk of errors.
              </p>
            </div>
          </section>

          {/* Visual Flow - no scroll, wraps for PDF */}
          <section>
            <h2 className="text-2xl font-bold text-foreground mb-6">End-to-End Process Flow</h2>
            <div className="rounded-xl border border-border bg-card p-6">
              <div className="flex items-center gap-1 flex-wrap justify-center">
                {flowSteps.map((step, i) => (
                  <div key={i} className="flex items-center">
                    <div className="flex flex-col items-center text-center w-24">
                      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-sm font-bold text-primary mb-2">
                        {i + 1}
                      </div>
                      <p className="text-xs font-semibold text-foreground leading-tight">{step.label}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">{step.sub}</p>
                    </div>
                    {i < flowSteps.length - 1 && <div className="w-8 h-px bg-border mx-1 shrink-0" />}
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* Step-by-step */}
          <section>
            <h2 className="text-2xl font-bold text-foreground mb-6">Detailed Process Steps</h2>
            <div className="space-y-6">
              {steps.map((step) => (
                <div
                  key={step.number}
                  className={`rounded-xl border border-border bg-card overflow-hidden${(step.number === 3 || step.number === 7) ? " break-before-page" : ""}`}
                  style={(step.number === 3 || step.number === 7) ? { pageBreakBefore: "always" } : undefined}
                >
                  <div className="p-6">
                    <div className="flex items-start gap-4 mb-4">
                      <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                        <step.icon className="w-6 h-6 text-primary" />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-3 flex-wrap">
                          <h3 className="text-lg font-bold text-foreground">
                            Step {step.number}: {step.title}
                          </h3>
                          <div className="flex gap-1.5">
                            {step.systems.map((sys) => (
                              <span
                                key={sys}
                                className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-accent text-accent-foreground"
                              >
                                {sys}
                              </span>
                            ))}
                          </div>
                        </div>
                        <p className="text-foreground/70 mt-2 leading-relaxed">{step.description}</p>
                      </div>
                    </div>

                    <ul className="ml-16 space-y-2">
                      {step.details.map((detail, i) => (
                        <li key={i} className="flex items-baseline gap-2.5 text-sm text-foreground/80">
                          <span className="inline-flex items-center shrink-0" style={{ width: 16, height: 16, position: 'relative', top: '2px' }}>
                            <CheckCircle className="w-4 h-4 text-primary" />
                          </span>
                          <span>{detail}</span>
                        </li>
                      ))}
                    </ul>

                    {step.callout && (
                      <div
                        className={`ml-16 mt-4 p-3 rounded-lg border text-sm ${
                          step.callout.type === "warning"
                            ? "bg-destructive/5 border-destructive/20 text-destructive"
                            : "bg-primary/5 border-primary/20 text-primary"
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                          {step.callout.text}
                        </div>
                      </div>
                    )}

                    {step.link && (
                      <a
                        href={step.link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-16 mt-3 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        {step.link.label}
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Benefits Summary */}
          <section>
            <h2 className="text-2xl font-bold text-foreground mb-6">Key Benefits</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {benefits.map((b) => (
                <div key={b.title} className="rounded-xl border border-border bg-card p-6 flex items-start gap-4">
                  <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                    <b.icon className="w-5 h-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-bold text-foreground mb-1">{b.title}</h3>
                    <p className="text-sm text-foreground/70 leading-relaxed">{b.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

        </main>
      </div>
    </div>
  );
}
