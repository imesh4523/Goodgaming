import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, boolean, decimal, bigint, jsonb, pgEnum, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Enums for better type safety
export const userRoleEnum = pgEnum("user_role", ["user", "admin", "agent"]);
export const vipLevelEnum = pgEnum("vip_level", ["lv1", "lv2", "vip", "vip1", "vip2", "vip3", "vip4", "vip5", "vip6", "vip7"]);
export const gameTypeEnum = pgEnum("game_type", ["color", "crash"]);
export const gameStatusEnum = pgEnum("game_status", ["active", "completed", "cancelled"]);
export const betTypeEnum = pgEnum("bet_type", ["color", "number", "size", "crash"]);
export const betStatusEnum = pgEnum("bet_status", ["pending", "won", "lost", "cashed_out", "cancelled"]);
export const transactionTypeEnum = pgEnum("transaction_type", ["deposit", "withdrawal", "referral_bonus", "agent_commission", "commission_withdrawal"]);
export const transactionStatusEnum = pgEnum("transaction_status", ["pending", "completed", "failed", "cancelled"]);
export const withdrawalRequestStatusEnum = pgEnum("withdrawal_request_status", ["pending", "approved", "rejected", "processing", "completed"]);
export const paymentMethodEnum = pgEnum("payment_method", ["crypto", "bank_transfer", "agent", "internal"]);
export const referralStatusEnum = pgEnum("referral_status", ["active", "inactive"]);
export const databaseTypeEnum = pgEnum("database_type", ["postgresql", "mysql", "mongodb"]);
export const databaseStatusEnum = pgEnum("database_status", ["active", "inactive", "testing"]);

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  publicId: varchar("public_id").unique(), // Random numeric ID like 02826262818 for user display
  email: text("email").notNull().unique(), // Made email required
  passwordHash: text("password_hash").notNull(), // Hashed password for security
  withdrawalPasswordHash: text("withdrawal_password_hash"), // Withdrawal password for security
  profilePhoto: text("profile_photo"), // Base64 encoded profile photo or file path
  balance: decimal("balance", { precision: 18, scale: 8 }).notNull().default("0.00000000"), // Support crypto precision
  role: userRoleEnum("role").notNull().default("user"),
  vipLevel: vipLevelEnum("vip_level").notNull().default("lv1"), // VIP level based on team size
  isActive: boolean("is_active").notNull().default(true),
  referralCode: text("referral_code").unique(),
  referredBy: varchar("referred_by"), // FK to users
  referralLevel: integer("referral_level").notNull().default(1), // Level in referral tree (1=direct, 2=second level, etc.)
  totalDeposits: decimal("total_deposits", { precision: 18, scale: 8 }).notNull().default("0.00000000"),
  totalWithdrawals: decimal("total_withdrawals", { precision: 18, scale: 8 }).notNull().default("0.00000000"),
  totalWinnings: decimal("total_winnings", { precision: 18, scale: 8 }).notNull().default("0.00000000"),
  totalLosses: decimal("total_losses", { precision: 18, scale: 8 }).notNull().default("0.00000000"),
  totalCommission: decimal("total_commission", { precision: 18, scale: 8 }).notNull().default("0.00000000"), // Commission earned from betting and referrals
  lifetimeCommissionEarned: decimal("lifetime_commission_earned", { precision: 18, scale: 8 }).notNull().default("0.00000000"), // Lifetime total commission earned (never decreases)
  totalBetsAmount: decimal("total_bets_amount", { precision: 18, scale: 8 }).notNull().default("0.00000000"), // Total amount wagered
  dailyWagerAmount: decimal("daily_wager_amount", { precision: 18, scale: 8 }).notNull().default("0.00000000"), // Today's wager amount
  lastWagerResetDate: timestamp("last_wager_reset_date").default(sql`CURRENT_TIMESTAMP`), // Track daily reset
  remainingRequiredBetAmount: decimal("remaining_required_bet_amount", { precision: 18, scale: 8 }).notNull().default("0.00000000"), // Remaining bet amount required from deposits (60% per deposit)
  teamSize: integer("team_size").notNull().default(0), // Qualified referrals with $10+ deposit (for VIP level)
  totalTeamMembers: integer("total_team_members").notNull().default(0), // All referrals (including those without deposits)
  registrationIp: text("registration_ip"), // Store IP address when user registers
  registrationCountry: text("registration_country"), // Store country code when user registers (from Cloudflare)
  lastLoginIp: text("last_login_ip"), // Store last login IP
  maxBetLimit: decimal("max_bet_limit", { precision: 18, scale: 8 }).notNull().default("999999.00000000"), // VIP level adjustable bet limit
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false), // 2FA status
  twoFactorSecret: text("two_factor_secret"), // TOTP secret for 2FA
  isBanned: boolean("is_banned").notNull().default(false), // Whether user is banned
  bannedUntil: timestamp("banned_until"), // Temporary ban expiry (null = permanent ban if isBanned is true)
  banReason: text("ban_reason"), // Reason for the ban
  enableAnimations: boolean("enable_animations").notNull().default(true), // User preference for 3D animations and effects
  wingoMode: boolean("wingo_mode").notNull().default(false), // Focus mode - shows only Win Go game interface
  lastWithdrawalRequestAt: timestamp("last_withdrawal_request_at"), // Track last withdrawal request time for cooldown period
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const games = pgTable("games", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  gameId: text("game_id").notNull().unique(),
  gameType: gameTypeEnum("game_type").notNull().default("color"), // 'color' or 'crash'
  roundDuration: integer("round_duration").notNull(), // in minutes
  startTime: timestamp("start_time").notNull(),
  endTime: timestamp("end_time").notNull(),
  status: gameStatusEnum("status").notNull().default("active"),
  result: integer("result"), // winning number 0-9
  resultColor: text("result_color"), // 'green', 'red', 'violet'
  resultSize: text("result_size"), // 'big', 'small'
  // Crash game specific fields
  crashPoint: decimal("crash_point", { precision: 10, scale: 2 }), // The multiplier when crash happens (e.g., 2.34)
  currentMultiplier: decimal("current_multiplier", { precision: 10, scale: 2 }).default("1.00"), // Current multiplier for active crash games
  crashedAt: timestamp("crashed_at"), // When the crash happened
  isManuallyControlled: boolean("is_manually_controlled").notNull().default(false),
  manualResult: integer("manual_result"), // admin set result (0-9)
  totalBetsAmount: decimal("total_bets_amount", { precision: 18, scale: 8 }).notNull().default("0.00000000"),
  totalPayouts: decimal("total_payouts", { precision: 18, scale: 8 }).notNull().default("0.00000000"),
  houseProfit: decimal("house_profit", { precision: 18, scale: 8 }).notNull().default("0.00000000"),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  statusIdx: index("games_status_idx").on(table.status),
}));

