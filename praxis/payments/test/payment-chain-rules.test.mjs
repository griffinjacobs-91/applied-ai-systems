// Pure-function tests for src/lib/payment-chain-rules.ts.
//
// Run: npm run test:chain  (or npm run test:crm, which includes this file)
//
// This decision emails a real client a real request for money with nobody
// watching, so the matrix is written out rather than sampled. The rules it
// must not break:
//   1. A DEAL A PERSON ALREADY INVOICED BY HAND IS NEVER EMAILED. Client A
//      Griffin's deposit link was minted on 2026-09-08 and she was written to
//      by hand; the chain must leave that row alone forever.
//   2. Never twice. A sent stamp ends it, and so does a Gmail message id with
//      no sent stamp: that is an email the client HAS and Praxis only half
//      wrote down, and treating it as unsent sends a second invoice.
//   3. Half-signed is not signed, and an MSA on its own buys nothing.
//   4. The final waits for the deposit AND for the work.
//   5. A live lease means somebody else is sending right now; a stale one does
//      not, or a crashed run would wedge the deal.
//   6. A CLIENT WHO PAYS BY BANK TRANSFER IS NEVER MINTED FOR AND NEVER
//      EMAILED. one client pays by ACH arranged outside Praxis, so the
//      chain has to stand down on a row it would otherwise have every reason
//      to act on, including when a person presses Send now.

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  contractsFullySigned,
  allDeliverablesDone,
  decideChain,
  resolvePaymentRecipient,
  paymentMethodOf,
  paysByAch,
  paymentClockStart,
  acceptanceBlockers,
  LEASE_STALE_MS,
} = await import('../src/payment-chain-rules.ts');

const NOW = new Date('2026-09-09T18:00:00.000Z');
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();

/** A deal with both contracts made and signed and money on the SOW. */
function row(over = {}) {
  return {
    sow_generated_at: '2026-09-01T18:00:00.000Z',
    sow_error: null,
    sow_signed_at: '2026-09-08T18:00:00.000Z',
    msa_generated_at: '2026-09-01T18:00:00.000Z',
    msa_error: null,
    msa_signed_at: '2026-09-08T18:00:00.000Z',
    sow_data: { deposit_cents: 280_000, milestone_cents: 280_000 },
    deposit_invoiced_at: null,
    deposit_paid_at: null,
    deposit_email_sent_at: null,
    deposit_email_message_id: null,
    deposit_email_error: null,
    deposit_email_claimed_at: null,
    final_invoiced_at: null,
    final_paid_at: null,
    final_email_sent_at: null,
    final_email_message_id: null,
    final_email_error: null,
    final_email_claimed_at: null,
    ...over,
  };
}

const del = (done = null) => ({ done_at: done });

// ── contractsFullySigned ────────────────────────────────────────────────

test('both contracts made and signed is signed', () => {
  assert.equal(contractsFullySigned(row()), true);
});

test('an MSA that was never made does not hold the deal up', () => {
  assert.equal(
    contractsFullySigned(row({ msa_generated_at: null, msa_signed_at: null })),
    true,
    'a document nobody made is not waiting on anybody',
  );
});

test('an MSA that errored on generation does not hold the deal up', () => {
  assert.equal(contractsFullySigned(row({ msa_error: 'model refused', msa_signed_at: null })), true);
});

test('SOW signed and MSA still out is NOT signed', () => {
  assert.equal(contractsFullySigned(row({ msa_signed_at: null })), false);
});

test('MSA signed and SOW still out is NOT signed', () => {
  assert.equal(contractsFullySigned(row({ sow_signed_at: null })), false);
});

test('an MSA alone, with no SOW at all, is never signed: terms with nothing bought under them', () => {
  assert.equal(
    contractsFullySigned(row({ sow_generated_at: null, sow_signed_at: null })),
    false,
  );
});

// ── allDeliverablesDone ─────────────────────────────────────────────────

test('every deliverable ticked is done; an empty list is not', () => {
  assert.equal(allDeliverablesDone([del('2026-09-09T00:00:00Z'), del('2026-09-09T00:00:00Z')]), true);
  assert.equal(allDeliverablesDone([del('2026-09-09T00:00:00Z'), del()]), false);
  assert.equal(allDeliverablesDone([]), false, 'nothing was promised, so nothing is finished');
});

