// The Project stage machine: one land or construction deal, from dirt to sale.
//
// Pure: no Supabase, no fetch, no clock. Shaped like src/lib/realtor/stages.ts
// and the deals board (src/lib/deals-board.ts) on purpose, so phase B can hand
// these rungs to the same board rendering and every caller keeps asking the
// same questions: what are the rungs, in what order, what is each one called.
// test/projects-stages.test.mjs holds it, including the lockstep check against
// supabase/migrations-realtor/2026_09_23_05_projects.sql.
//
// ── WHERE THE RUNGS COME FROM ───────────────────────────────────────────────
//
// Griffin's list (23 Sep): raw land found; due diligence (soils, utilities,
// access, water); plat and subdivision (survey, application, approval); lots;
// build (builder, plans, permits, timeline); sale (spec or client).
//
// Folded into what Mesa County and the City of Grand Junction publish as their
// own process, read 23 Sep 2026:
//
//   Mesa County 2020 Land Development Code (amended 17 Oct 2023)
//     https://www.mesacounty.us/sites/default/files/2023-12/Land%20Development%20Code%20-%202020%20(Amended%2010-17-23)_3.pdf
//     3.02 A    Pre-Application Meeting: "generally recommended but optional"
//     4.10 F.2  Major Subdivision = Concept Plan, Final Plan, Final Plat
//     4.10 F.3  Concept Plan: "An optional process intended to review the
//               feasibility and design characteristics"
//     4.10 F.4  Final Plan: application, agency review, neighborhood meeting,
//               notice, Planning Commission review, Director decision
//     4.10 F.5  Final Plat: improvements installed or a Development
//               Improvements Agreement executed BEFORE the plat is approved;
//               recorded with the Clerk and Recorder (lapses if not recorded)
//     4.05      Development Improvements Agreements, "executed and recorded
//               with the Final Plat"
//     4.12      Planned Unit Development: Outline Development Plan AND
//               REZONING first ("zoning for the entire property ... is
//               established"), then Final Plan, then Final Plat
//     4.15      Rezonings, their own application
//   Mesa County plat checklist
//     https://www.mesacounty.us/sites/default/files/2022-12/Plat%20Check%20List%20and%20Notes.pdf
//   City of Grand Junction, Project Submittal Hub and checklists
//     https://www.gjcity.org/507/Project-Submittal-Hub
//     https://www.gjcity.org/DocumentCenter/View/17687   (a meeting with review
//               staff is required before most subdivision applications)
//     https://www.gjcity.org/1526/Submittal-Checklists    (Subdivision - Major
//               Preliminary, then Major Final; Rezone, Annexation and Planned
//               Development - Outline Development Plan as separate applications)
//     https://www.gjcity.org/DocumentCenter/View/17597   (Major Preliminary:
//               preliminary geotechnical and drainage reports, neighborhood
//               meeting minutes, construction plan set)
//     https://www.gjcity.org/DocumentCenter/View/17596   (Major Final: subdivision
//               plat, improvement survey plat, title commitment, DIA Exhibit B,
//               CC&Rs, final geotech and drainage)
//     https://www.gjcity.org/1533/Development-Improvement-Agreements
//
// What that did to Griffin's list:
//   - "concept" is its own rung because both governments show a pre-application
//     meeting and the county a Concept Plan as a separate, optional step.
//   - "entitlements" is its own rung because both show rezoning and a planned
//     development Outline Development Plan as separate applications that come
//     BEFORE the subdivision plan (county 4.12, city checklists). Only when the
//     ground's zoning does not already allow the plan; skipping it is normal.
//   - "plat and subdivision" is two rungs, because the county puts a whole
//     step between the plan approval and the plat: the public improvements are
//     built or guaranteed by a Development Improvements Agreement before the
//     Final Plat is approved (4.10 F.5.a). That step is where the roads and
//     utilities go in, and it is months, not a form.
//
// Names: the county calls the detailed plan the "Final Plan"; the city calls
// the same step the "Major Preliminary" subdivision. One rung, "subdivision
// plan", holds both, and STAGE_SOURCES keeps each government's own name.

export type ProjectStage =
  | 'raw_land'
  | 'due_diligence'
  | 'concept'
  | 'entitlements'
  | 'subdivision_plan'
  | 'improvements'
  | 'final_plat'
  | 'lots'
  | 'build'
  | 'sale';

