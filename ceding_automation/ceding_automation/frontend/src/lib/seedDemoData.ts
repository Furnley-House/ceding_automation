import { api } from "@/lib/api";

const DEMO_CASES = [
  {
    case_ref: "FH-SIPP-28471",
    client_name: "James Richardson",
    Provider_group: "Aviva",
    plan_number: "AV-SIPP-2847",
    plan_type: "Personal Pension",
    status: "in_review",
    current_stage: 9,
    stages_completed: [1, 2, 3, 4, 5, 6, 7, 8],
    missing_fields_count: 2,
    confidence_score: 78,
    rag: "amber",
    owner_name: "Priya Ramesh",
    current_value: "£287,420",
    transfer_value: "£287,420",
    case_notes: "Mix of HIGH/MED fields, awaiting paraplanner sign-off.",
  },
  {
    case_ref: "FH-ISA-91034",
    client_name: "Sarah Matthews",
    Provider_group: "Hargreaves Lansdown",
    plan_number: "HL-ISA-91034",
    plan_type: "ISA",
    status: "extraction_complete",
    current_stage: 4,
    stages_completed: [1, 2, 3],
    missing_fields_count: 0,
    confidence_score: 96,
    rag: "green",
    owner_name: "Priya Ramesh",
    current_value: "£62,180",
    case_notes: "Stocks & Shares ISA — all HIGH confidence.",
  },
  {
    case_ref: "FH-PP-44721",
    client_name: "David Park",
    Provider_group: "Scottish Widows",
    plan_number: "SW-PP-44721",
    plan_type: "Personal Pension",
    status: "on_hold",
    current_stage: 1,
    stages_completed: [],
    missing_fields_count: 12,
    confidence_score: 0,
    rag: "red",
    owner_name: "Priya Ramesh",
    case_notes: "Client has not provided policy reference number — adviser notified.",
  },
  {
    case_ref: "FH-BND-78832",
    client_name: "Margaret Ellison",
    Provider_group: "Prudential",
    plan_number: "PRU-IB-78832",
    plan_type: "Bond",
    status: "awaiting_documents",
    current_stage: 2,
    stages_completed: [1],
    missing_fields_count: 14,
    confidence_score: 0,
    rag: "amber",
    owner_name: "Priya Ramesh",
    current_value: "£145,000",
    case_notes: "LOA sent 4 days ago, awaiting Prudential pack.",
  },
  {
    case_ref: "FH-DB-12009",
    client_name: "Robert Haines",
    Provider_group: "Legal & General",
    plan_number: "LG-DB-12009",
    plan_type: "Final Salary",
    status: "approved",
    current_stage: 10,
    stages_completed: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    missing_fields_count: 0,
    confidence_score: 100,
    rag: "green",
    owner_name: "Priya Ramesh",
    current_value: "£412,000",
    transfer_value: "£412,000",
    case_notes: "DB transfer — fully approved, ready for export.",
  },
];

export async function seedDemoData() {
  const res = await api.get("/cases");
  const existing = (res.data as { case_ref?: string }[]) ?? [];
  const existingRefs = new Set(existing.map((c) => c.case_ref));
  const toInsert = DEMO_CASES.filter((c) => !existingRefs.has(c.case_ref));
  if (toInsert.length === 0) return { inserted: 0 };
  await Promise.all(toInsert.map((c) => api.post("/cases", c)));
  return { inserted: toInsert.length };
}
