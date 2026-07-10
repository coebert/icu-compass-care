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
const DATETIME_VALUE = "yyyy-MM-dd'T'HH:mm";
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
 * British-formatted date + time picker. Stores/emits a `yyyy-MM-ddTHH:mm`
 * string (the shape the old native `<input type="datetime-local">` produced),
 * displaying the date part as `DD/MM/YYYY` with a 24-hour time field.
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
    onChange(format(next, DATETIME_VALUE));
  }

  return (
    <div className={cn("flex flex-col gap-2 sm:flex-row", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            disabled={disabled}
            className={cn(
              "flex-1 justify-start text-left font-normal",
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
      <Input
        type="time"
        aria-label="Time"
        disabled={disabled}
        value={timeValue}
        onChange={(e) => emit(selected ?? new Date(), e.target.value)}
        className="sm:w-32"
      />
    </div>
  );
}
