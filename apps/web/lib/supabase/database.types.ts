export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
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
      business_members: {
        Row: {
          business_id: string
          created_at: string
          id: string
          role_id: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          business_id: string
          created_at?: string
          id?: string
          role_id: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          business_id?: string
          created_at?: string
          id?: string
          role_id?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_members_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_members_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
        ]
      }
      businesses: {
        Row: {
          created_at: string
          created_by: string
          id: string
          name: string
          slug: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          name: string
          slug: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          name?: string
          slug?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      inventory_balances: {
        Row: {
          business_id: string
          id: string
          inventory_location_id: string
          product_id: string
          quantity: number
          updated_at: string
        }
        Insert: {
          business_id: string
          id?: string
          inventory_location_id: string
          product_id: string
          quantity?: number
          updated_at?: string
        }
        Update: {
          business_id?: string
          id?: string
          inventory_location_id?: string
          product_id?: string
          quantity?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_balances_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_balances_inventory_location_id_business_id_fkey"
            columns: ["inventory_location_id", "business_id"]
            isOneToOne: false
            referencedRelation: "inventory_locations"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "inventory_balances_product_id_business_id_fkey"
            columns: ["product_id", "business_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
      inventory_ledger: {
        Row: {
          balance_after: number
          business_id: string
          created_at: string
          created_by: string
          id: string
          idempotency_key: string
          inventory_location_id: string
          movement_type: string
          note: string | null
          product_id: string
          quantity_delta: number
          reason: string
          reference_id: string | null
          reference_type: string | null
          unit_cost: number | null
        }
        Insert: {
          balance_after: number
          business_id: string
          created_at?: string
          created_by: string
          id?: string
          idempotency_key: string
          inventory_location_id: string
          movement_type: string
          note?: string | null
          product_id: string
          quantity_delta: number
          reason: string
          reference_id?: string | null
          reference_type?: string | null
          unit_cost?: number | null
        }
        Update: {
          balance_after?: number
          business_id?: string
          created_at?: string
          created_by?: string
          id?: string
          idempotency_key?: string
          inventory_location_id?: string
          movement_type?: string
          note?: string | null
          product_id?: string
          quantity_delta?: number
          reason?: string
          reference_id?: string | null
          reference_type?: string | null
          unit_cost?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_ledger_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_ledger_inventory_location_id_business_id_fkey"
            columns: ["inventory_location_id", "business_id"]
            isOneToOne: false
            referencedRelation: "inventory_locations"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "inventory_ledger_product_id_business_id_fkey"
            columns: ["product_id", "business_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
      inventory_locations: {
        Row: {
          business_id: string
          created_at: string
          created_by: string
          id: string
          is_default: boolean
          name: string
          status: string
          updated_at: string
        }
        Insert: {
          business_id: string
          created_at?: string
          created_by: string
          id?: string
          is_default?: boolean
          name: string
          status?: string
          updated_at?: string
        }
        Update: {
          business_id?: string
          created_at?: string
          created_by?: string
          id?: string
          is_default?: boolean
          name?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_locations_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      permissions: {
        Row: {
          created_at: string
          description: string | null
          id: string
          key: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          key: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          key?: string
        }
        Relationships: []
      }
      products: {
        Row: {
          barcode: string | null
          business_id: string
          category: string | null
          cost_price: number
          created_at: string
          created_by: string
          creation_key: string
          currency_code: string
          description: string | null
          id: string
          low_stock_threshold: number | null
          name: string
          selling_price: number
          sku: string | null
          status: string
          track_inventory: boolean
          unit: string
          updated_at: string
        }
        Insert: {
          barcode?: string | null
          business_id: string
          category?: string | null
          cost_price?: number
          created_at?: string
          created_by: string
          creation_key: string
          currency_code?: string
          description?: string | null
          id?: string
          low_stock_threshold?: number | null
          name: string
          selling_price?: number
          sku?: string | null
          status?: string
          track_inventory?: boolean
          unit?: string
          updated_at?: string
        }
        Update: {
          barcode?: string | null
          business_id?: string
          category?: string | null
          cost_price?: number
          created_at?: string
          created_by?: string
          creation_key?: string
          currency_code?: string
          description?: string | null
          id?: string
          low_stock_threshold?: number | null
          name?: string
          selling_price?: number
          sku?: string | null
          status?: string
          track_inventory?: boolean
          unit?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "products_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      role_permissions: {
        Row: {
          permission_id: string
          role_id: string
        }
        Insert: {
          permission_id: string
          role_id: string
        }
        Update: {
          permission_id?: string
          role_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_permissions_permission_id_fkey"
            columns: ["permission_id"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_permissions_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
        ]
      }
      roles: {
        Row: {
          created_at: string
          description: string | null
          id: string
          name: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          name: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          name?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      consume_recovery_grant: { Args: { p_grant_id: string }; Returns: boolean }
      create_business: {
        Args: { p_name: string; p_slug: string }
        Returns: {
          created_at: string
          created_by: string
          id: string
          name: string
          slug: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "businesses"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_product: {
        Args: {
          p_barcode?: string
          p_business_id: string
          p_category?: string
          p_cost_price?: number
          p_creation_key: string
          p_currency_code?: string
          p_description?: string
          p_low_stock_threshold?: number
          p_name: string
          p_opening_location_id?: string
          p_opening_quantity?: number
          p_selling_price?: number
          p_sku?: string
          p_track_inventory?: boolean
          p_unit?: string
        }
        Returns: {
          barcode: string | null
          business_id: string
          category: string | null
          cost_price: number
          created_at: string
          created_by: string
          creation_key: string
          currency_code: string
          description: string | null
          id: string
          low_stock_threshold: number | null
          name: string
          selling_price: number
          sku: string | null
          status: string
          track_inventory: boolean
          unit: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "products"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      get_movement_unit_cost: { Args: { p_ledger_id: string }; Returns: Json }
      get_product_cost: { Args: { p_product_id: string }; Returns: Json }
      has_permission: {
        Args: { p_business_id: string; p_permission_key: string }
        Returns: boolean
      }
      issue_recovery_grant: {
        Args: { p_session_id: string; p_user_id: string }
        Returns: string
      }
      record_inventory_movement: {
        Args: {
          p_business_id: string
          p_idempotency_key: string
          p_inventory_location_id: string
          p_movement_type: string
          p_note?: string
          p_product_id: string
          p_quantity: number
          p_reason?: string
          p_reference_id?: string
          p_reference_type?: string
          p_unit_cost?: number
        }
        Returns: {
          balance_after: number
          business_id: string
          created_at: string
          created_by: string
          id: string
          idempotency_key: string
          inventory_location_id: string
          movement_type: string
          note: string | null
          product_id: string
          quantity_delta: number
          reason: string
          reference_id: string | null
          reference_type: string | null
          unit_cost: number | null
        }
        SetofOptions: {
          from: "*"
          to: "inventory_ledger"
          isOneToOne: true
          isSetofReturn: false
        }
      }
    }
    Enums: {
      [_ in never]: never
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
    Enums: {},
  },
} as const