export interface StageDef {
  key: ProjectStage;
  label: string;
  /** The county shows this step as optional or "only if needed". Skipping it
   *  forward is normal; the board still draws the rung. */
  optional: boolean;
}

/** Every rung, in the order a deal walks them. */
export const STAGES: readonly StageDef[] = [
  { key: 'raw_land', label: 'Raw land found', optional: false },
  { key: 'due_diligence', label: 'Due diligence', optional: false },
  { key: 'concept', label: 'Pre-application and concept', optional: true },
  { key: 'entitlements', label: 'Entitlements', optional: true },
  { key: 'subdivision_plan', label: 'Subdivision plan', optional: false },
  { key: 'improvements', label: 'Improvements', optional: false },
  { key: 'final_plat', label: 'Final plat recorded', optional: false },
  { key: 'lots', label: 'Lots', optional: false },
  { key: 'build', label: 'Build', optional: false },
  { key: 'sale', label: 'Sale', optional: false },
];

export const PROJECT_STAGES: readonly ProjectStage[] = STAGES.map((s) => s.key);

export const PROJECT_STAGE_LABELS: Record<ProjectStage, string> = Object.fromEntries(
  STAGES.map((s) => [s.key, s.label]),
) as Record<ProjectStage, string>;

/** What a new project is stamped with when nobody said otherwise. The column
 *  default in the migration is the same word. */
export const DEFAULT_PROJECT_STAGE: ProjectStage = 'raw_land';

/**
 * Where each rung is described by the government that runs it. Citations, not
 * prose: the per-stage teaching notes (project_stage_notes) are drafted from
 * these and approved by Griffin before they read as anything but a draft.
 * Stages the county does not run (lots, build, sale) cite nothing here.
 */
export const STAGE_SOURCES: Record<ProjectStage, readonly string[]> = {
  raw_land: [],
  due_diligence: [
    'City of Grand Junction, Subdivision - Major Preliminary checklist (preliminary geotechnical and drainage reports): https://www.gjcity.org/DocumentCenter/View/17597',
  ],
  concept: [
    'Mesa County LDC 3.02 A (Pre-Application Meeting) and 4.10 F.3 (Concept Plan)',
    'City of Grand Junction, meeting required before most subdivision applications: https://www.gjcity.org/DocumentCenter/View/17687',
  ],
  entitlements: [
    'Mesa County LDC 4.12 C (Outline Development Plan and Rezoning) and 4.15 (Rezonings)',
    'City of Grand Junction checklists: Rezone, Annexation, Planned Development - Outline Development Plan: https://www.gjcity.org/1526/Submittal-Checklists',
  ],
  subdivision_plan: [
    'Mesa County LDC 4.10 F.4 (Major Subdivision Final Plan)',
    'City of Grand Junction, Subdivision - Major Preliminary: https://www.gjcity.org/DocumentCenter/View/17597',
  ],
  improvements: [
    'Mesa County LDC 4.05 (Development Improvements Agreements) and 4.10 F.5.a',
    'City of Grand Junction: https://www.gjcity.org/1533/Development-Improvement-Agreements',
  ],
  final_plat: [
    'Mesa County LDC 4.10 F.5 (Final Plat; recording and lapse)',
    'Mesa County plat checklist: https://www.mesacounty.us/sites/default/files/2022-12/Plat%20Check%20List%20and%20Notes.pdf',
    'City of Grand Junction, Subdivision - Major Final: https://www.gjcity.org/DocumentCenter/View/17596',
  ],
  lots: [],
  build: [],
  sale: [],
};

// ── Kinds ────────────────────────────────────────────────────────────────────

export type ProjectKind = 'land' | 'spec_build' | 'client_build' | 'flip' | 'investment';

export const PROJECT_KINDS: readonly ProjectKind[] = ['land', 'spec_build', 'client_build', 'flip', 'investment'];

export const PROJECT_KIND_LABELS: Record<ProjectKind, string> = {
  land: 'Land development',
  spec_build: 'Spec build',
  client_build: 'Client build',
  flip: 'Flip',
  investment: 'Investment',
};

