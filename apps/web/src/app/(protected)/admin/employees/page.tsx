"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import {
  useEmployeeList,
  useCreateEmployee,
  useSetEmployeeStatus,
  type EmployeeRecord,
} from "@/hooks/queries/useEmployees";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/use-toast";
import { UserPlus, Search, UserCheck, UserX } from "lucide-react";

const PAGE_SIZE = 50;

function EmployeeRow({ employee }: { employee: EmployeeRecord }) {
  const { toast } = useToast();
  const setStatus = useSetEmployeeStatus(employee.id);

  function handleToggle() {
    setStatus.mutate(!employee.is_active, {
      onSuccess: () =>
        toast({ title: employee.is_active ? "Employee deactivated" : "Employee activated" }),
      onError: (err) =>
        toast({ variant: "destructive", title: "Update failed", description: err.message }),
    });
  }

  return (
    <tr className="border-b last:border-0 hover:bg-muted/30 transition-colors">
      <td className="py-3 px-4 font-mono text-sm">{employee.employee_code}</td>
      <td className="py-3 px-4 font-medium">{employee.name}</td>
      <td className="py-3 px-4 text-muted-foreground text-sm">{employee.phone ?? "—"}</td>
      <td className="py-3 px-4">
        <Badge variant={employee.is_active ? "default" : "outline"}>
          {employee.is_active ? "Active" : "Inactive"}
        </Badge>
      </td>
      <td className="py-3 px-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleToggle}
          disabled={setStatus.isPending}
          className="gap-1"
        >
          {employee.is_active ? (
            <><UserX className="h-3 w-3" /> Deactivate</>
          ) : (
            <><UserCheck className="h-3 w-3" /> Activate</>
          )}
        </Button>
      </td>
    </tr>
  );
}

export default function AdminEmployeesPage() {
  const { permissions } = useAuth();
  const router = useRouter();
  const { toast } = useToast();

  useEffect(() => {
    if (!permissions.viewAnalytics) {
      router.replace("/sessions");
    }
  }, [permissions, router]);

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [filterActive, setFilterActive] = useState<boolean | undefined>(undefined);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");

  const { data, isLoading, error } = useEmployeeList(page, PAGE_SIZE, {
    active: filterActive,
    search: search || undefined,
  });
  const createEmployee = useCreateEmployee();

  const employees = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const hasMore = page * PAGE_SIZE < total;

  function handleCreate() {
    if (!newName.trim()) return;
    createEmployee.mutate(
      { name: newName.trim(), phone: newPhone.trim() || undefined },
      {
        onSuccess: (emp) => {
          toast({
            title: "Employee created",
            description: `${emp.name} — code: ${emp.employee_code}`,
          });
          setNewName("");
          setNewPhone("");
          setShowCreateForm(false);
        },
        onError: (err) => {
          toast({ variant: "destructive", title: "Creation failed", description: err.message });
        },
      },
    );
  }

  if (!permissions.viewAnalytics) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Employees</h2>
          <p className="text-muted-foreground">Manage employee records — {total} total</p>
        </div>
        <Button onClick={() => setShowCreateForm((v) => !v)} className="gap-2">
          <UserPlus className="h-4 w-4" />
          Add Employee
        </Button>
      </div>

      {showCreateForm && (
        <Card>
          <CardHeader>
            <CardTitle>New Employee</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex flex-col gap-1 flex-1">
              <label className="text-sm font-medium">Name *</label>
              <input
                className="border rounded px-3 py-2 text-sm"
                placeholder="Full name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1 flex-1">
              <label className="text-sm font-medium">Phone</label>
              <input
                className="border rounded px-3 py-2 text-sm"
                placeholder="+91 98765 43210"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={handleCreate} disabled={createEmployee.isPending}>
                {createEmployee.isPending ? "Creating…" : "Create"}
              </Button>
              <Button variant="outline" onClick={() => setShowCreateForm(false)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="pt-4 pb-3 flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              className="border rounded px-3 py-2 pl-9 text-sm w-full"
              placeholder="Search by name…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="flex gap-2">
            {(["all", "active", "inactive"] as const).map((f) => (
              <Button
                key={f}
                size="sm"
                variant={
                  (f === "all" && filterActive === undefined) ||
                  (f === "active" && filterActive === true) ||
                  (f === "inactive" && filterActive === false)
                    ? "default"
                    : "outline"
                }
                onClick={() => {
                  setFilterActive(f === "all" ? undefined : f === "active");
                  setPage(1);
                }}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {error && <ErrorBanner error={error as Error} />}

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Loading employees…</div>
          ) : employees.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">No employees found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50 text-muted-foreground text-xs uppercase tracking-wide">
                    <th className="text-left py-3 px-4">Code</th>
                    <th className="text-left py-3 px-4">Name</th>
                    <th className="text-left py-3 px-4">Phone</th>
                    <th className="text-left py-3 px-4">Status</th>
                    <th className="text-left py-3 px-4">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {employees.map((emp) => (
                    <EmployeeRow key={emp.id} employee={emp} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {(page > 1 || hasMore) && (
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} · {total} total
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={!hasMore}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
