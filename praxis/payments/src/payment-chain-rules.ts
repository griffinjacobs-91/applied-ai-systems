// WHY THIS FILE EXISTS.
//
// From 2026-09-09, marking a contract signed does not just write a date: it
// mints the Stripe link and emails the client the ask. That is money leaving
// Praxis on its own, at a client, without a person reading the outcome first,
// so the question "should this deal be emailed right now" is answered here,
// in a file with no imports, that a test can hold in its hand.
//
// THE RULE THAT MATTERS MOST is link_predates_automation. Every deal that was
// invoiced before this code existed already has {w}_invoiced_at set, and a
// human sent that person their link by hand. If the chain treated an invoiced
// link as fair game it would email a client a second copy of an invoice
// she already has, from a system she has never heard from. So: a payment that
// carries an invoiced stamp, has never been emailed by the chain, and has no
// recorded email failure, is a payment a person minted. Automation leaves it
// alone. The one caller allowed past this rule is the Send now button: a
// person looking at the deal, choosing to send. That is `manual: true` below.
//
// THE SECOND RULE THAT MATTERS AS MUCH is ach_manual, from 2026-09-15. A
// client can pay by bank transfer arranged outside Praxis (one client already
// pays this way). For that client there is no Stripe link to mint and no ask to
// send, and an email offering one would be Praxis inventing a payment method
// the client never agreed to. payment_method is a fact about the CLIENT, not
// about how far the deal has got, and nothing downstream can change the
// answer, so it is checked before anything else.
//
// THE SKIP ORDER IS THE SPECIFICATION. It runs cheapest and most decisive
// first, so the reason a deal was skipped is the FIRST true thing about it and
// not whichever check happened to be written last.
//
// Pure. Every input is passed in, including `now`. Loading and sending live in
// payment-chain.ts.

export type PaymentWhich = 'deposit' | 'final';

/**
 * How a client pays. 'stripe' is every row that has never been told otherwise
 * (the column defaults to it), so the shape of this union is also the shape of
 * the CHECK constraint in 2026_09_15_payment_method.sql.
 */
export type PaymentMethod = 'stripe' | 'ach';

/**
 * Read a payment_method column into the union, treating ANYTHING unrecognised
 * as 'stripe'.
 *
 * That direction is deliberate and it is the safe one only because the
 * database refuses any other value: a NULL or a missing column is a row from
 * before 2026-09-15, which is a Stripe row. If the check constraint were ever
 * dropped and a typo like 'ACH' got stored, this would read it as Stripe and
 * the client would be emailed a link, so paysByAch is the only thing allowed
 * to decide, and the column is the only thing allowed to feed it.
 */
export function paymentMethodOf(raw: unknown): PaymentMethod {
  return raw === 'ach' ? 'ach' : 'stripe';
}

/** Does this client pay outside Praxis, by bank transfer? */
export function paysByAch(raw: unknown): boolean {
  return paymentMethodOf(raw) === 'ach';
}

export type ChainSkipReason =
  /** This client pays by bank transfer. Praxis mints nothing and sends nothing. */
  | 'ach_manual'
  /** The contracts are not fully signed, so there is nothing to be owed for. */
  | 'not_signed'
  /** This half is already in the bank. */
  | 'already_paid'
  /**
   * The chain has already emailed this ask. Never twice.
   *
   * True of a send that was recorded properly AND of one Gmail accepted but
   * Praxis only half wrote down: a message id with no sent stamp is still an
   * email sitting in the client's inbox.
   */
  | 'already_emailed'
  /** A person minted this link by hand before automation existed. Leave it. */
  | 'link_predates_automation'
  /** The final is never asked for before the deposit is in. */
  | 'deposit_unpaid'
  /** Work is still open, so the final is not owed yet. */
  | 'deliverables_open'
  /** The SOW committed to no deliverables, so nothing can declare the work done. */
  | 'no_deliverables'
  /** An acceptance certificate is out for the client's signature. The final waits for it. */
  | 'acceptance_unsigned'
  /**
   * The work is done on a SOW that can carry an acceptance certificate, and
   * none has gone out yet. Griffin, 2026-09-15: the final follows the client's
   * signature, so the last tick no longer sends it.
   */
  | 'acceptance_needed'
  /** The SOW carries no figure for this half. Nothing to ask for. */
  | 'no_amount'
  /** Another run holds the lease and is sending right now. */
  | 'in_flight'
  /**
   * The operator archived this deal (2026-09-17). Nothing automatic mints or
   * emails for it: a late signature on a deal taken off the board is recorded
   * and raised as his turn, never turned into an ask. Send now still works.
   */
  | 'deal_archived'
  /** The operator deleted this deal. Same rule as deal_archived. */
  | 'deal_deleted';

