"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { useOrgExpenses, useUpdateExpenseStatus } from "@/hooks/queries/useExpenses";
import { ExpensesTable } from "@/components/tables/ExpensesTable";
import { ErrorBanner } from "@/components/ErrorBanner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { Expense, ExpenseStatus } from "@/types";
import { formatCurrency, formatDate } from "@/lib/utils";

const PAGE_LIMIT = 20;

interface PendingAction {
  expense: Expense;
  status: ExpenseStatus;
}

export default function AdminExpensesPage() {
  const { permissions } = useAuth();
  const router = useRouter();
  const { toast } = useToast();

  useEffect(() => {
    if (!permissions.manageExpenses) {
      router.replace("/sessions");
    }
  }, [permissions, router]);

  const [page, setPage] = useState(1);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);

  const { data, isLoading, error } = useOrgExpenses(page, PAGE_LIMIT);
  const updateStatus = useUpdateExpenseStatus();

  const expenses = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const hasMore = page * PAGE_LIMIT < total;

  if (!permissions.manageExpenses) return null;

  function handleConfirm() {
    if (!pendingAction) return;

    updateStatus.mutate(
      { id: pendingAction.expense.id, status: pendingAction.status },
      {
        onSuccess: () => {
          toast({
            title: "Status updated",
            description: `Expense has been ${pendingAction.status.toLowerCase()}.`,
          });
          setPendingAction(null);
        },
        onError: (err) => {
          toast({
            variant: "destructive",
            title: "Failed to update",
            description: err.message,
          });
          setPendingAction(null);
        },
      }
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Manage Expenses</h2>
        <p className="text-muted-foreground">Review and approve or reject expense claims.</p>
      </div>

      {error && <ErrorBanner error={error} />}

      <ExpensesTable
        expenses={expenses}
        showActions={true}
        showEmployee={true}
        isAdmin={true}
        isLoading={isLoading}
        onApprove={(id) => {
          const expense = expenses.find((e) => e.id === id);
          if (expense) setPendingAction({ expense, status: "APPROVED" });
        }}
        onReject={(id) => {
          const expense = expenses.find((e) => e.id === id);
          if (expense) setPendingAction({ expense, status: "REJECTED" });
        }}
        page={page}
        hasMore={hasMore}
        onPageChange={setPage}
      />

      <Dialog
        open={!!pendingAction}
        onOpenChange={(open) => {
          if (!open) setPendingAction(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingAction?.status === "APPROVED" ? "Approve" : "Reject"} Expense
            </DialogTitle>
          </DialogHeader>

          {pendingAction && (
            <div className="space-y-3 text-sm">
              {(pendingAction.expense.employee_name || pendingAction.expense.employee_code) && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Employee</span>
                  <span className="font-medium">
                    {pendingAction.expense.employee_name}
                    {pendingAction.expense.employee_code && (
                      <span className="text-muted-foreground ml-1">
                        ({pendingAction.expense.employee_code})
                      </span>
                    )}
                  </span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">Amount</span>
                <span className="font-medium">{formatCurrency(pendingAction.expense.amount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Submitted</span>
                <span>{formatDate(pendingAction.expense.submitted_at)}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-muted-foreground">Description</span>
                <span className="text-foreground">{pendingAction.expense.description}</span>
              </div>
              {pendingAction.expense.receipt_url && (
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Receipt</span>
                  <a
                    href={pendingAction.expense.receipt_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline underline-offset-2"
                  >
                    View receipt
                  </a>
                </div>
              )}
              <p className="text-muted-foreground pt-1 border-t">
                Are you sure you want to{" "}
                <strong>{pendingAction.status === "APPROVED" ? "approve" : "reject"}</strong> this
                expense? This action cannot be undone.
              </p>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingAction(null)}>
              Cancel
            </Button>
            <Button
              variant={pendingAction?.status === "APPROVED" ? "default" : "destructive"}
              onClick={handleConfirm}
              disabled={updateStatus.isPending}
            >
              {updateStatus.isPending ? "Updating..." : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
