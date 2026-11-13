/**
 * What a section of the console provides.
 *
 * `show` runs every time the section is opened or its address changes, with
 * whatever followed the section's name in the hash (a submission's id, a
 * user's id, a round's slug), so a record can be linked to directly.
 * A section keeps what it loaded between visits and reloads on its own
 * Refresh, or when an action elsewhere tells the store the data changed.
 */
export interface View {
  show(body: HTMLElement, tools: HTMLElement, arg: string | null): void | Promise<void>;
  hide?(): void;
}
