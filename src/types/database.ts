export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      admin_sessions: {
        Row: {
          admin_id: string
          created_at: string
          ended_at: string | null
          id: string
          organization_id: string
          started_at: string
        }
        Insert: {
          admin_id: string
          created_at?: string
          ended_at?: string | null
          id?: string
          organization_id: string
          started_at?: string
        }
        Update: {
          admin_id?: string
          created_at?: string
          ended_at?: string | null
          id?: string
          organization_id?: string
          started_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "admin_sessions_admin_id_fkey"
            columns: ["admin_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "admin_sessions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance_sessions: {
        Row: {
          checkin_at: string
          checkout_at: string | null
          created_at: string
          distance_recalculation_status: Database["public"]["Enums"]["distance_job_status"]
          employee_id: string
          id: string
          organization_id: string
          total_distance_km: number | null
          total_duration_seconds: number | null
          updated_at: string
        }
        Insert: {
          checkin_at?: string
          checkout_at?: string | null
          created_at?: string
          distance_recalculation_status?: Database["public"]["Enums"]["distance_job_status"]
          employee_id: string
          id?: string
          organization_id: string
          total_distance_km?: number | null
          total_duration_seconds?: number | null
          updated_at?: string
        }
        Update: {
          checkin_at?: string
          checkout_at?: string | null
          created_at?: string
          distance_recalculation_status?: Database["public"]["Enums"]["distance_job_status"]
          employee_id?: string
          id?: string
          organization_id?: string
          total_distance_km?: number | null
          total_duration_seconds?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_sessions_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_sessions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      employees: {
        Row: {
          created_at: string
          employee_code: string
          id: string
          is_active: boolean
          last_activity_at: string | null
          name: string
          organization_id: string
          phone: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          employee_code: string
          id?: string
          is_active?: boolean
          last_activity_at?: string | null
          name: string
          organization_id: string
          phone?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          employee_code?: string
          id?: string
          is_active?: boolean
          last_activity_at?: string | null
          name?: string
          organization_id?: string
          phone?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "employees_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      expenses: {
        Row: {
          amount: number
          created_at: string
          description: string
          employee_id: string
          id: string
          organization_id: string
          receipt_url: string | null
          rejection_comment: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["expense_status"]
          submitted_at: string
          updated_at: string
        }
        Insert: {
          amount: number
          created_at?: string
          description: string
          employee_id: string
          id?: string
          organization_id: string
          receipt_url?: string | null
          rejection_comment?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["expense_status"]
          submitted_at?: string
          updated_at?: string
        }
        Update: {
          amount?: number
          created_at?: string
          description?: string
          employee_id?: string
          id?: string
          organization_id?: string
          receipt_url?: string | null
          rejection_comment?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["expense_status"]
          submitted_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "expenses_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      gps_locations: {
        Row: {
          accuracy: number | null
          employee_id: string
          id: string
          is_duplicate: boolean
          latitude: number
          longitude: number
          organization_id: string
          recorded_at: string
          sequence_number: number | null
          session_id: string
        }
        Insert: {
          accuracy?: number | null
          employee_id: string
          id?: string
          is_duplicate?: boolean
          latitude: number
          longitude: number
          organization_id: string
          recorded_at: string
          sequence_number?: number | null
          session_id: string
        }
        Update: {
          accuracy?: number | null
          employee_id?: string
          id?: string
          is_duplicate?: boolean
          latitude?: number
          longitude?: number
          organization_id?: string
          recorded_at?: string
          sequence_number?: number | null
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "gps_locations_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gps_locations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gps_locations_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "attendance_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          id: string
          name: string
          slug: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          slug?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          slug?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      session_summaries: {
        Row: {
          avg_speed_kmh: number
          computed_at: string
          created_at: string
          id: string
          organization_id: string
          session_id: string
          total_distance_km: number
          total_duration_seconds: number
          updated_at: string
        }
        Insert: {
          avg_speed_kmh?: number
          computed_at?: string
          created_at?: string
          id?: string
          organization_id: string
          session_id: string
          total_distance_km?: number
          total_duration_seconds?: number
          updated_at?: string
        }
        Update: {
          avg_speed_kmh?: number
          computed_at?: string
          created_at?: string
          id?: string
          organization_id?: string
          session_id?: string
          total_distance_km?: number
          total_duration_seconds?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_summaries_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_summaries_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "attendance_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          created_at: string
          email: string
          id: string
          organization_id: string
          role: Database["public"]["Enums"]["user_role"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          organization_id: string
          role: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          organization_id?: string
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "users_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_latest_sessions: {
        Row: {
          employee_id: string
          organization_id: string
          session_id: string | null
          /** Authoritative name: latest_checkin. Migration alias: checkin_at. */
          latest_checkin: string | null
          latest_checkout: string | null
          total_distance_km: number | null
          total_duration_seconds: number | null
          status: string
          updated_at: string
        }
        Insert: {
          employee_id: string
          organization_id: string
          session_id?: string | null
          latest_checkin?: string | null
          latest_checkout?: string | null
          total_distance_km?: number | null
          total_duration_seconds?: number | null
          status?: string
          updated_at?: string
        }
        Update: {
          employee_id?: string
          organization_id?: string
          session_id?: string | null
          latest_checkin?: string | null
          latest_checkout?: string | null
          total_distance_km?: number | null
          total_duration_seconds?: number | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "employee_latest_sessions_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_latest_sessions_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "attendance_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_daily_metrics: {
        Row: {
          id: string
          organization_id: string
          employee_id: string
          date: string
          sessions: number
          distance_km: number
          duration_seconds: number
          expenses_count: number
          expenses_amount: number
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          organization_id: string
          employee_id: string
          date: string
          sessions?: number
          distance_km?: number
          duration_seconds?: number
          expenses_count?: number
          expenses_amount?: number
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          organization_id?: string
          employee_id?: string
          date?: string
          sessions?: number
          distance_km?: number
          duration_seconds?: number
          expenses_count?: number
          expenses_amount?: number
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "employee_daily_metrics_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_daily_metrics_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_daily_metrics: {
        Row: {
          id: string
          organization_id: string
          date: string
          total_sessions: number
          total_distance_km: number
          total_duration_seconds: number
          active_employees: number
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          organization_id: string
          date: string
          total_sessions?: number
          total_distance_km?: number
          total_duration_seconds?: number
          active_employees?: number
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          organization_id?: string
          date?: string
          total_sessions?: number
          total_distance_km?: number
          total_duration_seconds?: number
          active_employees?: number
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_daily_metrics_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_dashboard_snapshot: {
        Row: {
          organization_id: string
          active_employee_count: number
          recent_employee_count: number
          inactive_employee_count: number
          active_employees_today: number
          today_session_count: number
          today_distance_km: number
          pending_expense_count: number
          pending_expense_amount: number
          updated_at: string
        }
        Insert: {
          organization_id: string
          active_employee_count?: number
          recent_employee_count?: number
          inactive_employee_count?: number
          active_employees_today?: number
          today_session_count?: number
          today_distance_km?: number
          pending_expense_count?: number
          pending_expense_amount?: number
          updated_at?: string
        }
        Update: {
          organization_id?: string
          active_employee_count?: number
          recent_employee_count?: number
          inactive_employee_count?: number
          active_employees_today?: number
          today_session_count?: number
          today_distance_km?: number
          pending_expense_count?: number
          pending_expense_amount?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_dashboard_snapshot_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_deliveries: {
        Row: {
          id: string
          webhook_id: string
          event_id: string
          organization_id: string
          status: string
          attempt_count: number
          response_status: number | null
          response_body: string | null
          last_attempt_at: string | null
          next_retry_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          webhook_id: string
          event_id: string
          organization_id: string
          status?: string
          attempt_count?: number
          response_status?: number | null
          response_body?: string | null
          last_attempt_at?: string | null
          next_retry_at?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          webhook_id?: string
          event_id?: string
          organization_id?: string
          status?: string
          attempt_count?: number
          response_status?: number | null
          response_body?: string | null
          last_attempt_at?: string | null
          next_retry_at?: string | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_deliveries_webhook_id_fkey"
            columns: ["webhook_id"]
            isOneToOne: false
            referencedRelation: "webhooks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "webhook_deliveries_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "webhook_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "webhook_deliveries_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_events: {
        Row: {
          id: string
          organization_id: string
          event_type: string
          payload: Json
          created_at: string
        }
        Insert: {
          id?: string
          organization_id: string
          event_type: string
          payload?: Json
          created_at?: string
        }
        Update: {
          id?: string
          organization_id?: string
          event_type?: string
          payload?: Json
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      webhooks: {
        Row: {
          id: string
          organization_id: string
          url: string
          secret: string
          is_active: boolean
          events: string[]
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          organization_id: string
          url: string
          secret: string
          is_active?: boolean
          events?: string[]
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          organization_id?: string
          url?: string
          secret?: string
          is_active?: boolean
          events?: string[]
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhooks_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_org_latest_sessions: {
        Args: {
          p_org_id: string
          p_status?: string
          p_limit?: number
          p_offset?: number
        }
        Returns: Array<{
          id: string
          employee_id: string
          organization_id: string
          checkin_at: string
          checkout_at: string | null
          total_distance_km: number | null
          total_duration_seconds: number | null
          distance_recalculation_status: string
          created_at: string
          updated_at: string
          employee_code: string
          employee_name: string
          activity_status: string
          total_count: number
        }>
      }
    }
    Enums: {
      distance_job_status: "pending" | "processing" | "done" | "failed"
      expense_status: "PENDING" | "APPROVED" | "REJECTED"
      user_role: "ADMIN" | "EMPLOYEE" | "SUPERVISOR" | "FINANCE" | "TEAM_LEAD"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      distance_job_status: ["pending", "processing", "done", "failed"],
      expense_status: ["PENDING", "APPROVED", "REJECTED"],
      user_role: ["ADMIN", "EMPLOYEE", "SUPERVISOR", "FINANCE", "TEAM_LEAD"],
    },
  },
} as const
