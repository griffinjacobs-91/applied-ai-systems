// The pure rules behind the money path guards (2026-09-17). Imports nothing,
// so test/money-guards.test.mjs loads it straight off disk.
//
//   expectedPaymentCents / paymentAmountCheck
//     what a half SHOULD cost, and whether what Stripe collected is that
//   looksLikeStripeDelivery
//     a request with a bad signature that is shaped like Stripe sent it
//   businessDaysSince / pendingDebitStale / acceptanceHoldStale
//     when a payment on its way, or a final held for a signature, has sat long
//     enough that somebody should look
//   dealGone
//     a deal the operator took off the board, which nothing automatic may move

export type Which = 'deposit' | 'final';

export interface SowMoney {
  total_cents?: number | null;
  deposit_cents?: number | null;
  milestone_cents?: number | null;
}

const isCents = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * The amount this half is for, in cents, or null when nothing says.
 *
 * THE SOW FIRST, the link second. The SOW is what the client signed for. A
 * link is what was minted at the time, and regenerating the SOW does not
 * retire it, so a link's own figure is exactly the stale number this check
 * exists to catch. Only when the SOW carries no figure at all does the link's
 * minted amount stand in. The split for a SOW with only a total is the one
 * service-data.ts uses: half up front, the rest at the end.
 */
export function expectedPaymentCents(which: Which, sow: SowMoney | null | undefined, linkCents?: number | null): number | null {
  const total = isCents(sow?.total_cents) ? sow!.total_cents! : null;
  if (which === 'deposit') {
    if (isCents(sow?.deposit_cents)) return sow!.deposit_cents!;
    if (total !== null) return Math.round(total / 2);
  } else {
    if (isCents(sow?.milestone_cents)) return sow!.milestone_cents!;
    if (total !== null) {
      const deposit = isCents(sow?.deposit_cents) ? sow!.deposit_cents! : Math.round(total / 2);
      if (total - deposit > 0) return total - deposit;
    }
  }
  return isCents(linkCents) ? linkCents : null;
}

export type AmountCheck =
  | { verdict: 'match'; expected: number; received: number }
  | { verdict: 'mismatch'; expected: number; received: number | null }
  | { verdict: 'unknown'; expected: null; received: number | null };

/**
 * Whether a completed payment is the payment this half asked for. Exact to the
 * cent: Praxis adds no tax, fees or tips at checkout, so any difference is a
 * different price. A payment Stripe reports with no amount at all is a
 * mismatch when an amount was expected: "paid, amount unknown" is not "paid in
 * full".
 */
export function paymentAmountCheck(expected: number | null, received: number | null): AmountCheck {
  if (expected === null) return { verdict: 'unknown', expected: null, received };
  if (received !== null && received === expected) return { verdict: 'match', expected, received };
  return { verdict: 'mismatch', expected, received };
}

const usd = (cents: number): string =>
  '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 });

/** The drawer and inbox sentence for a mismatch. */
export function mismatchNote(which: Which, expected: number, received: number | null, sowNumber?: string | null): string {
  const got = received === null ? 'an amount Stripe did not report' : usd(received);
  return (
    `Stripe says the ${which} was paid, but for ${got}, and ${sowNumber ? `${sowNumber} asks for` : 'the SOW asks for'} ${usd(expected)}. ` +
    `It is NOT marked paid. Most likely an old payment link from before the SOW changed. Check it in Stripe, then mark it paid by hand or collect the difference.`
  );
}

// ── A signature that did not verify ─────────────────────────────────────────

/**
 * True when a request that failed signature verification is nonetheless
 * shaped like a real Stripe delivery: a Stripe-Signature header with a current
 * timestamp and a 64-hex v1 signature, over a body that parses as a Stripe
 * event (an evt_ id, object "event", a type).
 *
 * WHY. A bad signature from a scanner means nothing. A bad signature on a real
 * Stripe delivery means the secret Praxis holds is not the endpoint's secret,
 * every payment from then on is refused, and nobody hears. The shape does not
 * prove Stripe sent it (anyone can build this), which is why the webhook only
 * alerts when Stripe's retry of the same event id arrives as well.
 */
export function looksLikeStripeDelivery(
  rawBody: string,
  signatureHeader: string | null | undefined,
  nowSeconds: number,
  toleranceSeconds = 300,
): { event_id: string; event_type: string } | null {
  if (!signatureHeader) return null;
  let t: number | null = null;
  let hasV1 = false;
  for (const part of signatureHeader.split(',')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't' && /^\d{9,11}$/.test(v)) t = Number(v);
    if (k === 'v1' && /^[0-9a-f]{64}$/.test(v)) hasV1 = true;
  }
  if (t === null || !hasV1 || Math.abs(nowSeconds - t) > toleranceSeconds) return null;
  let evt: { id?: unknown; object?: unknown; type?: unknown };
  try {
    evt = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!evt || typeof evt.id !== 'string' || !/^evt_[A-Za-z0-9]{8,}$/.test(evt.id)) return null;
  if (evt.object !== 'event' || typeof evt.type !== 'string' || !evt.type) return null;
  return { event_id: evt.id, event_type: evt.type };
}

