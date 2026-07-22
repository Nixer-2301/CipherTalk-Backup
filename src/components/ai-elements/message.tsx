"use client";

import { Button } from "@/components/ui/aie-button";
import {
  ButtonGroup,
  ButtonGroupText,
} from "@/components/ui/button-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  Button as HeroButton,
  ButtonGroup as HeroButtonGroup,
  Card as HeroCard,
  Separator as HeroSeparator,
  Table as HeroTable,
  Toolbar as HeroToolbar,
} from "@heroui/react";
import type { FileUIPart, UIMessage } from "ai";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Code,
  Copy,
  ArrowDownToLine,
  ArrowUpRightFromSquare,
  Eye,
  File,
  CircleDashed,
  LayoutHeaderCellsLarge,
  Xmark,
} from "@gravity-ui/icons";
import type { ComponentProps, HTMLAttributes, ReactElement, ReactNode } from "react";
import { Children, Fragment, cloneElement, createContext, isValidElement, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { bundledLanguages, type BundledLanguage } from "shiki";
import { CodeBlock } from "./code-block";
import { Terminal, TerminalContent } from "./terminal";
import {
  WebPreview,
  WebPreviewBody,
  WebPreviewNavigation,
  WebPreviewUrl,
} from "./web-preview";
import { ChartBlock, type ChartBlockHandle, parseChartOption } from "./chart-block";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[95%] flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className
    )}
    data-agent-message-role={from}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "is-user:dark flex w-fit max-w-full min-w-0 flex-col gap-2 overflow-hidden text-sm",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-(--agent-radius,12px) group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = Omit<ComponentProps<typeof HeroToolbar>, "children"> & {
  children?: ReactNode;
};

export const MessageActions = ({
  className,
  children,
  "aria-label": ariaLabel = "回答操作",
  ...props
}: MessageActionsProps) => {
  const groups: ReactNode[][] = [[]];
  for (const child of Children.toArray(children)) {
    if (!isValidElement<MessageActionProps>(child) || child.type !== MessageAction) {
      groups[groups.length - 1].push(child);
      continue;
    }
    if (child.props.startsGroup && groups[groups.length - 1].length > 0) {
      groups.push([]);
    }
    const groupIndex = groups[groups.length - 1].length;
    groups[groups.length - 1].push(cloneElement(child, {
      showGroupSeparator: child.props.showGroupSeparator ?? groupIndex > 0,
    }));
  }

  return (
    <HeroToolbar aria-label={ariaLabel} className={cn("max-w-full gap-2", className)} {...props}>
      {groups.filter((group) => group.length > 0).map((group, index) => (
        <Fragment key={`group-${index}`}>
          {index > 0 && <HeroSeparator />}
          <div className="flex items-center gap-1" role="group">
            {group}
          </div>
        </Fragment>
      ))}
    </HeroToolbar>
  );
};

type MessageFloatingToolbarAction = {
  ariaLabel: string;
  icon: ReactNode;
  isDisabled?: boolean;
  onPress: () => void;
};

type MessageFloatingToolbarProps = Omit<ComponentProps<typeof HeroToolbar>, "children"> & {
  actions: MessageFloatingToolbarAction[];
  excludeFromTableExport?: boolean;
};

function MessageFloatingToolbar({
  actions,
  className,
  excludeFromTableExport = false,
  "aria-label": ariaLabel = "内容操作",
  ...props
}: MessageFloatingToolbarProps) {
  if (actions.length === 0) return null;

  return (
    <HeroToolbar
      aria-label={ariaLabel}
      className={cn("absolute top-1 right-1 z-10 gap-1 border-0 bg-transparent p-0 shadow-none", className)}
      data-ai-table-actions={excludeFromTableExport ? "" : undefined}
      {...props}
    >
      <HeroButtonGroup className="border-0 bg-transparent shadow-none" variant="ghost">
        {actions.map((action) => (
          <HeroButton
            aria-label={action.ariaLabel}
            className="size-8 min-w-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground data-[hovered=true]:bg-transparent data-[hovered=true]:text-foreground data-[pressed=true]:scale-95 [&_svg]:size-4"
            isDisabled={action.isDisabled}
            isIconOnly
            key={action.ariaLabel}
            onPress={action.onPress}
            size="sm"
          >
            {action.icon}
          </HeroButton>
        ))}
      </HeroButtonGroup>
    </HeroToolbar>
  );
}

export type MessageActionProps = Omit<
  ComponentProps<"button">,
  "children" | "className" | "disabled" | "onClick" | "type"
> & {
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  isDisabled?: boolean;
  tooltip?: string;
  label?: string;
  onClick?: () => void;
  onPress?: ComponentProps<"button">["onClick"];
  showGroupSeparator?: boolean;
  startsGroup?: boolean;
  size?: "icon-sm" | "sm" | "md" | "lg";
  variant?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant: _variant = "tertiary",
  size = "icon-sm",
  className,
  disabled,
  isDisabled,
  onClick,
  onPress,
  showGroupSeparator: _showGroupSeparator,
  startsGroup: _startsGroup,
  ...props
}: MessageActionProps) => {
  const isIconOnly = size === "icon-sm" || Children.count(children) === 1;
  const resolvedDisabled = isDisabled ?? disabled;
  const renderedChildren = Children.map(children, (child) => {
    if (!isValidElement<{ className?: string }>(child)) return child;
    return cloneElement(child, {
      className: cn(child.props.className, "size-4 stroke-[2.35]"),
    });
  });

  return (
    <button
      aria-label={props["aria-label"] ?? label ?? tooltip}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-(--agent-radius,12px) bg-transparent text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-45",
        isIconOnly ? "size-6 p-0" : "h-7 gap-1 px-1.5 text-xs",
        className
      )}
      disabled={resolvedDisabled}
      onClick={(event) => {
        onPress?.(event);
        onClick?.();
      }}
      type="button"
      {...props}
    >
      {renderedChildren}
      <span className="sr-only">{label || tooltip}</span>
    </button>
  );
};

