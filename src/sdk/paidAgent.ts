/** Paid agents: run an agent on your own device and get paid in XRP, CAPPZ or USD-tokenZ/1 (RLUSD), stage by stage (deposit, milestones, completion). */
export {
  SCHEDULE_PRESETS, MAX_AUTO_RETRIES, offerProblems, defineAgentOffer, stageAmounts, toMicro, fromMicro,
  destinationTagFor, paymentRequest, checkPayment, replayJob, memoryJobStore, xrplLedgerReader, createPaidAgent,
} from '../lib/agentKit/paidAgent';
export type {
  AgentOffer, PaymentStage, StageKind, PayCurrency, TokenSpec, JobTerms, PaymentRequest, PaymentCheck, PaymentCheckState,
  JobEvent, JobView, JobState, StageView, StageState, JobStore, StageWork, WorkContext, LedgerReader, PaidAgent, PaidAgentOptions, ResultAnswer,
} from '../lib/agentKit/paidAgent';

/**
 * Usage billing and the subscription agent skill (15.20.1): app usage plans in
 * USD, XRP or both; owner-unvalidated default prices as proposals; top-up
 * rules with overall/month/week/day/hour caps; runway and projected-vs-actual;
 * critical-first task planning; contract splits into AP/AR postings; platform
 * adapter templates with failover; and the edge-node watch job.
 */
export * from '../lib/treasury/funding/index.ts';
