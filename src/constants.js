// Shared reference data. Served to the UI via /api/meta so both sides agree.

export const LINES = {
  personal_auto: 'Personal Auto',
  homeowners: 'Homeowners',
  renters: 'Renters',
  condo: 'Condo (HO-6)',
  dwelling_fire: 'Dwelling Fire',
  flood: 'Flood',
  umbrella: 'Personal Umbrella',
  recreational: 'Motorcycle / RV / Recreational',
  watercraft: 'Watercraft',
  life: 'Life',
  health: 'Health',
  medicare: 'Medicare Supplement',
  commercial_auto: 'Commercial Auto',
  general_liability: 'General Liability',
  bop: "Business Owner's Policy (BOP)",
  workers_comp: "Workers' Compensation",
  commercial_property: 'Commercial Property',
  professional_liability: 'Professional Liability (E&O)',
  cyber: 'Cyber Liability',
  commercial_umbrella: 'Commercial Umbrella',
  other: 'Other',
};

export const LINE_CATEGORY = {
  personal_auto: 'Personal', homeowners: 'Personal', renters: 'Personal', condo: 'Personal',
  dwelling_fire: 'Personal', flood: 'Personal', umbrella: 'Personal', recreational: 'Personal',
  watercraft: 'Personal', life: 'Life & Health', health: 'Life & Health', medicare: 'Life & Health',
  commercial_auto: 'Commercial', general_liability: 'Commercial', bop: 'Commercial',
  workers_comp: 'Commercial', commercial_property: 'Commercial', professional_liability: 'Commercial',
  cyber: 'Commercial', commercial_umbrella: 'Commercial', other: 'Other',
};

export const ROLES = ['admin', 'manager', 'producer', 'csr', 'accounting'];
export const WRITE_ROLES = ['admin', 'manager', 'producer', 'csr'];
export const MANAGE_ROLES = ['admin', 'manager'];
export const MONEY_ROLES = ['admin', 'manager', 'accounting'];

export const CLIENT_TYPES = ['person', 'business'];
export const CLIENT_STATUS = ['prospect', 'active', 'inactive'];
export const POLICY_STATUS = ['quote', 'active', 'pending_cancel', 'cancelled', 'expired', 'non_renewed', 'renewed'];
export const RENEWAL_STATUS = ['not_started', 'in_review', 'remarketing', 'quoted', 'offered', 'renewed', 'lost'];
export const BILLING_METHODS = ['agency_bill', 'direct_bill'];
export const PAYMENT_PLANS = { full: 1, semi_annual: 2, quarterly: 4, monthly: 12 };
export const OPP_STAGES = ['new', 'contacted', 'quoting', 'proposal', 'won', 'lost'];
export const QUOTE_STATUS = ['pending', 'presented', 'accepted', 'declined'];
export const CLAIM_STATUS = ['open', 'in_review', 'approved', 'denied', 'closed'];
export const INVOICE_STATUS = ['open', 'partial', 'paid', 'void'];
export const COMMISSION_TYPES = ['new', 'renewal', 'endorsement', 'chargeback', 'bonus'];
export const COMMISSION_STATUS = ['expected', 'received', 'disputed', 'written_off'];
export const TASK_PRIORITY = ['low', 'normal', 'high', 'urgent'];
export const TASK_STATUS = ['open', 'done'];
export const ACTIVITY_KINDS = ['note', 'call', 'email', 'meeting', 'text', 'system'];
export const DOC_CATEGORIES = ['application', 'dec_page', 'policy', 'endorsement', 'id', 'loss_run', 'claim', 'correspondence', 'signed_form', 'other'];
export const PAYMENT_METHODS = ['check', 'ach', 'card', 'cash', 'carrier', 'other'];
export const RISK_KINDS = ['vehicle', 'driver', 'location', 'coverage_note', 'other'];

export const TODAY = () => new Date().toISOString().slice(0, 10);