// ── The deposit matrix ──────────────────────────────────────────────────

test('a freshly signed deal with money on it mints and sends', () => {
  assert.deepEqual(decideChain('deposit', row(), NOW), { action: 'mint_and_send' });
});

test('half-signed is skipped as not_signed, which is how the mark button stays safe', () => {
  assert.deepEqual(decideChain('deposit', row({ msa_signed_at: null }), NOW), {
    action: 'skip',
    reason: 'not_signed',
  });
});

test('a paid deposit is never asked for again', () => {
  assert.deepEqual(decideChain('deposit', row({ deposit_paid_at: ago(1000) }), NOW), {
    action: 'skip',
    reason: 'already_paid',
  });
});

test('a deposit already emailed is never emailed twice', () => {
  assert.deepEqual(
    decideChain('deposit', row({ deposit_email_sent_at: ago(1000), deposit_invoiced_at: ago(2000) }), NOW),
    { action: 'skip', reason: 'already_emailed' },
  );
});

test('HALF-RECORDED: a Gmail message id with no sent stamp is already emailed', () => {
  // Red team, 2026-09-15. Gmail delivered the deposit ask and the write that
  // records it lost: sent_at NULL, an error stamped, the same Stripe link
  // live, and the ten-minute lease long gone. Every other guard lets this row
  // through -- already_emailed has no sent stamp to see, and the hand-invoiced rule
  // exempts a row that carries an error -- so the message id is the only thing
  // standing between the client and a second copy of the same invoice.
  const halfRecorded = row({
    deposit_invoiced_at: ago(3600_000),
    deposit_email_sent_at: null,
    deposit_email_message_id: '19938f0c2a7b4e11',
    deposit_email_error: 'The deposit email was sent to ops@example.com but Praxis could not record it: timeout',
    deposit_email_claimed_at: ago(LEASE_STALE_MS + 60_000),
  });
  assert.deepEqual(decideChain('deposit', halfRecorded, NOW), { action: 'skip', reason: 'already_emailed' });
  // And Send now does not get past it either. Never twice means never.
  assert.deepEqual(
    decideChain('deposit', halfRecorded, NOW, [], { manual: true }),
    { action: 'skip', reason: 'already_emailed' },
  );

  // The same half-recorded state on the final, where the work is done and the
  // certificate is signed, so nothing else would stop it.
  const finalHalf = row({
    deposit_paid_at: ago(5 * 86_400_000),
    final_invoiced_at: ago(3600_000),
    final_email_sent_at: null,
    final_email_message_id: '19938f0c2a7b4e12',
    final_email_error: 'could not record it: timeout',
    acceptance_sent_at: ago(2 * 86_400_000),
    acceptance_signed_at: ago(86_400_000),
  });
  assert.deepEqual(decideChain('final', finalHalf, NOW, [del(ago(3600_000))]), {
    action: 'skip',
    reason: 'already_emailed',
  });

  // An empty or absent message id is NOT a send. A blank string is what a
  // column reads as when Gmail handed back no id, and a missing field is what
  // a caller that did not select the column sees; both must still send.
  assert.deepEqual(decideChain('deposit', row({ deposit_email_message_id: null }), NOW), { action: 'mint_and_send' });
  assert.deepEqual(decideChain('deposit', row({ deposit_email_message_id: '  ' }), NOW), { action: 'mint_and_send' });
  assert.deepEqual(decideChain('deposit', row(), NOW), { action: 'mint_and_send' });
});

test('HAND-INVOICED: a link minted by hand before automation existed is never emailed by automation', () => {
  // Her row on 2026-09-09: signed, link minted 09-08 23:38, invoiced stamped,
  // and no email column has ever been touched because the chain did not exist.
  const clientA = row({
    deposit_invoiced_at: '2026-09-09T05:38:00.000Z',
    deposit_email_sent_at: null,
    deposit_email_error: null,
  });
  assert.deepEqual(decideChain('deposit', clientA, NOW), {
    action: 'skip',
    reason: 'link_predates_automation',
  });
});

