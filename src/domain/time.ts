// Dates and times in the notebook's time zone. "Today", the daily log a change goes in and the
// archive month all come from here.

export interface ZonedNow {
  /** YYYY-MM-DD */
  date: string
  /** HH:MM, 24-hour */
  time: string
  /** Monday, Tuesday, … */
  weekday: string
  timezone: string
}

export function zonedNow(now: Date, timezone: string): ZonedNow {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'long',
    hourCycle: 'h23',
  }).formatToParts(now)
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? ''
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
    weekday: get('weekday'),
    timezone,
  }
}

/** The computer's time zone, for local mode. */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** Whole days from `from` to `to`, both YYYY-MM-DD. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}