export type ChainDecision = { action: 'mint_and_send' } | { action: 'skip'; reason: ChainSkipReason };

/**
 * How long a claim on a payment email is honoured. Long enough that a slow
 * Stripe call plus a slow Gmail call cannot be lapped, short enough that a run
 * that died mid-flight does not wedge the deal until somebody notices.
 */
export const LEASE_STALE_MS = 10 * 60 * 1000;

/** The columns decideChain reads. Everything nullable, because a fresh row is. */
export interface ChainRow {
  /** 'stripe' (or absent, which is the same thing) or 'ach'. */
  payment_method?: string | null;
  sow_generated_at?: string | null;
  sow_error?: string | null;
  sow_signed_at?: string | null;
  msa_generated_at?: string | null;
  msa_error?: string | null;
  msa_signed_at?: string | null;
  sow_data?: { deposit_cents?: number | null; milestone_cents?: number | null; scope_items?: unknown[] | null } | null;
  deposit_invoiced_at?: string | null;
  deposit_paid_at?: string | null;
  deposit_email_sent_at?: string | null;
  /**
   * The Gmail message id of the deposit ask (2026_09_09_payment_chain.sql).
   * Nothing writes it except the chain, and only after Gmail has accepted the
   * message, which is what makes it proof of delivery in its own right.
   * Optional so a caller that does not select the column reads as "no send".
   */
  deposit_email_message_id?: string | null;
  deposit_email_error?: string | null;
  deposit_email_claimed_at?: string | null;
  final_invoiced_at?: string | null;
  final_paid_at?: string | null;
  final_email_sent_at?: string | null;
  /** The Gmail message id of the final ask. See deposit_email_message_id. */
  final_email_message_id?: string | null;
  final_email_error?: string | null;
  final_email_claimed_at?: string | null;
  /** 2026_09_15_acceptance.sql. Set when a certificate went out for signature. */
  acceptance_sent_at?: string | null;
  /** Set by the watcher when Acrobat Sign reports the certificate signed. */
  acceptance_signed_at?: string | null;
  /** 2026_09_16_deal_archive.sql. A deal off the board is never sent to automatically. */
  archived_at?: string | null;
  deleted_at?: string | null;
}

/** Only the tick matters here, so the caller can pass service_deliverables rows straight in. */
export interface ChainDeliverable {
  done_at?: string | null;
}

/**
 * Is the paper done?
 *
 * The same shape as the stage engine's `signedDone` (pipeline-stages.ts): a
 * document that was never generated, or generated into an error, is not
 * waiting on anybody. But money adds one condition the stage engine does not
 * need: the SOW itself must exist and be signed. An MSA on its own is terms
 * with nothing bought under them, and there is no amount to ask for.
 */
export function contractsFullySigned(row: ChainRow): boolean {
  const sowMade = !!row.sow_generated_at && !row.sow_error;
  const msaMade = !!row.msa_generated_at && !row.msa_error;
  if (!sowMade || !row.sow_signed_at) return false;
  return !msaMade || !!row.msa_signed_at;
}

/**
 * Does this deal's final wait for a signed acceptance certificate?
 *
 * Yes whenever the SOW lists scope items, which is every SOW Praxis generates
 * and exactly the SOWs a certificate can be generated for
 * (acceptance-certificate.ts certificateReadiness). A contract registered from
 * outside Praxis carries no scope items and keeps the 2026-09-09 behaviour:
 * the last tick sends the final.
 */
export function certificateRequired(row: ChainRow): boolean {
  const items = row.sow_data?.scope_items;
  return Array.isArray(items) && items.length > 0;
}

/** Every deliverable ticked. An empty list is NOT done: nothing was promised to finish. */
export function allDeliverablesDone(deliverables: ChainDeliverable[]): boolean {
  return deliverables.length > 0 && deliverables.every((d) => !!d.done_at);
}

