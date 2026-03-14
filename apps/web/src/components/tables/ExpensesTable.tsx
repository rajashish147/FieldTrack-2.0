"use client";

import { DataTable, type ColumnDef } from "@/components/tables/DataTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Expense, ExpenseStatus } from "@/types";
import { formatDate, formatCurrency } from "@/lib/utils";
import { Receipt } from "lucide-react";
import { EmployeeIdentity } from "@/components/EmployeeIdentity";

interface ExpensesTableProps {
  expenses: Expense[];
  showActions: boolean;
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
  isLoading: boolean;
  page?: number;
  hasMore?: boolean;
  onPageChange?: (page: number) => void;
  showEmployee?: boolean;
  /** When true, employee cells get hover quick-actions and click navigation */
  isAdmin?: boolean;
}

function StatusBadge({ status }: { status: ExpenseStatus }) {
  if (status === "APPROVED") return <Badge variant="success">Approved</Badge>;
  if (status === "REJECTED") return <Badge variant="destructive">Rejected</Badge>;
  return <Badge variant="warning">Pending</Badge>;
}

function buildEmployeeColumn(isAdmin: boolean): ColumnDef<Expense> {
  return {
    key: "employee",
    title: "Employee",
    render: (e) => (
      <EmployeeIdentity
        employeeId={e.employee_id}
        name={e.employee_name ?? "—"}
        employeeCode={e.employee_code}
        isAdmin={isAdmin}
        showTooltip={isAdmin}
        size="sm"
      />
    ),
  };
}

function buildColumns(
  showActions: boolean,
  showEmployee: boolean,
  isAdmin: boolean,
  onApprove?: (id: string) => void,
  onReject?: (id: string) => void
): ColumnDef<Expense>[] {
  const base: ColumnDef<Expense>[] = [
    ...(showEmployee ? [buildEmployeeColumn(isAdmin)] : []),
    {
      key: "created_at",
      title: "Date",
      sortable: true,
      render: (e) => formatDate(e.created_at),
    },
    {
      key: "description",
      title: "Description",
      className: "max-w-xs truncate",
      render: (e) => e.description,
    },
    {
      key: "amount",
      title: "Amount",
      sortable: true,
      render: (e) => formatCurrency(e.amount),
    },
    {
      key: "status",
      title: "Status",
      render: (e) => <StatusBadge status={e.status} />,
    },
  ];

  if (showActions) {
    base.push({
      key: "_actions",
      title: "Actions",
      render: (e) =>
        e.status === "PENDING" ? (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={(ev) => { ev.stopPropagation(); onApprove?.(e.id); }}
              className="text-green-600 hover:text-green-700"
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={(ev) => { ev.stopPropagation(); onReject?.(e.id); }}
              className="text-destructive hover:text-destructive"
            >
              Reject
            </Button>
          </div>
        ) : null,
    });
  }

  return base;
}

export function ExpensesTable({
  expenses,
  showActions,
  onApprove,
  onReject,
  isLoading,
  page,
  hasMore,
  onPageChange,
  showEmployee = false,
  isAdmin = false,
}: ExpensesTableProps) {
  const columns = buildColumns(showActions, showEmployee, isAdmin, onApprove, onReject);

  return (
    <DataTable
      columns={columns}
      data={expenses}
      rowKey={(e) => e.id}
      isLoading={isLoading}
      emptyIcon={Receipt}
      emptyTitle="No expenses found"
      emptyDescription="Expenses will appear here once they are submitted."
      page={page}
      hasMore={hasMore}
      onPageChange={onPageChange}
    />
  );
}

