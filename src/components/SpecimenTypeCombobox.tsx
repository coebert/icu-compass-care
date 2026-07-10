import { useState } from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * Searchable specimen-type picker for microbiology results. Lets the user
 * type to filter the common specimen types (blood cultures, swabs, CSF, …)
 * and pick one quickly, while still allowing a free-text value that is not in
 * the preset list (typed text can be committed with "Use …").
 */
export function SpecimenTypeCombobox({
  value,
  onChange,
  options,
  id,
  placeholder = "Search specimen type…",
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
  id?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const trimmed = query.trim();
  const hasExactMatch = options.some(
    (o) => o.toLowerCase() === trimmed.toLowerCase(),
  );

  function commit(next: string) {
    onChange(next);
    setOpen(false);
    setQuery("");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-11 w-full justify-between font-normal sm:h-10"
        >
          <span className={cn(!value && "text-muted-foreground")}>
            {value || placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] p-0"
        align="start"
      >
        <Command
          filter={(itemValue, search) =>
            itemValue.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
          }
        >
          <CommandInput
            placeholder={placeholder}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>
              {trimmed ? (
                <button
                  type="button"
                  className="mx-auto flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:underline"
                  onClick={() => commit(trimmed)}
                >
                  <Search className="h-4 w-4" /> Use “{trimmed}”
                </button>
              ) : (
                "No specimen type found."
              )}
            </CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option}
                  value={option}
                  onSelect={() => commit(option)}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === option ? "opacity-100" : "opacity-0",
                    )}
                  />
                  {option}
                </CommandItem>
              ))}
              {trimmed && !hasExactMatch && (
                <CommandItem
                  value={`__use__${trimmed}`}
                  onSelect={() => commit(trimmed)}
                >
                  <Search className="mr-2 h-4 w-4" /> Use “{trimmed}”
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
