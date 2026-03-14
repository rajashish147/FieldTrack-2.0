"use client";

import {
  useState,
  useMemo,
  type ReactNode,
} from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";
import { EmptyState } from "@/components/EmptyState";
import { Pagination } from "@/components/tables/Pagination";
import { ChevronUp, ChevronDown, ChevronsUpDown, type LucideIcon } from "lucide-react";

// ---------------------------------------------------------------------------
// Column definition
// ---------------------------------------------------------------------------

export type SortDirection = "asc" | "desc" | null;

export interface ColumnDef<T> {
  /** Key used for sort state tracking */
  key: string;
  /** Column header label */
  title: string;
  /** Render the cell value for a row */
  render: (row: T) => ReactNode;
  /** If true, the column header becomes a sort toggle */
  sortable?: boolean;
  /** Optional className for <th> / <td> */
  className?: string;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DataTableProps<T> {
  columns: ColumnDef<T>[];
  data: T[];
  rowKey: (row: T) => string;
  isLoading?: boolean;

  /** Optional: click handler for a row */
  onRowClick?: (row: T) => void;

  /** Empty-state configuration */
  emptyIcon?: LucideIcon;
  emptyTitle?: string;
  emptyDescription?: string;

  /** Pagination — when provided a Pagination bar is rendered */
  page?: number;
  hasMore?: boolean;
  onPageChange?: (page: number) => void;

  /** Client-side sort comparator — override for custom sort logic */
  sortComparator?: (a: T, b: T, key: string, dir: "asc" | "desc") => number;
}

// ---------------------------------------------------------------------------
// Sort icon
// ---------------------------------------------------------------------------

function SortIcon({ dir }: { dir: SortDirection }) {
  if (dir === "asc") return <ChevronUp className="ml-1 inline h-3.5 w-3.5" />;
  if (dir === "desc") return <ChevronDown className="ml-1 inline h-3.5 w-3.5" />;
  return <ChevronsUpDown className="ml-1 inline h-3.5 w-3.5 opacity-40" />;
}

// ---------------------------------------------------------------------------
// DataTable
// ---------------------------------------------------------------------------

export function DataTable<T>({
  columns,
  data,
  rowKey,
  isLoading = false,
  onRowClick,
  emptyIcon,
  emptyTitle = "No results",
  emptyDescription = "There is nothing to display here yet.",
  page,
  hasMore = false,
  onPageChange,
  sortComparator,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  // All hooks must be called before any conditional returns (Rules of Hooks)
  const sorted = useMemo(() => {
    if (!sortKey) return data;

    return [...data].sort((a, b) => {
      if (sortComparator) return sortComparator(a, b, sortKey, sortDir);

      // Default: stringify and compare
      const aVal = String((a as Record<string, unknown>)[sortKey] ?? "");
      const bVal = String((b as Record<string, unknown>)[sortKey] ?? "");
      const cmp = aVal.localeCompare(bVal, undefined, { numeric: true });
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [data, sortKey, sortDir, sortComparator]);

  // --- loading skeleton ---
  if (isLoading) return <LoadingSkeleton variant="table" />;

  // --- empty state ---
  if (data.length === 0) {
    return (
      <EmptyState
        icon={emptyIcon}
        title={emptyTitle}
        description={emptyDescription}
      />
    );
  }

  function handleSortClick(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const showPagination =
    page !== undefined && onPageChange !== undefined && data.length > 0;

  return (
    <div className="space-y-4">
      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((col) => (
                <TableHead key={col.key} className={col.className}>
                  {col.sortable ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="-ml-3 h-8 font-medium"
                      onClick={() => handleSortClick(col.key)}
                    >
                      {col.title}
                      <SortIcon dir={sortKey === col.key ? sortDir : null} />
                    </Button>
                  ) : (
                    col.title
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((row) => (
              <TableRow
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={onRowClick ? "cursor-pointer" : undefined}
              >
                {columns.map((col) => (
                  <TableCell key={col.key} className={col.className}>
                    {col.render(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {showPagination && (
        <Pagination
          page={page!}
          onPageChange={onPageChange!}
          hasMore={hasMore}
        />
      )}
    </div>
  );
}
