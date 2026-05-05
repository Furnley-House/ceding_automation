// Type definitions matching our Express/Prisma backend schema (snake_case for UI compatibility)

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export interface Database {
  public: {
    Tables: {
      cases: {
        Row: {
          id: string;
          case_ref: string;
          client_name: string;
          plan_type: string;
          policy_reference: string | null;
          status: string;
          loa_status: string | null;
          provider_id: string | null;
          assigned_adviser_id: string | null;
          assigned_paraplanner_id: string | null;
          extraction_status: string | null;
          rag_status: string | null;
          stage: number | null;
          zoho_case_reference: string | null;
          ceding_confirmed: boolean | null;
          completion_date: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["cases"]["Row"]>;
        Update: Partial<Database["public"]["Tables"]["cases"]["Row"]>;
      };
      checklist_fields: {
        Row: {
          id: string;
          case_id: string;
          field_key: string;
          section: string | null;
          label: string | null;
          value: string | null;
          status: string | null;
          confidence_score: number | null;
          evidence_source: string | null;
          requires_review: boolean | null;
          is_manually_edited: boolean | null;
          audit_trail: Json | null;
          reviewer_name: string | null;
          notes: string | null;
          comment_count: number | null;
          approved_by: string | null;
          approved_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["checklist_fields"]["Row"]>;
        Update: Partial<Database["public"]["Tables"]["checklist_fields"]["Row"]>;
      };
      documents: {
        Row: {
          id: string;
          case_id: string;
          file_name: string;
          file_path: string;
          status: string;
          extraction_metadata: Json | null;
          confidence_average: number | null;
          extracted_json: Json | null;
          extraction_status: string | null;
          provider_detected: string | null;
          field_count: number | null;
          uploaded_by: string | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["documents"]["Row"]>;
        Update: Partial<Database["public"]["Tables"]["documents"]["Row"]>;
      };
      providers: {
        Row: {
          id: string;
          name: string;
          phone_main: string | null;
          phone_ceding_dept: string | null;
          email_main: string | null;
          is_on_origo: boolean | null;
          loa_format: string | null;
          accepted_sig_type: string | null;
          plan_type_prefixes: string[] | null;
          postal_address: string | null;
          turnaround_days: number | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["providers"]["Row"]>;
        Update: Partial<Database["public"]["Tables"]["providers"]["Row"]>;
      };
      notifications: {
        Row: {
          id: string;
          user_id: string;
          message: string;
          is_read: boolean;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["notifications"]["Row"]>;
        Update: Partial<Database["public"]["Tables"]["notifications"]["Row"]>;
      };
      profiles: {
        Row: {
          user_id: string;
          full_name: string | null;
          role: string;
        };
        Insert: Partial<Database["public"]["Tables"]["profiles"]["Row"]>;
        Update: Partial<Database["public"]["Tables"]["profiles"]["Row"]>;
      };
      tasks: {
        Row: {
          id: string;
          case_id: string | null;
          assigned_to: string | null;
          due_date: string | null;
          completed: boolean;
          title: string | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["tasks"]["Row"]>;
        Update: Partial<Database["public"]["Tables"]["tasks"]["Row"]>;
      };
      automation_rules: {
        Row: {
          id: string;
          rule_type: string;
          trigger_condition: string | null;
          action: string | null;
          enabled: boolean;
          last_triggered: string | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["automation_rules"]["Row"]>;
        Update: Partial<Database["public"]["Tables"]["automation_rules"]["Row"]>;
      };
      call_logs: {
        Row: {
          id: string;
          case_id: string | null;
          transcript: string | null;
          summary: string | null;
          duration_minutes: number | null;
          duration_seconds: number | null;
          resolved: boolean | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["call_logs"]["Row"]>;
        Update: Partial<Database["public"]["Tables"]["call_logs"]["Row"]>;
      };
      field_audit: {
        Row: {
          id: string;
          case_id: string;
          action: string;
          source: string | null;
          actor_name: string | null;
          actor_role: string | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["field_audit"]["Row"]>;
        Update: Partial<Database["public"]["Tables"]["field_audit"]["Row"]>;
      };
    };
  };
}

// Convenience type helpers
export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];

export type TablesInsert<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Insert"];

export type TablesUpdate<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Update"];