export const bets = pgTable("bets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(), // FK to users
  gameId: varchar("game_id").notNull(), // FK to games
  betType: betTypeEnum("bet_type").notNull(),
  betValue: text("bet_value").notNull(), // 'green', 'red', 'violet', '0-9', 'big', 'small', 'crash'
  amount: decimal("amount", { precision: 18, scale: 8 }).notNull(),
  potential: decimal("potential", { precision: 18, scale: 8 }).notNull(),
  actualPayout: decimal("actual_payout", { precision: 18, scale: 8 }), // Actual payout after fees (null for lost/pending bets)
  status: betStatusEnum("status").notNull().default("pending"),
  // Crash game specific fields
  cashOutMultiplier: decimal("cash_out_multiplier", { precision: 10, scale: 2 }), // Multiplier when player cashed out
  autoCashOut: decimal("auto_cash_out", { precision: 10, scale: 2 }), // Auto cash out at this multiplier
  cashedOutAt: timestamp("cashed_out_at"), // When the bet was cashed out
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  userIdIdx: index("bets_user_id_idx").on(table.userId),
  gameIdIdx: index("bets_game_id_idx").on(table.gameId),
  statusIdx: index("bets_status_idx").on(table.status),
}));

// Referral system table with proper constraints
export const referrals = pgTable("referrals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  referrerId: varchar("referrer_id").notNull(), // FK to users
  referredId: varchar("referred_id").notNull().unique(), // FK to users, unique to prevent multiple referrers
  referralLevel: integer("referral_level").notNull().default(1), // Level in referrer's team (1=direct, 2=indirect, etc.)
  commissionRate: decimal("commission_rate", { precision: 5, scale: 4 }).notNull().default("0.0600"), // 6% default
  totalCommission: decimal("total_commission", { precision: 18, scale: 8 }).notNull().default("0.00000000"),
  hasDeposited: boolean("has_deposited").notNull().default(false), // Track if referred user made deposit
  status: referralStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  referrerIdIdx: index("referrals_referrer_id_idx").on(table.referrerId),
}));

// Payment transactions table with crypto precision support
export const transactions = pgTable("transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(), // FK to users
  agentId: varchar("agent_id"), // FK to users with role='agent' - for agent-processed transactions
  type: transactionTypeEnum("type").notNull(),
  // Separate amounts for different currencies
  fiatAmount: decimal("fiat_amount", { precision: 18, scale: 2 }), // For USD, EUR, etc.
  cryptoAmount: decimal("crypto_amount", { precision: 36, scale: 18 }), // For crypto with full precision
  fiatCurrency: text("fiat_currency").default("USD"), // USD, EUR, etc.
  cryptoCurrency: text("crypto_currency"), // BTC, ETH, USDT, etc.
  status: transactionStatusEnum("status").notNull().default("pending"),
  paymentMethod: paymentMethodEnum("payment_method").notNull(),
  externalId: text("external_id"), // NOWPayments payment ID
  paymentAddress: text("payment_address"), // Crypto address
  txHash: text("tx_hash"), // Blockchain transaction hash
  fee: decimal("fee", { precision: 18, scale: 8 }).notNull().default("0.00000000"),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  userIdIdx: index("transactions_user_id_idx").on(table.userId),
  externalIdIdx: index("transactions_external_id_idx").on(table.externalId),
  statusIdx: index("transactions_status_idx").on(table.status),
}));

// Admin actions audit log
export const adminActions = pgTable("admin_actions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  adminId: varchar("admin_id").notNull(), // FK to users
  action: text("action").notNull(), // 'manual_game_result', 'user_edit', 'balance_adjustment'
  targetId: varchar("target_id"), // ID of affected entity (user, game, etc.)
  details: jsonb("details").notNull(), // Structured JSON data for action details
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  adminIdIdx: index("admin_actions_admin_id_idx").on(table.adminId),
}));

// Game analytics table
export const gameAnalytics = pgTable("game_analytics", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  gameId: varchar("game_id").notNull().unique(), // FK to games, one analytics per game
  totalPlayers: integer("total_players").notNull().default(0),
  totalBets: integer("total_bets").notNull().default(0),
  totalVolume: decimal("total_volume", { precision: 18, scale: 8 }).notNull().default("0.00000000"),
  houseEdge: decimal("house_edge", { precision: 5, scale: 4 }).notNull().default("0.0500"),
  actualProfit: decimal("actual_profit", { precision: 18, scale: 8 }).notNull().default("0.00000000"),
  expectedProfit: decimal("expected_profit", { precision: 18, scale: 8 }).notNull().default("0.00000000"),
  profitMargin: decimal("profit_margin", { precision: 5, scale: 4 }).notNull().default("0.0000"),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// IP tracking and user analytics table
export const userSessions = pgTable("user_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(), // FK to users
  ipAddress: text("ip_address").notNull(),
  userAgent: text("user_agent"),
  browserName: text("browser_name"), // Parsed browser name
  browserVersion: text("browser_version"), // Parsed browser version
  deviceType: text("device_type"), // mobile, desktop, tablet
  deviceModel: text("device_model"), // Parsed device model (e.g., "iPhone 15 Pro", "Samsung Galaxy S24")
  operatingSystem: text("operating_system"), // Parsed OS name
  loginTime: timestamp("login_time").notNull().default(sql`CURRENT_TIMESTAMP`),
  logoutTime: timestamp("logout_time"),
  isActive: boolean("is_active").notNull().default(true),
}, (table) => ({
  userIdIdx: index("user_sessions_user_id_idx").on(table.userId),
}));

// Page views tracking table for traffic analytics
export const pageViews = pgTable("page_views", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id"), // FK to users (null for anonymous visitors)
  path: text("path").notNull(), // Page path (e.g., "/", "/game", "/profile")
  ipAddress: text("ip_address").notNull(),
  country: text("country"), // Country code from Cloudflare (e.g., "US", "LK", "IN")
  userAgent: text("user_agent"),
  browserName: text("browser_name"),
  deviceType: text("device_type"), // mobile, desktop, tablet
  deviceModel: text("device_model"), // Parsed device model (e.g., "iPhone 15 Pro", "Samsung Galaxy S24")
  operatingSystem: text("operating_system"),
  referrer: text("referrer"), // Where the visitor came from
  sessionId: text("session_id"), // Track unique sessions
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  userIdIdx: index("page_views_user_id_idx").on(table.userId),
  pathIdx: index("page_views_path_idx").on(table.path),
  createdAtIdx: index("page_views_created_at_idx").on(table.createdAt),
}));