/**
 * Which rungs apply to which kind. Only a land development goes through the
 * county's subdivision process; a spec or client build starts on a lot that
 * already exists, a flip on a house that already exists, and neither ever
 * sees a plat. The migration's projects_kind_stage_check says the same thing.
 */
export const KIND_STAGES: Record<ProjectKind, readonly ProjectStage[]> = {
  land: PROJECT_STAGES,
  spec_build: ['raw_land', 'due_diligence', 'build', 'sale'],
  client_build: ['raw_land', 'due_diligence', 'build', 'sale'],
  flip: ['raw_land', 'due_diligence', 'build', 'sale'],
  investment: ['raw_land', 'due_diligence', 'build', 'sale'],
};

/** The stages only a land development has: the county's subdivision process
 *  and the lots it makes. */
export const SUBDIVISION_STAGES: readonly ProjectStage[] = PROJECT_STAGES.filter(
  (s) => !KIND_STAGES.spec_build.includes(s),
);

/** A rung reads differently on some kinds. A flip is not raw land. */
const KIND_STAGE_LABELS: Partial<Record<ProjectKind, Partial<Record<ProjectStage, string>>>> = {
  spec_build: { raw_land: 'Lot found' },
  client_build: { raw_land: 'Lot found' },
  flip: { raw_land: 'Property found', build: 'Renovation' },
  investment: { raw_land: 'Property found', build: 'Improvements to hold' },
};

export function stageLabel(kind: ProjectKind, stage: ProjectStage): string {
  return KIND_STAGE_LABELS[kind]?.[stage] ?? PROJECT_STAGE_LABELS[stage];
}

// ── Per-stage note slots ────────────────────────────────────────────────────
// The four questions a stage note answers, as SLOT NAMES only. The words that
// fill them are drafted later, marked draft, and approved by Griffin
// (project_stage_notes; src/lib/projects/rules.ts decides what reads approved).

export type StageNoteSlot = 'what_happens' | 'who_does_it' | 'where_she_fits' | 'how_she_is_paid';

export const STAGE_NOTE_SLOTS: readonly StageNoteSlot[] = [
  'what_happens',
  'who_does_it',
  'where_she_fits',
  'how_she_is_paid',
];

export const STAGE_NOTE_SLOT_LABELS: Record<StageNoteSlot, string> = {
  what_happens: 'What happens here',
  who_does_it: 'Who does it',
  where_she_fits: 'Where the agent fits',
  how_she_is_paid: 'How the agent is paid',
};

// ── Questions ───────────────────────────────────────────────────────────────

const STAGE_SET = new Set<string>(PROJECT_STAGES);
const KIND_SET = new Set<string>(PROJECT_KINDS);
const SLOT_SET = new Set<string>(STAGE_NOTE_SLOTS);

export function isProjectStage(v: unknown): v is ProjectStage {
  return typeof v === 'string' && STAGE_SET.has(v);
}

export function isProjectKind(v: unknown): v is ProjectKind {
  return typeof v === 'string' && KIND_SET.has(v);
}

export function isStageNoteSlot(v: unknown): v is StageNoteSlot {
  return typeof v === 'string' && SLOT_SET.has(v);
}

/** The rungs this kind of project walks, in order. */
export function stagesFor(kind: ProjectKind): readonly ProjectStage[] {
  return KIND_STAGES[kind];
}

/** True when this rung is part of this kind's walk. */
export function stageApplies(kind: ProjectKind, stage: string): boolean {
  return isProjectKind(kind) && KIND_STAGES[kind].includes(stage as ProjectStage);
}

/** Position on the full ladder, or -1. Order across kinds is the same ladder,
 *  so a flip's "build" and a land deal's "build" compare the same way. */
export function stageOrder(stage: string): number {
  return PROJECT_STAGES.indexOf(stage as ProjectStage);
}

export type ProjectStageCounts = Record<ProjectStage, number> & { total: number };

/** One number per rung for the board's column heads. A stage the table does
 *  not know counts in the total and nowhere else: a gap, not a lie. */
export function projectStageCounts(rows: readonly { stage: string }[]): ProjectStageCounts {
  const counts = { total: rows.length } as ProjectStageCounts;
  for (const s of PROJECT_STAGES) counts[s] = 0;
  for (const r of rows) if (isProjectStage(r.stage)) counts[r.stage] += 1;
  return counts;
}
