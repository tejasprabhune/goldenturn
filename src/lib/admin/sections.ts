/**
 * The console's sections, in sidebar order. Shared by the sidebar markup and
 * the router so a section cannot be listed without a view or the reverse.
 */

export interface SectionDef {
  id: string;
  label: string;
  /** Quiet heading over a run of sections; null for the ones at the top. */
  group: string | null;
}

export const SECTIONS: SectionDef[] = [
  { id: 'overview', label: 'Overview', group: null },
  { id: 'telemetry', label: 'Telemetry', group: 'Audience' },
  { id: 'rounds', label: 'Rounds', group: 'Archive' },
  { id: 'submissions', label: 'Submissions', group: 'Archive' },
  { id: 'proposals', label: 'Proposals', group: 'Archive' },
  { id: 'users', label: 'Users', group: 'People' },
  { id: 'prep', label: 'Prep access', group: 'People' },
];

export const DEFAULT_SECTION = 'overview';
