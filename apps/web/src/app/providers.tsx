"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/query-client";
import { AuthProvider } from "@/contexts/AuthContext";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { Toaster } from "@/components/ui/toaster";
import { validateEnv } from "@/lib/env";
import { useEffect } from "react";

function EnvValidator({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // Log API routing mode on every startup — instant misconfiguration visibility.
    console.log("[FieldTrack] API mode:", {
      base: process.env.NEXT_PUBLIC_API_BASE_URL ?? "(not set)",
      proxy: process.env.API_DESTINATION_URL ?? "(not set — only relevant in proxy mode)",
    });

    try {
      validateEnv();
    } catch (e) {
      console.error(e);
    }
  }, []);

  return <>{children}</>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <EnvValidator>
            {children}
            <Toaster />
          </EnvValidator>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