test('SEND NOW: a person pressing the button gets past the hand-invoiced rule', () => {
  // Griffin looking at Client A's deal and choosing to send is not automation.
  const clientA = row({
    deposit_invoiced_at: '2026-09-09T05:38:00.000Z',
    deposit_email_sent_at: null,
    deposit_email_error: null,
  });
  assert.deepEqual(decideChain('deposit', clientA, NOW, [], { manual: true }), { action: 'mint_and_send' });
  // But never twice, even by hand.
  const sent = row({ deposit_invoiced_at: '2026-09-09T05:38:00.000Z', deposit_email_sent_at: NOW.toISOString() });
  assert.deepEqual(decideChain('deposit', sent, NOW, [], { manual: true }), { action: 'skip', reason: 'already_emailed' });
});

test('RETRY: the same invoiced row with a recorded failure IS the chain\'s to send', () => {
  // Once Send now (or an earlier automatic run) has stamped an error, the row
  // belongs to the chain, so a retry is not blocked by the hand-invoiced rule.
  const retry = row({
    deposit_invoiced_at: '2026-09-09T05:38:00.000Z',
    deposit_email_error: 'Griffin\'s mailbox is not connected in Settings, so the deposit email was not sent',
  });
  assert.deepEqual(decideChain('deposit', retry, NOW), { action: 'mint_and_send' });
});

test('a SOW with no deposit figure has nothing to ask for', () => {
  assert.deepEqual(decideChain('deposit', row({ sow_data: { deposit_cents: 0 } }), NOW), {
    action: 'skip',
    reason: 'no_amount',
  });
  assert.deepEqual(decideChain('deposit', row({ sow_data: null }), NOW), {
    action: 'skip',
    reason: 'no_amount',
  });
});

test('a live lease means somebody else is sending; a stale one does not', () => {
  const live = row({ deposit_email_claimed_at: ago(LEASE_STALE_MS - 60_000) });
  assert.deepEqual(decideChain('deposit', live, NOW), { action: 'skip', reason: 'in_flight' });
  const stale = row({ deposit_email_claimed_at: ago(LEASE_STALE_MS + 60_000) });
  assert.deepEqual(decideChain('deposit', stale, NOW), { action: 'mint_and_send' });
});

test('the skip order is the specification: paid beats emailed beats the hand-invoiced rule', () => {
  const everything = row({
    deposit_paid_at: ago(100),
    deposit_email_sent_at: ago(200),
    deposit_invoiced_at: ago(300),
    deposit_email_claimed_at: ago(10),
  });
  assert.equal(decideChain('deposit', everything, NOW).reason, 'already_paid');
  const emailed = row({ deposit_email_sent_at: ago(200), deposit_invoiced_at: ago(300) });
  assert.equal(decideChain('deposit', emailed, NOW).reason, 'already_emailed');
});

test('not_signed beats everything, including a paid deposit', () => {
  const odd = row({ sow_signed_at: null, deposit_paid_at: ago(100) });
  assert.equal(decideChain('deposit', odd, NOW).reason, 'not_signed');
});

// ── The final matrix ────────────────────────────────────────────────────

const DONE = [del('2026-09-09T00:00:00Z'), del('2026-09-09T01:00:00Z')];
const OPEN = [del('2026-09-09T00:00:00Z'), del()];

test('the final is never asked for before the deposit is in', () => {
  assert.deepEqual(decideChain('final', row(), NOW, DONE), {
    action: 'skip',
    reason: 'deposit_unpaid',
  });
});

test('the final waits for the work', () => {
  const paid = row({ deposit_paid_at: ago(5 * 86_400_000) });
  assert.deepEqual(decideChain('final', paid, NOW, OPEN), { action: 'skip', reason: 'deliverables_open' });
  assert.deepEqual(decideChain('final', paid, NOW, []), { action: 'skip', reason: 'no_deliverables' });
  assert.deepEqual(decideChain('final', paid, NOW, DONE), { action: 'mint_and_send' });
});

test('the final reads its OWN email and lease columns, never the deposit\'s', () => {
  const paid = row({
    deposit_paid_at: ago(5 * 86_400_000),
    deposit_email_sent_at: ago(4 * 86_400_000),
    deposit_email_claimed_at: ago(10_000),
  });
  assert.deepEqual(decideChain('final', paid, NOW, DONE), { action: 'mint_and_send' });
  assert.equal(
    decideChain('final', { ...paid, final_email_sent_at: ago(100) }, NOW, DONE).reason,
    'already_emailed',
  );
});

