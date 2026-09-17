export type StoreHour = {
  day_of_week: number;
  opens_at: string;
  closes_at: string;
  active: boolean;
};

export type ScheduleException = {
  exception_date: string;
  is_closed: boolean;
  opens_at: string | null;
  closes_at: string | null;
};

function localParts(at: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const weekdays: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6
  };
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    dayOfWeek: weekdays[get("weekday")] ?? -1,
    time: `${get("hour")}:${get("minute")}:${get("second")}`
  };
}

function normalizeTime(value: string) {
  return value.length === 5 ? `${value}:00` : value.slice(0, 8);
}

function isOvernight(opensAt: string, closesAt: string) {
  return normalizeTime(opensAt) > normalizeTime(closesAt);
}

function insideSameDate(time: string, opensAt: string, closesAt: string) {
  const opens = normalizeTime(opensAt);
  const closes = normalizeTime(closesAt);
  if (opens <= closes) return time >= opens && time < closes;
  return time >= opens;
}

function previousDate(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function evaluateStoreSchedule(input: {
  at: Date;
  timezone: string;
  hours: StoreHour[];
  exceptions: ScheduleException[];
}) {
  let local: ReturnType<typeof localParts>;
  try {
    local = localParts(input.at, input.timezone);
  } catch {
    return { open: false, configured: false, source: "invalid" as const };
  }

  const exception = input.exceptions.find(
    (candidate) => candidate.exception_date === local.date
  );

  if (exception) {
    const open = !exception.is_closed && !!exception.opens_at && !!exception.closes_at &&
      insideSameDate(local.time, exception.opens_at, exception.closes_at);
    return { open, configured: true, source: "exception" as const };
  }

  const activeHours = input.hours.filter((hour) => hour.active);
  const yesterday = previousDate(local.date);
  const previousException = input.exceptions.find(
    (candidate) => candidate.exception_date === yesterday
  );

  if (previousException) {
    if (
      !previousException.is_closed &&
      previousException.opens_at &&
      previousException.closes_at &&
      isOvernight(previousException.opens_at, previousException.closes_at) &&
      local.time < normalizeTime(previousException.closes_at)
    ) {
      return { open: true, configured: true, source: "exception" as const };
    }
  } else {
    const previousDay = (local.dayOfWeek + 6) % 7;
    const carriedFromYesterday = activeHours.some((hour) =>
      hour.day_of_week === previousDay &&
      isOvernight(hour.opens_at, hour.closes_at) &&
      local.time < normalizeTime(hour.closes_at)
    );
    if (carriedFromYesterday) {
      return { open: true, configured: true, source: "weekly" as const };
    }
  }

  const today = activeHours.filter((hour) => hour.day_of_week === local.dayOfWeek);
  return {
    open: today.some((hour) => insideSameDate(local.time, hour.opens_at, hour.closes_at)),
    configured: activeHours.length > 0,
    source: "weekly" as const
  };
}