type MessageBranchContextType = {
  currentBranch: number;
  totalBranches: number;
  goToPrevious: () => void;
  goToNext: () => void;
  branches: ReactElement[];
  setBranches: (branches: ReactElement[]) => void;
};

const MessageBranchContext = createContext<MessageBranchContextType | null>(
  null
);

const useMessageBranch = () => {
  const context = useContext(MessageBranchContext);

  if (!context) {
    throw new Error(
      "MessageBranch components must be used within MessageBranch"
    );
  }

  return context;
};

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number;
  onBranchChange?: (branchIndex: number) => void;
};

export const MessageBranch = ({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch);
  const [branches, setBranches] = useState<ReactElement[]>([]);

  const handleBranchChange = (newBranch: number) => {
    setCurrentBranch(newBranch);
    onBranchChange?.(newBranch);
  };

  const goToPrevious = () => {
    const newBranch =
      currentBranch > 0 ? currentBranch - 1 : branches.length - 1;
    handleBranchChange(newBranch);
  };

  const goToNext = () => {
    const newBranch =
      currentBranch < branches.length - 1 ? currentBranch + 1 : 0;
    handleBranchChange(newBranch);
  };

  const contextValue: MessageBranchContextType = {
    currentBranch,
    totalBranches: branches.length,
    goToPrevious,
    goToNext,
    branches,
    setBranches,
  };

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div
        className={cn("grid w-full gap-2 [&>div]:pb-0", className)}
        {...props}
      />
    </MessageBranchContext.Provider>
  );
};

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageBranchContent = ({
  children,
  ...props
}: MessageBranchContentProps) => {
  const { currentBranch, setBranches, branches } = useMessageBranch();
  const childrenArray = Array.isArray(children) ? children : [children];

  // Use useEffect to update branches when they change
  useEffect(() => {
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray);
    }
  }, [childrenArray, branches, setBranches]);

  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        "grid gap-2 overflow-hidden [&>div]:pb-0",
        index === currentBranch ? "block" : "hidden"
      )}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ));
};

export type MessageBranchSelectorProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const MessageBranchSelector = ({
  className,
  from,
  ...props
}: MessageBranchSelectorProps) => {
  const { totalBranches } = useMessageBranch();

  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null;
  }

  return (
    <ButtonGroup
      className="[&>*:not(:first-child)]:rounded-l-(--agent-radius,12px) [&>*:not(:last-child)]:rounded-r-(--agent-radius,12px)"
      orientation="horizontal"
      {...props}
    />
  );
};

export type MessageBranchPreviousProps = ComponentProps<typeof Button>;

export const MessageBranchPrevious = ({
  children,
  ...props
}: MessageBranchPreviousProps) => {
  const { goToPrevious, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Previous branch"
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronLeft width={14} height={14} />}
    </Button>
  );
};

export type MessageBranchNextProps = ComponentProps<typeof Button>;

export const MessageBranchNext = ({
  children,
  className,
  ...props
}: MessageBranchNextProps) => {
  const { goToNext, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Next branch"
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronRight width={14} height={14} />}
    </Button>
  );
};

export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>;

export const MessageBranchPage = ({
  className,
  ...props
}: MessageBranchPageProps) => {
  const { currentBranch, totalBranches } = useMessageBranch();

  return (
    <ButtonGroupText
      className={cn(
        "border-none bg-transparent text-muted-foreground shadow-none",
        className
      )}
      {...props}
    >
      {currentBranch + 1} of {totalBranches}
    </ButtonGroupText>
  );
};

export type MessageResponseProps = ComponentProps<typeof Streamdown> & {
  isStreaming?: boolean;
  showStreamingIndicator?: boolean;
};

const DEFAULT_CODE_LANGUAGE: BundledLanguage = "md";

const LANGUAGE_ALIASES: Record<string, BundledLanguage> = {
  plain: "md",
  plaintext: "md",
  text: "md",
};

const TERMINAL_LANGUAGES = new Set([
  "ansi",
  "bash",
  "bat",
  "cmd",
  "console",
  "fish",
  "log",
  "powershell",
  "ps1",
  "sh",
  "shell",
  "shellsession",
  "terminal",
  "text",
  "txt",
  "zsh",
]);

const CHART_LANGUAGES = new Set(["chart", "echarts"]);
const CHART_OPTION_LANGUAGES = new Set(["chart", "echarts", "json"]);
const DATA_TABLE_LANGUAGES = new Set(["csv", "tsv"]);

export type MessageRenderActivity = {
  hasChart: boolean;
  hasCode: boolean;
  hasLink: boolean;
  hasTable: boolean;
  linkCount: number;
  pendingChart: boolean;
  pendingCode: boolean;
  pendingLink: boolean;
  pendingTable: boolean;
};

const EMPTY_RENDER_ACTIVITY: MessageRenderActivity = {
  hasChart: false,
  hasCode: false,
  hasLink: false,
  hasTable: false,
  linkCount: 0,
  pendingChart: false,
  pendingCode: false,
  pendingLink: false,
  pendingTable: false,
};