test('a final link minted by hand is protected the same way the deposit is', () => {
  const paid = row({ deposit_paid_at: ago(5 * 86_400_000), final_invoiced_at: ago(86_400_000) });
  assert.deepEqual(decideChain('final', paid, NOW, DONE), {
    action: 'skip',
    reason: 'link_predates_automation',
  });
});

test('a SOW with no milestone figure cannot ask for a final', () => {
  const paid = row({
    deposit_paid_at: ago(5 * 86_400_000),
    sow_data: { deposit_cents: 280_000, milestone_cents: null },
  });
  assert.deepEqual(decideChain('final', paid, NOW, DONE), { action: 'skip', reason: 'no_amount' });
});

// ── The last tick, 2026-09-09 ───────────────────────────────────────────
//
// From today the last deliverable ticked runs this decision for the final,
// with nobody reading the answer. These are the cases that behaviour turns on.

test('CLIENT B: a final invoiced by hand is never re-sent when the last box is ticked', () => {
  // Its final link was minted by a person before the chain existed, so the
  // row carries final_invoiced_at and no email column has ever been written.
  // Finishing the work must not send that client a second invoice.
  const mrock = row({
    deposit_paid_at: ago(30 * 86_400_000),
    final_invoiced_at: ago(3 * 86_400_000),
    final_email_sent_at: null,
    final_email_error: null,
  });
  assert.deepEqual(decideChain('final', mrock, NOW, DONE), {
    action: 'skip',
    reason: 'link_predates_automation',
  });
  // And Send now still gets a person past it, exactly as on the deposit.
  assert.deepEqual(decideChain('final', mrock, NOW, DONE, { manual: true }), { action: 'mint_and_send' });
});

test('UNTICK AND RE-TICK: the second last tick sends nothing, because an invoice is a fact', () => {
  // Griffin ticks the last box, the final goes out, he unticks one to fix
  // something, then ticks it again. The row already carries a sent stamp, so
  // the client is never asked twice for the same money.
  const emailed = row({ deposit_paid_at: ago(5 * 86_400_000), final_invoiced_at: ago(3600_000), final_email_sent_at: ago(3600_000) });
  assert.deepEqual(decideChain('final', emailed, NOW, OPEN), { action: 'skip', reason: 'already_emailed' });
  assert.deepEqual(decideChain('final', emailed, NOW, DONE), { action: 'skip', reason: 'already_emailed' });
});

test('a final already paid is never asked for, however the boxes are ticked', () => {
  const paid = row({ deposit_paid_at: ago(9 * 86_400_000), final_paid_at: ago(86_400_000) });
  assert.deepEqual(decideChain('final', paid, NOW, DONE), { action: 'skip', reason: 'already_paid' });
});

test('a live lease on the final holds the deliverable tick and the Stripe webhook apart', () => {
  // Both can fire within milliseconds of each other: the last box ticked while
  // the deposit payment lands. Only one of them may send.
  const base = { deposit_paid_at: ago(5 * 86_400_000) };
  const live = row({ ...base, final_email_claimed_at: ago(LEASE_STALE_MS - 30_000) });
  assert.deepEqual(decideChain('final', live, NOW, DONE), { action: 'skip', reason: 'in_flight' });
  const stale = row({ ...base, final_email_claimed_at: ago(LEASE_STALE_MS + 30_000) });
  assert.deepEqual(decideChain('final', stale, NOW, DONE), { action: 'mint_and_send' });
});

test('an unsigned deal never sends a final, even with every box ticked and the deposit paid', () => {
  const odd = row({ sow_signed_at: null, deposit_paid_at: ago(5 * 86_400_000) });
  assert.deepEqual(decideChain('final', odd, NOW, DONE), { action: 'skip', reason: 'not_signed' });
});

// ── Who it goes to ──────────────────────────────────────────────────────

test('the typed address beats the form address beats the signer', () => {
  assert.equal(
    resolvePaymentRecipient({
      override: 'typed@example.com',
      prefill_email: 'form@example.com',
      contract_signer_email: 'signer@example.com',
    }),
    'typed@example.com',
  );
  assert.equal(
    resolvePaymentRecipient({ prefill_email: 'form@example.com', contract_signer_email: 'signer@example.com' }),
    'form@example.com',
  );
  assert.equal(resolvePaymentRecipient({ contract_signer_email: 'signer@example.com' }), 'signer@example.com');
});