// Password reset tokens table
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull(),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  used: boolean("used").notNull().default(false),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// System settings table for admin-configurable settings
export const systemSettings = pgTable("system_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  key: text("key").notNull().unique(), // Setting name (e.g., 'nowpayments_api_key')
  value: text("value").notNull(), // Setting value (encrypted for sensitive data)
  description: text("description"), // Optional description
  isEncrypted: boolean("is_encrypted").notNull().default(false), // Whether the value is encrypted
  lastUpdatedBy: varchar("last_updated_by").notNull(), // Admin user ID who last updated
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Database connections table for multi-database management
export const databaseConnections = pgTable("database_connections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(), // User-friendly name (e.g., 'Digital Ocean Backup', 'AWS Production')
  databaseType: databaseTypeEnum("database_type").notNull(), // postgresql, mysql, mongodb
  host: text("host").notNull(), // Database host (e.g., 'db.example.com')
  port: integer("port").notNull(), // Database port (e.g., 5432, 3306)
  database: text("database").notNull(), // Database name
  username: text("username").notNull(), // Database username
  password: text("password").notNull(), // Database password (encrypted)
  ssl: boolean("ssl").notNull().default(true), // Use SSL connection
  status: databaseStatusEnum("status").notNull().default("inactive"), // active, inactive, testing
  isActive: boolean("is_active").notNull().default(false), // Currently active database
  isPrimary: boolean("is_primary").notNull().default(false), // Primary database for the application
  lastSyncAt: timestamp("last_sync_at"), // Last time data was synced to this database
  lastTestAt: timestamp("last_test_at"), // Last time connection was tested
  connectionStatus: text("connection_status"), // Result of last connection test
  createdBy: varchar("created_by").notNull(), // Admin user ID who created this connection
  updatedBy: varchar("updated_by"), // Admin user ID who last updated
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Withdrawal requests table
export const withdrawalRequests = pgTable("withdrawal_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(), // FK to users
  amount: decimal("amount", { precision: 18, scale: 8 }).notNull(),
  currency: text("currency").notNull().default("USD"),
  walletAddress: text("wallet_address").notNull(),
  status: withdrawalRequestStatusEnum("status").notNull().default("pending"),
  adminNote: text("admin_note"), // Admin can add notes
  requiredBetAmount: decimal("required_bet_amount", { precision: 18, scale: 8 }).notNull(), // 60% of deposits
  currentBetAmount: decimal("current_bet_amount", { precision: 18, scale: 8 }).notNull(), // User's current betting
  eligible: boolean("eligible").notNull().default(false), // Auto-calculated eligibility
  duplicateIpCount: integer("duplicate_ip_count").notNull().default(0), // Number of accounts from same registration IP
  duplicateIpUserIds: text("duplicate_ip_user_ids").array(), // User IDs with same registration IP
  commissionAmount: decimal("commission_amount", { precision: 18, scale: 8 }).notNull().default("0.00000000"), // Amount from referral/commission earnings
  winningsAmount: decimal("winnings_amount", { precision: 18, scale: 8 }).notNull().default("0.00000000"), // Amount from bet winnings
  balanceFrozen: boolean("balance_frozen").notNull().default(false), // Track if balance was deducted when request was created
  processedAt: timestamp("processed_at"),
  processedBy: varchar("processed_by"), // Admin user ID
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  userIdIdx: index("withdrawal_requests_user_id_idx").on(table.userId),
  statusIdx: index("withdrawal_requests_status_idx").on(table.status),
}));

// Agent profiles table - extends users with role='agent'
export const agentProfiles = pgTable("agent_profiles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().unique(), // FK to users with role='agent'
  commissionRate: decimal("commission_rate", { precision: 5, scale: 4 }).notNull().default("0.0500"), // 5% default commission
  earningsBalance: decimal("earnings_balance", { precision: 18, scale: 8 }).notNull().default("0.00000000"), // Agent's commission earnings
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Agent activities audit table
export const agentActivities = pgTable("agent_activities", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(), // FK to users with role='agent'
  action: text("action").notNull(), // 'deposit', 'withdrawal', 'commission_award'
  targetUserId: varchar("target_user_id"), // FK to users - who was affected by the action
  amount: decimal("amount", { precision: 18, scale: 8 }).notNull(), // Transaction amount
  commissionAmount: decimal("commission_amount", { precision: 18, scale: 8 }).notNull().default("0.00000000"), // Commission earned
  transactionId: varchar("transaction_id"), // FK to transactions
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  agentIdIdx: index("agent_activities_agent_id_idx").on(table.agentId),
}));

// Passkeys table for WebAuthn credentials (for withdrawal security)
export const passkeys = pgTable("passkeys", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(), // FK to users
  credentialId: text("credential_id").notNull().unique(), // Base64URL encoded credential ID from WebAuthn
  publicKey: text("public_key").notNull(), // Base64URL encoded public key from WebAuthn
  counter: bigint("counter", { mode: "number" }).notNull().default(0), // Signature counter for replay attack prevention
  deviceName: text("device_name").notNull(), // User-friendly name for the device (e.g., "iPhone", "Touch ID", "YubiKey")
  isActive: boolean("is_active").notNull().default(true), // Allow users to disable specific passkeys
  lastUsedAt: timestamp("last_used_at"), // Track when the passkey was last used
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Notifications table for admin-to-user messaging
export const notifications = pgTable("notifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id"), // FK to users - null means notification to all users
  title: text("title").notNull(),
  message: text("message").notNull(),
  type: text("type").notNull().default("info"), // info, success, warning, error
  imageUrl: text("image_url"), // Optional image for rich notifications
  isRead: boolean("is_read").notNull().default(false),
  sentBy: varchar("sent_by").notNull(), // FK to admin user
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  userIdIdx: index("notifications_user_id_idx").on(table.userId),
  isReadIdx: index("notifications_is_read_idx").on(table.isRead),
}));

// Push subscriptions table for PWA push notifications
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(), // FK to users
  endpoint: text("endpoint").notNull().unique(),
  p256dhKey: text("p256dh_key").notNull(), // Client public key for encryption
  authKey: text("auth_key").notNull(), // Authentication secret
  userAgent: text("user_agent"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  userIdIdx: index("push_subscriptions_user_id_idx").on(table.userId),
  endpointIdx: index("push_subscriptions_endpoint_idx").on(table.endpoint),
}));

// Promo codes table for promotional giveaways
export const promoCodes = pgTable("promo_codes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  code: text("code").notNull().unique(), // The actual promo code
  totalValue: decimal("total_value", { precision: 18, scale: 8 }).notNull(), // Total value of the code (e.g., 100 coins)
  minValue: decimal("min_value", { precision: 18, scale: 8 }).notNull(), // Minimum random value users can get
  maxValue: decimal("max_value", { precision: 18, scale: 8 }).notNull(), // Maximum random value users can get
  usageLimit: integer("usage_limit"), // null = unlimited, otherwise max number of redemptions
  usedCount: integer("used_count").notNull().default(0), // Number of times redeemed
  isActive: boolean("is_active").notNull().default(true), // Whether code can be redeemed
  requireDeposit: boolean("require_deposit").notNull().default(false), // Only users who deposited can redeem
  vipLevelUpgrade: vipLevelEnum("vip_level_upgrade"), // VIP level to upgrade user to (null = no upgrade)
  expiresAt: timestamp("expires_at"), // null = never expires
  createdBy: varchar("created_by").notNull(), // FK to admin user
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  codeIdx: index("promo_codes_code_idx").on(table.code),
  isActiveIdx: index("promo_codes_is_active_idx").on(table.isActive),
}));

