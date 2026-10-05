// frontend/src/lib/caseflowPeriods.ts
//
// Bucket boundaries for the dashboard Caseflow chart's period switch,
// computed in the browser's local calendar (so a UK week starts Monday
// 00:00 UK time and months follow the calendar, BST included).

export type CaseflowPeriod = "weeks" | "lastWeek" | "thisMonth" | "thisYear";

export const CASEFLOW_PERIODS: { key: CaseflowPeriod; label: string; subtitle: string }[] = [
  { key: "weeks", label: "5 weeks", subtitle: "last 5 weeks" },
  { key: "lastWeek", label: "Last week", subtitle: "last week, by day" },
  { key: "thisMonth", label: "This month", subtitle: "this month, by day" },
  { key: "thisYear", label: "This year", subtitle: "this year, by month" },
];

export interface CaseflowRange {
  starts: Date[];
  end: Date;
  /** Short x-axis label per bucket. */
  labels: string[];
  /** Longer tooltip label per bucket. */
  ranges: string[];
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function mondayOf(d: Date): Date {
  const x = startOfDay(d);
  return addDays(x, -((x.getDay() + 6) % 7));
}

const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleDateString("en-GB", o);

export function caseflowRange(period: CaseflowPeriod, now: Date = new Date()): CaseflowRange {
  const thisMonday = mondayOf(now);

  if (period === "lastWeek") {
    const starts = Array.from({ length: 7 }, (_, i) => addDays(thisMonday, i - 7));
    return {
      starts,
      end: thisMonday,
      labels: starts.map((d) => fmt(d, { weekday: "short", day: "numeric" })),
      ranges: starts.map((d) => fmt(d, { weekday: "long", day: "numeric", month: "short" })),
    };
  }

  if (period === "thisMonth") {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const days = now.getDate();
    const starts = Array.from({ length: days }, (_, i) => addDays(first, i));
    return {
      starts,
      end: addDays(startOfDay(now), 1),
      labels: starts.map((d) => String(d.getDate())),
      ranges: starts.map((d) => fmt(d, { weekday: "short", day: "numeric", month: "short" })),
    };
  }

  if (period === "thisYear") {
    const months = now.getMonth() + 1;
    const starts = Array.from({ length: months }, (_, i) => new Date(now.getFullYear(), i, 1));
    return {
      starts,
      end: new Date(now.getFullYear(), now.getMonth() + 1, 1),
      labels: starts.map((d) => fmt(d, { month: "short" })),
      ranges: starts.map((d) => fmt(d, { month: "long", year: "numeric" })),
    };
  }

  // "weeks": the last 5 Monday–Sunday weeks, this week included.
  const starts = Array.from({ length: 5 }, (_, i) => addDays(thisMonday, (i - 4) * 7));
  return {
    starts,
    end: addDays(thisMonday, 7),
    labels: starts.map((d) => fmt(d, { day: "numeric", month: "short" })),
    ranges: starts.map(
      (d) => `${fmt(d, { day: "numeric", month: "short" })} – ${fmt(addDays(d, 6), { day: "numeric", month: "short" })}`,
    ),
  };
}
