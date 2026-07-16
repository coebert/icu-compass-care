import * as React from "react";
import { format, parse, parseISO, isValid } from "date-fns";
import { enGB } from "date-fns/locale";
import { CalendarIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const DATE_VALUE = "yyyy-MM-dd";
/** British display format used everywhere in the app. */
const DATE_DISPLAY = "dd/MM/yyyy";

function parseDateValue(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const d = value.length > 10 ? parseISO(value) : parse(value, DATE_VALUE, new Date());
  return isValid(d) ? d : undefined;
}

/**
 * British-formatted date picker. Stores/emits an ISO `yyyy-MM-dd` string (the
 * same shape the old native `<input type="date">` produced) while always
 * *displaying* the date as `DD/MM/YYYY`, regardless of the browser locale.
 */
export function DatePicker({
  value,
  onChange,
  id,
  disabled,
  className,
  placeholder = "DD/MM/YYYY",
}: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const selected = parseDateValue(value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn(
            "w-full justify-start text-left font-normal",
            !selected && "text-muted-foreground",
            className,
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4 shrink-0" />
          {selected ? format(selected, DATE_DISPLAY) : <span>{placeholder}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          locale={enGB}
          selected={selected}
          defaultMonth={selected}
          onSelect={(d) => {
            if (d) onChange(format(d, DATE_VALUE));
            else onChange("");
            setOpen(false);
          }}
          initialFocus
          className={cn("p-3 pointer-events-auto")}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Locale-independent 24-hour time entry field. Uses a plain text input (not the
 * native `<input type="time">`, whose display follows the OS/browser locale and
 * can render AM/PM), so entries are always shown and captured as 24-hour `HH:mm`
 * regardless of the user's locale. Free-form entry is normalised on blur:
 * "9" → 09:00, "930" → 09:30, "1345" → 13:45, "9:30" → 09:30.
 */
export function normalizeTime24(raw: string): string {
  const cleaned = raw.trim();
  if (!cleaned) return "";
  let h: number;
  let m: number;
  const parts = cleaned.split(/[:.\s]+/).filter(Boolean);
  if (parts.length >= 2) {
    h = parseInt(parts[0], 10);
    m = parseInt(parts[1], 10);
  } else {
    const digits = cleaned.replace(/\D/g, "");
    if (!digits) return "";
    if (digits.length <= 2) {
      h = parseInt(digits, 10);
      m = 0;
    } else {
      h = parseInt(digits.slice(0, digits.length - 2), 10);
      m = parseInt(digits.slice(-2), 10);
    }
  }
  if (!Number.isFinite(h)) h = 0;
  if (!Number.isFinite(m)) m = 0;
  h = Math.min(23, Math.max(0, h));
  m = Math.min(59, Math.max(0, m));
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function TimeInput24({
  value,
  onChange,
  id,
  disabled,
  className,
  "aria-label": ariaLabel = "Time (24-hour)",
}: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const [draft, setDraft] = React.useState(value);
  const [focused, setFocused] = React.useState(false);

  React.useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);

  return (
    <Input
      id={id}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      placeholder="HH:MM"
      maxLength={5}
      aria-label={ariaLabel}
      disabled={disabled}
      value={draft}
      onFocus={() => setFocused(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setFocused(false);
        const norm = normalizeTime24(draft);
        setDraft(norm);
        if (norm !== value) onChange(norm);
      }}
      className={className}
    />
  );
}

/**
 * British-formatted date + time picker. Stores/emits a `yyyy-MM-ddTHH:mm`
 * string (the shape the old native `<input type="datetime-local">` produced),
 * displaying the date part as `DD/MM/YYYY` with a locale-independent 24-hour
 * time field.
 */
export function DateTimePicker({
  value,
  onChange,
  id,
  disabled,
  className,
  placeholder = "DD/MM/YYYY",
}: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const selected = parseDateValue(value);
  const timeValue = selected ? format(selected, "HH:mm") : "";

  function emit(date: Date | undefined, time: string) {
    if (!date) {
      onChange("");
      return;
    }
    const [h, m] = (time || "00:00").split(":").map((n) => parseInt(n, 10));
    const next = new Date(date);
    next.setHours(Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0, 0, 0);
    // Emit an absolute UTC instant so the value round-trips losslessly through
    // Postgres `timestamptz` columns (see src/lib/datetime.ts). `next` is a
    // local Date built from the picked date + 24-hour time, so toISOString()
    // captures the correct instant for the user's timezone.
    onChange(next.toISOString());
  }

  return (
    <div className={cn("flex w-full min-w-0 flex-col gap-2 sm:flex-row", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            disabled={disabled}
            className={cn(
              "w-full min-w-0 flex-1 justify-start overflow-hidden text-left font-normal",
              !selected && "text-muted-foreground",
            )}
          >
            <CalendarIcon className="mr-2 h-4 w-4 shrink-0" />
            {selected ? format(selected, DATE_DISPLAY) : <span>{placeholder}</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            locale={enGB}
            selected={selected}
            defaultMonth={selected}
            onSelect={(d) => {
              emit(d ?? undefined, timeValue);
              setOpen(false);
            }}
            initialFocus
            className={cn("p-3 pointer-events-auto")}
          />
        </PopoverContent>
      </Popover>
      <TimeInput24
        aria-label="Time (24-hour)"
        disabled={disabled}
        value={timeValue}
        onChange={(t) => emit(selected ?? new Date(), t)}
        className="sm:w-32"
      />
    </div>
  );
}
