import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Loader2 } from "lucide-react";

import { getProviders } from "@/services/api";
import type { Provider } from "@/pages/ProviderDirectory";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

// Provider fields arrive in snake_case here — services/api.ts:getProviders
// runs the API response through snakeKeys(). Read only the snake_case keys
// (email_ceding_dept / email_main / is_on_origo / is_active).

interface ProviderPickerProps {
  currentProviderId: string | null;
  onPick: (providerId: string) => void;
  disabled?: boolean;
}

export function ProviderPicker({ currentProviderId, onPick, disabled }: ProviderPickerProps) {
  const [open, setOpen] = useState(false);

  const { data: raw = [], isLoading } = useQuery({
    queryKey: ["providers"],
    queryFn: getProviders,
  });

  const providers = (raw as Provider[]).filter((p) => p.is_active);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="h-7 gap-1 text-[11px] uppercase tracking-wider"
        >
          Change provider <ChevronsUpDown className="h-3 w-3 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[380px] p-0" align="end">
        <Command>
          <CommandInput placeholder="Search provider…" />
          <CommandList>
            {isLoading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading providers…
              </div>
            ) : (
              <>
                <CommandEmpty>No provider found.</CommandEmpty>
                <CommandGroup>
                  {providers.map((p) => {
                    const previewEmail = p.email_ceding_dept ?? p.email_main ?? null;
                    const isCurrent = p.id === currentProviderId;
                    return (
                      <CommandItem
                        key={p.id}
                        value={`${p.name} ${p.email_main ?? ""} ${p.email_ceding_dept ?? ""}`}
                        onSelect={() => {
                          onPick(p.id);
                          setOpen(false);
                        }}
                        className="flex flex-col items-start gap-0.5 py-2"
                      >
                        <div className="flex w-full items-center gap-2">
                          <Check
                            className={cn(
                              "h-3.5 w-3.5 shrink-0",
                              isCurrent ? "opacity-100 text-teal" : "opacity-0",
                            )}
                          />
                          <span className="font-medium text-foreground">{p.name}</span>
                          {p.is_on_origo && (
                            <Badge variant="outline" className="ml-auto h-4 px-1 text-[10px]">
                              Origo
                            </Badge>
                          )}
                        </div>
                        <div
                          className={cn(
                            "ml-5 font-mono text-[11px]",
                            previewEmail ? "text-muted-foreground" : "text-warning",
                          )}
                        >
                          {previewEmail ?? "no email on file"}
                        </div>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
