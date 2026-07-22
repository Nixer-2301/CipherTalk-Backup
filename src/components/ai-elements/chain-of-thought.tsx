"use client";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { IconComponent } from "@/types/icon";
import { ChevronDown, CircleFill } from "@gravity-ui/icons";
import type { ComponentProps, ReactNode } from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

// 本地等价实现，避免依赖 @radix-ui/react-use-controllable-state（项目用统一的 radix-ui 包）
function useControllableState({
  prop,
  defaultProp,
  onChange,
}: {
  prop?: boolean;
  defaultProp: boolean;
  onChange?: (value: boolean) => void;
}): [boolean, (value: boolean) => void] {
  const [uncontrolled, setUncontrolled] = useState(defaultProp);
  const isControlled = prop !== undefined;
  const value = isControlled ? (prop as boolean) : uncontrolled;
  const setValue = useCallback(
    (next: boolean) => {
      if (!isControlled) {
        setUncontrolled(next);
      }
      onChange?.(next);
    },
    [isControlled, onChange]
  );
  return [value, setValue];
}

interface ChainOfThoughtContextValue {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
}

const ChainOfThoughtContext = createContext<ChainOfThoughtContextValue | null>(
  null
);

const useChainOfThought = () => {
  const context = useContext(ChainOfThoughtContext);
  if (!context) {
    throw new Error(
      "ChainOfThought components must be used within ChainOfThought"
    );
  }
  return context;
};

export type ChainOfThoughtProps = ComponentProps<"div"> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export const ChainOfThought = memo(
  ({
    className,
    open,
    defaultOpen = false,
    onOpenChange,
    children,
    ...props
  }: ChainOfThoughtProps) => {
    const [isOpen, setIsOpen] = useControllableState({
      defaultProp: defaultOpen,
      onChange: onOpenChange,
      prop: open,
    });

    const chainOfThoughtContext = useMemo(
      () => ({ isOpen, setIsOpen }),
      [isOpen, setIsOpen]
    );

    return (
      <ChainOfThoughtContext.Provider value={chainOfThoughtContext}>
        <div className={cn("not-prose w-full space-y-4", className)} {...props}>
          {children}
        </div>
      </ChainOfThoughtContext.Provider>
    );
  }
);

export type ChainOfThoughtHeaderProps = ComponentProps<
  typeof CollapsibleTrigger
>;

export const ChainOfThoughtHeader = memo(
  ({ className, children, ...props }: ChainOfThoughtHeaderProps) => {
    const { isOpen, setIsOpen } = useChainOfThought();

    return (
      <Collapsible className="w-fit max-w-full" onOpenChange={setIsOpen} open={isOpen}>
        <CollapsibleTrigger
          className={cn(
            "inline-flex w-fit max-w-full items-center gap-2 rounded-md px-1 py-0.5 text-muted-foreground text-sm hover:bg-muted/40 hover:text-foreground",
            isOpen && "text-foreground",
            className
          )}
          {...props}
        >
          <span className="truncate text-left">
            {children ?? "Chain of Thought"}
          </span>
          <ChevronDown
            className={cn(
              "size-4 transition-transform duration-200 ease-out",
              isOpen ? "rotate-180" : "rotate-0"
            )}
          />
        </CollapsibleTrigger>
      </Collapsible>
    );
  }
);

export type ChainOfThoughtStepProps = ComponentProps<"div"> & {
  icon?: IconComponent;
  label: ReactNode;
  description?: ReactNode;
  status?: "complete" | "active" | "pending";
};

const stepStatusStyles = {
  active: "text-foreground",
  complete: "text-muted-foreground",
  pending: "text-muted-foreground/50",
};

