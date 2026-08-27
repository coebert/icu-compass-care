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
    PostgrestVersion: "14.17"
  }
  public: {
    Tables: {
      account_access_events: {
        Row: {
          action: string
          actor_email: string | null
          actor_id: string | null
          created_at: string
          id: string
          note: string | null
          reason: string | null
          role: string | null
          target_display_name: string | null
          target_email: string | null
          target_user_id: string | null
        }
        Insert: {
          action: string
          actor_email?: string | null
          actor_id?: string | null
          created_at?: string
          id?: string
          note?: string | null
          reason?: string | null
          role?: string | null
          target_display_name?: string | null
          target_email?: string | null
          target_user_id?: string | null
        }
        Update: {
          action?: string
          actor_email?: string | null
          actor_id?: string | null
          created_at?: string
          id?: string
          note?: string | null
          reason?: string | null
          role?: string | null
          target_display_name?: string | null
          target_email?: string | null
          target_user_id?: string | null
        }
        Relationships: []
      }
      antimicrobial_library: {
        Row: {
          created_at: string
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          action: Database["public"]["Enums"]["audit_action"]
          created_at: string
          diff: Json | null
          entity: string
          entity_id: string | null
          id: string
          user_id: string | null
        }
        Insert: {
          action: Database["public"]["Enums"]["audit_action"]
          created_at?: string
          diff?: Json | null
          entity: string
          entity_id?: string | null
          id?: string
          user_id?: string | null
        }
        Update: {
          action?: Database["public"]["Enums"]["audit_action"]
          created_at?: string
          diff?: Json | null
          entity?: string
          entity_id?: string | null
          id?: string
          user_id?: string | null
        }
        Relationships: []
      }
      bridge_lockouts: {
        Row: {
          first_strike_at: string
          ip: string
          last_reason: string | null
          locked_until: string | null
          strikes: number
          updated_at: string
        }
        Insert: {
          first_strike_at?: string
          ip: string
          last_reason?: string | null
          locked_until?: string | null
          strikes?: number
          updated_at?: string
        }
        Update: {
          first_strike_at?: string
          ip?: string
          last_reason?: string | null
          locked_until?: string | null
          strikes?: number
          updated_at?: string
        }
        Relationships: []
      }
      bridge_rate_limits: {
        Row: {
          bucket_key: string
          count: number
          updated_at: string
          window_start: string
        }
        Insert: {
          bucket_key: string
          count?: number
          updated_at?: string
          window_start?: string
        }
        Update: {
          bucket_key?: string
          count?: number
          updated_at?: string
          window_start?: string
        }
        Relationships: []
      }
      bridge_security_alerts: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          alert_key: string
          created_at: string
          event_count: number
          event_type: string
          first_seen: string
          id: string
          last_seen: string
          note: string | null
          sample_actor_email: string | null
          sample_detail: string | null
          sample_ip: string | null
          status: string
          threshold: number
          updated_at: string
          window_minutes: number
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          alert_key: string
          created_at?: string
          event_count?: number
          event_type: string
          first_seen?: string
          id?: string
          last_seen?: string
          note?: string | null
          sample_actor_email?: string | null
          sample_detail?: string | null
          sample_ip?: string | null
          status?: string
          threshold: number
          updated_at?: string
          window_minutes: number
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          alert_key?: string
          created_at?: string
          event_count?: number
          event_type?: string
          first_seen?: string
          id?: string
          last_seen?: string
          note?: string | null
          sample_actor_email?: string | null
          sample_detail?: string | null
          sample_ip?: string | null
          status?: string
          threshold?: number
          updated_at?: string
          window_minutes?: number
        }
        Relationships: []
      }
      bridge_security_events: {
        Row: {
          actor_email: string | null
          actor_role: string | null
          created_at: string
          detail: string | null
          endpoint: string | null
          event_type: string
          id: string
          ip: string | null
          method: string | null
        }
        Insert: {
          actor_email?: string | null
          actor_role?: string | null
          created_at?: string
          detail?: string | null
          endpoint?: string | null
          event_type: string
          id?: string
          ip?: string | null
          method?: string | null
        }
        Update: {
          actor_email?: string | null
          actor_role?: string | null
          created_at?: string
          detail?: string | null
          endpoint?: string | null
          event_type?: string
          id?: string
          ip?: string | null
          method?: string | null
        }
        Relationships: []
      }
      bridge_sync_events: {
        Row: {
          actor_email: string | null
          actor_role: string | null
          created_at: string
          direction: string
          entity: string
          error_message: string | null
          id: string
          record_count: number
          status: string
        }
        Insert: {
          actor_email?: string | null
          actor_role?: string | null
          created_at?: string
          direction: string
          entity: string
          error_message?: string | null
          id?: string
          record_count?: number
          status?: string
        }
        Update: {
          actor_email?: string | null
          actor_role?: string | null
          created_at?: string
          direction?: string
          entity?: string
          error_message?: string | null
          id?: string
          record_count?: number
          status?: string
        }
        Relationships: []
      }
      bridge_write_nonces: {
        Row: {
          seen_at: string
          signature_hash: string
        }
        Insert: {
          seen_at?: string
          signature_hash: string
        }
        Update: {
          seen_at?: string
          signature_hash?: string
        }
        Relationships: []
      }
      chart_days: {
        Row: {
          archive_reason: string | null
          archived_at: string | null
          archived_by: string | null
          balance_24h_ml: number | null
          chart_date: string
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          patient_id: string
          source: Database["public"]["Enums"]["chart_source"]
          updated_at: string
        }
        Insert: {
          archive_reason?: string | null
          archived_at?: string | null
          archived_by?: string | null
          balance_24h_ml?: number | null
          chart_date: string
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          patient_id: string
          source?: Database["public"]["Enums"]["chart_source"]
          updated_at?: string
        }
        Update: {
          archive_reason?: string | null
          archived_at?: string | null
          archived_by?: string | null
          balance_24h_ml?: number | null
          chart_date?: string
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          patient_id?: string
          source?: Database["public"]["Enums"]["chart_source"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "chart_days_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      chart_hourly: {
        Row: {
          actual_removal_ml: number | null
          bowels: string | null
          cam_icu: string | null
          chart_day_id: string
          cumulative_balance_ml: number | null
          cvp: number | null
          dbp: number | null
          etco2: number | null
          fio2: number | null
          flushes_ml: number | null
          gcs: number | null
          hour: number
          hourly_balance_ml: number | null
          hr: number | null
          intake_ml: number | null
          map: number | null
          mv: number | null
          ng_aspirate_ml: number | null
          ng_free_ml: number | null
          p_support: number | null
          peak_pressure: number | null
          peep: number | null
          pupils_l: string | null
          pupils_r: string | null
          rr: number | null
          sbp: number | null
          spo2: number | null
          target_removal_ml: number | null
          temp: number | null
          tv: number | null
          updated_at: string
          urine_ml: number | null
          vent_mode: string | null
        }
        Insert: {
          actual_removal_ml?: number | null
          bowels?: string | null
          cam_icu?: string | null
          chart_day_id: string
          cumulative_balance_ml?: number | null
          cvp?: number | null
          dbp?: number | null
          etco2?: number | null
          fio2?: number | null
          flushes_ml?: number | null
          gcs?: number | null
          hour: number
          hourly_balance_ml?: number | null
          hr?: number | null
          intake_ml?: number | null
          map?: number | null
          mv?: number | null
          ng_aspirate_ml?: number | null
          ng_free_ml?: number | null
          p_support?: number | null
          peak_pressure?: number | null
          peep?: number | null
          pupils_l?: string | null
          pupils_r?: string | null
          rr?: number | null
          sbp?: number | null
          spo2?: number | null
          target_removal_ml?: number | null
          temp?: number | null
          tv?: number | null
          updated_at?: string
          urine_ml?: number | null
          vent_mode?: string | null
        }
        Update: {
          actual_removal_ml?: number | null
          bowels?: string | null
          cam_icu?: string | null
          chart_day_id?: string
          cumulative_balance_ml?: number | null
          cvp?: number | null
          dbp?: number | null
          etco2?: number | null
          fio2?: number | null
          flushes_ml?: number | null
          gcs?: number | null
          hour?: number
          hourly_balance_ml?: number | null
          hr?: number | null
          intake_ml?: number | null
          map?: number | null
          mv?: number | null
          ng_aspirate_ml?: number | null
          ng_free_ml?: number | null
          p_support?: number | null
          peak_pressure?: number | null
          peep?: number | null
          pupils_l?: string | null
          pupils_r?: string | null
          rr?: number | null
          sbp?: number | null
          spo2?: number | null
          target_removal_ml?: number | null
          temp?: number | null
          tv?: number | null
          updated_at?: string
          urine_ml?: number | null
          vent_mode?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "chart_hourly_chart_day_id_fkey"
            columns: ["chart_day_id"]
            isOneToOne: false
            referencedRelation: "chart_days"
            referencedColumns: ["id"]
          },
        ]
      }
      crypto_key_escrow: {
        Row: {
          algo: string
          created_at: string
          key_id: string
          note: string | null
          updated_at: string
          wrapped_key: string
        }
        Insert: {
          algo?: string
          created_at?: string
          key_id: string
          note?: string | null
          updated_at?: string
          wrapped_key: string
        }
        Update: {
          algo?: string
          created_at?: string
          key_id?: string
          note?: string | null
          updated_at?: string
          wrapped_key?: string
        }
        Relationships: []
      }
      handover_acknowledgements: {
        Row: {
          ack_by: string | null
          ack_name: string | null
          action: string
          created_at: string
          id: string
          note: string | null
          patient_id: string
          shift_key: string
        }
        Insert: {
          ack_by?: string | null
          ack_name?: string | null
          action: string
          created_at?: string
          id?: string
          note?: string | null
          patient_id: string
          shift_key: string
        }
        Update: {
          ack_by?: string | null
          ack_name?: string | null
          action?: string
          created_at?: string
          id?: string
          note?: string | null
          patient_id?: string
          shift_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "handover_acknowledgements_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      handover_versions: {
        Row: {
          captured_at: string
          created_at: string
          id: string
          label: string
          local_date: string
          patient_count: number
          search_text: string
          shift: string
          snapshot: Json
        }
        Insert: {
          captured_at?: string
          created_at?: string
          id?: string
          label: string
          local_date: string
          patient_count?: number
          search_text?: string
          shift: string
          snapshot: Json
        }
        Update: {
          captured_at?: string
          created_at?: string
          id?: string
          label?: string
          local_date?: string
          patient_count?: number
          search_text?: string
          shift?: string
          snapshot?: Json
        }
        Relationships: []
      }
      icnarc_targets: {
        Row: {
          decision_to_arrival_target_min: number
          id: boolean
          time_to_seen_target_min: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          decision_to_arrival_target_min?: number
          id?: boolean
          time_to_seen_target_min?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          decision_to_arrival_target_min?: number
          id?: boolean
          time_to_seen_target_min?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      icu_beds: {
        Row: {
          created_at: string
          id: string
          is_side_room: boolean
          label: string
          position: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_side_room?: boolean
          label: string
          position: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_side_room?: boolean
          label?: string
          position?: number
          updated_at?: string
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
      microbiology_results: {
        Row: {
          created_at: string
          created_by: string | null
          findings: string
          id: string
          patient_id: string
          result_at: string
          specimen_type: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          findings: string
          id?: string
          patient_id: string
          result_at?: string
          specimen_type: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          findings?: string
          id?: string
          patient_id?: string
          result_at?: string
          specimen_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "microbiology_results_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_deliveries: {
        Row: {
          actor_id: string | null
          channel: string
          delivered_at: string | null
          endpoint: string | null
          error: string | null
          generated_at: string
          id: string
          kind: string
          notification_id: string | null
          recipient_id: string
          referral_id: string | null
          status: string
        }
        Insert: {
          actor_id?: string | null
          channel: string
          delivered_at?: string | null
          endpoint?: string | null
          error?: string | null
          generated_at?: string
          id?: string
          kind: string
          notification_id?: string | null
          recipient_id: string
          referral_id?: string | null
          status: string
        }
        Update: {
          actor_id?: string | null
          channel?: string
          delivered_at?: string | null
          endpoint?: string | null
          error?: string | null
          generated_at?: string
          id?: string
          kind?: string
          notification_id?: string | null
          recipient_id?: string
          referral_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_deliveries_notification_id_fkey"
            columns: ["notification_id"]
            isOneToOne: false
            referencedRelation: "notifications"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          created_at: string
          id: string
          kind: string
          message: string
          read_at: string | null
          referral_id: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind: string
          message: string
          read_at?: string | null
          referral_id?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          message?: string
          read_at?: string | null
          referral_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_referral_id_fkey"
            columns: ["referral_id"]
            isOneToOne: false
            referencedRelation: "referrals"
            referencedColumns: ["id"]
          },
        ]
      }
      patient_events: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          event_at: string
          event_type: string
          id: string
          patient_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          event_at?: string
          event_type: string
          id?: string
          patient_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          event_at?: string
          event_type?: string
          id?: string
          patient_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "patient_events_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      patient_field_changes: {
        Row: {
          changed_at: string
          changed_by: string | null
          changed_by_email: string | null
          field_name: string
          id: string
          new_value: string | null
          old_value: string | null
          patient_id: string
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          changed_by_email?: string | null
          field_name: string
          id?: string
          new_value?: string | null
          old_value?: string | null
          patient_id: string
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          changed_by_email?: string | null
          field_name?: string
          id?: string
          new_value?: string | null
          old_value?: string | null
          patient_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "patient_field_changes_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      patient_lines: {
        Row: {
          created_at: string
          created_by: string | null
          device_type: string
          id: string
          indication: string | null
          inserted_in_unit: boolean
          inserted_on: string | null
          laterality: string | null
          notes: string | null
          patient_id: string
          removed_on: string | null
          site: string | null
          size: string | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          device_type: string
          id?: string
          indication?: string | null
          inserted_in_unit?: boolean
          inserted_on?: string | null
          laterality?: string | null
          notes?: string | null
          patient_id: string
          removed_on?: string | null
          site?: string | null
          size?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          device_type?: string
          id?: string
          indication?: string | null
          inserted_in_unit?: boolean
          inserted_on?: string | null
          laterality?: string | null
          notes?: string | null
          patient_id?: string
          removed_on?: string | null
          site?: string | null
          size?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "patient_lines_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      patient_observations: {
        Row: {
          created_at: string
          dbp: number | null
          fio2: number | null
          fluid_in_ml: number | null
          fluid_out_ml: number | null
          gcs: number | null
          hr: number | null
          id: string
          lactate: number | null
          map: number | null
          notes: string | null
          patient_id: string
          peep: number | null
          recorded_at: string
          recorded_by: string | null
          rr: number | null
          sbp: number | null
          spo2: number | null
          temp: number | null
          updated_at: string
          urine_ml: number | null
          vasopressor: string | null
          vasopressor_dose: number | null
          vent_mode: string | null
          vt: number | null
        }
        Insert: {
          created_at?: string
          dbp?: number | null
          fio2?: number | null
          fluid_in_ml?: number | null
          fluid_out_ml?: number | null
          gcs?: number | null
          hr?: number | null
          id?: string
          lactate?: number | null
          map?: number | null
          notes?: string | null
          patient_id: string
          peep?: number | null
          recorded_at?: string
          recorded_by?: string | null
          rr?: number | null
          sbp?: number | null
          spo2?: number | null
          temp?: number | null
          updated_at?: string
          urine_ml?: number | null
          vasopressor?: string | null
          vasopressor_dose?: number | null
          vent_mode?: string | null
          vt?: number | null
        }
        Update: {
          created_at?: string
          dbp?: number | null
          fio2?: number | null
          fluid_in_ml?: number | null
          fluid_out_ml?: number | null
          gcs?: number | null
          hr?: number | null
          id?: string
          lactate?: number | null
          map?: number | null
          notes?: string | null
          patient_id?: string
          peep?: number | null
          recorded_at?: string
          recorded_by?: string | null
          rr?: number | null
          sbp?: number | null
          spo2?: number | null
          temp?: number | null
          updated_at?: string
          urine_ml?: number | null
          vasopressor?: string | null
          vasopressor_dose?: number | null
          vent_mode?: string | null
          vt?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "patient_observations_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      patient_reviews: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          patient_id: string
          plan: string | null
          review: string | null
          reviewed_at: string
          specialty: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          patient_id: string
          plan?: string | null
          review?: string | null
          reviewed_at?: string
          specialty: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          patient_id?: string
          plan?: string | null
          review?: string | null
          reviewed_at?: string
          specialty?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "patient_reviews_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      patient_tasks: {
        Row: {
          category: string
          created_at: string
          created_by: string | null
          description: string
          due_at: string | null
          id: string
          notes: string | null
          owner: string | null
          patient_id: string
          position: number
          priority: string
          status: string
          updated_at: string
        }
        Insert: {
          category?: string
          created_at?: string
          created_by?: string | null
          description: string
          due_at?: string | null
          id?: string
          notes?: string | null
          owner?: string | null
          patient_id: string
          position?: number
          priority?: string
          status?: string
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          created_by?: string | null
          description?: string
          due_at?: string | null
          id?: string
          notes?: string | null
          owner?: string | null
          patient_id?: string
          position?: number
          priority?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "patient_tasks_patient_id_fkey"
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
          age: number | null
          airway_type: string | null
          allergies: Json
          anticoagulation: string[]
          antimicrobials: Json
          bed: string | null
          created_at: string
          created_by: string | null
          current_admission: string | null
          current_admission_enc: string | null
          current_management: string | null
          current_management_enc: string | null
          daily_goals: Json
          daily_goals_reviewed_at: string | null
          daily_goals_reviewed_by: string | null
          date_of_death: string | null
          discharge_date: string | null
          discharge_destination: string | null
          discharge_destination_enc: string | null
          dnacpr_date: string | null
          dnacpr_decision: boolean
          dnacpr_details: string | null
          dnacpr_details_enc: string | null
          full_name: string | null
          full_name_enc: string | null
          full_name_hash: string | null
          height_m: number | null
          hospital_number: string | null
          hospital_number_enc: string | null
          hospital_number_hash: string | null
          id: string
          isolation_required: boolean
          location_type: Database["public"]["Enums"]["patient_location"]
          nok_contact: string | null
          nok_contact_enc: string | null
          nok_last_updated: string | null
          nok_last_updated_by: string | null
          nok_name: string | null
          nok_name_enc: string | null
          nok_relationship: string | null
          nok_relationship_enc: string | null
          nursing_handover: string | null
          nursing_handover_enc: string | null
          nutrition_route: string[]
          outstanding_tasks: string | null
          outstanding_tasks_enc: string | null
          parent_specialty: string | null
          past_medical_history: string | null
          past_medical_history_enc: string | null
          pca_agents: string[]
          physio_handover: string | null
          physio_handover_enc: string | null
          regional_analgesia: string[]
          renal_diuretics: boolean
          renal_rrt: boolean
          resp_fio2: string | null
          resp_support: string[]
          salt_handover: string | null
          salt_handover_enc: string | null
          sedative_agents: string[]
          sex: string | null
          shared_with_partner: boolean
          shared_with_partner_at: string | null
          shared_with_partner_by: string | null
          source_referral_id: string | null
          specialty_consultant: string | null
          status: Database["public"]["Enums"]["patient_status"]
          systems_cvs: string | null
          systems_cvs_enc: string | null
          systems_gastro: string | null
          systems_gastro_enc: string | null
          systems_haem: string | null
          systems_haem_enc: string | null
          systems_micro: string | null
          systems_micro_enc: string | null
          systems_neuro: string | null
          systems_neuro_enc: string | null
          systems_other: string | null
          systems_other_enc: string | null
          systems_renal: string | null
          systems_renal_enc: string | null
          systems_resp: string | null
          systems_resp_enc: string | null
          tep_details: string | null
          tep_details_enc: string | null
          tep_exclusions: string[]
          tep_in_place: boolean
          updated_at: string
          updated_by: string | null
          vasoactive_agents: string[]
          ward: string | null
          wardable: boolean
          wardable_at: string | null
          wardable_by: string | null
          weight_kg: number | null
        }
        Insert: {
          admission_date?: string | null
          age?: number | null
          airway_type?: string | null
          allergies?: Json
          anticoagulation?: string[]
          antimicrobials?: Json
          bed?: string | null
          created_at?: string
          created_by?: string | null
          current_admission?: string | null
          current_admission_enc?: string | null
          current_management?: string | null
          current_management_enc?: string | null
          daily_goals?: Json
          daily_goals_reviewed_at?: string | null
          daily_goals_reviewed_by?: string | null
          date_of_death?: string | null
          discharge_date?: string | null
          discharge_destination?: string | null
          discharge_destination_enc?: string | null
          dnacpr_date?: string | null
          dnacpr_decision?: boolean
          dnacpr_details?: string | null
          dnacpr_details_enc?: string | null
          full_name?: string | null
          full_name_enc?: string | null
          full_name_hash?: string | null
          height_m?: number | null
          hospital_number?: string | null
          hospital_number_enc?: string | null
          hospital_number_hash?: string | null
          id?: string
          isolation_required?: boolean
          location_type?: Database["public"]["Enums"]["patient_location"]
          nok_contact?: string | null
          nok_contact_enc?: string | null
          nok_last_updated?: string | null
          nok_last_updated_by?: string | null
          nok_name?: string | null
          nok_name_enc?: string | null
          nok_relationship?: string | null
          nok_relationship_enc?: string | null
          nursing_handover?: string | null
          nursing_handover_enc?: string | null
          nutrition_route?: string[]
          outstanding_tasks?: string | null
          outstanding_tasks_enc?: string | null
          parent_specialty?: string | null
          past_medical_history?: string | null
          past_medical_history_enc?: string | null
          pca_agents?: string[]
          physio_handover?: string | null
          physio_handover_enc?: string | null
          regional_analgesia?: string[]
          renal_diuretics?: boolean
          renal_rrt?: boolean
          resp_fio2?: string | null
          resp_support?: string[]
          salt_handover?: string | null
          salt_handover_enc?: string | null
          sedative_agents?: string[]
          sex?: string | null
          shared_with_partner?: boolean
          shared_with_partner_at?: string | null
          shared_with_partner_by?: string | null
          source_referral_id?: string | null
          specialty_consultant?: string | null
          status?: Database["public"]["Enums"]["patient_status"]
          systems_cvs?: string | null
          systems_cvs_enc?: string | null
          systems_gastro?: string | null
          systems_gastro_enc?: string | null
          systems_haem?: string | null
          systems_haem_enc?: string | null
          systems_micro?: string | null
          systems_micro_enc?: string | null
          systems_neuro?: string | null
          systems_neuro_enc?: string | null
          systems_other?: string | null
          systems_other_enc?: string | null
          systems_renal?: string | null
          systems_renal_enc?: string | null
          systems_resp?: string | null
          systems_resp_enc?: string | null
          tep_details?: string | null
          tep_details_enc?: string | null
          tep_exclusions?: string[]
          tep_in_place?: boolean
          updated_at?: string
          updated_by?: string | null
          vasoactive_agents?: string[]
          ward?: string | null
          wardable?: boolean
          wardable_at?: string | null
          wardable_by?: string | null
          weight_kg?: number | null
        }
        Update: {
          admission_date?: string | null
          age?: number | null
          airway_type?: string | null
          allergies?: Json
          anticoagulation?: string[]
          antimicrobials?: Json
          bed?: string | null
          created_at?: string
          created_by?: string | null
          current_admission?: string | null
          current_admission_enc?: string | null
          current_management?: string | null
          current_management_enc?: string | null
          daily_goals?: Json
          daily_goals_reviewed_at?: string | null
          daily_goals_reviewed_by?: string | null
          date_of_death?: string | null
          discharge_date?: string | null
          discharge_destination?: string | null
          discharge_destination_enc?: string | null
          dnacpr_date?: string | null
          dnacpr_decision?: boolean
          dnacpr_details?: string | null
          dnacpr_details_enc?: string | null
          full_name?: string | null
          full_name_enc?: string | null
          full_name_hash?: string | null
          height_m?: number | null
          hospital_number?: string | null
          hospital_number_enc?: string | null
          hospital_number_hash?: string | null
          id?: string
          isolation_required?: boolean
          location_type?: Database["public"]["Enums"]["patient_location"]
          nok_contact?: string | null
          nok_contact_enc?: string | null
          nok_last_updated?: string | null
          nok_last_updated_by?: string | null
          nok_name?: string | null
          nok_name_enc?: string | null
          nok_relationship?: string | null
          nok_relationship_enc?: string | null
          nursing_handover?: string | null
          nursing_handover_enc?: string | null
          nutrition_route?: string[]
          outstanding_tasks?: string | null
          outstanding_tasks_enc?: string | null
          parent_specialty?: string | null
          past_medical_history?: string | null
          past_medical_history_enc?: string | null
          pca_agents?: string[]
          physio_handover?: string | null
          physio_handover_enc?: string | null
          regional_analgesia?: string[]
          renal_diuretics?: boolean
          renal_rrt?: boolean
          resp_fio2?: string | null
          resp_support?: string[]
          salt_handover?: string | null
          salt_handover_enc?: string | null
          sedative_agents?: string[]
          sex?: string | null
          shared_with_partner?: boolean
          shared_with_partner_at?: string | null
          shared_with_partner_by?: string | null
          source_referral_id?: string | null
          specialty_consultant?: string | null
          status?: Database["public"]["Enums"]["patient_status"]
          systems_cvs?: string | null
          systems_cvs_enc?: string | null
          systems_gastro?: string | null
          systems_gastro_enc?: string | null
          systems_haem?: string | null
          systems_haem_enc?: string | null
          systems_micro?: string | null
          systems_micro_enc?: string | null
          systems_neuro?: string | null
          systems_neuro_enc?: string | null
          systems_other?: string | null
          systems_other_enc?: string | null
          systems_renal?: string | null
          systems_renal_enc?: string | null
          systems_resp?: string | null
          systems_resp_enc?: string | null
          tep_details?: string | null
          tep_details_enc?: string | null
          tep_exclusions?: string[]
          tep_in_place?: boolean
          updated_at?: string
          updated_by?: string | null
          vasoactive_agents?: string[]
          ward?: string | null
          wardable?: boolean
          wardable_at?: string | null
          wardable_by?: string | null
          weight_kg?: number | null
        }
        Relationships: []
      }
      postop_bookings: {
        Row: {
          age: number | null
          arrived_at: string | null
          bmi: number | null
          booking_status: Database["public"]["Enums"]["postop_booking_status"]
          cancellation_notes: string | null
          cancellation_reason:
            | Database["public"]["Enums"]["postop_cancellation_reason"]
            | null
          cancelled_at: string | null
          cancelled_by: string | null
          converted_referral_id: string | null
          created_at: string
          created_by: string
          deleted_at: string | null
          deleted_by: string | null
          height_cm: number | null
          hospital_number_enc: string | null
          hospital_number_hash: string | null
          id: string
          intensivist_reviewed_at: string | null
          intensivist_reviewed_by: string | null
          is_test: boolean
          past_medical_history_enc: string | null
          past_surgical_history_enc: string | null
          predicted_level: Database["public"]["Enums"]["postop_level"]
          preop_signed_off_at: string | null
          preop_signed_off_by: string | null
          proposed_procedure_enc: string | null
          proposed_surgery_date: string | null
          reason_for_bed_enc: string | null
          sex: string | null
          social_history_enc: string | null
          surgical_specialty: string | null
          updated_at: string
          updated_by: string | null
          weight_kg: number | null
        }
        Insert: {
          age?: number | null
          arrived_at?: string | null
          bmi?: number | null
          booking_status?: Database["public"]["Enums"]["postop_booking_status"]
          cancellation_notes?: string | null
          cancellation_reason?:
            | Database["public"]["Enums"]["postop_cancellation_reason"]
            | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          converted_referral_id?: string | null
          created_at?: string
          created_by?: string
          deleted_at?: string | null
          deleted_by?: string | null
          height_cm?: number | null
          hospital_number_enc?: string | null
          hospital_number_hash?: string | null
          id?: string
          intensivist_reviewed_at?: string | null
          intensivist_reviewed_by?: string | null
          is_test?: boolean
          past_medical_history_enc?: string | null
          past_surgical_history_enc?: string | null
          predicted_level: Database["public"]["Enums"]["postop_level"]
          preop_signed_off_at?: string | null
          preop_signed_off_by?: string | null
          proposed_procedure_enc?: string | null
          proposed_surgery_date?: string | null
          reason_for_bed_enc?: string | null
          sex?: string | null
          social_history_enc?: string | null
          surgical_specialty?: string | null
          updated_at?: string
          updated_by?: string | null
          weight_kg?: number | null
        }
        Update: {
          age?: number | null
          arrived_at?: string | null
          bmi?: number | null
          booking_status?: Database["public"]["Enums"]["postop_booking_status"]
          cancellation_notes?: string | null
          cancellation_reason?:
            | Database["public"]["Enums"]["postop_cancellation_reason"]
            | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          converted_referral_id?: string | null
          created_at?: string
          created_by?: string
          deleted_at?: string | null
          deleted_by?: string | null
          height_cm?: number | null
          hospital_number_enc?: string | null
          hospital_number_hash?: string | null
          id?: string
          intensivist_reviewed_at?: string | null
          intensivist_reviewed_by?: string | null
          is_test?: boolean
          past_medical_history_enc?: string | null
          past_surgical_history_enc?: string | null
          predicted_level?: Database["public"]["Enums"]["postop_level"]
          preop_signed_off_at?: string | null
          preop_signed_off_by?: string | null
          proposed_procedure_enc?: string | null
          proposed_surgery_date?: string | null
          reason_for_bed_enc?: string | null
          sex?: string | null
          social_history_enc?: string | null
          surgical_specialty?: string | null
          updated_at?: string
          updated_by?: string | null
          weight_kg?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "postop_bookings_converted_referral_id_fkey"
            columns: ["converted_referral_id"]
            isOneToOne: false
            referencedRelation: "referrals"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string
          full_name: string | null
          id: string
          is_at_work: boolean
          job_title: string | null
          notify_capacity: boolean
          notify_capacity_l1: boolean
          notify_capacity_l2: boolean
          notify_capacity_l3: boolean
          notify_new_referral: boolean
          notify_notes: boolean
          notify_status: boolean
          notify_updated_referral: boolean
          shift_updated_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string
          full_name?: string | null
          id: string
          is_at_work?: boolean
          job_title?: string | null
          notify_capacity?: boolean
          notify_capacity_l1?: boolean
          notify_capacity_l2?: boolean
          notify_capacity_l3?: boolean
          notify_new_referral?: boolean
          notify_notes?: boolean
          notify_status?: boolean
          notify_updated_referral?: boolean
          shift_updated_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string
          full_name?: string | null
          id?: string
          is_at_work?: boolean
          job_title?: string | null
          notify_capacity?: boolean
          notify_capacity_l1?: boolean
          notify_capacity_l2?: boolean
          notify_capacity_l3?: boolean
          notify_new_referral?: boolean
          notify_notes?: boolean
          notify_status?: boolean
          notify_updated_referral?: boolean
          shift_updated_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      record_audit: {
        Row: {
          action: string
          actor_email: string | null
          actor_id: string | null
          actor_role: string | null
          after: Json | null
          before: Json | null
          changed_fields: string[]
          created_at: string
          entity: string
          id: string
          record_id: string
          source: string
        }
        Insert: {
          action: string
          actor_email?: string | null
          actor_id?: string | null
          actor_role?: string | null
          after?: Json | null
          before?: Json | null
          changed_fields?: string[]
          created_at?: string
          entity: string
          id?: string
          record_id: string
          source?: string
        }
        Update: {
          action?: string
          actor_email?: string | null
          actor_id?: string | null
          actor_role?: string | null
          after?: Json | null
          before?: Json | null
          changed_fields?: string[]
          created_at?: string
          entity?: string
          id?: string
          record_id?: string
          source?: string
        }
        Relationships: []
      }
      referrals: {
        Row: {
          accepting_consultant: string | null
          admission_urgency:
            | Database["public"]["Enums"]["admission_urgency"]
            | null
          age: number | null
          allergies: string | null
          anticipated_interventions: string[]
          arrived_on_unit_at: string | null
          baseline_function_enc: string | null
          ceiling_of_care: Database["public"]["Enums"]["ceiling_of_care"] | null
          consultant_to_consultant_only: boolean
          created_at: string
          created_by: string | null
          current_bed: string | null
          current_ward: string | null
          decision_at: string | null
          decline_reason: string | null
          deleted_at: string | null
          deleted_by: string | null
          discussed_with_consultant: string | null
          dnacpr_respect: boolean
          first_seen_at: string | null
          for_ongoing_ccot_review: boolean
          frailty_score: number | null
          hospital_number_enc: string | null
          hospital_number_hash: string | null
          id: string
          infection_organism: string | null
          infection_status:
            | Database["public"]["Enums"]["infection_status"]
            | null
          is_test: boolean
          needs_ward_review: boolean
          news2_recorded_at: string | null
          news2_score: number | null
          origin_booking_id: string | null
          outcome: Database["public"]["Enums"]["referral_outcome"] | null
          outcome_recorded_at: string | null
          past_medical_history_enc: string | null
          previous_referral_id: string | null
          reason_category:
            | Database["public"]["Enums"]["referral_reason_category"]
            | null
          reason_for_referral_enc: string | null
          referral_received_at: string
          referring_specialty: string | null
          resus_status: Database["public"]["Enums"]["resus_status"] | null
          sex: Database["public"]["Enums"]["patient_sex"] | null
          status: Database["public"]["Enums"]["referral_status"]
          updated_at: string
          updated_by: string | null
          ward_review_timeframe: string | null
          weight_kg: number | null
        }
        Insert: {
          accepting_consultant?: string | null
          admission_urgency?:
            | Database["public"]["Enums"]["admission_urgency"]
            | null
          age?: number | null
          allergies?: string | null
          anticipated_interventions?: string[]
          arrived_on_unit_at?: string | null
          baseline_function_enc?: string | null
          ceiling_of_care?:
            | Database["public"]["Enums"]["ceiling_of_care"]
            | null
          consultant_to_consultant_only?: boolean
          created_at?: string
          created_by?: string | null
          current_bed?: string | null
          current_ward?: string | null
          decision_at?: string | null
          decline_reason?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          discussed_with_consultant?: string | null
          dnacpr_respect?: boolean
          first_seen_at?: string | null
          for_ongoing_ccot_review?: boolean
          frailty_score?: number | null
          hospital_number_enc?: string | null
          hospital_number_hash?: string | null
          id?: string
          infection_organism?: string | null
          infection_status?:
            | Database["public"]["Enums"]["infection_status"]
            | null
          is_test?: boolean
          needs_ward_review?: boolean
          news2_recorded_at?: string | null
          news2_score?: number | null
          origin_booking_id?: string | null
          outcome?: Database["public"]["Enums"]["referral_outcome"] | null
          outcome_recorded_at?: string | null
          past_medical_history_enc?: string | null
          previous_referral_id?: string | null
          reason_category?:
            | Database["public"]["Enums"]["referral_reason_category"]
            | null
          reason_for_referral_enc?: string | null
          referral_received_at?: string
          referring_specialty?: string | null
          resus_status?: Database["public"]["Enums"]["resus_status"] | null
          sex?: Database["public"]["Enums"]["patient_sex"] | null
          status?: Database["public"]["Enums"]["referral_status"]
          updated_at?: string
          updated_by?: string | null
          ward_review_timeframe?: string | null
          weight_kg?: number | null
        }
        Update: {
          accepting_consultant?: string | null
          admission_urgency?:
            | Database["public"]["Enums"]["admission_urgency"]
            | null
          age?: number | null
          allergies?: string | null
          anticipated_interventions?: string[]
          arrived_on_unit_at?: string | null
          baseline_function_enc?: string | null
          ceiling_of_care?:
            | Database["public"]["Enums"]["ceiling_of_care"]
            | null
          consultant_to_consultant_only?: boolean
          created_at?: string
          created_by?: string | null
          current_bed?: string | null
          current_ward?: string | null
          decision_at?: string | null
          decline_reason?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          discussed_with_consultant?: string | null
          dnacpr_respect?: boolean
          first_seen_at?: string | null
          for_ongoing_ccot_review?: boolean
          frailty_score?: number | null
          hospital_number_enc?: string | null
          hospital_number_hash?: string | null
          id?: string
          infection_organism?: string | null
          infection_status?:
            | Database["public"]["Enums"]["infection_status"]
            | null
          is_test?: boolean
          needs_ward_review?: boolean
          news2_recorded_at?: string | null
          news2_score?: number | null
          origin_booking_id?: string | null
          outcome?: Database["public"]["Enums"]["referral_outcome"] | null
          outcome_recorded_at?: string | null
          past_medical_history_enc?: string | null
          previous_referral_id?: string | null
          reason_category?:
            | Database["public"]["Enums"]["referral_reason_category"]
            | null
          reason_for_referral_enc?: string | null
          referral_received_at?: string
          referring_specialty?: string | null
          resus_status?: Database["public"]["Enums"]["resus_status"] | null
          sex?: Database["public"]["Enums"]["patient_sex"] | null
          status?: Database["public"]["Enums"]["referral_status"]
          updated_at?: string
          updated_by?: string | null
          ward_review_timeframe?: string | null
          weight_kg?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "referrals_origin_booking_id_fkey"
            columns: ["origin_booking_id"]
            isOneToOne: false
            referencedRelation: "postop_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referrals_previous_referral_id_fkey"
            columns: ["previous_referral_id"]
            isOneToOne: false
            referencedRelation: "referrals"
            referencedColumns: ["id"]
          },
        ]
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
      webauthn_challenges: {
        Row: {
          challenge: string
          created_at: string
          purpose: string
          user_id: string
        }
        Insert: {
          challenge: string
          created_at?: string
          purpose: string
          user_id: string
        }
        Update: {
          challenge?: string
          created_at?: string
          purpose?: string
          user_id?: string
        }
        Relationships: []
      }
      webauthn_credentials: {
        Row: {
          counter: number
          created_at: string
          credential_id: string
          device_label: string | null
          id: string
          last_used_at: string | null
          public_key: string
          transports: string[]
          user_id: string
        }
        Insert: {
          counter?: number
          created_at?: string
          credential_id: string
          device_label?: string | null
          id?: string
          last_used_at?: string | null
          public_key: string
          transports?: string[]
          user_id: string
        }
        Update: {
          counter?: number
          created_at?: string
          credential_id?: string
          device_label?: string | null
          id?: string
          last_used_at?: string | null
          public_key?: string
          transports?: string[]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      check_bridge_lockout: {
        Args: { _ip: string }
        Returns: {
          locked: boolean
          retry_after: number
        }[]
      }
      check_bridge_rate_limit: {
        Args: { _bucket_key: string; _limit: number; _window_seconds?: number }
        Returns: {
          allowed: boolean
          current_count: number
          retry_after: number
        }[]
      }
      record_bridge_security_event: {
        Args: {
          _actor_email?: string
          _actor_role?: string
          _detail?: string
          _endpoint?: string
          _event_type: string
          _ip?: string
          _method?: string
          _threshold?: number
          _window_minutes?: number
        }
        Returns: undefined
      }
      register_bridge_strike: {
        Args: {
          _base_lock_seconds?: number
          _ip: string
          _max_lock_seconds?: number
          _reason?: string
          _threshold?: number
          _window_seconds?: number
        }
        Returns: {
          locked: boolean
          retry_after: number
        }[]
      }
      to_initials: { Args: { _name: string }; Returns: string }
    }
    Enums: {
      admission_urgency:
        | "within_15_min"
        | "within_30_min"
        | "within_1_hour"
        | "within_1_2_hours"
      app_role: "admin" | "clinician"
      audit_action: "view" | "create" | "update" | "delete"
      ceiling_of_care:
        | "full_escalation"
        | "no_cpr"
        | "ward_based"
        | "symptom_control"
        | "not_documented"
      chart_source: "scan" | "manual"
      infection_status: "none" | "suspected" | "confirmed" | "unknown"
      patient_location: "icu" | "outlier"
      patient_sex: "male" | "female" | "other" | "unknown"
      patient_status: "referred" | "admitted" | "discharged" | "died"
      postop_booking_status:
        | "requested"
        | "provisionally_confirmed"
        | "confirmed"
        | "admitted"
        | "cancelled"
      postop_cancellation_reason:
        | "no_bed"
        | "patient_unfit"
        | "surgery_deferred"
        | "died_pre_op"
        | "other"
      postop_level: "level_1" | "level_2" | "level_3"
      referral_outcome:
        | "admit_for_admission"
        | "review_on_ward"
        | "advice_given"
        | "declined"
      referral_reason_category:
        | "respiratory_failure"
        | "sepsis"
        | "shock"
        | "post_op"
        | "neurology"
        | "trauma"
        | "gi_bleed"
        | "metabolic"
        | "overdose"
        | "other"
      referral_status: "pending" | "declined" | "admitted"
      resus_status: "for_cpr" | "dnacpr" | "not_documented"
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
      admission_urgency: [
        "within_15_min",
        "within_30_min",
        "within_1_hour",
        "within_1_2_hours",
      ],
      app_role: ["admin", "clinician"],
      audit_action: ["view", "create", "update", "delete"],
      ceiling_of_care: [
        "full_escalation",
        "no_cpr",
        "ward_based",
        "symptom_control",
        "not_documented",
      ],
      chart_source: ["scan", "manual"],
      infection_status: ["none", "suspected", "confirmed", "unknown"],
      patient_location: ["icu", "outlier"],
      patient_sex: ["male", "female", "other", "unknown"],
      patient_status: ["referred", "admitted", "discharged", "died"],
      postop_booking_status: [
        "requested",
        "provisionally_confirmed",
        "confirmed",
        "admitted",
        "cancelled",
      ],
      postop_cancellation_reason: [
        "no_bed",
        "patient_unfit",
        "surgery_deferred",
        "died_pre_op",
        "other",
      ],
      postop_level: ["level_1", "level_2", "level_3"],
      referral_outcome: [
        "admit_for_admission",
        "review_on_ward",
        "advice_given",
        "declined",
      ],
      referral_reason_category: [
        "respiratory_failure",
        "sepsis",
        "shock",
        "post_op",
        "neurology",
        "trauma",
        "gi_bleed",
        "metabolic",
        "overdose",
        "other",
      ],
      referral_status: ["pending", "declined", "admitted"],
      resus_status: ["for_cpr", "dnacpr", "not_documented"],
    },
  },
} as const
