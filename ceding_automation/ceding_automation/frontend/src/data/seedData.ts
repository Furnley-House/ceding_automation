// ==================== TYPES ====================
export type CaseStatus = 'loa_sent' | 'loa_processed' | 'waiting_pdf' | 'pdf_received' | 'ceding_in_progress' | 'complete';
export type Confidence = 'high' | 'medium' | 'low';
export type EvidenceSource = 'pdf' | 'call' | 'email' | 'manual';
export type TaskType = 'chase' | 'call' | 'review' | 'upload';

export interface CaseItem {
  id: string;
  clientName: string;
  provider: string;
  planNumber: string;
  planType: string;
  status: CaseStatus;
  owner: string;
  loaSentDate: string;
  processingExpected: string;
  pdfExpectedDate: string;
  pdfReceivedDate?: string;
  aiExtractionDate?: string;
  cedingCompleteDate?: string;
  currentValue?: string;
  transferValue?: string;
  isOverdue: boolean;
  missingFieldsCount: number;
  confidenceScore: number; // 0-100
}

export interface ChecklistField {
  id: string;
  section: string;
  label: string;
  value: string | null;
  confidence: Confidence | null;
  evidenceSource: EvidenceSource | null;
  evidenceRef?: string;
  status: 'complete' | 'missing' | 'needs_review';
  notes?: string;
}

export interface Provider {
  id: string;
  name: string;
  aliases: string[];
  phone: string;
  email: string;
  portalUrl?: string;
  origoSupported: boolean;
  avgTurnaround: number; // days
  lastVerified: string;
  routingRules: RoutingRule[];
  jargonMap: { providerTerm: string; standardTerm: string }[];
}

export interface RoutingRule {
  planPrefix: string;
  department: string;
  phone: string;
  email?: string;
}

export interface Task {
  id: string;
  caseId: string;
  type: TaskType;
  title: string;
  dueDate: string;
  assignedTo: string;
  completed: boolean;
  clientName: string;
  provider: string;
}

export interface AutomationRule {
  id: string;
  name: string;
  trigger: string;
  action: string;
  enabled: boolean;
  lastTriggered?: string;
}

// ==================== SEED DATA ====================

export const statusLabels: Record<CaseStatus, string> = {
  loa_sent: 'LOA Sent',
  loa_processed: 'LOA Processed',
  waiting_pdf: 'Waiting PDF',
  pdf_received: 'PDF Received',
  ceding_in_progress: 'Ceding In Progress',
  complete: 'Complete',
};

