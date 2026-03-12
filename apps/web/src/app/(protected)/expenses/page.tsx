"use client";

import { useState } from "react";
import { useMyExpenses, useCreateExpense } from "@/hooks/queries/useExpenses";
import { ExpensesTable } from "@/components/tables/ExpensesTable";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";

const PAGE_LIMIT = 20;

export default function ExpensesPage() {
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useMyExpenses(page, PAGE_LIMIT);
  const createExpense = useCreateExpense();
  const { toast } = useToast();

  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [receiptUrl, setReceiptUrl] = useState("");

  const expenses = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const hasMore = page * PAGE_LIMIT < total;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      toast({ variant: "destructive", title: "Invalid amount", description: "Enter a positive number." });
      return;
    }
    createExpense.mutate(
      { amount: parsedAmount, description, receipt_url: receiptUrl || undefined },
      {
        onSuccess: () => {
          toast({ title: "Expense submitted", description: "Your expense claim has been submitted for review." });
          setAmount("");
          setDescription("");
          setReceiptUrl("");
        },
        onError: (err) => {
          toast({ variant: "destructive", title: "Submission failed", description: err.message });
        },
      }
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">My Expenses</h2>
        <p className="text-muted-foreground">Submit and track your expense claims.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Submit New Expense</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="exp-amount">Amount (₹)</Label>
                <Input
                  id="exp-amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="exp-receipt">Receipt URL (optional)</Label>
                <Input
                  id="exp-receipt"
                  type="url"
                  placeholder="https://..."
                  value={receiptUrl}
                  onChange={(e) => setReceiptUrl(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="exp-desc">Description</Label>
              <textarea
                id="exp-desc"
                placeholder="What was this expense for?"
                value={description}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
                required
                rows={3}
                className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
            <Button type="submit" disabled={createExpense.isPending}>
              {createExpense.isPending ? "Submitting..." : "Submit Expense"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {error && <ErrorBanner error={error} />}

      <ExpensesTable
        expenses={expenses}
        showActions={false}
        isLoading={isLoading}
        page={page}
        hasMore={hasMore}
        onPageChange={setPage}
      />
    </div>
  );
}

