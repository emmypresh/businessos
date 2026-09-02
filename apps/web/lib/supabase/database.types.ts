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
      audit_events: {
        Row: {
          action: string
          actor_email_snapshot: string | null
          actor_name_snapshot: string | null
          actor_type: string
          actor_user_id: string | null
          branch_id: string | null
          business_id: string
          category: string
          created_at: string
          id: string
          metadata: Json
          outcome: string
          resource_id: string | null
          resource_label_snapshot: string | null
          resource_type: string | null
        }
        Insert: {
          action: string
          actor_email_snapshot?: string | null
          actor_name_snapshot?: string | null
          actor_type: string
          actor_user_id?: string | null
          branch_id?: string | null
          business_id: string
          category: string
          created_at?: string
          id?: string
          metadata?: Json
          outcome?: string
          resource_id?: string | null
          resource_label_snapshot?: string | null
          resource_type?: string | null
        }
        Update: {
          action?: string
          actor_email_snapshot?: string | null
          actor_name_snapshot?: string | null
          actor_type?: string
          actor_user_id?: string | null
          branch_id?: string | null
          business_id?: string
          category?: string
          created_at?: string
          id?: string
          metadata?: Json
          outcome?: string
          resource_id?: string | null
          resource_label_snapshot?: string | null
          resource_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_events_branch_id_business_id_fkey"
            columns: ["branch_id", "business_id"]
            isOneToOne: false
            referencedRelation: "business_branches"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "audit_events_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      business_branches: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          business_id: string
          city: string | null
          code: string | null
          country_code: string
          created_at: string
          created_by: string
          id: string
          is_default: boolean
          name: string
          phone: string | null
          state: string | null
          status: string
          updated_at: string
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          business_id: string
          city?: string | null
          code?: string | null
          country_code?: string
          created_at?: string
          created_by: string
          id?: string
          is_default?: boolean
          name: string
          phone?: string | null
          state?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          business_id?: string
          city?: string | null
          code?: string | null
          country_code?: string
          created_at?: string
          created_by?: string
          id?: string
          is_default?: boolean
          name?: string
          phone?: string | null
          state?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_branches_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      business_invitation_branches: {
        Row: {
          branch_id: string
          business_id: string
          id: string
          invitation_id: string
          is_primary: boolean
        }
        Insert: {
          branch_id: string
          business_id: string
          id?: string
          invitation_id: string
          is_primary?: boolean
        }
        Update: {
          branch_id?: string
          business_id?: string
          id?: string
          invitation_id?: string
          is_primary?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "business_invitation_branches_branch_id_business_id_fkey"
            columns: ["branch_id", "business_id"]
            isOneToOne: false
            referencedRelation: "business_branches"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "business_invitation_branches_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_invitation_branches_invitation_id_business_id_fkey"
            columns: ["invitation_id", "business_id"]
            isOneToOne: false
            referencedRelation: "business_invitations"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
      business_invitations: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          business_id: string
          created_at: string
          creation_key: string
          email: string
          expires_at: string
          id: string
          invited_by: string
          revoked_at: string | null
          revoked_by: string | null
          role_id: string
          status: string
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          business_id: string
          created_at?: string
          creation_key: string
          email: string
          expires_at: string
          id?: string
          invited_by: string
          revoked_at?: string | null
          revoked_by?: string | null
          role_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          business_id?: string
          created_at?: string
          creation_key?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string
          revoked_at?: string | null
          revoked_by?: string | null
          role_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_invitations_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_invitations_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
        ]
      }
      business_member_branches: {
        Row: {
          assigned_at: string
          assigned_by: string
          branch_id: string
          business_id: string
          id: string
          is_primary: boolean
          member_id: string
        }
        Insert: {
          assigned_at?: string
          assigned_by: string
          branch_id: string
          business_id: string
          id?: string
          is_primary?: boolean
          member_id: string
        }
        Update: {
          assigned_at?: string
          assigned_by?: string
          branch_id?: string
          business_id?: string
          id?: string
          is_primary?: boolean
          member_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_member_branches_branch_id_business_id_fkey"
            columns: ["branch_id", "business_id"]
            isOneToOne: false
            referencedRelation: "business_branches"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "business_member_branches_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_member_branches_member_id_business_id_fkey"
            columns: ["member_id", "business_id"]
            isOneToOne: false
            referencedRelation: "business_members"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
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
      customers: {
        Row: {
          address: string | null
          business_id: string
          created_at: string
          created_by: string
          email: string | null
          id: string
          name: string
          notes: string | null
          phone: string | null
          status: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          business_id: string
          created_at?: string
          created_by: string
          email?: string | null
          id?: string
          name: string
          notes?: string | null
          phone?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          business_id?: string
          created_at?: string
          created_by?: string
          email?: string | null
          id?: string
          name?: string
          notes?: string | null
          phone?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customers_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_categories: {
        Row: {
          business_id: string
          created_at: string
          created_by: string
          id: string
          name: string
          status: string
          updated_at: string
        }
        Insert: {
          business_id: string
          created_at?: string
          created_by?: string
          id?: string
          name: string
          status?: string
          updated_at?: string
        }
        Update: {
          business_id?: string
          created_at?: string
          created_by?: string
          id?: string
          name?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_categories_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      expenses: {
        Row: {
          amount: number
          branch_id: string | null
          branch_name_snapshot: string | null
          business_id: string
          category_id: string
          category_name_snapshot: string
          created_at: string
          created_by: string
          creation_key: string
          currency_code: string
          expense_number: string
          id: string
          incurred_at: string
          notes: string | null
          payee: string | null
          payment_method: string
          reference: string | null
          status: string
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          amount: number
          branch_id?: string | null
          branch_name_snapshot?: string | null
          business_id: string
          category_id: string
          category_name_snapshot: string
          created_at?: string
          created_by: string
          creation_key: string
          currency_code?: string
          expense_number: string
          id?: string
          incurred_at: string
          notes?: string | null
          payee?: string | null
          payment_method: string
          reference?: string | null
          status?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          amount?: number
          branch_id?: string | null
          branch_name_snapshot?: string | null
          business_id?: string
          category_id?: string
          category_name_snapshot?: string
          created_at?: string
          created_by?: string
          creation_key?: string
          currency_code?: string
          expense_number?: string
          id?: string
          incurred_at?: string
          notes?: string | null
          payee?: string | null
          payment_method?: string
          reference?: string | null
          status?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "expenses_branch_id_business_id_fkey"
            columns: ["branch_id", "business_id"]
            isOneToOne: false
            referencedRelation: "business_branches"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "expenses_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_category_id_business_id_fkey"
            columns: ["category_id", "business_id"]
            isOneToOne: false
            referencedRelation: "expense_categories"
            referencedColumns: ["id", "business_id"]
          },
        ]
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
          branch_id: string
          business_id: string
          created_at: string
          created_by: string
          id: string
          is_branch_default: boolean
          is_default: boolean
          name: string
          status: string
          updated_at: string
        }
        Insert: {
          branch_id: string
          business_id: string
          created_at?: string
          created_by: string
          id?: string
          is_branch_default?: boolean
          is_default?: boolean
          name: string
          status?: string
          updated_at?: string
        }
        Update: {
          branch_id?: string
          business_id?: string
          created_at?: string
          created_by?: string
          id?: string
          is_branch_default?: boolean
          is_default?: boolean
          name?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_locations_branch_id_business_id_fkey"
            columns: ["branch_id", "business_id"]
            isOneToOne: false
            referencedRelation: "business_branches"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "inventory_locations_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_items: {
        Row: {
          business_id: string
          created_at: string
          description: string
          id: string
          invoice_id: string
          line_total: number
          position: number
          product_id: string | null
          product_name_snapshot: string | null
          quantity: number
          sku_snapshot: string | null
          unit_price: number
        }
        Insert: {
          business_id: string
          created_at?: string
          description: string
          id?: string
          invoice_id: string
          line_total: number
          position: number
          product_id?: string | null
          product_name_snapshot?: string | null
          quantity: number
          sku_snapshot?: string | null
          unit_price: number
        }
        Update: {
          business_id?: string
          created_at?: string
          description?: string
          id?: string
          invoice_id?: string
          line_total?: number
          position?: number
          product_id?: string | null
          product_name_snapshot?: string | null
          quantity?: number
          sku_snapshot?: string | null
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_items_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_items_invoice_id_business_id_fkey"
            columns: ["invoice_id", "business_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "invoice_items_product_id_business_id_fkey"
            columns: ["product_id", "business_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
      invoice_payments: {
        Row: {
          amount: number
          branch_id: string
          business_id: string
          created_at: string
          creation_key: string
          id: string
          invoice_id: string
          note: string | null
          paid_at: string
          payment_method: string
          recorded_by: string
          reference: string | null
        }
        Insert: {
          amount: number
          branch_id: string
          business_id: string
          created_at?: string
          creation_key: string
          id?: string
          invoice_id: string
          note?: string | null
          paid_at?: string
          payment_method: string
          recorded_by: string
          reference?: string | null
        }
        Update: {
          amount?: number
          branch_id?: string
          business_id?: string
          created_at?: string
          creation_key?: string
          id?: string
          invoice_id?: string
          note?: string | null
          paid_at?: string
          payment_method?: string
          recorded_by?: string
          reference?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoice_payments_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_payments_invoice_id_business_id_branch_id_fkey"
            columns: ["invoice_id", "business_id", "branch_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id", "business_id", "branch_id"]
          },
          {
            foreignKeyName: "invoice_payments_invoice_id_business_id_fkey"
            columns: ["invoice_id", "business_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
      invoices: {
        Row: {
          amount_paid: number
          branch_id: string
          branch_name_snapshot: string
          business_id: string
          created_at: string
          created_by: string
          creation_key: string
          customer_email_snapshot: string | null
          customer_id: string
          customer_name_snapshot: string
          customer_phone_snapshot: string | null
          due_date: string | null
          id: string
          invoice_number: string
          issued_at: string
          notes: string | null
          status: string
          total_amount: number
          updated_at: string
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          amount_paid?: number
          branch_id: string
          branch_name_snapshot: string
          business_id: string
          created_at?: string
          created_by: string
          creation_key: string
          customer_email_snapshot?: string | null
          customer_id: string
          customer_name_snapshot: string
          customer_phone_snapshot?: string | null
          due_date?: string | null
          id?: string
          invoice_number: string
          issued_at?: string
          notes?: string | null
          status?: string
          total_amount: number
          updated_at?: string
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          amount_paid?: number
          branch_id?: string
          branch_name_snapshot?: string
          business_id?: string
          created_at?: string
          created_by?: string
          creation_key?: string
          customer_email_snapshot?: string | null
          customer_id?: string
          customer_name_snapshot?: string
          customer_phone_snapshot?: string | null
          due_date?: string | null
          id?: string
          invoice_number?: string
          issued_at?: string
          notes?: string | null
          status?: string
          total_amount?: number
          updated_at?: string
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_branch_id_business_id_fkey"
            columns: ["branch_id", "business_id"]
            isOneToOne: false
            referencedRelation: "business_branches"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "invoices_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_customer_id_business_id_fkey"
            columns: ["customer_id", "business_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id", "business_id"]
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
      sale_items: {
        Row: {
          business_id: string
          created_at: string
          id: string
          line_total: number
          product_id: string
          product_name_snapshot: string
          quantity: number
          sale_id: string
          sku_snapshot: string | null
          unit_cost_snapshot: number | null
          unit_price: number
        }
        Insert: {
          business_id: string
          created_at?: string
          id?: string
          line_total: number
          product_id: string
          product_name_snapshot: string
          quantity: number
          sale_id: string
          sku_snapshot?: string | null
          unit_cost_snapshot?: number | null
          unit_price: number
        }
        Update: {
          business_id?: string
          created_at?: string
          id?: string
          line_total?: number
          product_id?: string
          product_name_snapshot?: string
          quantity?: number
          sale_id?: string
          sku_snapshot?: string | null
          unit_cost_snapshot?: number | null
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "sale_items_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_items_product_id_business_id_fkey"
            columns: ["product_id", "business_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "sale_items_sale_id_business_id_fkey"
            columns: ["sale_id", "business_id"]
            isOneToOne: false
            referencedRelation: "sales"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
      sale_return_items: {
        Row: {
          business_id: string
          created_at: string
          id: string
          line_total: number
          position: number
          product_id: string
          product_name_snapshot: string
          quantity: number
          restock: boolean
          sale_item_id: string
          sale_return_id: string
          sku_snapshot: string | null
          unit_price_snapshot: number
        }
        Insert: {
          business_id: string
          created_at?: string
          id?: string
          line_total: number
          position: number
          product_id: string
          product_name_snapshot: string
          quantity: number
          restock: boolean
          sale_item_id: string
          sale_return_id: string
          sku_snapshot?: string | null
          unit_price_snapshot: number
        }
        Update: {
          business_id?: string
          created_at?: string
          id?: string
          line_total?: number
          position?: number
          product_id?: string
          product_name_snapshot?: string
          quantity?: number
          restock?: boolean
          sale_item_id?: string
          sale_return_id?: string
          sku_snapshot?: string | null
          unit_price_snapshot?: number
        }
        Relationships: [
          {
            foreignKeyName: "sale_return_items_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_return_items_product_id_business_id_fkey"
            columns: ["product_id", "business_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "sale_return_items_sale_item_id_business_id_fkey"
            columns: ["sale_item_id", "business_id"]
            isOneToOne: false
            referencedRelation: "sale_items"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "sale_return_items_sale_return_id_business_id_fkey"
            columns: ["sale_return_id", "business_id"]
            isOneToOne: false
            referencedRelation: "sale_returns"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
      sale_returns: {
        Row: {
          branch_id: string
          branch_name_snapshot: string
          business_id: string
          created_at: string
          created_by: string
          creation_key: string
          id: string
          notes: string | null
          reason: string | null
          refund_amount: number
          refund_method: string | null
          return_number: string
          sale_id: string
          status: string
        }
        Insert: {
          branch_id: string
          branch_name_snapshot: string
          business_id: string
          created_at?: string
          created_by: string
          creation_key: string
          id?: string
          notes?: string | null
          reason?: string | null
          refund_amount?: number
          refund_method?: string | null
          return_number: string
          sale_id: string
          status?: string
        }
        Update: {
          branch_id?: string
          branch_name_snapshot?: string
          business_id?: string
          created_at?: string
          created_by?: string
          creation_key?: string
          id?: string
          notes?: string | null
          reason?: string | null
          refund_amount?: number
          refund_method?: string | null
          return_number?: string
          sale_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "sale_returns_branch_id_business_id_fkey"
            columns: ["branch_id", "business_id"]
            isOneToOne: false
            referencedRelation: "business_branches"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "sale_returns_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_returns_sale_id_business_id_fkey"
            columns: ["sale_id", "business_id"]
            isOneToOne: false
            referencedRelation: "sales"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
      sales: {
        Row: {
          amount_paid: number
          branch_id: string
          branch_name_snapshot: string
          business_id: string
          cancelled_at: string | null
          completed_at: string | null
          created_at: string
          created_by: string
          creation_key: string
          currency_code: string
          customer_address_snapshot: string | null
          customer_email_snapshot: string | null
          customer_id: string | null
          customer_name_snapshot: string | null
          customer_phone_snapshot: string | null
          discount: number
          id: string
          inventory_location_id: string
          inventory_location_name_snapshot: string
          notes: string | null
          payment_method: string | null
          payment_status: string
          sale_number: string
          status: string
          subtotal: number
          total: number
          updated_at: string
        }
        Insert: {
          amount_paid?: number
          branch_id: string
          branch_name_snapshot: string
          business_id: string
          cancelled_at?: string | null
          completed_at?: string | null
          created_at?: string
          created_by: string
          creation_key: string
          currency_code?: string
          customer_address_snapshot?: string | null
          customer_email_snapshot?: string | null
          customer_id?: string | null
          customer_name_snapshot?: string | null
          customer_phone_snapshot?: string | null
          discount?: number
          id?: string
          inventory_location_id: string
          inventory_location_name_snapshot: string
          notes?: string | null
          payment_method?: string | null
          payment_status?: string
          sale_number: string
          status?: string
          subtotal?: number
          total?: number
          updated_at?: string
        }
        Update: {
          amount_paid?: number
          branch_id?: string
          branch_name_snapshot?: string
          business_id?: string
          cancelled_at?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string
          creation_key?: string
          currency_code?: string
          customer_address_snapshot?: string | null
          customer_email_snapshot?: string | null
          customer_id?: string | null
          customer_name_snapshot?: string | null
          customer_phone_snapshot?: string | null
          discount?: number
          id?: string
          inventory_location_id?: string
          inventory_location_name_snapshot?: string
          notes?: string | null
          payment_method?: string | null
          payment_status?: string
          sale_number?: string
          status?: string
          subtotal?: number
          total?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sales_branch_id_business_id_fkey"
            columns: ["branch_id", "business_id"]
            isOneToOne: false
            referencedRelation: "business_branches"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "sales_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_customer_id_business_id_fkey"
            columns: ["customer_id", "business_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "sales_inventory_location_id_business_id_fkey"
            columns: ["inventory_location_id", "business_id"]
            isOneToOne: false
            referencedRelation: "inventory_locations"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_business_invitation: {
        Args: { p_invitation_id: string }
        Returns: string
      }
      change_member_role: {
        Args: { p_business_id: string; p_member_id: string; p_role: string }
        Returns: string
      }
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
      create_business_branch: {
        Args: {
          p_address_line1?: string
          p_address_line2?: string
          p_business_id: string
          p_city?: string
          p_code?: string
          p_country_code?: string
          p_creation_key: string
          p_name: string
          p_phone?: string
          p_state?: string
        }
        Returns: string
      }
      create_business_invitation: {
        Args: {
          p_branch_ids?: Json
          p_business_id: string
          p_creation_key: string
          p_email: string
          p_primary_branch_id?: string
          p_role: string
        }
        Returns: string
      }
      create_customer: {
        Args: {
          p_address?: string
          p_business_id: string
          p_creation_key: string
          p_email?: string
          p_name: string
          p_notes?: string
          p_phone?: string
        }
        Returns: string
      }
      create_expense: {
        Args: {
          p_amount: number
          p_branch_id?: string
          p_business_id: string
          p_category_id: string
          p_creation_key: string
          p_incurred_at: string
          p_notes?: string
          p_payee?: string
          p_payment_method: string
          p_reference?: string
        }
        Returns: string
      }
      create_invoice: {
        Args: {
          p_branch_id: string
          p_business_id: string
          p_creation_key: string
          p_customer_id: string
          p_due_date?: string
          p_items: Json
          p_notes?: string
        }
        Returns: string
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
      create_sale: {
        Args: {
          p_amount_paid?: number
          p_branch_id?: string
          p_business_id: string
          p_creation_key: string
          p_customer_id?: string
          p_discount?: number
          p_items: Json
          p_notes?: string
          p_payment_method?: string
          p_payment_status?: string
        }
        Returns: string
      }
      create_sale_return: {
        Args: {
          p_business_id: string
          p_creation_key: string
          p_items: Json
          p_notes?: string
          p_reason?: string
          p_refund_amount?: number
          p_refund_method?: string
          p_sale_id: string
        }
        Returns: string
      }
      deactivate_business_branch: {
        Args: { p_branch_id: string; p_business_id: string }
        Returns: string
      }
      get_audit_branch_filter_options: {
        Args: { p_business_id: string }
        Returns: {
          code: string
          id: string
          name: string
          status: string
        }[]
      }
      get_business_branch_options: {
        Args: { p_business_id: string; p_scope: string }
        Returns: {
          code: string
          id: string
          is_default: boolean
          is_primary: boolean
          name: string
          status: string
        }[]
      }
      get_financial_summary: {
        Args: {
          p_branch_id?: string
          p_business_id: string
          p_from: string
          p_to: string
        }
        Returns: Json
      }
      get_invitation_branch_options: {
        Args: { p_business_id: string }
        Returns: {
          code: string
          id: string
          name: string
        }[]
      }
      get_invoice_branch_options: {
        Args: { p_business_id: string }
        Returns: {
          code: string
          id: string
          is_default: boolean
          is_primary: boolean
          name: string
        }[]
      }
      get_invoice_customer_options: {
        Args: { p_business_id: string; p_search?: string }
        Returns: {
          id: string
          name: string
        }[]
      }
      get_invoice_filter_branch_options: {
        Args: { p_business_id: string }
        Returns: {
          code: string
          id: string
          name: string
          status: string
        }[]
      }
      get_invoice_product_options: {
        Args: { p_business_id: string; p_search?: string }
        Returns: {
          id: string
          name: string
          selling_price: number
          sku: string
        }[]
      }
      get_invoice_void_eligibility: {
        Args: { p_business_id: string; p_invoice_id: string }
        Returns: boolean
      }
      get_movement_unit_cost: { Args: { p_ledger_id: string }; Returns: Json }
      get_payable_invoice_options: {
        Args: { p_business_id: string; p_search?: string }
        Returns: {
          amount_paid: number
          branch_name_snapshot: string
          customer_name_snapshot: string
          id: string
          invoice_number: string
          status: string
          total_amount: number
        }[]
      }
      get_product_cost: { Args: { p_product_id: string }; Returns: Json }
      get_returnable_sale_items: {
        Args: { p_business_id: string; p_sale_id: string }
        Returns: {
          already_returned: number
          product_name_snapshot: string
          quantity: number
          sale_item_id: string
          sku_snapshot: string
          unit_price: number
        }[]
      }
      get_returnable_sale_options: {
        Args: { p_business_id: string; p_search?: string }
        Returns: {
          amount_paid: number
          branch_name_snapshot: string
          completed_at: string
          customer_name_snapshot: string
          id: string
          sale_number: string
          total: number
        }[]
      }
      get_returns_branch_filter_options: {
        Args: { p_business_id: string }
        Returns: {
          code: string
          id: string
          name: string
          status: string
        }[]
      }
      has_branch_access: {
        Args: { p_branch_id: string; p_business_id: string }
        Returns: boolean
      }
      has_permission: {
        Args: { p_business_id: string; p_permission_key: string }
        Returns: boolean
      }
      issue_recovery_grant: {
        Args: { p_session_id: string; p_user_id: string }
        Returns: string
      }
      list_invoice_payments_for_viewer: {
        Args: { p_business_id: string; p_search?: string }
        Returns: {
          amount: number
          branch_name_snapshot: string
          customer_name_snapshot: string
          id: string
          invoice_number: string
          paid_at: string
          payment_method: string
          reference: string
        }[]
      }
      list_returns_for_viewer: {
        Args: {
          p_branch_id?: string
          p_business_id: string
          p_cursor_created_at?: string
          p_cursor_id?: string
          p_limit?: number
          p_reason?: string
          p_search?: string
        }
        Returns: {
          branch_name_snapshot: string
          created_at: string
          id: string
          reason: string
          refund_amount: number
          refund_method: string
          return_number: string
          sale_id: string
          sale_number: string
          status: string
        }[]
      }
      reactivate_business_branch: {
        Args: { p_branch_id: string; p_business_id: string }
        Returns: string
      }
      reactivate_member: {
        Args: { p_business_id: string; p_member_id: string }
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
      record_invoice_payment: {
        Args: {
          p_amount: number
          p_business_id: string
          p_creation_key: string
          p_invoice_id: string
          p_note?: string
          p_paid_at: string
          p_payment_method: string
          p_reference?: string
        }
        Returns: string
      }
      replace_member_branches: {
        Args: {
          p_branch_ids: Json
          p_business_id: string
          p_member_id: string
          p_primary_branch_id?: string
        }
        Returns: string
      }
      revoke_business_invitation: {
        Args: { p_business_id: string; p_invitation_id: string }
        Returns: string
      }
      set_default_business_branch: {
        Args: { p_branch_id: string; p_business_id: string }
        Returns: string
      }
      suspend_member: {
        Args: { p_business_id: string; p_member_id: string }
        Returns: string
      }
      update_business_branch: {
        Args: {
          p_address_line1?: string
          p_address_line2?: string
          p_branch_id: string
          p_business_id: string
          p_city?: string
          p_code?: string
          p_country_code?: string
          p_name: string
          p_phone?: string
          p_state?: string
        }
        Returns: string
      }
      void_expense: {
        Args: { p_business_id: string; p_expense_id: string; p_reason: string }
        Returns: string
      }
      void_invoice: {
        Args: { p_business_id: string; p_invoice_id: string }
        Returns: string
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