/**
 * Should the chain mint the link and send the email for this half, right now?
 *
 * `deliverables` is only read for the final; pass an empty array for a deposit.
 */
export function decideChain(
  which: PaymentWhich,
  row: ChainRow,
  now: Date,
  deliverables: ChainDeliverable[] = [],
  options: { manual?: boolean } = {},
): ChainDecision {
  const skip = (reason: ChainSkipReason): ChainDecision => ({ action: 'skip', reason });

  // Before everything, including the manual Send now button. A person pressing
  // Send now on an ACH client is not choosing to send THIS email, they are
  // pressing a button that should not have been offered; sending it anyway
  // would put a Stripe link in front of a client who pays by bank transfer.
  if (paysByAch(row.payment_method)) return skip('ach_manual');

  // A deal the operator took off the board moves only by his own hand. The
  // mailbox watcher, the webhook and the last tick all run with nobody
  // watching, and a signature that comes back on a deleted deal used to mark
  // it signed and email the client the deposit ask. Send now (manual) is a
  // person looking at that deal and choosing, so it is let through.
  if (!options.manual) {
    if (row.deleted_at) return skip('deal_deleted');
    if (row.archived_at) return skip('deal_archived');
  }

  if (!contractsFullySigned(row)) return skip('not_signed');

  const paidAt = which === 'deposit' ? row.deposit_paid_at : row.final_paid_at;
  if (paidAt) return skip('already_paid');

  // NEVER TWICE, AND A HALF-RECORDED SEND STILL COUNTS AS ONCE.
  //
  // The sent stamp is the ordinary answer. The message id is the backstop, and
  // it exists because of a red-team finding on 2026-09-15: the Gmail send and
  // the row that records it are two different systems, so a bookkeeping write
  // that fails after Gmail has already delivered leaves a client holding an
  // invoice email Praxis has no sent stamp for. With only the sent stamp read
  // here, the next run past the ten-minute lease would reuse the same Stripe
  // link and send that client a SECOND copy of the same ask.
  //
  // A message id with no sent stamp therefore means "sent, badly written
  // down", never "not sent": step 10 of payment-chain.ts is the only writer of
  // that column and it only runs once Gmail has accepted the message. An
  // absent column (a caller that did not select it) reads as no send, which is
  // the same answer this check gave before the column was read at all.
  const sentAt = which === 'deposit' ? row.deposit_email_sent_at : row.final_email_sent_at;
  const messageId = which === 'deposit' ? row.deposit_email_message_id : row.final_email_message_id;
  if (sentAt || (typeof messageId === 'string' && messageId.trim() !== '')) return skip('already_emailed');

  // The hand-invoiced rule. See the header. A person pressing Send now is exempt:
  // they are looking at the deal and choosing to send. So is a final whose
  // acceptance certificate the client has signed: Griffin sending that
  // certificate out WAS the choice to send the final once it came back, and
  // already_emailed above still stops a second copy.
  const invoicedAt = which === 'deposit' ? row.deposit_invoiced_at : row.final_invoiced_at;
  const emailError = which === 'deposit' ? row.deposit_email_error : row.final_email_error;
  const clientAccepted = which === 'final' && !!row.acceptance_sent_at && !!row.acceptance_signed_at;
  if (invoicedAt && !emailError && !options.manual && !clientAccepted) return skip('link_predates_automation');

  if (which === 'final') {
    if (!row.deposit_paid_at) return skip('deposit_unpaid');
    if (deliverables.length === 0) return skip('no_deliverables');
    if (!allDeliverablesDone(deliverables)) return skip('deliverables_open');
    // The client is told the link follows the signature (Griffin, 2026-09-15,
    // ruled again the same day when the red team showed the last tick firing
    // the final before any certificate could exist). Send now still gets past
    // it: a client who accepts by reply instead of in Acrobat Sign is a
    // person's call to make.
    if (!options.manual && !row.acceptance_signed_at) {
      if (row.acceptance_sent_at) return skip('acceptance_unsigned');
      if (certificateRequired(row)) return skip('acceptance_needed');
    }
  }

  const cents = which === 'deposit' ? row.sow_data?.deposit_cents : row.sow_data?.milestone_cents;
  if (typeof cents !== 'number' || !Number.isFinite(cents) || cents <= 0) return skip('no_amount');

  const claimedAt = which === 'deposit' ? row.deposit_email_claimed_at : row.final_email_claimed_at;
  if (claimedAt) {
    const age = now.getTime() - Date.parse(claimedAt);
    if (Number.isFinite(age) && age < LEASE_STALE_MS) return skip('in_flight');
  }

  return { action: 'mint_and_send' };
}