test('blank and malformed candidates are skipped, not used', () => {
  assert.equal(
    resolvePaymentRecipient({ override: '   ', prefill_email: '', contract_signer_email: 'signer@example.com' }),
    'signer@example.com',
  );
  assert.equal(
    resolvePaymentRecipient({ override: 'not an address', contract_signer_email: 'signer@example.com' }),
    'signer@example.com',
  );
  assert.equal(resolvePaymentRecipient({ prefill_email: '  spaced@example.com  ' }), 'spaced@example.com');
});

test('nobody to write to is null, so the caller says so instead of guessing', () => {
  assert.equal(resolvePaymentRecipient({}), null);
  assert.equal(resolvePaymentRecipient({ override: null, prefill_email: null, contract_signer_email: null }), null);
});

// ── ACH: the chain stands down ──────────────────────────────────────────
//
// The row used here is the one the chain most wants to act on: both contracts
// signed, money on the SOW, nothing invoiced, nothing emailed, no lease. On a
// Stripe row that is mint_and_send. On an ACH row it must be a skip, and the
// skip must name ACH rather than some later condition, or the reason on the
// activity feed would send Griffin looking for the wrong problem.

test('an ACH row is skipped for the deposit, and the reason says why', () => {
  const r = row({ payment_method: 'ach' });
  assert.deepEqual(decideChain('deposit', r, NOW), { action: 'skip', reason: 'ach_manual' });
});

test('an ACH row is skipped for the final too', () => {
  const r = row({ payment_method: 'ach', deposit_paid_at: ago(86_400_000) });
  assert.deepEqual(decideChain('final', r, NOW, [del(ago(3600_000))]), { action: 'skip', reason: 'ach_manual' });
});

test('Send now cannot force an email to an ACH client', () => {
  const r = row({ payment_method: 'ach' });
  assert.deepEqual(decideChain('deposit', r, NOW, [], { manual: true }), { action: 'skip', reason: 'ach_manual' });
});

test('ACH beats every other reason, so the feed names the real one', () => {
  // Unsigned AND unpaid AND no amount: three other skips are true as well.
  const r = row({
    payment_method: 'ach',
    sow_signed_at: null,
    msa_signed_at: null,
    sow_data: { deposit_cents: null, milestone_cents: null },
  });
  assert.deepEqual(decideChain('deposit', r, NOW), { action: 'skip', reason: 'ach_manual' });
});

test('the same row on Stripe is unchanged: it mints and sends', () => {
  assert.deepEqual(decideChain('deposit', row({ payment_method: 'stripe' }), NOW), { action: 'mint_and_send' });
  // A row from before the column existed carries no payment_method at all.
  assert.deepEqual(decideChain('deposit', row(), NOW), { action: 'mint_and_send' });
  assert.deepEqual(decideChain('deposit', row({ payment_method: null }), NOW), { action: 'mint_and_send' });
});

test('only the exact string ach means ACH', () => {
  assert.equal(paymentMethodOf('ach'), 'ach');
  assert.equal(paymentMethodOf('stripe'), 'stripe');
  assert.equal(paymentMethodOf(null), 'stripe');
  assert.equal(paymentMethodOf(undefined), 'stripe');
  // The database CHECK refuses these; if it ever stopped, they must not be
  // silently treated as ACH either, because that would hide a broken column
  // behind a payment method nobody chose.
  assert.equal(paymentMethodOf('ACH'), 'stripe');
  assert.equal(paymentMethodOf('bank'), 'stripe');
  assert.equal(paysByAch('ach'), true);
  assert.equal(paysByAch('stripe'), false);
});

// ── The acceptance hold (2026_09_15_acceptance.sql) ─────────────────────
//
// Client B, 2026-09-15: Griffin told the client the payment link
// follows his signature on the acceptance certificate. The final link was
// minted by hand on 09-05 and never emailed. So: an acceptance out holds the
// final; a signed one releases it even past the hand-minted-link rule; the
// due date runs from the signature, not from 09-05.

/** Russell's shape: deposit paid, work done, final minted by hand 09-05, never sent. */
const clientB = (over = {}) =>
  row({
    deposit_paid_at: '2026-07-22T13:42:31.000Z',
    final_invoiced_at: '2026-09-05T05:40:45.000Z',
    ...over,
  });
