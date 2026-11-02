// Jordan's text channel: Twilio SMS, the voice forward, and the webhook
// signature check.
//
// Jordan texts from his own local number. Voice is NOT Jordan's job: a call to
// his number is greeted with one line and forwarded to Griffin's cell. No
// callerId is set on the Dial, so Twilio presents the ORIGINAL caller's number
// to Griffin and he sees who is actually calling. (The first draft set
// callerId to Jordan's number, the opposite of what its comment promised.)
//
// Texting hours are not decided here: callers use withinTextingHours from
// ../time.ts. The first draft had its own quiet-hours function that guessed
// daylight saving from the month.
//
// Env (process.env first, see calendar-sync.ts on Vite inlining):
// TWILIO_ACCOUNT_SID (or TWILIO_ACCOUNT_ID, the name Griffin used in the
// praxis Vercel project on 30 Sep; SID wins when both are set),
// TWILIO_AUTH_TOKEN, TWILIO_JORDAN_NUMBER, JORDAN_FORWARD_TO (Griffin's cell,
// E.164).

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { InboundMedia } from '../types.ts';

const API = 'https://api.twilio.com/2010-04-01';

/** The Twilio account SID: TWILIO_ACCOUNT_SID first, then TWILIO_ACCOUNT_ID. Blank counts as unset. */
export function twilioAccountSid(): string {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  if (sid) return sid;
  return process.env.TWILIO_ACCOUNT_ID?.trim() ?? '';
}

function creds(): { sid: string; token: string } | null {
  const sid = twilioAccountSid();
  const token = process.env.TWILIO_AUTH_TOKEN;
  return sid && token ? { sid, token } : null;
}

export function twilioConfigured(): boolean {
  return creds() !== null;
}

export function jordanNumber(): string {
  return process.env.TWILIO_JORDAN_NUMBER ?? '';
}

/** Send one SMS. Plain body only: the persona owns the words. Returns the MessageSid. */
export async function sendSMS(to: string, body: string): Promise<{ sid: string }> {
  const c = creds();
  if (!c) throw new Error('Twilio not configured (TWILIO_ACCOUNT_SID or TWILIO_ACCOUNT_ID / TWILIO_AUTH_TOKEN)');
  const res = await fetch(`${API}/Accounts/${c.sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: jordanNumber(), Body: body }),
  });
  if (!res.ok) throw new Error(`twilio send failed ${res.status}: ${await res.text()}`);
  const out = (await res.json()) as { sid: string };
  return { sid: out.sid };
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * TwiML for an inbound VOICE call to Jordan's number: one line to the caller,
 * then forward to Griffin's cell with the caller's own number shown. With no
 * forwarding number set, the caller is told to text instead, never left in
 * silence.
 */
export function voiceForwardTwiML(): string {
  const forwardTo = (process.env.JORDAN_FORWARD_TO ?? '').trim();
  if (!forwardTo) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Sorry, this number cannot take calls right now. Please send a text to this number instead.</Say>
  <Hangup/>
</Response>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">You have reached Griffin Jacobs Consulting. Connecting you now.</Say>
  <Dial>${escapeXml(forwardTo)}</Dial>
</Response>`;
}

// ── STOP ────────────────────────────────────────────────────────────────────

// A whole message that is only one of these is an opt-out.
const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout']);

// A SHORT message (six words or fewer) that STARTS with one of these is an
// opt-out: "STOP. Who is this?", "stop all". Deliberately not cancel, end or
// quit, which start ordinary sentences ("End of the month works", "Quit
// worrying, Thursday is fine").
const STOP_LEAD_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'optout']);

// Anywhere in the message.
const STOP_ANYWHERE = [
  'stop texting',
  'stop messaging',
  'stop contacting',
  'stop txting',
  'remove me',
  'take me off',
  'opt out',
  'opt-out',
  'unsubscribe',
  "don't text me",
  'do not text me',
  "don't contact me",
  'do not contact me',
];

// Whole-message requests in plain words, kept from the first rewrite.
const STOP_PHRASES = /^(please )?(stop( it)?|stop please|remove me( from (your|this|the) list)?|unsubscribe me)( please)?$/;

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