export const cases: CaseItem[] = [
  {
    id: 'CASE-001',
    clientName: 'Rita Wright',
    provider: 'Aviva',
    planNumber: 'TK12097279',
    planType: 'Personal Pension',
    status: 'ceding_in_progress',
    owner: 'Sarah Chen',
    loaSentDate: '2026-01-20',
    processingExpected: '2026-01-30',
    pdfExpectedDate: '2026-02-03',
    pdfReceivedDate: '2026-02-06',
    aiExtractionDate: '2026-02-06',
    currentValue: '£7,594.33',
    transferValue: '£7,594.33',
    isOverdue: false,
    missingFieldsCount: 3,
    confidenceScore: 87,
  },
  {
    id: 'CASE-002',
    clientName: 'James Thornton',
    provider: 'Standard Life',
    planNumber: 'SL-449281-PP',
    planType: 'Personal Pension',
    status: 'waiting_pdf',
    owner: 'Sarah Chen',
    loaSentDate: '2026-02-01',
    processingExpected: '2026-02-11',
    pdfExpectedDate: '2026-02-15',
    isOverdue: true,
    missingFieldsCount: 12,
    confidenceScore: 0,
  },
  {
    id: 'CASE-003',
    clientName: 'Helen Marsden',
    provider: 'Royal London',
    planNumber: 'RL78234516',
    planType: 'Stakeholder Pension',
    status: 'pdf_received',
    owner: 'Michael Torres',
    loaSentDate: '2026-02-04',
    processingExpected: '2026-02-14',
    pdfExpectedDate: '2026-02-18',
    pdfReceivedDate: '2026-02-16',
    currentValue: '£23,412.80',
    transferValue: '£23,412.80',
    isOverdue: false,
    missingFieldsCount: 8,
    confidenceScore: 45,
  },
  {
    id: 'CASE-004',
    clientName: 'David Okonkwo',
    provider: 'Scottish Widows',
    planNumber: 'SW-881234-A',
    planType: 'SIPP',
    status: 'loa_processed',
    owner: 'Michael Torres',
    loaSentDate: '2026-02-10',
    processingExpected: '2026-02-20',
    pdfExpectedDate: '2026-02-24',
    isOverdue: false,
    missingFieldsCount: 0,
    confidenceScore: 0,
  },
  {
    id: 'CASE-005',
    clientName: 'Margaret Ellis',
    provider: 'Aegon',
    planNumber: 'AEG-5523178',
    planType: 'Personal Pension',
    status: 'complete',
    owner: 'Sarah Chen',
    loaSentDate: '2026-01-05',
    processingExpected: '2026-01-15',
    pdfExpectedDate: '2026-01-19',
    pdfReceivedDate: '2026-01-18',
    aiExtractionDate: '2026-01-18',
    cedingCompleteDate: '2026-01-22',
    currentValue: '£45,231.00',
    transferValue: '£45,231.00',
    isOverdue: false,
    missingFieldsCount: 0,
    confidenceScore: 96,
  },
  {
    id: 'CASE-006',
    clientName: 'Robert Patel',
    provider: 'Prudential',
    planNumber: 'PRU-9912345',
    planType: 'With-Profits Pension',
    status: 'loa_sent',
    owner: 'Sarah Chen',
    loaSentDate: '2026-02-17',
    processingExpected: '2026-02-27',
    pdfExpectedDate: '2026-03-03',
    isOverdue: false,
    missingFieldsCount: 0,
    confidenceScore: 0,
  },
];