const doneDels = [del('2026-09-05T05:25:13.000Z'), del('2026-09-05T05:25:14.000Z')];

test('an acceptance out for signature holds the final', () => {
  const r = row({ deposit_paid_at: ago(1000), acceptance_sent_at: ago(500) });
  assert.deepEqual(decideChain('final', r, NOW, doneDels), { action: 'skip', reason: 'acceptance_unsigned' });
});

test('the hold never touches the deposit', () => {
  const r = row({ acceptance_sent_at: ago(500) });
  assert.deepEqual(decideChain('deposit', r, NOW), { action: 'mint_and_send' });
});

test('a signed acceptance releases the final', () => {
  const r = row({ deposit_paid_at: ago(1000), acceptance_sent_at: ago(500), acceptance_signed_at: ago(100) });
  assert.deepEqual(decideChain('final', r, NOW, doneDels), { action: 'mint_and_send' });
});

test('Client B: hand-minted final stays untouched until the acceptance is signed', () => {
  // Before anything was sent out: the hand-invoiced rule, as ever.
  assert.deepEqual(decideChain('final', clientB(), NOW, doneDels), { action: 'skip', reason: 'link_predates_automation' });
  // Out for signature: still no send.
  assert.equal(decideChain('final', clientB({ acceptance_sent_at: ago(500) }), NOW, doneDels).action, 'skip');
  // Signed: released past the hand-minted-link rule.
  assert.deepEqual(
    decideChain('final', clientB({ acceptance_sent_at: ago(500), acceptance_signed_at: ago(100) }), NOW, doneDels),
    { action: 'mint_and_send' },
  );
});

test('a signed acceptance with no certificate recorded as sent does not unlock a hand-minted link', () => {
  const r = clientB({ acceptance_signed_at: ago(100) });
  assert.deepEqual(decideChain('final', r, NOW, doneDels), { action: 'skip', reason: 'link_predates_automation' });
});

test('a signed acceptance never sends twice and never sends a paid final', () => {
  const signed = { acceptance_sent_at: ago(500), acceptance_signed_at: ago(100) };
  assert.deepEqual(decideChain('final', clientB({ ...signed, final_email_sent_at: ago(50) }), NOW, doneDels), {
    action: 'skip',
    reason: 'already_emailed',
  });
  assert.deepEqual(decideChain('final', clientB({ ...signed, final_paid_at: ago(50) }), NOW, doneDels), {
    action: 'skip',
    reason: 'already_paid',
  });
  assert.deepEqual(decideChain('final', clientB({ ...signed, payment_method: 'ach' }), NOW, doneDels), {
    action: 'skip',
    reason: 'ach_manual',
  });
});

test('a signed acceptance does not skip the work or the deposit', () => {
  const signed = { acceptance_sent_at: ago(500), acceptance_signed_at: ago(100) };
  assert.deepEqual(decideChain('final', clientB({ ...signed, deposit_paid_at: null }), NOW, doneDels), {
    action: 'skip',
    reason: 'deposit_unpaid',
  });
  assert.deepEqual(decideChain('final', clientB(signed), NOW, [del(ago(1)), del(null)]), {
    action: 'skip',
    reason: 'deliverables_open',
  });
});

test('Send now gets past an unsigned acceptance', () => {
  const r = row({ deposit_paid_at: ago(1000), acceptance_sent_at: ago(500) });
  assert.deepEqual(decideChain('final', r, NOW, doneDels, { manual: true }), { action: 'mint_and_send' });
});

test('no acceptance on the deal: the final behaves exactly as before', () => {
  assert.deepEqual(decideChain('final', row({ deposit_paid_at: ago(1000) }), NOW, doneDels), { action: 'mint_and_send' });
});

test('the Net 15 clock on a held final starts at the signature when that is later', () => {
  const invoiced = '2026-09-05T05:40:45.000Z';
  const signed = '2026-09-16T15:00:00.000Z';
  assert.equal(paymentClockStart('final', invoiced, { acceptance_signed_at: signed }), signed);
  // A link minted after the signature keeps its own stamp.
  assert.equal(paymentClockStart('final', '2026-09-17T00:00:00.000Z', { acceptance_signed_at: signed }), '2026-09-17T00:00:00.000Z');
  assert.equal(paymentClockStart('final', null, { acceptance_signed_at: signed }), signed);
  // Nothing signed, or the deposit: unchanged.
  assert.equal(paymentClockStart('final', invoiced, {}), invoiced);
  assert.equal(paymentClockStart('deposit', invoiced, { acceptance_signed_at: signed }), invoiced);
});

