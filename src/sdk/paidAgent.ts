/** Paid agents: run an agent on your own device and get paid in XRP or CAPPZ, stage by stage (deposit, milestones, completion). */
export {
  SCHEDULE_PRESETS, MAX_AUTO_RETRIES, offerProblems, defineAgentOffer, stageAmounts, toMicro, fromMicro,
  destinationTagFor, paymentRequest, checkPayment, replayJob, memoryJobStore, xrplLedgerReader, createPaidAgent,
} from '../lib/agentKit/paidAgent';
export type {
  AgentOffer, PaymentStage, StageKind, PayCurrency, TokenSpec, JobTerms, PaymentRequest, PaymentCheck, PaymentCheckState,
  JobEvent, JobView, JobState, StageView, StageState, JobStore, StageWork, WorkContext, LedgerReader, PaidAgent, PaidAgentOptions, ResultAnswer,
} from '../lib/agentKit/paidAgent';
