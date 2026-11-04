export type Days = 'daily' | 'weekdays' | 'weekends';

export interface Schedule {
  /** Created once and never changed; state.json records sends by it. */
  id: string;
  /** "HH:MM" in the effective timezone. */
  time: string;
  days: Days;
  /** ISO with offset. The occurrence on the day it was added only counts if still ahead. */
  createdAt: string;
}