test('acceptanceBlockers: Client B today can go out', () => {
  assert.deepEqual(acceptanceBlockers(clientB({ payment_method: 'stripe' }), doneDels), []);
});

test('acceptanceBlockers names every reason a hold would be wrong', () => {
  assert.equal(acceptanceBlockers(clientB({ payment_method: 'ach' }), doneDels).length, 1);
  assert.equal(acceptanceBlockers(clientB({ sow_signed_at: null }), doneDels).length, 1);
  assert.equal(acceptanceBlockers(clientB({ deposit_paid_at: null }), doneDels).length, 1);
  assert.equal(acceptanceBlockers(clientB(), []).length, 1);
  assert.equal(acceptanceBlockers(clientB(), [del(ago(1)), del(null)]).length, 1);
  assert.equal(acceptanceBlockers(clientB({ final_paid_at: ago(1) }), doneDels).length, 1);
  assert.equal(acceptanceBlockers(clientB({ final_email_sent_at: ago(1) }), doneDels).length, 1);
  assert.equal(acceptanceBlockers(clientB({ acceptance_sent_at: ago(5), acceptance_signed_at: ago(1) }), doneDels, { replace: true }).length, 1);
});

test('acceptanceBlockers: a certificate already out needs --replace', () => {
  const out = clientB({ acceptance_sent_at: ago(5) });
  assert.equal(acceptanceBlockers(out, doneDels).length, 1);
  assert.deepEqual(acceptanceBlockers(out, doneDels, { replace: true }), []);
});

// ── The last tick holds the final on a Praxis SOW (red team, 2026-09-15) ───
//
// Before this, ticking the last deliverable emailed the final at once, so no
// acceptance certificate could ever go out first: the generator refuses a deal
// whose final already went. Griffin ruled: hold it.

const { certificateRequired } = await import('../src/payment-chain-rules.ts');
const scoped = (over = {}) =>
  row({
    deposit_paid_at: ago(1000),
    sow_data: { deposit_cents: 280_000, milestone_cents: 280_000, scope_items: [{ deliverable: 'CRM' }] },
    ...over,
  });

test('a Praxis SOW with scope items requires a certificate; a registered one does not', () => {
  assert.equal(certificateRequired(scoped()), true);
  assert.equal(certificateRequired(row()), false);
  assert.equal(certificateRequired(row({ sow_data: { milestone_cents: 1, scope_items: [] } })), false);
});

test('HAND-INVOICED: the last tick on a Praxis SOW holds the final until a certificate is signed', () => {
  assert.deepEqual(decideChain('final', scoped(), NOW, doneDels), { action: 'skip', reason: 'acceptance_needed' });
  assert.deepEqual(decideChain('final', scoped({ acceptance_sent_at: ago(10) }), NOW, doneDels), { action: 'skip', reason: 'acceptance_unsigned' });
  assert.deepEqual(
    decideChain('final', scoped({ acceptance_sent_at: ago(10), acceptance_signed_at: ago(5) }), NOW, doneDels),
    { action: 'mint_and_send' },
  );
});

test('Send now still sends a held final, and never for ACH', () => {
  assert.deepEqual(decideChain('final', scoped(), NOW, doneDels, { manual: true }), { action: 'mint_and_send' });
  assert.deepEqual(decideChain('final', scoped({ payment_method: 'ach' }), NOW, doneDels, { manual: true }), { action: 'skip', reason: 'ach_manual' });
});

test('the hold never touches the deposit, even on a Praxis SOW', () => {
  assert.deepEqual(decideChain('deposit', scoped({ deposit_paid_at: null }), NOW), { action: 'mint_and_send' });
});

test('open work is still the reason given before the certificate', () => {
  assert.deepEqual(decideChain('final', scoped(), NOW, [del(ago(1)), del(null)]), { action: 'skip', reason: 'deliverables_open' });
});