function normalizeMarkdownLanguage(language?: string): string {
  return language?.trim().toLowerCase().replace(/[^\w#+.-].*$/, "") || "";
}

function scanFencedCode(markdown: string) {
  const lines = markdown.split(/\r?\n/);
  const languages: string[] = [];
  let inFence = false;
  let openLanguage = "";
  const nonFenceLines: string[] = [];

  for (const line of lines) {
    const match = line.match(/^\s*(```+|~~~+)\s*([^\s`]*)?/);
    if (match) {
      if (inFence) {
        inFence = false;
        openLanguage = "";
      } else {
        openLanguage = normalizeMarkdownLanguage(match[2]);
        languages.push(openLanguage);
        inFence = true;
      }
      continue;
    }
    if (!inFence) nonFenceLines.push(line);
  }

  return { inFence, languages, nonFenceLines, openLanguage };
}

function hasMarkdownTable(lines: string[]): boolean {
  const separator = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = lines[index];
    const divider = lines[index + 1];
    if (header.includes("|") && separator.test(divider)) return true;
  }
  return false;
}

function hasLikelyPendingTable(lines: string[]): boolean {
  const recent = lines.slice(-6).map((line) => line.trim()).filter(Boolean);
  if (recent.length === 0) return false;
  const last = recent[recent.length - 1];
  if (!last.includes("|")) return false;
  if (/^\|?\s*:?-{0,2}:?\s*(\|\s*:?-{0,2}:?\s*)+\|?$/.test(last)) return true;
  return recent.some((line) => line.split("|").length >= 3);
}

export function analyzeMessageRenderActivity(markdown: string, isStreaming = false): MessageRenderActivity {
  if (!markdown.trim()) return EMPTY_RENDER_ACTIVITY;

  const { inFence, languages, nonFenceLines, openLanguage } = scanFencedCode(markdown);
  const hasChart = languages.some((language) => CHART_LANGUAGES.has(language));
  const hasDataTableCode = languages.some((language) => DATA_TABLE_LANGUAGES.has(language));
  const hasCode = languages.some((language) => !CHART_LANGUAGES.has(language) && !DATA_TABLE_LANGUAGES.has(language));
  const hasTable = hasMarkdownTable(nonFenceLines) || hasDataTableCode;
  const markdownLinks = markdown.match(/\[[^\]]*]\((?:https?:\/\/|\/|#|mailto:|tel:)[^)]+\)/gi) ?? [];
  const bareLinkSource = markdown.replace(/\[[^\]]*]\((?:https?:\/\/|\/|#|mailto:|tel:)[^)]+\)/gi, " ");
  const bareLinks = bareLinkSource.match(/(?:https?:\/\/|mailto:|tel:)[^\s<>)]+/gi) ?? [];
  const linkCount = markdownLinks.length + bareLinks.length;
  const pendingChart = isStreaming && inFence && CHART_LANGUAGES.has(openLanguage);
  const pendingDataTableCode = isStreaming && inFence && DATA_TABLE_LANGUAGES.has(openLanguage);
  const pendingCode = isStreaming && inFence && !pendingChart && !pendingDataTableCode;
  const pendingTable = pendingDataTableCode || (isStreaming && !hasTable && hasLikelyPendingTable(nonFenceLines));
  const pendingLink = isStreaming && /(?:https?:\/\/|mailto:|tel:)[^\s<>)]*$/i.test(markdown.trim());

  return {
    hasChart,
    hasCode,
    hasLink: linkCount > 0,
    hasTable,
    linkCount,
    pendingChart,
    pendingCode,
    pendingLink,
    pendingTable,
  };
}

const MessageRenderContext = createContext<{ isStreaming: boolean; markdown: string }>({
  isStreaming: false,
  markdown: "",
});

function normalizeCodeLanguage(language?: string): BundledLanguage {
  const normalized = language?.trim().toLowerCase();
  if (!normalized) return DEFAULT_CODE_LANGUAGE;
  const aliased = LANGUAGE_ALIASES[normalized] || normalized;
  if (Object.prototype.hasOwnProperty.call(bundledLanguages, aliased)) {
    return aliased as BundledLanguage;
  }
  return DEFAULT_CODE_LANGUAGE;
}

function getRawCodeLanguage(className?: string): string | undefined {
  return className?.match(/language-([^\s]+)/)?.[1]?.trim();
}

function getOriginalFenceLanguage(markdown: string, code: string, classLanguage?: string): string | undefined {
  if (!markdown || !code) return undefined;

  const expectedLanguage = normalizeMarkdownLanguage(classLanguage);
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let fenceMarker = "";
  let fenceLength = 0;
  let fenceLanguage = "";
  let fenceLines: string[] = [];
  const candidates: { code: string; language: string }[] = [];

  for (const line of lines) {
    const openMatch = line.match(/^\s*(```+|~~~+)\s*([^\s`]*)?/);
    if (openMatch) {
      if (inFence) {
        const marker = openMatch[1];
        if (marker[0] === fenceMarker && marker.length >= fenceLength) {
          candidates.push({
            code: fenceLines.join("\n"),
            language: fenceLanguage,
          });
          inFence = false;
          fenceMarker = "";
          fenceLength = 0;
          fenceLanguage = "";
          fenceLines = [];
        } else {
          fenceLines.push(line);
        }
      } else {
        const marker = openMatch[1];
        inFence = true;
        fenceMarker = marker[0];
        fenceLength = marker.length;
        fenceLanguage = openMatch[2]?.trim() ?? "";
        fenceLines = [];
      }
      continue;
    }

    if (inFence) fenceLines.push(line);
  }

  const normalizedCode = code.replace(/\n$/, "");
  const match = candidates.find((candidate) => {
    if (candidate.code.replace(/\n$/, "") !== normalizedCode) return false;
    if (!expectedLanguage) return true;
    return normalizeMarkdownLanguage(candidate.language) === expectedLanguage;
  }) ?? candidates.find((candidate) => candidate.code.replace(/\n$/, "") === normalizedCode);

  return match?.language || undefined;
}

function isHtmlCode(language: string | undefined, code: string): boolean {
  if (language === "html" || language === "htm" || language === "xhtml") {
    return true;
  }
  return /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(code);
}

function isTerminalCode(language: string | undefined): boolean {
  return Boolean(language && TERMINAL_LANGUAGES.has(language));
}

function isChartCode(language: string | undefined): boolean {
  return Boolean(language && CHART_LANGUAGES.has(language));
}

function canParseChartOption(language: string | undefined): boolean {
  return Boolean(language && CHART_OPTION_LANGUAGES.has(language));
}

type MessageCodeProps = ComponentProps<"code"> & {
  node?: unknown;
  "data-block"?: boolean | string;
};

function StreamingChartPlaceholder({ language }: { language?: string }) {
  return (
    <div aria-label={`正在生成${language || "图表"}`} className="relative my-2 w-full max-w-full overflow-hidden" role="img">
      <CircleDashed className="absolute top-5 right-5 z-10 size-4 animate-spin text-muted-foreground" />
      <div className="flex aspect-video min-h-72 flex-col gap-4">
        <div className="h-5 w-40 animate-pulse rounded bg-muted" />
        <div className="grid flex-1 grid-cols-6 items-end gap-3">
          {[46, 72, 58, 86, 64, 78].map((height, index) => (
            <div
              className="animate-pulse rounded-t bg-muted"
              key={index}
              style={{ height: `${height}%` }}
            />
          ))}
        </div>
        <div className="flex justify-between gap-3">
          <div className="h-3 w-20 animate-pulse rounded bg-muted" />
          <div className="h-3 w-24 animate-pulse rounded bg-muted" />
          <div className="h-3 w-16 animate-pulse rounded bg-muted" />
        </div>
      </div>
    </div>
  );
}

// mermaid 渲染流水号：mermaid.render 需要全局唯一的容器 id
let mermaidRenderSeq = 0;

/**
 * ```mermaid 代码块 → SVG 流程图。
 * mermaid 库较大，动态 import 按需加载（Vite 自动分包）；渲染失败回退为源码展示。
 * mermaid 默认 securityLevel=strict，输出 SVG 内部已做 sanitize。
 */
function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setSvg("");
    setError("");
    void (async () => {
      try {
        const { mermaid } = await import("@streamdown/mermaid");
        const isDark = document.documentElement.classList.contains("dark");
        const instance = mermaid.getMermaid({ theme: isDark ? "dark" : "default" });
        const rendered = await instance.render(`ct-mermaid-${++mermaidRenderSeq}`, code);
        if (!cancelled) setSvg(rendered.svg);
      } catch (renderError) {
        if (!cancelled) setError(renderError instanceof Error ? renderError.message : String(renderError));
      }
    })();
    return () => { cancelled = true; };
  }, [code]);

  if (error) {
    return (
      <div className="my-2 w-full max-w-full overflow-hidden rounded-(--agent-radius,12px) border border-border/70 bg-card">
        <div className="border-border/70 border-b px-3 py-1.5 text-destructive text-xs">流程图渲染失败：{error}</div>
        <pre className="overflow-x-auto px-3 py-2 font-mono text-foreground text-xs leading-5">{code}</pre>
      </div>
    );
  }
  if (!svg) {
    return (
      <div aria-label="正在渲染流程图" className="my-2 flex min-h-40 w-full items-center justify-center gap-2 rounded-(--agent-radius,12px) border border-border/70 bg-card text-muted-foreground text-xs" role="img">
        <CircleDashed className="size-4 animate-spin" />
        渲染流程图…
      </div>
    );
  }
  return (
    <div
      className="my-2 w-full max-w-full overflow-x-auto rounded-(--agent-radius,12px) border border-border/70 bg-card p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid strict 模式输出的已 sanitize SVG
      dangerouslySetInnerHTML={{ __html: svg }}
      role="img"
    />
  );
}