// Promo code redemptions tracking
export const promoCodeRedemptions = pgTable("promo_code_redemptions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  promoCodeId: varchar("promo_code_id").notNull(), // FK to promoCodes
  userId: varchar("user_id").notNull(), // FK to users
  code: text("code").notNull(), // Store code for reference
  amountAwarded: decimal("amount_awarded", { precision: 18, scale: 8 }).notNull(), // Actual amount user received (random between min-max)
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  promoCodeIdIdx: index("promo_code_redemptions_promo_code_id_idx").on(table.promoCodeId),
  userIdIdx: index("promo_code_redemptions_user_id_idx").on(table.userId),
  // Unique constraint to prevent same user from redeeming same code multiple times
  userCodeIdx: index("promo_code_redemptions_user_code_idx").on(table.userId, table.code),
}));

// VIP Level Telegram Links table for level-based telegram group/channel links
export const vipLevelTelegramLinks = pgTable("vip_level_telegram_links", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  vipLevel: vipLevelEnum("vip_level").notNull().unique(), // VIP level (lv1, lv2, vip, vip1, etc.)
  telegramLink: text("telegram_link").notNull(), // Telegram group or channel link
  description: text("description"), // Optional description for the link
  isActive: boolean("is_active").notNull().default(true), // Whether the link is active
  updatedBy: varchar("updated_by").notNull(), // FK to admin user who last updated
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  vipLevelIdx: index("vip_level_telegram_links_vip_level_idx").on(table.vipLevel),
}));

// Schema definitions for form validation with proper constraints
export const insertUserSchema = z.object({
  email: z.string().email("Invalid email format"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  confirmPassword: z.string(),
  withdrawalPassword: z.string().min(6, "Withdrawal password must be at least 6 characters"),
  acceptedTerms: z.boolean().refine((val) => val === true, {
    message: "You must accept the terms and conditions"
  }),
  referralCode: z.string().optional(), // Support referral signup
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

export const loginSchema = z.object({
  email: z.string().email("Invalid email format"),
  password: z.string().min(1, "Password is required"),
});

export const resetPasswordSchema = z.object({
  email: z.string().email("Invalid email format"),
});

export const resetPasswordConfirmSchema = z.object({
  token: z.string().min(1, "Reset token is required"),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
  confirmPassword: z.string(),
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z.string().min(8, "New password must be at least 8 characters"),
  confirmPassword: z.string(),
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

export const changeWithdrawalPasswordSchema = z.object({
  currentWithdrawalPassword: z.string().min(1, "Current withdrawal password is required"),
  newWithdrawalPassword: z.string().min(6, "New withdrawal password must be at least 6 characters"),
  confirmWithdrawalPassword: z.string(),
}).refine((data) => data.newWithdrawalPassword === data.confirmWithdrawalPassword, {
  message: "Withdrawal passwords don't match",
  path: ["confirmWithdrawalPassword"],
});

export const verifyWithdrawalPasswordSchema = z.object({
  withdrawalPassword: z.string().min(1, "Withdrawal password is required"),
});

export const setup2FASchema = z.object({
  userId: z.string().min(1, "User ID is required"),
});

export const verify2FASchema = z.object({
  userId: z.string().min(1, "User ID is required"),
  token: z.string().min(6, "Token must be 6 digits").max(6, "Token must be 6 digits"),
  secret: z.string().min(1, "Secret is required"),
});

export const validate2FASchema = z.object({
  userId: z.string().min(1, "User ID is required"),
  token: z.string().min(6, "Token must be 6 digits").max(6, "Token must be 6 digits"),
});

// Passkey/WebAuthn validation schemas
export const startPasskeyRegistrationSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
  deviceName: z.string().min(1, "Device name is required").max(50, "Device name too long"),
});

export const passkeyDeviceNameSchema = z.object({
  deviceName: z.string().min(1, "Device name is required").max(50, "Device name too long"),
});

export const finishPasskeyRegistrationSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
  credentialId: z.string().min(1, "Credential ID is required"),
  publicKey: z.string().min(1, "Public key is required"),
  deviceName: z.string().min(1, "Device name is required").max(50, "Device name too long"),
  counter: z.number().min(0, "Counter must be non-negative"),
});

export const startPasskeyAuthenticationSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
  purpose: z.enum(["withdrawal", "settings"], { message: "Invalid authentication purpose" }),
});

export const finishPasskeyAuthenticationSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
  credentialId: z.string().min(1, "Credential ID is required"),
  signature: z.string().min(1, "Signature is required"),
  authenticatorData: z.string().min(1, "Authenticator data is required"),
  clientDataJSON: z.string().min(1, "Client data JSON is required"),
  counter: z.number().min(0, "Counter must be non-negative"),
});

export const updatePasskeySchema = z.object({
  passkeyId: z.string().min(1, "Passkey ID is required"),
  deviceName: z.string().min(1, "Device name is required").max(50, "Device name too long").optional(),
  isActive: z.boolean().optional(),
});

export const insertPasskeySchema = createInsertSchema(passkeys).omit({
  id: true,
  lastUsedAt: true,
  createdAt: true,
  updatedAt: true,
});

export const insertNotificationSchema = createInsertSchema(notifications).omit({
  id: true,
  isRead: true,
  createdAt: true,
});

export const sendNotificationSchema = z.object({
  userId: z.string().optional(), // Optional - if not provided, sends to all users
  title: z.string().min(1, "Title is required").max(100, "Title too long"),
  message: z.string().min(1, "Message is required").max(500, "Message too long"),
  type: z.enum(["info", "success", "warning", "error"], {
    message: "Invalid notification type"
  }).default("info"),
  imageUrl: z.string().url("Invalid image URL").optional().or(z.literal("")),
});

export const markNotificationReadSchema = z.object({
  notificationId: z.string().min(1, "Notification ID is required"),
});

