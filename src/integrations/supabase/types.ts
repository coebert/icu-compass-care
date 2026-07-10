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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      bridge_sync_events: {
        Row: {
          actor_email: string | null
          actor_role: string | null
          created_at: string
          direction: string
          entity: string
          id: string
          record_count: number
        }
        Insert: {
          actor_email?: string | null
          actor_role?: string | null
          created_at?: string
          direction: string
          entity: string
          id?: string
          record_count?: number
        }
        Update: {
          actor_email?: string | null
          actor_role?: string | null
          created_at?: string
          direction?: string
          entity?: string
          id?: string
          record_count?: number
        }
        Relationships: []
      }
      investigations: {
        Row: {
          category: string
          created_at: string
          created_by: string | null
          findings: string
          id: string
          patient_id: string
          result_at: string
          updated_at: string
        }
        Insert: {
          category: string
          created_at?: string
          created_by?: string | null
          findings: string
          id?: string
          patient_id: string
          result_at?: string
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          created_by?: string | null
          findings?: string
          id?: string
          patient_id?: string
          result_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "investigations_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      patients: {
        Row: {
          admission_date: string | null
          bed: string | null
          created_at: string
          created_by: string | null
          current_admission: string | null
          current_management: string | null
          date_of_death: string | null
          discharge_date: string | null
          discharge_destination: string | null
          dnacpr_date: string | null
          dnacpr_decision: boolean
          dnacpr_details: string | null
          dob: string | null
          full_name: string
          hospital_number: string | null
          id: string
          location_type: Database["public"]["Enums"]["patient_location"]
          nhs_number: string | null
          nok_contact: string | null
          nok_last_updated: string | null
          nok_last_updated_by: string | null
          nok_name: string | null
          nok_relationship: string | null
          outstanding_tasks: string | null
          past_medical_history: string | null
          status: Database["public"]["Enums"]["patient_status"]
          tep_details: string | null
          tep_in_place: boolean
          updated_at: string
          updated_by: string | null
          ward: string | null
        }
        Insert: {
          admission_date?: string | null
          bed?: string | null
          created_at?: string
          created_by?: string | null
          current_admission?: string | null
          current_management?: string | null
          date_of_death?: string | null
          discharge_date?: string | null
          discharge_destination?: string | null
          dnacpr_date?: string | null
          dnacpr_decision?: boolean
          dnacpr_details?: string | null
          dob?: string | null
          full_name: string
          hospital_number?: string | null
          id?: string
          location_type?: Database["public"]["Enums"]["patient_location"]
          nhs_number?: string | null
          nok_contact?: string | null
          nok_last_updated?: string | null
          nok_last_updated_by?: string | null
          nok_name?: string | null
          nok_relationship?: string | null
          outstanding_tasks?: string | null
          past_medical_history?: string | null
          status?: Database["public"]["Enums"]["patient_status"]
          tep_details?: string | null
          tep_in_place?: boolean
          updated_at?: string
          updated_by?: string | null
          ward?: string | null
        }
        Update: {
          admission_date?: string | null
          bed?: string | null
          created_at?: string
          created_by?: string | null
          current_admission?: string | null
          current_management?: string | null
          date_of_death?: string | null
          discharge_date?: string | null
          discharge_destination?: string | null
          dnacpr_date?: string | null
          dnacpr_decision?: boolean
          dnacpr_details?: string | null
          dob?: string | null
          full_name?: string
          hospital_number?: string | null
          id?: string
          location_type?: Database["public"]["Enums"]["patient_location"]
          nhs_number?: string | null
          nok_contact?: string | null
          nok_last_updated?: string | null
          nok_last_updated_by?: string | null
          nok_name?: string | null
          nok_relationship?: string | null
          outstanding_tasks?: string | null
          past_medical_history?: string | null
          status?: Database["public"]["Enums"]["patient_status"]
          tep_details?: string | null
          tep_in_place?: boolean
          updated_at?: string
          updated_by?: string | null
          ward?: string | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string
          id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string
          id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "clinician"
      patient_location: "icu" | "outlier"
      patient_status: "referred" | "admitted" | "discharged" | "died"
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
  public: {
    Enums: {
      app_role: ["admin", "clinician"],
      patient_location: ["icu", "outlier"],
      patient_status: ["referred", "admitted", "discharged", "died"],
    },
  },
} as const