export const ChainOfThoughtStep = memo(
  ({
    className,
    icon: Icon = CircleFill,
    label,
    description,
    status = "complete",
    children,
    ...props
  }: ChainOfThoughtStepProps) => {
    const [isOpen, setIsOpen] = useState(false);
    const hasDetails = Boolean(children || description);

    return (
      <div
        className={cn(
          "flex gap-2 text-sm",
          stepStatusStyles[status],
          "fade-in-0 slide-in-from-top-2 animate-in",
          className
        )}
        {...props}
      >
        <div className="relative mt-0.5">
          <Icon className="size-4" />
          <div className="absolute top-7 bottom-0 left-1/2 -mx-px w-px bg-border" />
        </div>
        <div className="min-w-0 flex-1 overflow-hidden">
          <Collapsible onOpenChange={setIsOpen} open={isOpen}>
            <CollapsibleTrigger
              className={cn(
                "flex w-full min-w-0 items-center gap-1.5 text-left",
                hasDetails ? "cursor-pointer" : "cursor-default"
              )}
              disabled={!hasDetails}
            >
              <span className="min-w-0 truncate">{label}</span>
              {hasDetails && (
                <ChevronDown className={cn("size-3.5 shrink-0 transition-transform duration-200", isOpen && "rotate-180")} />
              )}
            </CollapsibleTrigger>
            {hasDetails && (
              <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-[ct-chain-collapse_220ms_cubic-bezier(0.4,0,0.2,1)] data-[state=open]:animate-[ct-chain-expand_220ms_cubic-bezier(0.4,0,0.2,1)]">
                <div className="space-y-2 pt-2">
                  {description && <div className="text-muted-foreground text-xs">{description}</div>}
                  {children}
                </div>
              </CollapsibleContent>
            )}
          </Collapsible>
        </div>
      </div>
    );
  }
);

export type ChainOfThoughtSearchResultsProps = ComponentProps<"div">;

export const ChainOfThoughtSearchResults = memo(
  ({ className, ...props }: ChainOfThoughtSearchResultsProps) => (
    <div
      className={cn("flex w-fit max-w-full flex-wrap items-center gap-2", className)}
      {...props}
    />
  )
);

export type ChainOfThoughtSearchResultProps = ComponentProps<typeof Badge>;

export const ChainOfThoughtSearchResult = memo(
  ({ className, children, ...props }: ChainOfThoughtSearchResultProps) => (
    <Badge
      className={cn("max-w-full gap-1 rounded-(--agent-radius,12px) px-2 py-0.5 font-normal text-xs", className)}
      variant="secondary"
      {...props}
    >
      {children}
    </Badge>
  )
);

export type ChainOfThoughtContentProps = ComponentProps<
  typeof CollapsibleContent
>;

export const ChainOfThoughtContent = memo(
  ({ className, children, ...props }: ChainOfThoughtContentProps) => {
    const { isOpen } = useChainOfThought();

    return (
      <Collapsible open={isOpen}>
        <CollapsibleContent
          className={cn(
            "mt-2 space-y-3 overflow-hidden text-popover-foreground outline-none will-change-[height,opacity]",
            "data-[state=closed]:animate-[ct-chain-collapse_220ms_cubic-bezier(0.4,0,0.2,1)] data-[state=open]:animate-[ct-chain-expand_220ms_cubic-bezier(0.4,0,0.2,1)]",
            className
          )}
          {...props}
        >
          {children}
        </CollapsibleContent>
      </Collapsible>
    );
  }
);

export type ChainOfThoughtImageProps = ComponentProps<"div"> & {
  caption?: string;
};

export const ChainOfThoughtImage = memo(
  ({ className, children, caption, ...props }: ChainOfThoughtImageProps) => (
    <div className={cn("mt-2 space-y-2", className)} {...props}>
      <div className="relative flex max-h-[22rem] items-center justify-center overflow-hidden rounded-(--agent-radius,12px) bg-muted p-3">
        {children}
      </div>
      {caption && <p className="text-muted-foreground text-xs">{caption}</p>}
    </div>
  )
);

ChainOfThought.displayName = "ChainOfThought";
ChainOfThoughtHeader.displayName = "ChainOfThoughtHeader";
ChainOfThoughtStep.displayName = "ChainOfThoughtStep";
ChainOfThoughtSearchResults.displayName = "ChainOfThoughtSearchResults";
ChainOfThoughtSearchResult.displayName = "ChainOfThoughtSearchResult";
ChainOfThoughtContent.displayName = "ChainOfThoughtContent";
ChainOfThoughtImage.displayName = "ChainOfThoughtImage";
