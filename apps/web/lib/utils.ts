import * as React from "react"
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Some vendored components were written against Base UI's `render` prop (the element passed
// becomes the rendered root; the wrapping component's own `children` become that element's
// content). The primitives here are Radix-based (`asChild`), so this adapts `render` callers
// onto `asChild` — clone the `render` element with the wrapper's children substituted in.
export function withRenderProp(render: React.ReactElement, children: React.ReactNode) {
  return React.cloneElement(render, undefined, children)
}

// wasm-bindgen panics and some rejected promises throw values that aren't Error instances
// (plain strings, or JsValue-wrapped objects) — cover those instead of always falling back to
// a generic message that hides the real cause.
export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
