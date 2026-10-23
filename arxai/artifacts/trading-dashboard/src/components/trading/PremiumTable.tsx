import React from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "./EmptyState";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

export interface PremiumColumn<T> {
  key: string;
  header: string;
  align?: "left" | "right" | "center";
  className?: string;
  width?: string | number;
  cell: (row: T) => React.ReactNode;
}

interface Props<T> {
  columns: PremiumColumn<T>[];
  rows: T[] | undefined | null;
  rowKey: (row: T) => string | number;
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyIcon?: LucideIcon;
  onRowClick?: (row: T) => void;
  className?: string;
  stickyHeader?: boolean;
}

export function PremiumTable<T>({
  columns, rows, rowKey, loading, emptyTitle, emptyDescription, emptyIcon, onRowClick, className, stickyHeader,
}: Props<T>) {
  return (
    <div className={cn("overflow-x-auto -mx-px", className)}>
      <Table>
        <TableHeader className={cn("bg-muted/30", stickyHeader && "sticky top-0 z-10")}>
          <TableRow className="hover:bg-transparent">
            {columns.map((col) => (
              <TableHead
                key={col.key}
                style={col.width ? { width: col.width } : undefined}
                className={cn(
                  "text-[10px] uppercase tracking-wider font-semibold whitespace-nowrap",
                  col.align === "right" && "text-right",
                  col.align === "center" && "text-center",
                  col.className
                )}
              >
                {col.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <TableRow key={i}>
                {columns.map((c) => (
                  <TableCell key={c.key} className={cn(c.align === "right" && "text-right")}>
                    <Skeleton className={cn("h-4", c.align === "right" ? "w-16 ml-auto" : "w-full")} />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : !rows || rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-32 p-0">
                <EmptyState icon={emptyIcon} title={emptyTitle ?? "No records"} description={emptyDescription} />
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn("hover:bg-muted/30 transition-colors", onRowClick && "cursor-pointer")}
              >
                {columns.map((col) => (
                  <TableCell
                    key={col.key}
                    className={cn(
                      col.align === "right" && "text-right",
                      col.align === "center" && "text-center",
                      col.className
                    )}
                  >
                    {col.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
