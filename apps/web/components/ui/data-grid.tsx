"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface DataGridColumn<T> {
  key: string;
  header: string;
  render?: (row: T) => React.ReactNode;
  className?: string;
}

export interface DataGridProps<T> {
  columns: DataGridColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  emptyMessage?: string;
  className?: string;
}

export function DataGrid<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  emptyMessage = "No items.",
  className,
}: DataGridProps<T>): React.ReactElement {
  if (rows.length === 0) {
    return (
      <div className={cn("rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground", className)}>
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className={cn("overflow-hidden rounded-lg border bg-card", className)}>
      <table className="w-full text-sm">
        <thead className="border-b bg-muted/40 text-left text-muted-foreground">
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={cn("px-3 py-2 font-medium", column.className)}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={rowKey(row, index)}
              className={cn("border-b last:border-b-0", onRowClick && "cursor-pointer hover:bg-accent/50")}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((column) => (
                <td key={column.key} className={cn("px-3 py-2 align-top", column.className)}>
                  {column.render ? column.render(row) : String((row as Record<string, unknown>)[column.key] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
