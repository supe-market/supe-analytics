export const IST_TIME_ZONE = 'Asia/Kolkata';

const DAY_IN_MS = 24 * 60 * 60 * 1000;

const IST_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: IST_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatDateParts(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function formatISTDate(date: Date): string {
  const parts = IST_DATE_FORMATTER.formatToParts(date);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const day = Number(parts.find((part) => part.type === 'day')?.value);

  return formatDateParts(year, month, day);
}

export function getCurrentISTDate(): string {
  return formatISTDate(new Date());
}

export function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function formatDateOnly(date: Date): string {
  return formatDateParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function shiftDate(value: string, offsetDays: number): string {
  const date = parseDateOnly(value);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return formatDateOnly(date);
}

export function daysBetweenDates(fromDate: string, toDate: string): number {
  const diff = parseDateOnly(toDate).getTime() - parseDateOnly(fromDate).getTime();
  return Math.max(Math.floor(diff / DAY_IN_MS), 0);
}

export function getDateParts(value: string | Date): {
  year: number;
  month: number;
  day: number;
  daysInMonth: number;
  quarter: number;
} {
  const str = value instanceof Date ? formatDateOnly(value) : String(value);
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    // Handle Date.toString() format e.g. "Wed Apr 08 2026 00:00:00 GMT+0000"
    const parsed = new Date(str);
    if (isNaN(parsed.getTime())) {
      throw new Error(`Invalid date value: ${value}`);
    }
    return getDateParts(formatDateOnly(parsed));
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  return {
    year,
    month,
    day,
    daysInMonth: new Date(Date.UTC(year, month, 0)).getUTCDate(),
    quarter: Math.floor((month - 1) / 3) + 1
  };
}

export function startOfMonth(value: string): string {
  const { year, month } = getDateParts(value);
  return formatDateParts(year, month, 1);
}

export function startOfQuarter(value: string): string {
  const { year, quarter } = getDateParts(value);
  const month = (quarter - 1) * 3 + 1;
  return formatDateParts(year, month, 1);
}

export function startOfYear(value: string): string {
  const { year } = getDateParts(value);
  return formatDateParts(year, 1, 1);
}

export function getCurrentISTMonthRange(): { start: string; end: string } {
  const end = getCurrentISTDate();
  return {
    start: startOfMonth(end),
    end
  };
}