// Push subscription schemas
export const insertPushSubscriptionSchema = createInsertSchema(pushSubscriptions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const subscribeToPushSchema = z.object({
  endpoint: z.string().min(1, "Endpoint is required"),
  keys: z.object({
    p256dh: z.string().min(1, "p256dh key is required"),
    auth: z.string().min(1, "auth key is required"),
  }),
});

export const unsubscribeFromPushSchema = z.object({
  endpoint: z.string().min(1, "Endpoint is required"),
});

// Promo code schemas
export const insertPromoCodeSchema = createInsertSchema(promoCodes).omit({
  id: true,
  usedCount: true,
  createdAt: true,
  updatedAt: true,
});

export const createPromoCodeSchema = z.object({
  code: z.string().min(3, "Code must be at least 3 characters").max(20, "Code must be at most 20 characters").toUpperCase(),
  totalValue: z.string().refine((val) => {
    const num = parseFloat(val);
    return !isNaN(num) && isFinite(num) && num >= 0;
  }, {
    message: "Total value must be a valid number"
  }),
  minValue: z.string().refine((val) => {
    const num = parseFloat(val);
    return !isNaN(num) && isFinite(num) && num >= 0;
  }, {
    message: "Minimum value must be a valid number"
  }),
  maxValue: z.string().refine((val) => {
    const num = parseFloat(val);
    return !isNaN(num) && isFinite(num) && num >= 0;
  }, {
    message: "Maximum value must be a valid number"
  }),
  usageLimit: z.number().int().optional(),
  requireDeposit: z.boolean().default(false),
  vipLevelUpgrade: z.enum(["lv1", "lv2", "vip", "vip1", "vip2", "vip3", "vip4", "vip5", "vip6", "vip7"]).optional(),
  expiresAt: z.string().optional(), // ISO date string
}).refine((data) => {
  const min = parseFloat(data.minValue);
  const max = parseFloat(data.maxValue);
  return min <= max;
}, {
  message: "Minimum value cannot be greater than maximum value",
  path: ["minValue"],
}).refine((data) => {
  const max = parseFloat(data.maxValue);
  const total = parseFloat(data.totalValue);
  return max <= total;
}, {
  message: "Maximum value cannot be greater than total value",
  path: ["maxValue"],
});

export const redeemPromoCodeSchema = z.object({
  code: z.string().min(1, "Promo code is required"),
});

export const insertPromoCodeRedemptionSchema = createInsertSchema(promoCodeRedemptions).omit({
  id: true,
  createdAt: true,
});

export const insertVipLevelTelegramLinkSchema = createInsertSchema(vipLevelTelegramLinks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const upsertVipLevelTelegramLinkSchema = z.object({
  vipLevel: z.enum(["lv1", "lv2", "vip", "vip1", "vip2", "vip3", "vip4", "vip5", "vip6", "vip7"]),
  telegramLink: z.string().url("Invalid Telegram link").min(1, "Telegram link is required"),
  description: z.string().optional(),
  isActive: z.boolean().default(true),
});

export const insertGameSchema = createInsertSchema(games).omit({
  id: true,
  result: true,
  resultColor: true,
  resultSize: true,
  totalBetsAmount: true,
  totalPayouts: true,
  houseProfit: true,
  createdAt: true,
});

export const insertBetSchema = createInsertSchema(bets).omit({
  id: true,
  createdAt: true,
  status: true,
  potential: true,
  actualPayout: true,
});

// Crash game specific schemas
export const insertCrashGameSchema = createInsertSchema(games).omit({
  id: true,
  result: true,
  resultColor: true,
  resultSize: true,
  currentMultiplier: true,
  crashedAt: true,
  totalBetsAmount: true,
  totalPayouts: true,
  houseProfit: true,
  createdAt: true,
}).extend({
  gameType: z.literal("crash"),
  crashPoint: z.string().refine((val) => {
    const num = parseFloat(val);
    return !isNaN(num) && isFinite(num) && num >= 1.00 && num <= 100.00;
  }, {
    message: "Crash point must be between 1.00 and 100.00"
  }),
});

export const insertCrashBetSchema = createInsertSchema(bets).omit({
  id: true,
  createdAt: true,
  status: true,
  potential: true,
  cashOutMultiplier: true,
  cashedOutAt: true,
}).extend({
  betType: z.literal("crash"),
  betValue: z.literal("crash"),
  autoCashOut: z.string().optional().refine((val) => {
    if (!val) return true;
    const num = parseFloat(val);
    return !isNaN(num) && isFinite(num) && num >= 1.01 && num <= 1000.00;
  }, {
    message: "Auto cash out must be between 1.01 and 1000.00"
  }),
});

export const insertTransactionSchema = createInsertSchema(transactions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertReferralSchema = createInsertSchema(referrals).omit({
  id: true,
  totalCommission: true,
  createdAt: true,
});

export const insertAdminActionSchema = createInsertSchema(adminActions).omit({
  id: true,
  createdAt: true,
});

export const insertGameAnalyticsSchema = createInsertSchema(gameAnalytics).omit({
  id: true,
  createdAt: true,
});

export const insertUserSessionSchema = createInsertSchema(userSessions).omit({
  id: true,
  loginTime: true,
});

export const insertPageViewSchema = createInsertSchema(pageViews).omit({
  id: true,
  createdAt: true,
});

export const insertWithdrawalRequestSchema = createInsertSchema(withdrawalRequests).omit({
  id: true,
  status: true,
  processedAt: true,
  processedBy: true,
  createdAt: true,
  updatedAt: true,
});

export const insertSystemSettingSchema = createInsertSchema(systemSettings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertDatabaseConnectionSchema = createInsertSchema(databaseConnections).omit({
  id: true,
  lastSyncAt: true,
  lastTestAt: true,
  connectionStatus: true,
  createdAt: true,
  updatedAt: true,
});

export const insertAgentProfileSchema = createInsertSchema(agentProfiles).omit({
  id: true,
  earningsBalance: true,
  createdAt: true,
  updatedAt: true,
});

export const insertAgentActivitySchema = createInsertSchema(agentActivities).omit({
  id: true,
  createdAt: true,
});

export const updateSystemSettingSchema = z.object({
  key: z.string().min(1, "Setting key is required"),
  value: z.string().min(1, "Setting value is required"),
  description: z.string().optional(),
  isEncrypted: z.boolean().optional(),
});

export const createWithdrawalRequestSchema = z.object({
  amount: z.string().refine((val) => {
    const num = parseFloat(val);
    return !isNaN(num) && isFinite(num) && num >= 1200 && Number.isInteger(num);
  }, {
    message: "Amount must be at least 1200 coins and a whole number"
  }),
  currency: z.string().min(1, "Currency is required"),
  address: z.string().min(1, "Wallet address is required"),
  withdrawalPassword: z.string().min(1, "Withdrawal password is required"),
});

export const processWithdrawalRequestSchema = z.object({
  action: z.enum(["approve", "reject"]),
  adminNote: z.string().optional(),
});

// Admin API response types
export const adminDepositResponseSchema = z.object({
  deposits: z.array(z.object({
    id: z.string(),
    userId: z.string(),
    agentId: z.string().optional(),
    type: z.literal("deposit"),
    fiatAmount: z.string().optional(),
    cryptoAmount: z.string().optional(),
    fiatCurrency: z.string().optional(),
    cryptoCurrency: z.string().optional(),
    status: z.enum(["pending", "completed", "failed", "cancelled"]),
    paymentMethod: z.string(),
    externalId: z.string().optional(),
    paymentAddress: z.string().optional(),
    txHash: z.string().optional(),
    fee: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    userEmail: z.string().optional(),
    userPublicId: z.string().optional(),
  })),
  total: z.number(),
  page: z.number(),
  totalPages: z.number(),
});

export const adminWithdrawalResponseSchema = z.object({
  withdrawals: z.array(z.object({
    id: z.string(),
    userId: z.string(),
    agentId: z.string().optional(),
    type: z.literal("withdrawal"),
    fiatAmount: z.string().optional(),
    cryptoAmount: z.string().optional(),
    fiatCurrency: z.string().optional(),
    cryptoCurrency: z.string().optional(),
    status: z.enum(["pending", "completed", "failed", "cancelled"]),
    paymentMethod: z.string(),
    externalId: z.string().optional(),
    paymentAddress: z.string().optional(),
    txHash: z.string().optional(),
    fee: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    userEmail: z.string().optional(),
    userPublicId: z.string().optional(),
    userTotalDeposits: z.string().optional(),
    userTotalBets: z.string().optional(),
    userBetPercentage: z.number().optional(),
  })),
  total: z.number(),
  page: z.number(),
  totalPages: z.number(),
});

export type AdminDepositResponse = z.infer<typeof adminDepositResponseSchema>;
export type AdminWithdrawalResponse = z.infer<typeof adminWithdrawalResponseSchema>;

// Agent-specific schemas
export const createAgentSchema = z.object({
  email: z.string().email("Invalid email format"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  commissionRate: z.string().refine((val) => {
    const num = parseFloat(val);
    return !isNaN(num) && isFinite(num) && num >= 0 && num <= 1;
  }, {
    message: "Commission rate must be between 0 and 1"
  }).optional(),
});

export const agentDepositSchema = z.object({
  userIdentifier: z.string().min(1, "User identifier (public ID or email) is required"),
  amount: z.string().refine((val) => {
    const num = parseFloat(val);
    return !isNaN(num) && isFinite(num) && num >= 11;
  }, {
    message: "Minimum deposit amount is 11 USD"
  }),
});

export const agentWithdrawalSchema = z.object({
  userIdentifier: z.string().min(1, "User identifier (public ID or email) is required"),
  amount: z.string().refine((val) => {
    const num = parseFloat(val);
    return !isNaN(num) && isFinite(num) && num >= 12;
  }, {
    message: "Amount must be at least 12 USD (1200 coins)"
  }),
});

export const updateCommissionSchema = z.object({
  agentId: z.string().min(1, "Agent ID is required"),
  commissionRate: z.string().refine((val) => {
    const num = parseFloat(val);
    return !isNaN(num) && isFinite(num) && num >= 0 && num <= 1;
  }, {
    message: "Commission rate must be between 0 and 1"
  }),
});

export const agentSelfDepositSchema = z.object({
  amount: z.string().refine((val) => {
    const num = parseFloat(val);
    return !isNaN(num) && isFinite(num) && num >= 15;
  }, {
    message: "Amount must be a valid number with minimum 15 USD"
  }),
  currency: z.enum(["TRX", "USDTTRC20", "USDTMATIC"])
});

// VIP settings table for admin-configurable VIP levels
export const vipSettings = pgTable("vip_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  levelKey: text("level_key").notNull().unique(), // 'lv1', 'vip1', etc.
  levelName: text("level_name").notNull().unique(), // "Level 1", "VIP 1", etc.
  levelOrder: integer("level_order").notNull().unique(), // 0, 1, 2, etc. for ordering
  teamRequirement: integer("team_requirement").notNull().default(0), // Number of team members required
  maxBet: decimal("max_bet", { precision: 18, scale: 8 }).notNull().default("100000000.00000000"),
  dailyWagerReward: decimal("daily_wager_reward", { precision: 10, scale: 6 }).notNull().default("0.000000"), // Daily wager reward percentage
  commissionRates: text("commission_rates").notNull().default("[]"), // JSON array of commission rates
  rechargeAmount: decimal("recharge_amount", { precision: 18, scale: 8 }).notNull().default("1000.00000000"), // USDT amount (for reference)
  telegramLink: text("telegram_link"), // Telegram channel/group link for this VIP level
  supportEmail: text("support_email"), // Support email for this VIP level
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Golden Live player tracking tables
export const goldenLiveStats = pgTable("golden_live_stats", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  totalPlayers: integer("total_players").notNull().default(0),
  activePlayers: integer("active_players").notNull().default(0),
  lastHourlyIncrease: timestamp("last_hourly_increase").notNull().default(sql`CURRENT_TIMESTAMP`),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Golden Live events tracking for audit trail
export const goldenLiveEvents = pgTable("golden_live_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  eventType: text("event_type").notNull(), // 'hourly_increase', 'manual_adjustment', 'active_player_update'
  previousValue: integer("previous_value").notNull(),
  newValue: integer("new_value").notNull(),
  incrementAmount: integer("increment_amount").notNull().default(0),
  description: text("description"),
  createdAt: timestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// VIP settings insert schemas
export const insertVipSettingSchema = createInsertSchema(vipSettings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateVipSettingSchema = z.object({
  id: z.string().min(1, "VIP setting ID is required"),
  levelKey: z.string().optional(),
  levelName: z.string().optional(),
  levelOrder: z.number().optional(),
  teamRequirement: z.number().optional(),
  maxBet: z.string().optional(),
  dailyWagerReward: z.string().optional(),
  commissionRates: z.string().optional(), // JSON string of array
  rechargeAmount: z.string().optional(),
  telegramLink: z.string().optional(),
  supportEmail: z.string().optional(),
  isActive: z.boolean().optional(),
});

// Golden Live insert schemas
export const insertGoldenLiveStatsSchema = createInsertSchema(goldenLiveStats).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertGoldenLiveEventSchema = createInsertSchema(goldenLiveEvents).omit({
  id: true,
  createdAt: true,
});

// Relations
import { relations } from "drizzle-orm";

export const usersRelations = relations(users, ({ many, one }) => ({
  bets: many(bets),
  transactions: many(transactions),
  agentTransactions: many(transactions, { relationName: "agentTransactions" }),
  referralsMade: many(referrals, { relationName: "referrer" }),
  referralReceived: one(referrals, { relationName: "referred", fields: [users.id], references: [referrals.referredId] }),
  adminActions: many(adminActions),
  sessions: many(userSessions),
  withdrawalRequests: many(withdrawalRequests),
  agentProfile: one(agentProfiles),
  agentActivities: many(agentActivities),
  referrer: one(users, { fields: [users.referredBy], references: [users.id] }),
}));

export const gamesRelations = relations(games, ({ many, one }) => ({
  bets: many(bets),
  analytics: one(gameAnalytics),
}));

export const betsRelations = relations(bets, ({ one }) => ({
  user: one(users, { fields: [bets.userId], references: [users.id] }),
  game: one(games, { fields: [bets.gameId], references: [games.id] }),
}));

export const transactionsRelations = relations(transactions, ({ one }) => ({
  user: one(users, { fields: [transactions.userId], references: [users.id] }),
  agent: one(users, { relationName: "agentTransactions", fields: [transactions.agentId], references: [users.id] }),
}));

export const referralsRelations = relations(referrals, ({ one }) => ({
  referrer: one(users, { relationName: "referrer", fields: [referrals.referrerId], references: [users.id] }),
  referred: one(users, { relationName: "referred", fields: [referrals.referredId], references: [users.id] }),
}));

export const adminActionsRelations = relations(adminActions, ({ one }) => ({
  admin: one(users, { fields: [adminActions.adminId], references: [users.id] }),
}));

export const gameAnalyticsRelations = relations(gameAnalytics, ({ one }) => ({
  game: one(games, { fields: [gameAnalytics.gameId], references: [games.id] }),
}));

export const userSessionsRelations = relations(userSessions, ({ one }) => ({
  user: one(users, { fields: [userSessions.userId], references: [users.id] }),
}));

export const passwordResetTokensRelations = relations(passwordResetTokens, ({ one }) => ({
  user: one(users, { fields: [passwordResetTokens.email], references: [users.email] }),
}));

export const withdrawalRequestsRelations = relations(withdrawalRequests, ({ one }) => ({
  user: one(users, { fields: [withdrawalRequests.userId], references: [users.id] }),
  processedByAdmin: one(users, { fields: [withdrawalRequests.processedBy], references: [users.id] }),
}));

export const systemSettingsRelations = relations(systemSettings, ({ one }) => ({
  lastUpdatedByAdmin: one(users, { fields: [systemSettings.lastUpdatedBy], references: [users.id] }),
}));

export const agentProfilesRelations = relations(agentProfiles, ({ one, many }) => ({
  user: one(users, { fields: [agentProfiles.userId], references: [users.id] }),
  activities: many(agentActivities),
}));

export const agentActivitiesRelations = relations(agentActivities, ({ one }) => ({
  agent: one(users, { fields: [agentActivities.agentId], references: [users.id] }),
  targetUser: one(users, { fields: [agentActivities.targetUserId], references: [users.id] }),
  transaction: one(transactions, { fields: [agentActivities.transactionId], references: [transactions.id] }),
}));

export const passkeysRelations = relations(passkeys, ({ one }) => ({
  user: one(users, { fields: [passkeys.userId], references: [users.id] }),
}));

// VIP Level Utilities
export const VIP_LEVELS = {
  lv1: { 
    teamRequirement: 0,
    depositRequirement: 0,
    maxBetLimit: 999999, 
    displayName: "Level 1",
    dailyWagerReward: 0.000, // 0.0%
    commissionRates: [0.06, 0.05, 0.04, 0.03, 0.02, 0.01, 0.007, 0.005, 0.003] // Lv1-Lv9
  },
  lv2: { 
    teamRequirement: 1,
    depositRequirement: 30,
    maxBetLimit: 999999, 
    displayName: "Level 2",
    dailyWagerReward: 0.0005, // 0.05%
    commissionRates: [0.065, 0.055, 0.045, 0.035, 0.025, 0.015, 0.01, 0.007, 0.005] // Lv1-Lv9
  },
  vip: { 
    teamRequirement: 7,
    depositRequirement: 300,
    maxBetLimit: 999999, 
    displayName: "VIP",
    dailyWagerReward: 0.001, // 0.1%
    commissionRates: [0.07, 0.06, 0.05, 0.04, 0.03, 0.02, 0.01, 0.005] // Lv1-Lv8
  },
  vip1: { 
    teamRequirement: 10,
    depositRequirement: 600,
    maxBetLimit: 999999, 
    displayName: "VIP 1",
    dailyWagerReward: 0.002, // 0.2%
    commissionRates: [0.08, 0.07, 0.06, 0.05, 0.04, 0.03, 0.02, 0.01] // Lv1-Lv8
  },
  vip2: { 
    teamRequirement: 20,
    depositRequirement: 1000,
    maxBetLimit: 999999, 
    displayName: "VIP 2",
    dailyWagerReward: 0.003, // 0.3%
    commissionRates: [0.09, 0.08, 0.07, 0.06, 0.05, 0.04, 0.03, 0.02] // Lv1-Lv8
  },
  vip3: { 
    teamRequirement: 30,
    depositRequirement: 2000,
    maxBetLimit: 999999, 
    displayName: "VIP 3",
    dailyWagerReward: 0.004, // 0.4%
    commissionRates: [0.10, 0.09, 0.08, 0.07, 0.06, 0.05, 0.04, 0.03] // Lv1-Lv8
  },
  vip4: { 
    teamRequirement: 40,
    depositRequirement: 5000,
    maxBetLimit: 999999, 
    displayName: "VIP 4",
    dailyWagerReward: 0.005, // 0.5%
    commissionRates: [0.11, 0.10, 0.09, 0.08, 0.07, 0.06, 0.05, 0.04] // Lv1-Lv8
  },
  vip5: { 
    teamRequirement: 50,
    depositRequirement: 10000,
    maxBetLimit: 999999, 
    displayName: "VIP 5",
    dailyWagerReward: 0.006, // 0.6%
    commissionRates: [0.12, 0.11, 0.10, 0.09, 0.08, 0.07, 0.06, 0.05] // Lv1-Lv8
  },
  vip6: { 
    teamRequirement: 60,
    depositRequirement: 20000,
    maxBetLimit: 999999, 
    displayName: "VIP 6",
    dailyWagerReward: 0.007, // 0.7%
    commissionRates: [0.13, 0.12, 0.11, 0.10, 0.09, 0.08, 0.07, 0.06] // Lv1-Lv8
  },
  vip7: { 
    teamRequirement: 70,
    depositRequirement: 50000,
    maxBetLimit: 999999, 
    displayName: "VIP 7",
    dailyWagerReward: 0.008, // 0.8%
    commissionRates: [0.14, 0.13, 0.12, 0.11, 0.10, 0.09, 0.08, 0.07] // Lv1-Lv8
  },
} as const;

export function calculateVipLevel(teamSize: number, totalDeposits: number = 0): keyof typeof VIP_LEVELS {
  // Sort levels by team requirement in descending order
  const levels: [keyof typeof VIP_LEVELS, typeof VIP_LEVELS[keyof typeof VIP_LEVELS]][] = [
    ['vip7', VIP_LEVELS.vip7],
    ['vip6', VIP_LEVELS.vip6],
    ['vip5', VIP_LEVELS.vip5],
    ['vip4', VIP_LEVELS.vip4],
    ['vip3', VIP_LEVELS.vip3],
    ['vip2', VIP_LEVELS.vip2],
    ['vip1', VIP_LEVELS.vip1],
    ['vip', VIP_LEVELS.vip],
    ['lv2', VIP_LEVELS.lv2],
    ['lv1', VIP_LEVELS.lv1],
  ];

  for (const [key, config] of levels) {
    // User qualifies if they meet EITHER team requirement OR deposit requirement
    const meetsTeamRequirement = teamSize >= config.teamRequirement;
    const meetsDepositRequirement = totalDeposits >= config.depositRequirement;
    
    if (meetsTeamRequirement || meetsDepositRequirement) {
      return key;
    }
  }

  return "lv1";
}

export function getMaxBetLimit(vipLevel: keyof typeof VIP_LEVELS): number {
  return VIP_LEVELS[vipLevel].maxBetLimit;
}

export function getVipDisplayName(vipLevel: keyof typeof VIP_LEVELS): string {
  return VIP_LEVELS[vipLevel].displayName;
}

export function getCommissionRate(vipLevel: keyof typeof VIP_LEVELS, teamLevel: number): number {
  const rates = VIP_LEVELS[vipLevel].commissionRates;
  const index = teamLevel - 1; // teamLevel 1 = index 0
  return rates[index] || 0;
}

export function getDailyWagerReward(vipLevel: keyof typeof VIP_LEVELS): number {
  return VIP_LEVELS[vipLevel].dailyWagerReward;
}

// Type exports
export type InsertUser = z.infer<typeof insertUserSchema>;
export type LoginUser = z.infer<typeof loginSchema>;
export type ResetPassword = z.infer<typeof resetPasswordSchema>;
export type ResetPasswordConfirm = z.infer<typeof resetPasswordConfirmSchema>;
export type User = typeof users.$inferSelect;
export type InsertGame = z.infer<typeof insertGameSchema>;
export type Game = typeof games.$inferSelect;
export type InsertBet = z.infer<typeof insertBetSchema>;
export type Bet = typeof bets.$inferSelect;
export type InsertTransaction = z.infer<typeof insertTransactionSchema>;
export type Transaction = typeof transactions.$inferSelect;
export type InsertReferral = z.infer<typeof insertReferralSchema>;
export type Referral = typeof referrals.$inferSelect;
export type InsertAdminAction = z.infer<typeof insertAdminActionSchema>;
export type AdminAction = typeof adminActions.$inferSelect;
export type InsertGameAnalytics = z.infer<typeof insertGameAnalyticsSchema>;
export type GameAnalytics = typeof gameAnalytics.$inferSelect;
export type InsertUserSession = z.infer<typeof insertUserSessionSchema>;
export type UserSession = typeof userSessions.$inferSelect;
export type InsertPageView = z.infer<typeof insertPageViewSchema>;
export type PageView = typeof pageViews.$inferSelect;
export type Setup2FA = z.infer<typeof setup2FASchema>;
export type Verify2FA = z.infer<typeof verify2FASchema>;
export type Validate2FA = z.infer<typeof validate2FASchema>;
export type InsertWithdrawalRequest = z.infer<typeof insertWithdrawalRequestSchema>;
export type WithdrawalRequest = typeof withdrawalRequests.$inferSelect;
export type CreateWithdrawalRequest = z.infer<typeof createWithdrawalRequestSchema>;
export type ProcessWithdrawalRequest = z.infer<typeof processWithdrawalRequestSchema>;
export type InsertSystemSetting = z.infer<typeof insertSystemSettingSchema>;
export type SystemSetting = typeof systemSettings.$inferSelect;
export type UpdateSystemSetting = z.infer<typeof updateSystemSettingSchema>;
export type InsertDatabaseConnection = z.infer<typeof insertDatabaseConnectionSchema>;
export type DatabaseConnection = typeof databaseConnections.$inferSelect;
export type InsertAgentProfile = z.infer<typeof insertAgentProfileSchema>;
export type AgentProfile = typeof agentProfiles.$inferSelect;
export type InsertAgentActivity = z.infer<typeof insertAgentActivitySchema>;
export type AgentActivity = typeof agentActivities.$inferSelect;
export type CreateAgent = z.infer<typeof createAgentSchema>;
export type AgentDeposit = z.infer<typeof agentDepositSchema>;
export type AgentWithdrawal = z.infer<typeof agentWithdrawalSchema>;
export type UpdateCommission = z.infer<typeof updateCommissionSchema>;
export type StartPasskeyRegistration = z.infer<typeof startPasskeyRegistrationSchema>;
export type FinishPasskeyRegistration = z.infer<typeof finishPasskeyRegistrationSchema>;
export type StartPasskeyAuthentication = z.infer<typeof startPasskeyAuthenticationSchema>;
export type FinishPasskeyAuthentication = z.infer<typeof finishPasskeyAuthenticationSchema>;
export type UpdatePasskey = z.infer<typeof updatePasskeySchema>;
export type InsertPasskey = z.infer<typeof insertPasskeySchema>;
export type Passkey = typeof passkeys.$inferSelect;
export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type SendNotification = z.infer<typeof sendNotificationSchema>;
export type MarkNotificationRead = z.infer<typeof markNotificationReadSchema>;
export type Notification = typeof notifications.$inferSelect;
export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type InsertPushSubscription = z.infer<typeof insertPushSubscriptionSchema>;
export type InsertVipSetting = z.infer<typeof insertVipSettingSchema>;
export type UpdateVipSetting = z.infer<typeof updateVipSettingSchema>;
export type VipSetting = typeof vipSettings.$inferSelect;
export type InsertGoldenLiveStats = z.infer<typeof insertGoldenLiveStatsSchema>;
export type GoldenLiveStats = typeof goldenLiveStats.$inferSelect;
export type InsertGoldenLiveEvent = z.infer<typeof insertGoldenLiveEventSchema>;
export type GoldenLiveEvent = typeof goldenLiveEvents.$inferSelect;
export type InsertPromoCode = z.infer<typeof insertPromoCodeSchema>;
export type CreatePromoCode = z.infer<typeof createPromoCodeSchema>;
export type RedeemPromoCode = z.infer<typeof redeemPromoCodeSchema>;
export type PromoCode = typeof promoCodes.$inferSelect;
export type InsertPromoCodeRedemption = z.infer<typeof insertPromoCodeRedemptionSchema>;
export type PromoCodeRedemption = typeof promoCodeRedemptions.$inferSelect;
export type InsertVipLevelTelegramLink = z.infer<typeof insertVipLevelTelegramLinkSchema>;
export type UpsertVipLevelTelegramLink = z.infer<typeof upsertVipLevelTelegramLinkSchema>;
export type VipLevelTelegramLink = typeof vipLevelTelegramLinks.$inferSelect;