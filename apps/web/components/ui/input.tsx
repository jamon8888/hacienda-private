import * as React from "react"

import { cn } from "@/lib/utils"

export interface InputProps extends Omit<React.ComponentProps<"input">, "size"> {
  // Styling variant — shadows (and is not forwarded as) the native HTML `size` attribute
  // (a character-count number), which this component doesn't expose.
  size?: "default" | "sm"
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, size = "default", ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          size === "sm" ? "h-8 text-sm" : "h-10",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
