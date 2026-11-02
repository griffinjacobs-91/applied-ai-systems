// Jordan's shared vocabulary: the few types every Jordan module agrees on.
//
// This file exists so the conversation logic, the brain, the channel
// adapters, the pipeline and the transcript harness all mean the same thing
// by "a turn" and "a slot". It carries no logic and no imports, so a test can
// load any Jordan module off disk without dragging Supabase or Google in
// behind a type.

export type Channel = 'email' | 'text';

/** One message in a thread, oldest first. */
export interface Turn {
  role: 'lead' | 'jordan';
  text: string;
}

/**
 * One real opening on Griffin's calendar.
 *
 * A Slot is only ever produced by code that has read the calendar (or, in the
 * transcript harness, by the fake calendar that stands in for it). Jordan may
 * name a time to a lead only if it is a Slot he was handed: the validator
 * refuses any clock time that is not one of them. That is what makes "Griffin
 * has Thursday at 1:30 open" a true sentence rather than a guess.
 */
export interface Slot {
  /** ISO 8601 instant, UTC. The single source of truth for the time. */
  startsAt: string;
  /** How Jordan says it, in Mountain time: "Thursday, October 8 at 1:30 PM". */
  label: string;
}

/**
 * One picture (or other media) that came with a text: the link Twilio gave
 * (MediaUrlN) and its type (MediaContentTypeN). Kept with the inbound message
 * (jordan_messages.media); Jordan never downloads it and cannot see it.
 */
export interface InboundMedia {
  url: string;
  contentType: string | null;
}

/** A confirmed appointment, as the thread state carries it. */
export interface ConfirmedBooking extends Slot {
  meetingLink: string | null;
}