const MessageCode = ({ children, className, node: _node, ...props }: MessageCodeProps) => {
  const { isStreaming, markdown } = useContext(MessageRenderContext);
  const [isCopied, setIsCopied] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const isBlock = "data-block" in props;
  if (!isBlock) {
    return (
      <code className={cn(className, "box-decoration-clone rounded-(--agent-radius,12px) border border-primary/20 bg-primary/10 px-1.5 py-0.5 font-mono text-[0.85em] text-foreground dark:bg-primary/20")}>
        {children}
      </code>
    );
  }

  const code = String(children ?? "").replace(/\n$/, "");
  const rawLanguage = getRawCodeLanguage(className);
  const displayLanguage = getOriginalFenceLanguage(markdown, code, rawLanguage) ?? rawLanguage;
  const canPreviewHtml = isHtmlCode(rawLanguage, code);
  const canRenderTerminal = isTerminalCode(rawLanguage);
  const chartOption = useMemo(
    () => canParseChartOption(rawLanguage) ? parseChartOption(code) : null,
    [code, rawLanguage]
  );
  const language = normalizeCodeLanguage(canPreviewHtml && !rawLanguage ? "html" : rawLanguage);
  const chartRef = useRef<ChartBlockHandle | null>(null);

  // mermaid：流式期间先按源码高亮展示，流结束后再渲染成图（半成品源码必然渲染失败）
  if (rawLanguage === "mermaid" && !isStreaming) {
    return <MermaidBlock code={code} />;
  }

  if (isStreaming && isChartCode(rawLanguage) && !chartOption) {
    return <StreamingChartPlaceholder language={rawLanguage} />;
  }

  const handleCopy = async () => {
    if (typeof window === "undefined" || !navigator?.clipboard?.writeText) return;
    await navigator.clipboard.writeText(code);
    setIsCopied(true);
    window.setTimeout(() => setIsCopied(false), 2000);
  };
  const handleDownloadChart = () => {
    const dataUrl = chartRef.current?.getDataURL();
    if (!dataUrl) return;
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = `ai-chart-${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (chartOption) {
    return (
      <div className="relative my-2 w-full max-w-full overflow-hidden">
        <MessageFloatingToolbar
          actions={[
            {
              ariaLabel: isCopied ? "图表配置已复制" : "复制图表配置",
              icon: isCopied ? <Check /> : <Copy />,
              onPress: () => void handleCopy(),
            },
            {
              ariaLabel: "下载图表",
              icon: <ArrowDownToLine />,
              onPress: handleDownloadChart,
            },
          ]}
          aria-label="图表操作"
        />
        <ChartBlock className="aspect-video h-auto min-h-72" option={chartOption} ref={chartRef} />
      </div>
    );
  }

  return (
    <HeroCard className="group/code relative my-2 flex w-fit max-w-full gap-0 overflow-hidden border border-border/70 bg-card p-0 text-card-foreground shadow-xs" variant="default">
      <div className="absolute top-2 right-2 z-10 flex items-center gap-1 opacity-70 transition-opacity group-hover/code:opacity-100">
          {canPreviewHtml && (
            <HeroButton
              aria-label={showPreview ? "查看代码" : "预览 HTML"}
              className="size-7 min-w-0 rounded-full bg-background/65 p-0 text-muted-foreground shadow-none backdrop-blur-sm data-[hovered=true]:bg-accent/15 data-[hovered=true]:text-foreground data-[pressed=true]:scale-95 [&_svg]:size-3.5"
              isIconOnly
              onPress={() => setShowPreview((value) => !value)}
              size="sm"
              variant="ghost"
            >
              {showPreview ? <Code /> : <Eye />}
            </HeroButton>
          )}
          <HeroButton
            aria-label={isCopied ? "已复制" : "复制代码"}
            className="size-7 min-w-0 rounded-full bg-background/65 p-0 text-muted-foreground shadow-none backdrop-blur-sm data-[hovered=true]:bg-accent/15 data-[hovered=true]:text-foreground data-[pressed=true]:scale-95 [&_svg]:size-3.5"
            isIconOnly
            onPress={() => void handleCopy()}
            size="sm"
            variant="ghost"
          >
            {isCopied ? <Check /> : <Copy />}
          </HeroButton>
      </div>
      {showPreview && canPreviewHtml ? (
        <WebPreview className="min-h-72 rounded-none border-0" defaultUrl="about:srcdoc">
          <WebPreviewNavigation>
            <WebPreviewUrl readOnly value="about:srcdoc" />
          </WebPreviewNavigation>
          <WebPreviewBody className="bg-white" sandbox="" srcDoc={code} />
        </WebPreview>
      ) : canRenderTerminal ? (
        <Terminal autoScroll className="max-h-[70vh] rounded-none border-0" output={code}>
          <TerminalContent className="max-h-none pb-8" />
        </Terminal>
      ) : (
        <CodeBlock
          className="w-fit max-w-full max-h-[70vh] rounded-none border-0 bg-transparent [&>div>div]:bg-transparent! [&>div>div>pre]:bg-transparent! [&>div>div>pre]:pb-8 [&>div>div>pre]:pr-14"
          code={code}
          isStreaming={isStreaming}
          language={language}
        />
      )}
      <div className="pointer-events-none absolute right-2 bottom-2 z-10 max-w-[calc(100%-1rem)] truncate rounded-md border border-border/50 bg-background/70 px-2 py-0.5 font-mono text-[11px] text-muted-foreground backdrop-blur-sm">
        {showPreview && canPreviewHtml ? "preview" : canRenderTerminal ? "terminal" : displayLanguage || language}
      </div>
    </HeroCard>
  );
};

type MessageLinkProps = ComponentProps<"a"> & {
  node?: unknown;
};

const EXTERNAL_HREF_RE = /^(https?:)?\/\//i;

function toExternalHref(href: string): string {
  return href.startsWith("//") ? `https:${href}` : href;
}

const MessageLink = ({ children, className, href, node: _node, ...props }: MessageLinkProps) => {
  const external = Boolean(href && EXTERNAL_HREF_RE.test(href));
  const childItems = Children.toArray(children).filter((item) => item !== "");
  const content = childItems.length > 0 ? children : href;

  return (
    <a
      className={cn(
        "inline-flex max-w-full items-baseline gap-1 break-all text-primary underline underline-offset-2 hover:text-primary/80",
        className
      )}
      href={href}
      {...props}
      onClick={(event) => {
        props.onClick?.(event);
        if (event.defaultPrevented || !external || !href) return;
        event.preventDefault();
        void window.electronAPI.shell.openExternal(toExternalHref(href));
      }}
      rel={external ? "noreferrer" : props.rel}
      target={external ? "_blank" : props.target}
    >
      <span className="min-w-0 break-all">{content}</span>
      {external && <ArrowUpRightFromSquare className="mb-0.5 size-3 shrink-0" />}
    </a>
  );
};

type MessageTableProps = ComponentProps<"table"> & {
  node?: unknown;
};

type TableSnapshot = {
  headers: string[];
  rows: string[][];
};

function getElementChildren(node: ReactNode): ReactNode {
  return isValidElement(node) ? (node.props as { children?: ReactNode }).children : null;
}

function getElementClassName(node: ReactNode): string | undefined {
  return isValidElement(node) ? (node.props as { className?: string }).className : undefined;
}

function isElementTag(node: ReactNode, tagName: string): node is ReactElement {
  if (!isValidElement(node)) return false;
  if (node.type === tagName) return true;
  const hastNode = (node.props as { node?: { tagName?: string } }).node;
  return hastNode?.tagName === tagName;
}

function getChildElements(children: ReactNode, tagName: string): ReactElement[] {
  return Children.toArray(children).filter(
    (child): child is ReactElement => isElementTag(child, tagName)
  );
}

function getTableCells(row: ReactNode, tagName: "td" | "th"): ReactElement[] {
  return getChildElements(getElementChildren(row), tagName);
}

function getTableRows(children: ReactNode): ReactElement[] {
  return getChildElements(children, "tr");
}

function getNodePlainText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") {
    return String(node);
  }
  if (Array.isArray(node)) return node.map(getNodePlainText).join("");
  if (!isValidElement(node)) return "";
  if (node.type === "br") return "\n";
  return getNodePlainText((node.props as { children?: ReactNode }).children);
}

function normalizeTableText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function getTableSnapshot(children: ReactNode): TableSnapshot {
  const head = getChildElements(children, "thead")[0];
  const body = getChildElements(children, "tbody")[0];
  const headerRow = head ? getTableRows(getElementChildren(head))[0] : undefined;
  const headers = headerRow
    ? getTableCells(headerRow, "th").map((cell) => normalizeTableText(getNodePlainText(getElementChildren(cell))))
    : [];
  const rows = (body ? getTableRows(getElementChildren(body)) : getTableRows(children))
    .map((row) => {
      const cells = getTableCells(row, "td");
      return cells.map((cell) => normalizeTableText(getNodePlainText(getElementChildren(cell))));
    })
    .filter((row) => row.length > 0);

  return { headers, rows };
}

function tableSnapshotToTsv(snapshot: TableSnapshot): string {
  const sanitize = (value: string) => value.replace(/\t/g, " ").replace(/\r?\n/g, " ");
  return [snapshot.headers, ...snapshot.rows]
    .filter((row) => row.length > 0)
    .map((row) => row.map(sanitize).join("\t"))
    .join("\n");
}

async function waitForTableExportReady(node: HTMLElement): Promise<void> {
  const imgs = Array.from(node.querySelectorAll("img"));
  await Promise.all(imgs.map((img) => {
    if (img.complete && img.naturalWidth > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      img.addEventListener("load", () => resolve(), { once: true });
      img.addEventListener("error", () => resolve(), { once: true });
    });
  }));
  try { await document.fonts?.ready; } catch { /* ignore font readiness failures */ }
}

function getTableExportOptions(node: HTMLElement) {
  const rect = node.getBoundingClientRect();
  const scroll = node.querySelector<HTMLElement>("[data-ai-table-scroll]");
  const scrollLeft = scroll?.scrollLeft ?? 0;
  const scrollTop = scroll?.scrollTop ?? 0;
  const width = Math.ceil(Math.max(rect.width, node.offsetWidth, 1));
  const height = Math.ceil(Math.max(rect.height, node.offsetHeight, 1));
  const background = window.getComputedStyle(node).backgroundColor || "#ffffff";

  return {
    bgcolor: background,
    filter: (target: Node) => !(target instanceof HTMLElement && target.dataset.aiTableActions != null),
    height,
    scale: 2,
    width,
    style: {
      height: `${height}px`,
      margin: "0",
      maxWidth: `${width}px`,
      minWidth: `${width}px`,
      overflow: "visible",
      width: `${width}px`,
    },
    onclone: (clone: HTMLElement) => {
      const clonedScroll = clone.querySelector<HTMLElement>("[data-ai-table-scroll]");
      if (clonedScroll) {
        clonedScroll.scrollLeft = scrollLeft;
        clonedScroll.scrollTop = scrollTop;
      }
    },
  };
}

const MessageTable = ({ children, className, node: _node, ..._props }: MessageTableProps) => {
  const { isStreaming } = useContext(MessageRenderContext);
  const tableExportRef = useRef<HTMLDivElement>(null);
  const [isCopied, setIsCopied] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const snapshot = useMemo(() => getTableSnapshot(children), [children]);
  const hasTableData = snapshot.headers.length > 0 || snapshot.rows.length > 0;
  const head = getChildElements(children, "thead")[0];
  const body = getChildElements(children, "tbody")[0];
  const headerRow = head ? getTableRows(getElementChildren(head))[0] : undefined;
  const headerCells = headerRow ? getTableCells(headerRow, "th") : [];
  const bodyRows = body ? getTableRows(getElementChildren(body)) : getTableRows(children);
  // 表格 markdown 一旦解析出「表头 + 至少一行」就直接渲染，不再干等整轮结束（最终审核/记忆抽取会把
  // isStreaming 拖住好几秒，表格却早就成型了）。仍在拼装（只有表头没有数据行）时才退回骨架占位。
  const canUseHeroTable = headerCells.length > 0 && bodyRows.length > 0;

  const handleCopy = async () => {
    if (!hasTableData || typeof window === "undefined" || !navigator?.clipboard?.writeText) return;
    await navigator.clipboard.writeText(tableSnapshotToTsv(snapshot));
    setIsCopied(true);
    window.setTimeout(() => setIsCopied(false), 2000);
  };

  const handleDownload = async () => {
    const node = tableExportRef.current;
    if (!node || isExporting) return;
    setIsExporting(true);
    try {
      await waitForTableExportReady(node);
      const domtoimage = (await import("dom-to-image-more")).default;
      const dataUrl = await (domtoimage as any).toPng(node, getTableExportOptions(node));
      const link = document.createElement("a");
      link.download = `ai-table-${Date.now()}.png`;
      link.href = dataUrl;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error("[MessageTable] 下载表格图片失败", error);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="my-4 min-w-0 max-w-full">
      <div className="relative" data-ai-table-export>
        <MessageFloatingToolbar
          actions={[
            {
              ariaLabel: isCopied ? "表格已复制" : "复制表格",
              icon: isCopied ? <Check /> : <Copy />,
              isDisabled: !hasTableData,
              onPress: () => void handleCopy(),
            },
            {
              ariaLabel: "下载表格图片",
              icon: isExporting ? <CircleDashed className="animate-spin" /> : <ArrowDownToLine />,
              isDisabled: !canUseHeroTable || isExporting,
              onPress: () => void handleDownload(),
            },
          ]}
          aria-label="表格操作"
          excludeFromTableExport
        />
        {canUseHeroTable ? (
          <div ref={tableExportRef} data-ai-table-export-target>
            <HeroTable className={cn("max-w-full", className)}>
              <HeroTable.ScrollContainer data-ai-table-scroll>
                <HeroTable.Content
                  aria-label="AI 生成表格"
                  className="min-w-max text-sm"
                  data-ai-table-content
                >
                  <HeroTable.Header>
                    {headerCells.map((header, index) => (
                      <HeroTable.Column
                        className={cn("whitespace-nowrap last:pr-18", getElementClassName(header))}
                        id={`col-${index}`}
                        isRowHeader={index === 0}
                        key={`col-${index}`}
                      >
                        {getElementChildren(header)}
                      </HeroTable.Column>
                    ))}
                  </HeroTable.Header>
                  <HeroTable.Body>
                    {bodyRows.map((row, rowIndex) => {
                      const cells = getTableCells(row, "td");
                      return (
                        <HeroTable.Row
                          className={getElementClassName(row)}
                          id={`row-${rowIndex}`}
                          key={`row-${rowIndex}`}
                        >
                          {cells.map((cell, cellIndex) => (
                            <HeroTable.Cell
                              className={cn("align-top wrap-break-word", getElementClassName(cell))}
                              key={`cell-${rowIndex}-${cellIndex}`}
                            >
                              {getElementChildren(cell)}
                            </HeroTable.Cell>
                          ))}
                        </HeroTable.Row>
                      );
                    })}
                  </HeroTable.Body>
                </HeroTable.Content>
              </HeroTable.ScrollContainer>
            </HeroTable>
          </div>
        ) : isStreaming ? (
          <StreamingTablePlaceholder />
        ) : null}
      </div>
    </div>
  );
};

type MessageTableHeadProps = ComponentProps<"thead"> & {
  node?: unknown;
};

const MessageTableHead = ({ children: _children, node: _node, ..._props }: MessageTableHeadProps) => null;

type MessageTableBodyProps = ComponentProps<"tbody"> & {
  node?: unknown;
};

const MessageTableBody = ({ children: _children, node: _node, ..._props }: MessageTableBodyProps) => null;

function StreamingTablePlaceholder() {
  return (
    <div className="my-4 overflow-hidden rounded-(--agent-radius,12px) border border-border bg-background">
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2 text-muted-foreground text-xs">
        <LayoutHeaderCellsLarge className="size-3.5" />
        <span>正在整理表格…</span>
      </div>
      <div className="space-y-2 p-3">
        {[0, 1, 2, 3].map((row) => (
          <div className="grid grid-cols-4 gap-2" key={row}>
            {[0, 1, 2, 3].map((cell) => (
              <div
                className={cn("h-4 animate-pulse rounded bg-muted", row === 0 && "bg-muted/80")}
                key={cell}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

const PIXEL_RUNNER_FRAMES = [
  [
    "...##...",
    "...##...",
    "..####..",
    ".#.##.#.",
    "...##...",
    "..#..#..",
    ".#....#.",
    "##....##",
  ],
  [
    "...##...",
    "...##...",
    "..####..",
    ".#.##.#.",
    "...##...",
    ".##..#..",
    "....##..",
    "...#..#.",
  ],
  [
    "...##...",
    "...##...",
    "..####..",
    "..####.#",
    ".#.##...",
    "...##...",
    "..#..##.",
    ".#....#.",
  ],
  [
    "...##...",
    "...##...",
    "..####..",
    "..##.#..",
    ".#.##.#.",
    "...##...",
    ".##..#..",
    "....#.##",
  ],
];

function PixelRunnerFrame({ className, frame }: { className?: string; frame: string[] }) {
  return (
    <span aria-hidden className={cn("absolute inset-0 grid grid-cols-8 grid-rows-8 gap-px", className)}>
      {frame.flatMap((row, rowIndex) =>
        Array.from(row).map((pixel, columnIndex) => (
          <span
            className={cn(
              "size-0.5 rounded-xs",
              pixel === "#" ? "bg-current" : "bg-transparent"
            )}
            key={`${rowIndex}-${columnIndex}`}
          />
        ))
      )}
    </span>
  );
}

export function MessageStreamingIndicator({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-label="AI 正在回复"
      className={cn(
        "mt-1.5 inline-flex w-fit items-center gap-1.5 text-muted-foreground text-xs",
        className
      )}
      role="status"
      {...props}
    >
      <span className="relative block h-5 w-6 shrink-0 overflow-hidden text-primary" aria-hidden>
        <span className="absolute bottom-0.5 left-0 h-px w-6 bg-current/25" />
        <span className="ai-runner-dust absolute bottom-1 left-0 size-0.5 rounded-xs bg-current/45" />
        <span className="absolute top-px left-1 block size-5">
          {PIXEL_RUNNER_FRAMES.map((frame, index) => (
            <PixelRunnerFrame
              className={`ai-runner-frame-${index}`}
              frame={frame}
              key={`runner-frame-${index}`}
            />
          ))}
        </span>
      </span>
      <span>回复中...</span>
    </div>
  );
}

export const MessageResponse = memo(
  ({ className, components, isStreaming = false, showStreamingIndicator = true, children, ...props }: MessageResponseProps) => {
    const markdown = typeof children === "string" ? children : "";
    const activity = useMemo(() => analyzeMessageRenderActivity(markdown, isStreaming), [isStreaming, markdown]);

    return (
      <MessageRenderContext.Provider value={{ isStreaming, markdown }}>
        <Streamdown
          animated={false}
          className={cn(
            "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
            className
          )}
          components={{
            a: MessageLink,
            code: MessageCode,
            table: MessageTable,
            tbody: MessageTableBody,
            thead: MessageTableHead,
            ...components,
          }}
          isAnimating={isStreaming}
          {...props}
        >
          {children}
        </Streamdown>
        {activity.pendingTable && <StreamingTablePlaceholder />}
        {isStreaming && showStreamingIndicator && <MessageStreamingIndicator />}
      </MessageRenderContext.Provider>
    );
  },
  messageResponsePropsAreEqual
);

MessageResponse.displayName = "MessageResponse";

const MESSAGE_RESPONSE_MEMO_KEYS = new Set(["children", "isStreaming", "showStreamingIndicator"]);

function messageResponsePropsAreEqual(prevProps: MessageResponseProps, nextProps: MessageResponseProps) {
  if (prevProps.children !== nextProps.children) return false;
  if (prevProps.isStreaming !== nextProps.isStreaming) return false;
  if (prevProps.showStreamingIndicator !== nextProps.showStreamingIndicator) return false;

  const prevKeys = Object.keys(prevProps).filter((key) => !MESSAGE_RESPONSE_MEMO_KEYS.has(key));
  const nextKeys = Object.keys(nextProps).filter((key) => !MESSAGE_RESPONSE_MEMO_KEYS.has(key));
  if (prevKeys.length !== nextKeys.length) return false;

  return prevKeys.every((key) => (
    Object.prototype.hasOwnProperty.call(nextProps, key)
    && (prevProps as Record<string, unknown>)[key] === (nextProps as Record<string, unknown>)[key]
  ));
}

function formatAttachmentSize(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "大小未知";
  }
  if (value < 1024) return `${value} B`;
  const kb = value / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

export type MessageAttachmentProps = HTMLAttributes<HTMLDivElement> & {
  data: FileUIPart;
  className?: string;
  onRemove?: () => void;
};

export function MessageAttachment({
  data,
  className,
  onRemove,
  ...props
}: MessageAttachmentProps) {
  const filename = data.filename || "";
  const mediaType =
    data.mediaType?.startsWith("image/") && data.url ? "image" : "file";
  const isImage = mediaType === "image";
  const attachmentLabel = filename || (isImage ? "Image" : "Attachment");
  const sizeBytes = (data as FileUIPart & { sizeBytes?: unknown }).sizeBytes;
  const attachmentSize = formatAttachmentSize(sizeBytes);

  return (
    <div
      className={cn(
        isImage
          ? "group relative size-24 overflow-hidden rounded-(--agent-radius,12px)"
          : "group relative flex min-h-16 w-72 max-w-full items-center gap-3 rounded-(--agent-radius,12px) border border-border/70 bg-card/80 px-3 py-2 text-left shadow-xs",
        className
      )}
      {...props}
    >
      {isImage ? (
        <>
          <img
            alt={filename || "attachment"}
            className="size-full object-cover"
            height={100}
            src={data.url}
            width={100}
          />
          {onRemove && (
            <Button
              aria-label="Remove attachment"
              className="absolute top-2 right-2 size-6 rounded-(--agent-radius,12px) bg-background/80 p-0 opacity-0 backdrop-blur-sm transition-opacity hover:bg-background group-hover:opacity-100 [&>svg]:size-3"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              type="button"
              variant="ghost"
            >
              <Xmark />
              <span className="sr-only">Remove</span>
            </Button>
          )}
        </>
      ) : (
        <>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-(--agent-radius,12px) bg-muted text-muted-foreground">
                    <File className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-foreground text-sm">
                      {attachmentLabel}
                    </div>
                    <div className="mt-0.5 text-muted-foreground text-xs">
                      {attachmentSize}
                    </div>
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p>{attachmentLabel} · {attachmentSize}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {onRemove && (
            <Button
              aria-label="Remove attachment"
              className="absolute top-2 right-2 size-6 shrink-0 rounded-(--agent-radius,12px) bg-background/80 p-0 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100 [&>svg]:size-3"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              type="button"
              variant="ghost"
            >
              <Xmark />
              <span className="sr-only">Remove</span>
            </Button>
          )}
        </>
      )}
    </div>
  );
}

export type MessageAttachmentsProps = ComponentProps<"div">;

export function MessageAttachments({
  children,
  className,
  ...props
}: MessageAttachmentsProps) {
  if (!children) {
    return null;
  }

  return (
    <div
      className={cn(
        "ml-auto flex w-fit flex-wrap items-start gap-2",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export type MessageToolbarProps = ComponentProps<"div">;

export const MessageToolbar = ({
  className,
  children,
  ...props
}: MessageToolbarProps) => (
  <div
    className={cn(
      "mt-4 flex w-full items-center justify-between gap-4",
      className
    )}
    {...props}
  >
    {children}
  </div>
);
