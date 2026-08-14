import { pgTable, serial, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Per-user identity layer (Phase 1 of per-user isolation refactor).
// `passwordHash` is scrypt-hashed; never stores plain-text. `role` is the
// product-level role (USER vs ADMIN); the existing security_user_roles table
// is still used for the OWNER/ADMIN/TESTER/VIEWER permission matrix and is
// independent. lastLoginAt is updated on every successful /auth/login.
export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash"), // nullable: legacy rows + owner bootstrap
  role: text("role").notNull().default("USER"), // USER | ADMIN
  // Marks rows created by seed/QA/bridge-test scripts. Hidden from the
  // Admin User Control Center default views; only visible to admins who
  // explicitly toggle "Show test/system users". Never used as an auth
  // gate — just a UI filter.
  isSystemUser: boolean("is_system_user").notNull().default(false),
  lastLoginAt: timestamp("last_login_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;

// Public view of a user — never includes passwordHash. Use this for any
// response body. Server code should map User → PublicUser before serializing.
export type PublicUser = Omit<User, "passwordHash">;
export function toPublicUser(u: User): PublicUser {
  const { passwordHash: _ph, ...rest } = u;
  return rest;
}