/**
 * When the Net 15 clock on this ask starts.
 *
 * Minting is invoicing, so ordinarily it is the link's invoiced stamp. A final
 * held for an acceptance signature is the exception: the link may have been
 * minted weeks before the client signed (Client B's was made on
 * 2026-09-05), and a due date counted from then would tell the client they
 * are nearly late on a bill they were only just sent. So the later of the two.
 */
export function paymentClockStart(which: PaymentWhich, invoicedAt: string | null, row: ChainRow): string | null {
  if (which !== 'final' || !row.acceptance_signed_at) return invoicedAt;
  if (!invoicedAt) return row.acceptance_signed_at;
  return Date.parse(row.acceptance_signed_at) > Date.parse(invoicedAt) ? row.acceptance_signed_at : invoicedAt;
}

/** The columns acceptanceBlockers reads. */
export interface AcceptanceRow {
  payment_method?: string | null;
  sow_signed_at?: string | null;
  deposit_paid_at?: string | null;
  final_paid_at?: string | null;
  final_email_sent_at?: string | null;
  acceptance_sent_at?: string | null;
  acceptance_signed_at?: string | null;
}

/**
 * Why an acceptance certificate cannot be registered to go out, in the
 * operator's words. Empty means it can.
 *
 * Registering one HOLDS the final until the client signs, so it is refused on
 * any deal where holding it would be wrong or meaningless: a client who pays
 * outside Praxis, work that is not done, a final already paid or already
 * sent. A certificate already out is refused unless `replace` is passed,
 * because a re-send gives it a new name and the old envelope stops matching.
 */
export function acceptanceBlockers(
  row: AcceptanceRow,
  deliverables: ChainDeliverable[],
  options: { replace?: boolean } = {},
): string[] {
  const out: string[] = [];
  if (paysByAch(row.payment_method)) out.push('This client pays by bank transfer, so there is no final link to release.');
  if (!row.sow_signed_at) out.push('The SOW is not marked signed.');
  if (!row.deposit_paid_at) out.push('The deposit is not marked paid.');
  if (deliverables.length === 0) out.push('The SOW lists no deliverables to accept.');
  else if (!allDeliverablesDone(deliverables)) out.push('Not every deliverable is ticked done.');
  if (row.final_paid_at) out.push('The final is already paid.');
  if (row.final_email_sent_at) out.push('The final payment email already went.');
  if (row.acceptance_signed_at) out.push('The acceptance certificate is already signed.');
  else if (row.acceptance_sent_at && !options.replace) {
    out.push('An acceptance certificate is already out for signature. Pass --replace to send a new one.');
  }
  return out;
}

// The same shape gmail-sender refuses to send to. Kept here so a bad address
// is caught before Stripe is asked for anything.
const EMAIL_SHAPE = /^[^\s@<>,;:"\\]+@[^\s@<>,;:"\\]+\.[^\s@<>,;:"\\]+$/;

/**
 * Who gets the ask.
 *
 * An address typed on the button wins, because the person typing it is looking
 * at the deal. Then the intake form's own address. Then the signer on the
 * contract, which is the only address a client who never filled in a form has.
 *
 * A candidate that is not shaped like an address is SKIPPED rather than used,
 * so one bad value does not send money mail nowhere. All three empty is null,
 * and the caller says so out loud instead of guessing.
 */
export function resolvePaymentRecipient(input: {
  override?: string | null;
  prefill_email?: string | null;
  contract_signer_email?: string | null;
}): string | null {
  for (const candidate of [input.override, input.prefill_email, input.contract_signer_email]) {
    if (typeof candidate !== 'string') continue;
    const flat = candidate.trim();
    if (flat && EMAIL_SHAPE.test(flat)) return flat;
  }
  return null;
}
