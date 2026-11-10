import { describe, expect, it } from 'vitest';
import { dropDuplicateDates } from './repair.js';

const lines = (...rows: string[]) => rows.join('\r\n');

describe('dropDuplicateDates', () => {
  it('keeps the first DTEND of an event, with its folded lines, and leaves the rest alone', () => {
    const ics = lines(
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'DTSTART;TZID=Asia/Shanghai:20230127T030000',
      'DTEND;TZID=Asia/Shanghai:20230127T040000',
      'DTEND;TZID=Asia/Shanghai:20230127T050000',
      ' X-FOLDED-PART',
      'SUMMARY:Dinner',
      ' continued',
      'END:VEVENT',
      'END:VCALENDAR',
    );
    expect(dropDuplicateDates(ics)).toBe(
      lines(
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'DTSTART;TZID=Asia/Shanghai:20230127T030000',
        'DTEND;TZID=Asia/Shanghai:20230127T040000',
        'SUMMARY:Dinner',
        ' continued',
        'END:VEVENT',
        'END:VCALENDAR',
      ),
    );
  });

  it('counts each component on its own, nested ones included', () => {
    const ics = lines(
      'BEGIN:VCALENDAR',
      'BEGIN:VTIMEZONE',
      'BEGIN:STANDARD',
      'DTSTART:19700405T030000',
      'END:STANDARD',
      'BEGIN:DAYLIGHT',
      'DTSTART:19700927T020000',
      'END:DAYLIGHT',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'DTSTART:20261110T090000Z',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'DTSTART:20261111T090000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    );
    expect(dropDuplicateDates(ics)).toBe(ics);
  });
});
