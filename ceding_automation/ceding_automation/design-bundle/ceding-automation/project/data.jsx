// data.jsx — seed data for the Missing Data Resolution prototype
// Fields aligned to ceding_automation/backend/prisma/seed.ts (Pension template)

const CASE = {
  id: 'CASE-001',
  ref: 'FH-2026-000001',
  client: 'Eleanor Whitmore',
  provider: 'Aviva',
  providerLogo: 'AV',
  providerColor: '#FFD400',
  plan: 'AV-PP-55021',
  planType: 'Personal Pension Plan',
  loaSent: '02 Apr 2026',
  pdfReceived: '18 Apr 2026',
  owner: 'Revathy S',
  ownerInitials: 'RS',
  agentPhone: '0800 285 1098',
  rcConfigured: true,
  totalFields: 56,
  approved: 38,
  needsReview: 5,
  missing: 3,
  routing: { dept: 'Pensions Servicing', phone: '0800 285 1098', email: 'NGP.questions@dgaviva.com', matchedFrom: 'AV-PP-55021' },
};

const QUEUE = [
  { id: 'CASE-001', client: 'Eleanor Whitmore', provider: 'Aviva', plan: 'AV-PP-55021', missing: 3, review: 5, total: 56, done: 38, sla: 'SLA: 1d', flag: 'urgent' },
  { id: 'CASE-003', client: 'Helen Marsden', provider: 'Royal London', plan: 'RL78234516', missing: 8, review: 4, total: 56, done: 28, sla: 'SLA: 3d', flag: 'normal' },
  { id: 'CASE-007', client: 'Thomas Greaves', provider: 'Standard Life', plan: 'SL449281PP', missing: 4, review: 2, total: 56, done: 42, sla: 'SLA: 4d', flag: 'normal' },
];

// FIELDS — drawn from the Pension checklist template in seed.ts
const FIELDS = [
  // ── MISSING ─────────────────────────────────────────────────
  // Charges → fund_charges_weighted
  { id: 'f1', section: 'Charges', label: 'Fund Charges (Weighted Average)', status: 'missing', value: null, evidence: null,
    notes: 'AI extraction returned no value. Statement aggregates fund costs — confirm with Aviva.', askOnCall: true, q: 'q3' },
  // Benefits → drawdown_options
  { id: 'f2', section: 'Benefits & Options', label: 'Drawdown Options Available', status: 'missing', value: null, evidence: null, askOnCall: true, q: 'q5' },
  // Benefits → death_benefits
  { id: 'f3', section: 'Benefits & Options', label: 'Death Benefits',  status: 'missing', value: null,
    evidence: { quote: 'No mention of death benefits structure in supplied documentation.', page: null, source: 'PDF analysis' },
    askOnCall: true, q: 'q7' },

  // ── NEEDS REVIEW ────────────────────────────────────────────
  // Valuation → current_value
  { id: 'f4', section: 'Valuation', label: 'Current Value', status: 'review', value: '£127,450.32',
    evidence: { quote: 'Current Plan Value as at 18/04/2026: <b>£127,450.32</b>', page: 'p.2 §3.1', source: 'Aviva Statement.pdf' },
    confidence: 'medium', conf: 72, askOnCall: false, q: 'q1' },
  // Valuation → transfer_value
  { id: 'f5', section: 'Valuation', label: 'Transfer Value', status: 'review', value: '£127,450.32',
    evidence: { quote: '<b>Transfer Value</b> may differ from Current Value if MVR or penalties apply.', page: 'p.4 §5.2', source: 'Aviva Statement.pdf' },
    confidence: 'low', conf: 48, notes: 'Confidence is low — statement uses ambiguous wording. Confirm whether MVR applies.', askOnCall: true, q: 'q2' },
  // Guarantees → gmp
  { id: 'f7', section: 'Guarantees', label: 'Guaranteed Minimum Pension (GMP)', status: 'review', value: 'No',
    evidence: { quote: 'No <b>GMP</b> or GAR present on this plan.', page: 'p.5 §6.0', source: 'Aviva Statement.pdf' },
    confidence: 'medium', conf: 81, askOnCall: true, q: 'q6' },
  // Charges → platform_charge
  { id: 'f8', section: 'Charges', label: 'Platform Charge', status: 'review', value: '0.00%',
    evidence: { quote: 'No separate <b>platform charge</b> applies — costs are bundled.', page: 'p.4 §5.5', source: 'Aviva Statement.pdf' },
    confidence: 'medium', conf: 76, askOnCall: false, q: 'q4' },

  // ── APPROVED ────────────────────────────────────────────────
  // Basic Details → plan_number
  { id: 'f9', section: 'Basic Details', label: 'Plan Number', status: 'done', value: 'AV-PP-55021',
    evidence: { quote: '<b>Plan number AV-PP-55021</b>', page: 'p.1', source: 'Aviva Statement.pdf' }, confidence: 'high', conf: 99 },
  // Basic Details → pension_type
  { id: 'f10', section: 'Basic Details', label: 'Type of Pension', status: 'done', value: 'Personal Pension Plan', confidence: 'high', conf: 98 },
  // Basic Details → provider_name
  { id: 'f11', section: 'Basic Details', label: 'Provider Name', status: 'done', value: 'Aviva', confidence: 'high', conf: 99 },
  // Basic Details → start_date
  { id: 'f12', section: 'Basic Details', label: 'Start Date', status: 'done', value: '04 Sep 2008', confidence: 'high', conf: 96 },
  // Basic Details → normal_retirement_date
  { id: 'f13', section: 'Basic Details', label: 'Normal Retirement Age', status: 'done', value: '65', confidence: 'high', conf: 94 },
];