/**
 * Is this text an opt-out? The message is normalized first (NFKC, so
 * full-width letters read as letters; zero-width characters removed;
 * non-letters such as punctuation and emoji trimmed from both ends; lower
 * case). It is a stop when:
 *   - the whole message is a stop word, or a plain whole-message request;
 *   - OR the first word is stop / stopall / unsubscribe / optout and the
 *     message is six words or fewer;
 *   - OR it says "stop texting", "remove me", "take me off", "opt out",
 *     "unsubscribe" or the like anywhere;
 *   - OR it ends with ", stop" in six words or fewer ("Not interested, stop").
 *
 * The bias is toward honouring: a missed opt-out is worse than a false one,
 * because a false one costs a lead and a missed one texts somebody who said
 * no. It still does not fire on an ordinary sentence that merely starts with
 * cancel, end or quit, or uses "stop" inside a sentence. The first draft
 * matched any prefix, so "Cancel my Thursday slot, can we do Friday" made the
 * lead permanently do-not-contact; the first rewrite then required the whole
 * message and missed "STOP. Who is this?".
 */
export function isStopCommand(text: string): boolean {
  const t = text
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')
    .replace(/\s+/g, ' ');
  if (!t) return false;
  if (STOP_WORDS.has(t) || STOP_PHRASES.test(t)) return true;

  const words = t.split(' ');
  const short = words.length <= 6;
  const first = words[0].replace(/[^\p{L}]+$/gu, '');
  if (short && STOP_LEAD_WORDS.has(first)) return true;
  if (STOP_ANYWHERE.some((p) => t.includes(p))) return true;
  if (short && /,\s*stop$/.test(t)) return true;
  return false;
}

/**
 * A message that is exactly one of the carrier opt-out keywords (STOP,
 * STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, OPTOUT, REVOKE), any case, with
 * punctuation around it. The carrier (Twilio's opt-out handling) answers
 * these itself, so Jordan sends no acknowledgment of his own for them; any
 * other opt-out wording gets his one fixed line.
 */
export function isCarrierKeyword(text: string): boolean {
  const t = text
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .toLowerCase()
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
  return STOP_WORDS.has(t);
}

// ── Pictures ────────────────────────────────────────────────────────────────

/** Twilio puts at most ten media on one message. */
const MAX_MEDIA = 10;

/**
 * The media on an inbound text, from the webhook's form: MediaUrl0..N with
 * MediaContentType0..N, in order. Read by index rather than trusting NumMedia
 * alone, so a picture is kept even if the count were missing. Nothing is
 * fetched: the links are kept so Griffin (or a later reader) can open them.
 * A blank link is not a picture; an over-long value is cut, never kept whole.
 */
export function inboundMedia(form: URLSearchParams): InboundMedia[] {
  const out: InboundMedia[] = [];
  for (let i = 0; i < MAX_MEDIA; i++) {
    const url = form.get(`MediaUrl${i}`)?.trim();
    if (!url) continue;
    const type = form.get(`MediaContentType${i}`)?.trim();
    out.push({ url: url.slice(0, 2048), contentType: type ? type.slice(0, 100) : null });
  }
  return out;
}

// ── Webhook signature ───────────────────────────────────────────────────────

export type TwilioParams = URLSearchParams | Record<string, string> | Iterable<readonly [string, string]>;

function pairs(params: TwilioParams): [string, string][] {
  if (params instanceof URLSearchParams) return [...params.entries()];
  if (Symbol.iterator in Object(params)) return [...(params as Iterable<readonly [string, string]>)].map(([k, v]) => [k, v]);
  return Object.entries(params as Record<string, string>);
}

/** The signature Twilio computes: base64 HMAC-SHA1 of URL + sorted key/value pairs. */
export function twilioSignature(url: string, params: TwilioParams, authToken: string): string {
  // Sorted by key in plain code-unit order, the way Twilio's helper libraries
  // sort. The first draft used localeCompare, which orders "To" and "body"
  // differently and would reject a real request.
  const data = pairs(params)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => k + v)
    .join('');
  return createHmac('sha1', authToken).update(url + data, 'utf8').digest('base64');
}

/**
 * Is X-Twilio-Signature valid for this URL (exactly as Twilio requested it,
 * query string included) and these POST params? Constant-time compare. An
 * empty token or signature is always false.
 */
export function verifyTwilioSignature(url: string, params: TwilioParams, signature: string, authToken: string): boolean {
  if (!authToken || !signature) return false;
  const expected = Buffer.from(twilioSignature(url, params, authToken));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}
