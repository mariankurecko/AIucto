import { PeriodInfo } from "./types.js";

function formatterParts(date: Date, timeZone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function previousMonth(year: number, month: number): { year: number; month: number } {
  if (month === 1) {
    return { year: year - 1, month: 12 };
  }
  return { year, month: month - 1 };
}

export function computePreviousCalendarMonth(
  now: Date,
  timeZone: string,
): PeriodInfo {
  const localNow = formatterParts(now, timeZone);
  const currentYear = Number.parseInt(localNow.year, 10);
  const currentMonth = Number.parseInt(localNow.month, 10);
  return periodFromYearMonth(...Object.values(previousMonth(currentYear, currentMonth)).map(Number) as [number, number], timeZone);
}

export function periodFromString(period: string, timeZone: string): PeriodInfo {
  const match = period.match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid period '${period}'. Expected YYYY-MM.`);
  }
  return periodFromYearMonth(
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    timeZone,
  );
}

export function periodFromYearMonth(
  year: number,
  month: number,
  timeZone: string,
): PeriodInfo {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Invalid year/month '${year}-${month}'.`);
  }
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const startDate = `${year}-${pad(month)}-01`;
  const endExclusiveDate = `${nextYear}-${pad(nextMonth)}-01`;
  return {
    period: `${year}-${pad(month)}`,
    year,
    month,
    startDate,
    endExclusiveDate,
    queryAfter: startDate.replace(/-/g, "/"),
    queryBefore: endExclusiveDate.replace(/-/g, "/"),
    timezone: timeZone,
  };
}

export function formatInternalDateToLocalDate(
  internalDateMs: number,
  timeZone: string,
): { localDate: string; timestampIso: string } {
  const date = new Date(internalDateMs);
  const parts = formatterParts(date, timeZone);
  return {
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    timestampIso: date.toISOString(),
  };
}

export function isInternalDateInPeriod(
  internalDateMs: number,
  period: PeriodInfo,
): boolean {
  const { localDate } = formatInternalDateToLocalDate(internalDateMs, period.timezone);
  return localDate >= period.startDate && localDate < period.endExclusiveDate;
}

export function buildIncomingQuery(period: PeriodInfo): string {
  return [
    `after:${period.queryAfter}`,
    `before:${period.queryBefore}`,
    "has:attachment",
    "filename:pdf",
    "-in:sent",
    "-in:spam",
    "-in:trash",
  ].join(" ");
}

export function buildSentQuery(period: PeriodInfo): string {
  return [
    "in:sent",
    `after:${period.queryAfter}`,
    `before:${period.queryBefore}`,
    "has:attachment",
    "filename:pdf",
    "-in:spam",
    "-in:trash",
  ].join(" ");
}