const SCRIPT = {
  opener: "Good morning, this is <b>Revathy S</b> calling from <b>Furnley House</b> on behalf of our client <b>Eleanor Whitmore</b>. We have an LOA on file dated <b>2 April 2026</b> for plan <b>AV-PP-55021</b>. I have a few outstanding items to confirm — do you have a moment?",
  sections: [
    {
      title: 'Verify',
      questions: [
        { id: 'q1', purpose: 'verify', text: 'Could you confirm the current value of the plan as of close of business yesterday?', linksTo: 'f4', answered: false },
        { id: 'q2', purpose: 'verify', text: 'And the transfer value — does it differ, and is any MVR or penalty applied?', linksTo: 'f5', answered: false },
      ],
    },
    {
      title: 'Obtain',
      questions: [
        { id: 'q3', purpose: 'obtain', text: 'What is the weighted average fund charge on this plan?', linksTo: 'f1', answered: false },
        { id: 'q4', purpose: 'obtain', text: 'Is there a separate platform charge in addition to the fund charges?', linksTo: 'f8', answered: false },
        { id: 'q5', purpose: 'obtain', text: 'Which drawdown options are available — flexi-access, UFPLS, in-house annuity?', linksTo: 'f2', answered: false },
        { id: 'q6', purpose: 'verify', text: 'Are there any safeguarded benefits — GMP, GAR or otherwise?', linksTo: 'f7', answered: false },
        { id: 'q7', purpose: 'obtain', text: 'How are death benefits paid — fund value lump sum or beneficiary drawdown?', linksTo: 'f3', answered: false },
      ],
    },
  ],
  closing: "Perfect, that covers everything I needed. Thank you very much for your help — could you confirm what I've recorded and email a copy to <b>ceding@furnleyhouse.co.uk</b> for our records?",
};

const TRANSCRIPT_STREAM = [
  { who: 'CA — Revathy', side: 'ca', text: 'Good morning, this is Revathy from Furnley House calling about plan AV-PP-55021 for our client Eleanor Whitmore.' },
  { who: 'Aviva — Mark', side: 'prov', text: 'Yes, I can see the LOA dated the 2nd of April. How can I help?' },
  { who: 'CA — Revathy', side: 'ca', text: 'Could you confirm the current value of the plan?' },
  { who: 'Aviva — Mark', side: 'prov', text: 'As of close of business yesterday, the current value is £127,450.32.', extracted: { fieldId: 'f4', value: '£127,450.32', confidence: 'high', conf: 96 } },
  { who: 'CA — Revathy', side: 'ca', text: 'And the transfer value — does any MVR or penalty apply?' },
  { who: 'Aviva — Mark', side: 'prov', text: 'Transfer value is the same — £127,450.32. No MVR, no exit penalty.', extracted: { fieldId: 'f5', value: '£127,450.32', confidence: 'high', conf: 95 } },
  { who: 'CA — Revathy', side: 'ca', text: 'What\'s the weighted average fund charge?' },
  { who: 'Aviva — Mark', side: 'prov', text: 'The weighted average fund charge is 0.45%. There\'s no separate platform charge.', extracted: { fieldId: 'f1', value: '0.45%', confidence: 'high', conf: 94 } },
];

Object.assign(window, { CASE, QUEUE, FIELDS, SCRIPT, TRANSCRIPT_STREAM });