// Based on real Aviva PDF data for Rita Wright
export const cedingChecklist: ChecklistField[] = [
  // Basic Details
  { id: 'f1', section: 'Basic Details', label: 'Provider Name', value: 'Aviva', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 1, Header', status: 'complete' },
  { id: 'f2', section: 'Basic Details', label: 'Plan Number', value: 'TK12097279', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 1, Row 1', status: 'complete' },
  { id: 'f3', section: 'Basic Details', label: 'Type of Pension', value: 'Personal Pension', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 1, Title', status: 'complete' },
  { id: 'f4', section: 'Basic Details', label: 'Status', value: 'Paid Up', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 1, Plan status', status: 'complete' },
  { id: 'f5', section: 'Basic Details', label: 'Start Date', value: '1 June 2021', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 1, Start date', status: 'complete' },
  { id: 'f6', section: 'Basic Details', label: 'Normal Retirement Age', value: '65', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 1, Retirement age', status: 'complete' },
  { id: 'f7', section: 'Basic Details', label: 'Provider Telephone & Email', value: null, confidence: null, evidenceSource: null, status: 'missing' },
  { id: 'f8', section: 'Basic Details', label: 'Inherited Pension', value: 'No', confidence: 'medium', evidenceSource: 'pdf', evidenceRef: 'Inferred - no mention', status: 'needs_review' },

  // Transaction History
  { id: 'f9', section: 'Transaction History', label: 'Regular Contributions - Personal (Gross)', value: '£183.45/month', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 3, Payment table', status: 'complete' },
  { id: 'f10', section: 'Transaction History', label: 'Regular Contributions - Employer', value: '£110.07/month', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 3, Payment table', status: 'complete' },
  { id: 'f11', section: 'Transaction History', label: 'Withdrawals', value: 'None', confidence: 'medium', evidenceSource: 'pdf', evidenceRef: 'No withdrawals section found', status: 'needs_review' },
  { id: 'f12', section: 'Transaction History', label: '% Crystallised', value: null, confidence: null, evidenceSource: null, status: 'missing' },
  { id: 'f13', section: 'Transaction History', label: 'Contributions 2025/2026', value: '£0.00', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 4, Pension input period', status: 'complete' },
  { id: 'f14', section: 'Transaction History', label: 'Contributions 2024/2025', value: '£0.00', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 4, Pension input period', status: 'complete' },

  // Valuation & Fund Details
  { id: 'f15', section: 'Valuation & Fund Details', label: 'Current Value', value: '£7,594.33 (as at 05/02/2026)', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 1, Plan value', status: 'complete' },
  { id: 'f16', section: 'Valuation & Fund Details', label: 'Transfer Value', value: '£7,594.33', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 1, Transfer value', status: 'complete' },
  { id: 'f17', section: 'Valuation & Fund Details', label: 'Fund 1', value: 'Aviva Pensions My Future Focus Growth S6 — £3,673.79 (969.75 units @ £3.7884)', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 2, Fund breakdown', status: 'complete' },
  { id: 'f18', section: 'Valuation & Fund Details', label: 'Fund 2', value: 'Aviva Pensions My Future Focus Long Term Growth S6 — £3,920.53 (2756.67 units @ £1.4222)', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 2, Fund breakdown', status: 'complete' },
  { id: 'f19', section: 'Valuation & Fund Details', label: 'Lifestyling Active', value: 'Yes — Lifestage Investment Approach', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 2, Auto-switching', status: 'complete' },

  // Charges
  { id: 'f20', section: 'Charges', label: 'Annual Fund Charge', value: '0.75%', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 5, Annual fund charge', status: 'complete' },
  { id: 'f21', section: 'Charges', label: 'Exit Charge / Penalty', value: 'None', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 5, Transferring out charge', status: 'complete' },
  { id: 'f22', section: 'Charges', label: 'Bid/Offer Spread', value: 'None', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 5, Bid/offer spread', status: 'complete' },
  { id: 'f23', section: 'Charges', label: 'Policy Fee', value: 'None', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 5, Policy fee', status: 'complete' },

  // Guarantees
  { id: 'f24', section: 'Guarantees', label: 'Guaranteed Annuity Rate (GAR)', value: 'None', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 2, Guarantees section', status: 'complete' },
  { id: 'f25', section: 'Guarantees', label: 'Guaranteed Minimum Pension (GMP)', value: 'None', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 2, Guarantees section', status: 'complete' },
  { id: 'f26', section: 'Guarantees', label: 'Protected Tax-Free Cash', value: 'No — standard 25%', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 2, Protected TFLS', status: 'complete' },
  { id: 'f27', section: 'Guarantees', label: 'Waiver of Premiums', value: 'None', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 1, Waiver of payment', status: 'complete' },

  // Benefits & Options
  { id: 'f28', section: 'Benefits & Options', label: 'Origo Transfer Available', value: 'Yes', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 6, Transfers section', status: 'complete' },
  { id: 'f29', section: 'Benefits & Options', label: 'Partial Transfer Available', value: 'Yes — must leave at least 1 segment', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 6, Partial transfers', status: 'complete' },
  { id: 'f30', section: 'Benefits & Options', label: 'Drawdown Available', value: null, confidence: null, evidenceSource: null, status: 'missing', notes: 'Not explicitly stated in policy document' },

  // Death Benefits
  { id: 'f31', section: 'Death Benefits', label: 'Death Benefit Options', value: 'Lump sum / Dependant\'s drawdown / Dependant\'s annuity', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 7, Death benefits', status: 'complete' },
  { id: 'f32', section: 'Death Benefits', label: 'Beneficiaries', value: 'None nominated', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 1, Beneficiaries', status: 'complete' },
  { id: 'f33', section: 'Death Benefits', label: 'Life Cover', value: 'None', confidence: 'high', evidenceSource: 'pdf', evidenceRef: 'Page 1, Life cover', status: 'complete' },
];

export const providers: Provider[] = [
  {
    id: 'prov-001', name: 'Aviva', aliases: ['Norwich Union', 'Friends Life', 'Friends Provident'],
    phone: '0800 068 6800', email: 'contactus@aviva.com', portalUrl: 'https://connect.avivab2b.co.uk/adviser/',
    origoSupported: true, avgTurnaround: 12, lastVerified: '2026-02-10',
    routingRules: [
      { planPrefix: 'TK', department: 'Personal Pensions', phone: '0800 068 6800', email: 'pensions@aviva.com' },
      { planPrefix: 'AV', department: 'Platform', phone: '0800 048 2345', email: 'platform@aviva.com' },
      { planPrefix: 'FP', department: 'Legacy Friends Provident', phone: '0800 068 6600' },
    ],
    jargonMap: [
      { providerTerm: 'Lifestage Investment Approach', standardTerm: 'Lifestyling / Auto-switch' },
      { providerTerm: 'Allocation rate', standardTerm: 'Contribution allocation %' },
      { providerTerm: 'Plan segments', standardTerm: 'Units for partial transfer' },
    ],
  },
  {
    id: 'prov-002', name: 'Standard Life', aliases: ['Standard Life Aberdeen', 'Abrdn'],
    phone: '0345 278 5678', email: 'adviserservices@standardlife.com', portalUrl: 'https://adviserzone.standardlife.co.uk',
    origoSupported: true, avgTurnaround: 18, lastVerified: '2026-01-28',
    routingRules: [
      { planPrefix: 'SL', department: 'Individual Pensions', phone: '0345 278 5678' },
      { planPrefix: 'GP', department: 'Group Pensions', phone: '0345 278 9012' },
    ],
    jargonMap: [
      { providerTerm: 'Pension Account', standardTerm: 'Personal Pension' },
      { providerTerm: 'WRAP', standardTerm: 'Platform / SIPP' },
    ],
  },
  {
    id: 'prov-003', name: 'Royal London', aliases: ['Scottish Life'],
    phone: '0345 605 0960', email: 'adviser.support@royallondon.com',
    origoSupported: true, avgTurnaround: 14, lastVerified: '2026-02-05',
    routingRules: [
      { planPrefix: 'RL', department: 'Pensions', phone: '0345 605 0960' },
    ],
    jargonMap: [
      { providerTerm: 'Governed Portfolio', standardTerm: 'Managed / Multi-asset fund' },
    ],
  },
  {
    id: 'prov-004', name: 'Scottish Widows', aliases: ['Clerical Medical', 'Halifax'],
    phone: '0345 769 7100', email: 'adviser.services@scottishwidows.co.uk',
    origoSupported: true, avgTurnaround: 20, lastVerified: '2026-01-15',
    routingRules: [
      { planPrefix: 'SW', department: 'Pensions Admin', phone: '0345 769 7100' },
      { planPrefix: 'CM', department: 'Legacy Clerical Medical', phone: '0345 769 7200' },
    ],
    jargonMap: [],
  },
  {
    id: 'prov-005', name: 'Aegon', aliases: ['Scottish Equitable', 'Cofunds'],
    phone: '0345 266 2622', email: 'retirementandinvestments@aegon.co.uk',
    origoSupported: true, avgTurnaround: 10, lastVerified: '2026-02-12',
    routingRules: [
      { planPrefix: 'AEG', department: 'Retirement', phone: '0345 266 2622' },
      { planPrefix: 'SE', department: 'Legacy Scottish Equitable', phone: '0345 266 2700' },
    ],
    jargonMap: [
      { providerTerm: 'One Retirement', standardTerm: 'SIPP / Drawdown' },
    ],
  },
  {
    id: 'prov-006', name: 'Prudential', aliases: ['M&G', 'PruFund'],
    phone: '0808 234 0234', email: 'adviser@prudential.co.uk',
    origoSupported: false, avgTurnaround: 22, lastVerified: '2026-01-20',
    routingRules: [
      { planPrefix: 'PRU', department: 'Pensions', phone: '0808 234 0234' },
    ],
    jargonMap: [
      { providerTerm: 'PruFund', standardTerm: 'With-Profits / Smoothed fund' },
      { providerTerm: 'Expected Growth Rate', standardTerm: 'Guaranteed Growth Rate' },
    ],
  },
];

export const tasks: Task[] = [
  { id: 'task-1', caseId: 'CASE-002', type: 'chase', title: 'Chase Standard Life for policy PDF — overdue by 3 days', dueDate: '2026-02-15', assignedTo: 'Sarah Chen', completed: false, clientName: 'James Thornton', provider: 'Standard Life' },
  { id: 'task-2', caseId: 'CASE-001', type: 'review', title: 'Review ceding checklist — 3 missing fields', dueDate: '2026-02-19', assignedTo: 'Sarah Chen', completed: false, clientName: 'Rita Wright', provider: 'Aviva' },
  { id: 'task-3', caseId: 'CASE-003', type: 'call', title: 'Call Royal London for guarantee details', dueDate: '2026-02-19', assignedTo: 'Michael Torres', completed: false, clientName: 'Helen Marsden', provider: 'Royal London' },
  { id: 'task-4', caseId: 'CASE-001', type: 'call', title: 'Obtain drawdown availability from Aviva', dueDate: '2026-02-20', assignedTo: 'Sarah Chen', completed: false, clientName: 'Rita Wright', provider: 'Aviva' },
  { id: 'task-5', caseId: 'CASE-003', type: 'upload', title: 'Run AI extraction on Royal London PDF', dueDate: '2026-02-18', assignedTo: 'Michael Torres', completed: false, clientName: 'Helen Marsden', provider: 'Royal London' },
];

export const automationRules: AutomationRule[] = [
  { id: 'auto-1', name: 'LOA Processing Check', trigger: 'LOA sent + 10 business days', action: 'Create "Check LOA processed" task', enabled: true, lastTriggered: '2026-02-14' },
  { id: 'auto-2', name: 'PDF Chase Reminder', trigger: 'Day 14 + no PDF received', action: 'Generate chase email draft', enabled: true, lastTriggered: '2026-02-15' },
  { id: 'auto-3', name: 'Missing Fields Alert', trigger: 'Ceding checklist has missing critical fields', action: 'Create call pack task for CA team', enabled: true },
  { id: 'auto-4', name: 'Adviser Review Reminder', trigger: 'Ceding checklist 90%+ complete for 2 days', action: 'Notify adviser for review', enabled: true },
  { id: 'auto-5', name: 'SLA Breach Warning', trigger: 'Case open > 30 days', action: 'Escalate to Ops Manager', enabled: false },
];

export const providerPainData = [
  { provider: 'Prudential', missingFields: 34, avgDays: 22 },
  { provider: 'Standard Life', missingFields: 28, avgDays: 18 },
  { provider: 'Scottish Widows', missingFields: 22, avgDays: 20 },
  { provider: 'Royal London', missingFields: 15, avgDays: 14 },
  { provider: 'Aviva', missingFields: 8, avgDays: 12 },
  { provider: 'Aegon', missingFields: 5, avgDays: 10 },
];

export const founderMetrics = {
  avgCallTimeBefore: 18, // mins
  avgCallTimeAfter: 7,
  checklistTimeBefore: 45, // mins
  checklistTimeAfter: 12,
  repeatCallsBefore: 3.2,
  repeatCallsAfter: 1.1,
  auditCompleteness: 94, // %
};
