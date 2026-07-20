"use client"

import * as React from "react"
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area"

import { cn } from "@/lib/utils"

export interface ScrollAreaProps
  extends React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> {
  orientation?: "vertical" | "horizontal" | "both"
  // Fades content near the viewport's top/bottom edges via a CSS mask (no scroll-position
  // tracking needed) so long lists don't end in a hard visual cutoff.
  scrollFade?: boolean
  // Reserves space for the scrollbar (CSS `scrollbar-gutter: stable`) so content doesn't
  // shift horizontally when a vertical scrollbar appears/disappears.
  scrollbarGutter?: boolean
  viewportClassName?: string
  viewportProps?: React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Viewport>
  viewportRef?: React.Ref<HTMLDivElement>
}

const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  ScrollAreaProps
>(
  (
    {
      className,
      children,
      orientation = "vertical",
      scrollFade,
      scrollbarGutter,
      viewportClassName,
      viewportProps,
      viewportRef,
      ...props
    },
    ref
  ) => (
    <ScrollAreaPrimitive.Root
      ref={ref}
      className={cn("relative overflow-hidden", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        className={cn(
          "h-full w-full rounded-[inherit]",
          scrollFade &&
            "[mask-image:linear-gradient(to_bottom,transparent,black_12px,black_calc(100%-12px),transparent)]",
          scrollbarGutter && "[scrollbar-gutter:stable]",
          viewportClassName
        )}
        {...viewportProps}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {(orientation === "vertical" || orientation === "both") && (
        <ScrollBar orientation="vertical" />
      )}
      {(orientation === "horizontal" || orientation === "both") && (
        <ScrollBar orientation="horizontal" />
      )}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
)
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName

const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = "vertical", ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      "flex touch-none select-none transition-colors",
      orientation === "vertical" &&
        "h-full w-2.5 border-l border-l-transparent p-[1px]",
      orientation === "horizontal" &&
        "h-2.5 flex-col border-t border-t-transparent p-[1px]",
      className
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
))
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName

export { ScrollArea, ScrollBar, ScrollAreaPrimitive }