/** Stripe's second attempt at the same event is the signal. */
export const STALE_SECRET_ATTEMPTS = 2;

// ── Ageing ──────────────────────────────────────────────────────────────────

const DENVER_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' });
const DENVER_WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', weekday: 'short' });

/**
 * Whole business days (Monday to Friday, Denver) that have ENDED since `iso`,
 * not counting the day it happened on. A debit that started Monday afternoon
 * has 0 business days behind it on Monday and 1 on Tuesday. US bank holidays
 * are not counted out: a bank debit's own clock does skip them, so this errs
 * toward raising the item a day early, never late.
 */
export function businessDaysSince(iso: string, now: Date): number {
  const start = Date.parse(iso);
  if (Number.isNaN(start) || start >= now.getTime()) return 0;
  const startDay = DENVER_DAY.format(new Date(start));
  const today = DENVER_DAY.format(now);
  let days = 0;
  // Step a day at a time from the day after the start up to, not including,
  // today. At most a few dozen iterations for anything this is used on.
  for (let t = start + 86_400_000; ; t += 86_400_000) {
    const d = new Date(t);
    const day = DENVER_DAY.format(d);
    if (day <= startDay) continue;
    if (day >= today) break;
    const wd = DENVER_WEEKDAY.format(d);
    if (wd !== 'Sat' && wd !== 'Sun') days += 1;
    if (days > 400) break;
  }
  return days;
}

/** A US bank debit normally settles in four business days. Seven is late. */
export const PENDING_DEBIT_STALE_BUSINESS_DAYS = 7;

export function pendingDebitStale(pendingAt: string | null | undefined, paidAt: string | null | undefined, now: Date): boolean {
  if (!pendingAt || paidAt) return false;
  return businessDaysSince(pendingAt, now) >= PENDING_DEBIT_STALE_BUSINESS_DAYS;
}

/** How long a final may wait on the acceptance signature once the work is done. */
export const ACCEPTANCE_HOLD_STALE_DAYS = 5;

export interface HoldFacts {
  deposit_paid_at?: string | null;
  final_paid_at?: string | null;
  final_pending_at?: string | null;
  final_email_sent_at?: string | null;
  acceptance_required?: boolean;
  acceptance_sent_at?: string | null;
  acceptance_signed_at?: string | null;
}

/**
 * The final is being held for an acceptance signature, and the last
 * deliverable was ticked more than ACCEPTANCE_HOLD_STALE_DAYS ago. Two ways
 * to be held: the certificate is out and the client has not signed
 * ('unsigned'), or the work is done on a SOW that needs one and none has gone
 * out ('not_sent'). Null when not held, or not held long.
 */
export function acceptanceHoldStale(
  facts: HoldFacts,
  deliverables: Array<{ done_at: string | null }>,
  now: Date,
): { waiting: 'unsigned' | 'not_sent'; doneAt: string; days: number } | null {
  if (!facts.deposit_paid_at || facts.final_paid_at || facts.final_pending_at || facts.final_email_sent_at) return null;
  if (facts.acceptance_signed_at) return null;
  if (deliverables.length === 0 || deliverables.some((d) => !d.done_at)) return null;
  const waiting = facts.acceptance_sent_at ? 'unsigned' : facts.acceptance_required ? 'not_sent' : null;
  if (!waiting) return null;
  const doneMs = Math.max(...deliverables.map((d) => Date.parse(d.done_at as string)).filter((n) => !Number.isNaN(n)));
  if (!Number.isFinite(doneMs)) return null;
  const days = Math.floor((now.getTime() - doneMs) / 86_400_000);
  if (days <= ACCEPTANCE_HOLD_STALE_DAYS) return null;
  return { waiting, doneAt: new Date(doneMs).toISOString(), days };
}

// ── Deals taken off the board ───────────────────────────────────────────────

export function dealGone(row: { archived_at?: string | null; deleted_at?: string | null }): 'deleted' | 'archived' | null {
  if (row.deleted_at) return 'deleted';
  if (row.archived_at) return 'archived';
  return null;
}

export interface OwedFacts {
  deposit_invoiced_at?: string | null;
  deposit_paid_at?: string | null;
  final_invoiced_at?: string | null;
  final_paid_at?: string | null;
}

/** The halves invoiced (or on their way) and not paid. Money a gone deal would hide. */
export function halvesOwed(row: OwedFacts): Which[] {
  const out: Which[] = [];
  if (row.deposit_invoiced_at && !row.deposit_paid_at) out.push('deposit');
  if (row.final_invoiced_at && !row.final_paid_at) out.push('final');
  return out;
}
