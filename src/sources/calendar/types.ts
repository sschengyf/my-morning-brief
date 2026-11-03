export interface CalendarEvent {
  title: string;
  location?: string;
  allDay: boolean;
  /** All-day: ISO date. Timed: ISO date-time with offset in the effective timezone. */
  start: string;
  /** All-day: exclusive ISO date. Timed: ISO date-time. */
  end: string;
}

export interface CalendarRaw {
  date: string;
  events: CalendarEvent[];
  failures: string[];
}
