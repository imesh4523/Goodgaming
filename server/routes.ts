import type { Express, Request, Response, NextFunction } from "express";
import express from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage, initializeStorage } from "./storage";
import { vipService } from "./vip-service";
import { type User, insertBetSchema, insertGameSchema, insertUserSchema, loginSchema, resetPasswordSchema, resetPasswordConfirmSchema, changePasswordSchema, changeWithdrawalPasswordSchema, setup2FASchema, verify2FASchema, validate2FASchema, updateSystemSettingSchema, insertDatabaseConnectionSchema, createAgentSchema, agentDepositSchema, agentWithdrawalSchema, updateCommissionSchema, agentSelfDepositSchema, startPasskeyRegistrationSchema, passkeyDeviceNameSchema, finishPasskeyRegistrationSchema, startPasskeyAuthenticationSchema, finishPasskeyAuthenticationSchema, updatePasskeySchema, createWithdrawalRequestSchema, sendNotificationSchema, markNotificationReadSchema, subscribeToPushSchema, unsubscribeFromPushSchema, systemSettings } from "@shared/schema";
import { authenticator } from "otplib";
import * as QRCode from "qrcode";
import { db } from "./db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createNOWPayment, getNOWPaymentStatus, verifyIPNSignature } from "./nowpayments";
import { parseUserAgent } from "./userAgentParser";
import { sendPasswordResetEmail, sendDepositConfirmationEmail, sendCustomEmail, sendWelcomeEmail, sendVipLevelUpgradeEmail, sendLevelUpEmail, sendWithdrawalRequestEmail, sendAgentApprovalEmail } from "./email";
import { sendWithdrawalNotification, testTelegramConnection, sendGameSignal, sendPhotoToSignalChannel, sendAdminLoginNotification, sendFailedLoginNotification, sendInvalid2FANotification } from "./telegram";
import sharp from "sharp";
import webPush from "web-push";
import { 
  generateRegistrationOptions, 
  verifyRegistrationResponse, 
  generateAuthenticationOptions, 
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse
} from '@simplewebauthn/server';
import { betSettlementService } from './bet-settlement-service';
import { periodSyncService } from './period-sync-service';
import { calculationValidator } from './calculation-validator';

// Web Push configuration
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BNzxJVkCqQqtqFmvIBftRJ1eMrD1QqlVH9wv3bNWxMF7IYc-_7xBQPPBjgAMZ7OpPVBbWVXUGhkPCZC2AhBZFmo';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'XYcW7cNQGQ9kH9nH8gHj5K6F3vBqKzVCPK6JqD4gqMk';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:pursuer.ail-4d@icloud.com';

webPush.setVapidDetails(
  VAPID_SUBJECT,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// WebAuthn configuration
const rpName = 'Gaming Platform';
const getRpID = () => {
  if (process.env.CUSTOM_DOMAIN) {
    return new URL(process.env.CUSTOM_DOMAIN).hostname;
  }
  return process.env.NODE_ENV === 'production' ? process.env.REPLIT_DEV_DOMAIN || 'localhost' : 'localhost';
};
const getOrigin = () => {
  if (process.env.CUSTOM_DOMAIN) {
    return process.env.CUSTOM_DOMAIN;
  }
  return process.env.NODE_ENV === 'production' 
    ? (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : 'http://localhost:5000')
    : 'http://localhost:5000';
};
const rpID = getRpID();
const origin = getOrigin();

// Helper function to check if user is banned
async function checkUserBanStatus(userId: string): Promise<{ banned: boolean; message?: string }> {
  const user = await storage.getUser(userId);
  if (!user) {
    return { banned: false };
  }
  
  if (user.isBanned) {
    // Check if temporary ban has expired
    if (user.bannedUntil && new Date(user.bannedUntil) <= new Date()) {
      // Temporary ban has expired, unban the user automatically
      await storage.unbanUser(userId);
      return { banned: false };
    }
    
    // User is still banned
    const banMessage = user.bannedUntil 
      ? `Account is banned until ${new Date(user.bannedUntil).toLocaleDateString()}. Reason: ${user.banReason || 'No reason provided'}`
      : `Account is permanently banned. Reason: ${user.banReason || 'No reason provided'}`;
    return { banned: true, message: banMessage };
  }
  
  return { banned: false };
}

// Authentication middleware
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const session = (req as any).session;
  if (!session?.userId) {
    return res.status(401).json({ message: 'Authentication required' });
  }
  
  // Check if user is banned
  checkUserBanStatus(session.userId).then(banStatus => {
    if (banStatus.banned) {
      // Invalidate session
      (req as any).session.destroy();
      return res.status(403).json({ message: banStatus.message });
    }
    next();
  }).catch(() => {
    res.status(500).json({ message: 'Internal server error' });
  });
}

// Admin middleware
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const session = (req as any).session;
  if (!session?.userId) {
    return res.status(401).json({ message: 'Authentication required' });
  }
  
  // Check if user is banned first, then check admin role
  checkUserBanStatus(session.userId).then(banStatus => {
    if (banStatus.banned) {
      // Invalidate session
      (req as any).session.destroy();
      return res.status(403).json({ message: banStatus.message });
    }
    
    // Check if user is admin
    return storage.getUser(session.userId).then(user => {
      if (!user || user.role !== 'admin') {
        return res.status(403).json({ message: 'Admin access required' });
      }
      next();
    });
  }).catch(() => {
    res.status(500).json({ message: 'Internal server error' });
  });
}

// Admin middleware with IP whitelist check
async function requireAdminWithIPCheck(req: Request, res: Response, next: NextFunction) {
  const session = (req as any).session;
  if (!session?.userId) {
    return res.status(401).json({ message: 'Authentication required' });
  }
  
  try {
    // Check if user is banned first
    const banStatus = await checkUserBanStatus(session.userId);
    if (banStatus.banned) {
      (req as any).session.destroy();
      return res.status(403).json({ message: banStatus.message });
    }
    
    // Check if user is admin
    const user = await storage.getUser(session.userId);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }
    
    // Check IP whitelist
    const ipWhitelistSetting = await storage.getSystemSetting('admin_ip_whitelist');
    if (ipWhitelistSetting && ipWhitelistSetting.value) {
      const clientIP = getRealIP(req);
      const whitelistedIPs = ipWhitelistSetting.value.split(',').map(ip => ip.trim());
      
      if (!whitelistedIPs.includes(clientIP)) {
        console.log(`🚫 Admin access denied. IP ${clientIP} not in whitelist: ${whitelistedIPs.join(', ')}`);
        return res.status(403).json({ 
          message: `Access denied. Your IP address (${clientIP}) is not authorized to access the admin dashboard.` 
        });
      }
      
      console.log(`✅ Admin access granted. IP ${clientIP} is whitelisted`);
    }
    
    next();
  } catch (error) {
    console.error('Admin IP check error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
}

// Helper function to get real IP address from proxy headers
function getRealIP(req: Request): string {
  // Check for Cloudflare's connecting IP header first
  const cfConnectingIP = req.headers['cf-connecting-ip'] as string;
  if (cfConnectingIP) {
    return cfConnectingIP;
  }

  // Check for X-Forwarded-For header (common proxy header)
  const xForwardedFor = req.headers['x-forwarded-for'] as string;
  if (xForwardedFor) {
    // X-Forwarded-For can contain multiple IPs, the first one is the real client IP
    const ips = xForwardedFor.split(',').map(ip => ip.trim());
    return ips[0];
  }

  // Check for X-Real-IP header
  const xRealIP = req.headers['x-real-ip'] as string;
  if (xRealIP) {
    return xRealIP;
  }

  // Fallback to standard methods
  return req.ip || 
         req.connection.remoteAddress || 
         req.socket.remoteAddress || 
         (req.connection as any)?.socket?.remoteAddress || 
         'unknown';
}

// Photo validation function
function validatePhoto(photoData: string): boolean {
  if (!photoData) return true; // Photo is optional
  
  // Check if it's a valid base64 data URL
  const dataUrlRegex = /^data:image\/(png|jpeg|jpg|gif|webp);base64,/;
  if (!dataUrlRegex.test(photoData)) {
    return false;
  }
  
  // Check file size (base64 is ~1.37x larger than original)
  const sizeInBytes = (photoData.length - photoData.indexOf(',') - 1) * 0.75;
  const maxSizeInBytes = 5 * 1024 * 1024; // 5MB
  
  return sizeInBytes <= maxSizeInBytes;
}

// Security function to sanitize user data before sending to client
// Uses whitelist approach to only include safe fields
function sanitizeUserData(user: any) {
  return {
    id: user.id,
    publicId: user.publicId,
    email: user.email,
    profilePhoto: user.profilePhoto,
    balance: user.balance,
    role: user.role,
    vipLevel: user.vipLevel,
    isActive: user.isActive,
    referralCode: user.referralCode,
    referredBy: user.referredBy,
    totalDeposits: user.totalDeposits,
    totalWithdrawals: user.totalWithdrawals,
    totalWinnings: user.totalWinnings,
    totalLosses: user.totalLosses,
    maxBetLimit: user.maxBetLimit,
    twoFactorEnabled: user.twoFactorEnabled,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

// Security function to sanitize agent data before sending to client
function sanitizeAgentData(agent: any) {
  const sanitizedUser = sanitizeUserData(agent);
  return {
    ...sanitizedUser,
    agentProfile: agent.agentProfile // Agent profile doesn't contain sensitive data
  };
}

// Multi-level commission distribution function
// Commission is calculated from the betting fee (3% of bet amount), not the bet itself
async function distributeCommissions(userId: string, betAmount: number) {
  try {
    // Import VIP utilities
    const { VIP_LEVELS, getCommissionRate } = await import("@shared/schema");
    
    // Get the user who placed the bet
    const user = await storage.getUser(userId);
    if (!user || !user.referredBy) return; // No referrer, no commissions
    
    // Get betting fee percentage from system settings (default 3%)
    const feeSetting = await storage.getSystemSetting('betting_fee_percentage');
    let feePercentage = feeSetting?.value ? parseFloat(feeSetting.value) : 3;
    
    // Validate fee percentage to prevent NaN errors
    if (isNaN(feePercentage) || feePercentage < 0 || feePercentage > 100) {
      console.error(`Invalid betting fee percentage: ${feeSetting?.value}, using default 3%`);
      feePercentage = 3;
    }
    
    // Calculate the fee amount (e.g., 3% of $1000 bet = $30)
    const feeAmount = betAmount * (feePercentage / 100);
    
    // Track referral levels and distribute commissions FROM the fee amount
    let currentUserId: string | null = user.referredBy;
    let level = 1;
    const MAX_LEVELS = 9;
    
    while (currentUserId && level <= MAX_LEVELS) {
      const referrer = await storage.getUser(currentUserId);
      if (!referrer) break;
      
      // Get commission rate based on referrer's VIP level and team level
      const commissionRate = getCommissionRate(referrer.vipLevel, level);
      
      if (commissionRate > 0) {
        // Commission is calculated from the FEE, not the bet
        // Example: Fee is $30 (3% of $1000), Level 1 at 6% → $30 * 0.06 = $1.80
        const commissionAmount = feeAmount * commissionRate;
        
        // Update referrer's total commission (available rewards)
        // User must withdraw to wallet to add to main balance
        const newTotalCommission = (parseFloat(referrer.totalCommission) + commissionAmount).toFixed(8);
        const newLifetimeCommission = (parseFloat(referrer.lifetimeCommissionEarned || "0") + commissionAmount).toFixed(8);
        await storage.updateUser(referrer.id, {
          totalCommission: newTotalCommission,
          lifetimeCommissionEarned: newLifetimeCommission
        });
      }
      
      // Move to next level
      currentUserId = referrer.referredBy;
      level++;
    }
  } catch (error) {
    console.error('Error distributing commissions:', error);
  }
}

// Daily period system - periods calculated based on Sri Lanka time (UTC+5:30)

// Get current time in Sri Lanka timezone (UTC+5:30)
function getSriLankaTime(): Date {
  const now = new Date();
  // Sri Lanka is UTC+5:30 (5.5 hours ahead of UTC)
  const sriLankaTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  return sriLankaTime;
}

function getTodayDateString(): string {
  const now = getSriLankaTime();
  const year = now.getUTCFullYear();
  const month = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = now.getUTCDate().toString().padStart(2, '0');
  return `${year}${month}${day}`;
}

function generateGameId(duration: number): string {
  const todayDate = getTodayDateString();
  
  // Calculate period number based on Sri Lanka time within the day
  const now = getSriLankaTime();
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0); // Midnight in Sri Lanka time
  
  // Minutes since midnight in Sri Lanka time
  const minutesSinceMidnight = Math.floor((now.getTime() - startOfDay.getTime()) / (1000 * 60));
  
  // Calculate current period based on duration
  const currentPeriod = Math.floor(minutesSinceMidnight / duration) + 1;
  
  // Format: YYYYMMDD + 2-digit duration + 4-digit period number
  // Example: 20250927010779 (1-minute, period 779) or 20250927030260 (3-minute, period 260)
  const durationPadded = duration.toString().padStart(2, '0');
  const periodNumber = currentPeriod.toString().padStart(4, '0');
  
  return `${todayDate}${durationPadded}${periodNumber}`;
}

function getNumberColor(num: number): string {
  if (num === 5) return "violet";
  if ([1, 3, 7, 9].includes(num)) return "green";
  if (num === 0) return "violet";
  return "red"; // 2, 4, 6, 8
}

function getNumberSize(num: number): string {
  return num >= 5 ? "big" : "small";
}

function calculatePayout(betType: string, betValue: string, amount: number): number {
  switch (betType) {
    case "color":
      return betValue === "violet" ? amount * 4.5 : amount * 2;
    case "number":
      return amount * 9; // 9x for exact number
    case "size":
      return amount * 2;
    default:
      return amount;
  }
}

// Profit Guarantee System
class ProfitTracker {
  private static instance: ProfitTracker;
  private totalBetsAmount: number = 0;
  private totalPayouts: number = 0;
  private targetProfitPercentage: number = 20; // Default 20%
  
  static getInstance(): ProfitTracker {
    if (!ProfitTracker.instance) {
      ProfitTracker.instance = new ProfitTracker();
    }
    return ProfitTracker.instance;
  }

  // Update target profit percentage from system settings
  async updateTargetProfit(): Promise<void> {
    try {
      const setting = await storage.getSystemSetting('house_profit_percentage');
      if (setting && setting.value) {
        this.targetProfitPercentage = parseInt(setting.value);
      }
    } catch (error) {
      console.error('Failed to get target profit percentage:', error);
    }
  }

  // Add a bet to tracking
  addBet(amount: number): void {
    this.totalBetsAmount += amount;
  }

  // Add a payout to tracking
  addPayout(amount: number): void {
    this.totalPayouts += amount;
  }

  // Get current profit percentage
  getCurrentProfitPercentage(): number {
    if (this.totalBetsAmount === 0) return 0;
    const currentProfit = this.totalBetsAmount - this.totalPayouts;
    return (currentProfit / this.totalBetsAmount) * 100;
  }

  // Get how much we need to adjust to reach target
  getProfitAdjustment(): number {
    const currentProfit = this.getCurrentProfitPercentage();
    return this.targetProfitPercentage - currentProfit;
  }

  // Check if we should bias results toward house
  shouldBiasTowardHouse(): boolean {
    return this.getProfitAdjustment() > 0;
  }

  // Check if we should bias results toward players (when house profit is too high)
  shouldBiasTowardPlayers(): boolean {
    return this.getProfitAdjustment() < 0;
  }

  // Get bias strength (0-1, where 1 is maximum bias)
  getBiasStrength(): number {
    const adjustment = Math.abs(this.getProfitAdjustment());
    // More aggressive bias when further from target
    return Math.min(adjustment / 10, 0.8); // Max 80% bias
  }

  // Reset tracking (for testing)
  reset(): void {
    this.totalBetsAmount = 0;
    this.totalPayouts = 0;
  }

  // Get current stats
  getStats() {
    return {
      totalBetsAmount: this.totalBetsAmount,
      totalPayouts: this.totalPayouts,
      currentProfit: this.totalBetsAmount - this.totalPayouts,
      currentProfitPercentage: this.getCurrentProfitPercentage(),
      targetProfitPercentage: this.targetProfitPercentage,
      adjustment: this.getProfitAdjustment(),
      biasStrength: this.getBiasStrength()
    };
  }
}

const profitTracker = ProfitTracker.getInstance();

export async function registerRoutes(app: Express): Promise<{ httpServer: Server; wss: WebSocketServer; startGames: () => void }> {
  // Initialize storage properly
  await initializeStorage();
  
  // Initialize VIP service cache to load bet limits
  await vipService.refreshCache();
  console.log('✅ VIP service cache initialized');
  
  // Initialize country blocking service
  const { countryBlockingService } = await import('./country-blocking-service');
  await countryBlockingService.loadSettings();
  console.log('✅ Country blocking service initialized');
  
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  // Game state management
  const activeGames = new Map<number, { game: any; timer: NodeJS.Timeout; scheduledResult?: number }>();
  
  // Store recent balance updates to send to reconnecting clients
  const recentBalanceUpdates: Array<{ type: string; balanceUpdate: any }> = [];
  const MAX_STORED_UPDATES = 20;

  function broadcastToClients(data: any) {
    const message = JSON.stringify(data);
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  function broadcastBalanceUpdate(userId: string, oldBalance: string, newBalance: string, changeType: 'win' | 'loss' | 'deposit' | 'withdrawal' | 'bet') {
    const changeAmount = (parseFloat(newBalance) - parseFloat(oldBalance)).toFixed(8);
    const balanceUpdate = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      userId,
      oldBalance,
      newBalance,
      changeAmount,
      changeType,
      timestamp: new Date().toISOString()
    };

    const message = {
      type: 'balanceUpdate',
      balanceUpdate
    };
    
    // Store balance update for reconnecting clients
    recentBalanceUpdates.unshift(message);
    if (recentBalanceUpdates.length > MAX_STORED_UPDATES) {
      recentBalanceUpdates.pop();
    }
    
    broadcastToClients(message);
  }

  // Setup bet settlement service with broadcast callback
  betSettlementService.setBroadcastCallback(broadcastBalanceUpdate);

  // Setup period sync service with broadcast callback
  periodSyncService.setBroadcastCallback(broadcastToClients);
  
  // Setup calculation validator with broadcast callback
  calculationValidator.setBroadcastCallback(broadcastToClients);

  // Start automatic period synchronization (every 5 seconds)
  periodSyncService.startAutoSync(5000);
  console.log('✅ Period sync service started');

  function broadcastAgentActivity(activity: any) {
    const message = {
      type: 'agentActivity',
      activity
    };
    
    broadcastToClients(message);
  }

  function broadcastAdminDashboardUpdate() {
    const message = {
      type: 'adminDashboardUpdate',
      timestamp: new Date().toISOString()
    };
    
    broadcastToClients(message);
  }

  async function broadcastLiveBettingUpdate() {
    try {
      const periods = [1, 3, 5, 10];
      const periodData = [];

      for (const duration of periods) {
        const colorTotals = {
          green: 0,
          red: 0,
          violet: 0
        };

        const activeGameData = activeGames.get(duration);
        if (activeGameData && activeGameData.game.status === 'active') {
          const bets = await storage.getBetsByGame(activeGameData.game.gameId);
          console.log(`📋 Game ${activeGameData.game.gameId} (${duration}min): Found ${bets.length} total bets`);
          
          for (const bet of bets) {
            if (bet.betType === 'color' && bet.status === 'pending') {
              const color = bet.betValue.toLowerCase();
              if (color === 'green' || color === 'red' || color === 'violet') {
                colorTotals[color] += parseFloat(bet.amount);
                console.log(`  ✓ ${color.toUpperCase()}: +$${bet.amount} (total now: $${colorTotals[color].toFixed(2)})`);
              }
            }
          }
        }

        periodData.push({
          duration,
          green: colorTotals.green.toFixed(2),
          red: colorTotals.red.toFixed(2),
          violet: colorTotals.violet.toFixed(2)
        });
      }

      const message = {
        type: 'liveBettingUpdate',
        liveBets: { periods: periodData }
      };
      
      console.log(`📊 Broadcasting live betting update to ${wss.clients.size} clients:`, JSON.stringify(periodData));
      broadcastToClients(message);
    } catch (error) {
      console.error('Error broadcasting live betting update:', error);
    }
  }

  async function broadcastServerMetrics() {
    try {
      const os = await import('os');
      
      const cpus = os.cpus();
      const cpuCount = cpus.length;
      
      const cpuUsage = cpus.map((cpu, i) => {
        const total = Object.values(cpu.times).reduce((acc, time) => acc + time, 0);
        const idle = cpu.times.idle;
        const usage = total > 0 ? ((total - idle) / total) * 100 : 0;
        return {
          core: i,
          usage: Math.round(usage * 100) / 100
        };
      });
      
      const avgCpuUsage = cpuUsage.reduce((acc, cpu) => acc + cpu.usage, 0) / cpuCount;
      
      const totalMemory = os.totalmem();
      const freeMemory = os.freemem();
      const usedMemory = totalMemory - freeMemory;
      const memoryUsagePercent = (usedMemory / totalMemory) * 100;
      
      const uptime = os.uptime();
      const loadAvg = os.loadavg();
      
      const formatBytes = (bytes: number) => {
        const gb = bytes / (1024 ** 3);
        return `${gb.toFixed(2)} GB`;
      };
      
      const formatUptime = (seconds: number): string => {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        
        const parts = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0) parts.push(`${minutes}m`);
        
        return parts.length > 0 ? parts.join(' ') : '< 1m';
      };
      
      const message = {
        type: 'serverMetrics',
        metrics: {
          cpu: {
            count: cpuCount,
            model: cpus[0]?.model || 'Unknown',
            usage: Math.round(avgCpuUsage * 100) / 100,
            cores: cpuUsage,
            loadAverage: {
              '1min': Math.round(loadAvg[0] * 100) / 100,
              '5min': Math.round(loadAvg[1] * 100) / 100,
              '15min': Math.round(loadAvg[2] * 100) / 100
            }
          },
          memory: {
            total: totalMemory,
            used: usedMemory,
            free: freeMemory,
            usagePercent: Math.round(memoryUsagePercent * 100) / 100,
            totalFormatted: formatBytes(totalMemory),
            usedFormatted: formatBytes(usedMemory),
            freeFormatted: formatBytes(freeMemory)
          },
          system: {
            platform: os.platform(),
            arch: os.arch(),
            hostname: os.hostname(),
            uptime: Math.floor(uptime),
            uptimeFormatted: formatUptime(uptime)
          },
          timestamp: new Date().toISOString()
        }
      };
      
      broadcastToClients(message);
    } catch (error) {
      console.error('Error broadcasting server metrics:', error);
    }
  }

  async function startGame(roundDuration: number) {
    const gameId = generateGameId(roundDuration);
    const startTime = new Date();
    const endTime = new Date(startTime.getTime() + roundDuration * 60 * 1000);

    // Use upsert (insert or update) to handle existing games
    let game;
    try {
      if ((storage as any).db) {
        const { games } = await import("@shared/schema");
        const { eq } = await import("drizzle-orm");
        
        // First try to find existing game with this gameId
        const [existingGame] = await (storage as any).db
          .select()
          .from(games)
          .where(eq(games.gameId, gameId))
          .limit(1);
        
        if (existingGame) {
          console.log(`⚠️  Game ${gameId} already exists, updating it...`);
          // Update the existing game to restart it
          const [updatedGame] = await (storage as any).db
            .update(games)
            .set({
              roundDuration,
              startTime,
              endTime,
              status: "active",
              result: null,
              resultColor: null,
              resultSize: null,
              totalBetsAmount: "0.00000000",
              totalPayouts: "0.00000000",
              houseProfit: "0.00000000",
            })
            .where(eq(games.gameId, gameId))
            .returning();
          game = updatedGame;
          console.log(`✅ Game ${gameId} updated successfully`);
        } else {
          // Create new game
          game = await storage.createGame({
            gameId,
            roundDuration,
            startTime,
            endTime,
            status: "active",
          });
        }
      } else {
        // Fallback to regular create for in-memory storage
        game = await storage.createGame({
          gameId,
          roundDuration,
          startTime,
          endTime,
          status: "active",
        });
      }
    } catch (error: any) {
      // If duplicate key error, update the existing game instead
      if (error.code === '23505' && error.constraint === 'games_game_id_unique') {
        console.log(`⚠️  Duplicate game ${gameId} detected, updating instead...`);
        try {
          const { games } = await import("@shared/schema");
          const { eq } = await import("drizzle-orm");
          const { db } = await import("./db");
          
          // If we got a Postgres duplicate error, we must be using database storage
          const [updatedGame] = await db
            .update(games)
            .set({
              roundDuration,
              startTime,
              endTime,
              status: "active",
              result: null,
              resultColor: null,
              resultSize: null,
              totalBetsAmount: "0.00000000",
              totalPayouts: "0.00000000",
              houseProfit: "0.00000000",
            })
            .where(eq(games.gameId, gameId))
            .returning();
          game = updatedGame;
          console.log(`✅ Game ${gameId} recovered from duplicate error`);
        } catch (updateError) {
          console.error(`❌ Failed to recover from duplicate:`, updateError);
          throw error;
        }
      } else {
        console.error(`❌ Failed to create/update game ${gameId}:`, error);
        throw error;
      }
    }

    console.log(`⏰ Setting timer for ${roundDuration}-minute game (${gameId}): ${roundDuration * 60 * 1000}ms`);

    const timer = setTimeout(async () => {
      console.log(`⏰ Timer fired for ${roundDuration}-minute game (${gameId})`);
      await endGame(game.gameId, roundDuration);
    }, roundDuration * 60 * 1000);

    activeGames.set(roundDuration, { game, timer });

    // Register period with sync service
    periodSyncService.registerPeriod(roundDuration, gameId, startTime, endTime, 'active');

    broadcastToClients({
      type: 'gameStarted',
      game: {
        ...game,
        timeRemaining: roundDuration * 60
      }
    });

    // Only send Telegram signals for 3-minute games
    if (roundDuration === 3) {
      sendGameSignal(gameId, roundDuration).catch(err => {
        console.error('Failed to send game signal:', err);
      });
    }

    console.log(`✅ Game ${gameId} started, ends at ${endTime.toISOString()}`);
    return game;
  }

  // Generate result based on selected algorithm
  async function generateGameResult(bets: any[]): Promise<number> {
    // Get selected algorithm from system settings
    const algorithmSetting = await storage.getSystemSetting('game_algorithm');
    const algorithm = algorithmSetting?.value || 'profit_guaranteed';
    
    if (bets.length === 0) {
      return Math.floor(Math.random() * 10); // No bets, always random (0-9)
    }

    switch (algorithm) {
      case 'fair_random':
        return generateFairRandomResult();
      
      case 'player_favored':
        return generatePlayerFavoredResult(bets);
      
      case 'profit_guaranteed':
      default:
        return generateProfitGuaranteedResult(bets);
    }
  }

  // Algorithm 1: Fair Random - completely random results
  function generateFairRandomResult(): number {
    return Math.floor(Math.random() * 10); // Generate 0-9
  }

  // Algorithm 2: Profit Guaranteed - current implementation
  async function generateProfitGuaranteedResult(bets: any[]): Promise<number> {
    // Update profit tracker from system settings
    await profitTracker.updateTargetProfit();
    
    // Calculate potential payouts for each possible result
    const resultAnalysis = [];
    for (let testResult = 0; testResult <= 9; testResult++) {
      const testColor = getNumberColor(testResult);
      const testSize = getNumberSize(testResult);
      let totalPayout = 0;
      let totalBets = 0;

      for (const bet of bets) {
        totalBets += parseFloat(bet.amount);
        let won = false;
        
        switch (bet.betType) {
          case "color":
            won = bet.betValue === testColor;
            break;
          case "number":
            won = parseInt(bet.betValue) === testResult;
            break;
          case "size":
            won = bet.betValue === testSize;
            break;
        }

        if (won) {
          totalPayout += parseFloat(bet.potential);
        }
      }

      const houseProfit = totalBets - totalPayout;
      const houseProfitPercentage = totalBets > 0 ? (houseProfit / totalBets) * 100 : 0;

      resultAnalysis.push({
        result: testResult,
        totalBets,
        totalPayout,
        houseProfit,
        houseProfitPercentage
      });
    }

    const biasStrength = profitTracker.getBiasStrength();
    const shouldBiasTowardHouse = profitTracker.shouldBiasTowardHouse();
    const shouldBiasTowardPlayers = profitTracker.shouldBiasTowardPlayers();

    if ((shouldBiasTowardHouse || shouldBiasTowardPlayers) && biasStrength > 0.1) {
      if (shouldBiasTowardHouse) {
        // Sort by house profit percentage (descending) - favor house
        resultAnalysis.sort((a, b) => b.houseProfitPercentage - a.houseProfitPercentage);
      } else {
        // Sort by house profit percentage (ascending) - favor players
        resultAnalysis.sort((a, b) => a.houseProfitPercentage - b.houseProfitPercentage);
      }

      // Apply bias toward favorable results
      const biasedOptions = resultAnalysis.slice(0, Math.max(1, Math.floor(5 * biasStrength)));
      const selectedIndex = Math.floor(Math.random() * biasedOptions.length);
      return biasedOptions[selectedIndex].result;
    } else {
      // Use normal random selection
      return Math.floor(Math.random() * 10); // Generate 0-9
    }
  }

  // Algorithm 3: Player Favored - slightly favor players
  function generatePlayerFavoredResult(bets: any[]): number {
    // Calculate potential payouts for each possible result
    const resultAnalysis = [];
    for (let testResult = 0; testResult <= 9; testResult++) {
      const testColor = getNumberColor(testResult);
      const testSize = getNumberSize(testResult);
      let totalPayout = 0;
      let totalBets = 0;

      for (const bet of bets) {
        totalBets += parseFloat(bet.amount);
        let won = false;
        
        switch (bet.betType) {
          case "color":
            won = bet.betValue === testColor;
            break;
          case "number":
            won = parseInt(bet.betValue) === testResult;
            break;
          case "size":
            won = bet.betValue === testSize;
            break;
        }

        if (won) {
          totalPayout += parseFloat(bet.potential);
        }
      }

      const houseProfit = totalBets - totalPayout;
      const playerAdvantage = totalPayout - totalBets; // Positive when players win more

      resultAnalysis.push({
        result: testResult,
        totalBets,
        totalPayout,
        houseProfit,
        playerAdvantage
      });
    }

    // Sort by player advantage (descending) - favor results where players win more
    resultAnalysis.sort((a, b) => b.playerAdvantage - a.playerAdvantage);
    
    // 60% chance to pick from top 3 most favorable results for players
    // 40% chance for completely random
    if (Math.random() < 0.6) {
      const favorableResults = resultAnalysis.slice(0, 3);
      const selectedIndex = Math.floor(Math.random() * favorableResults.length);
      return favorableResults[selectedIndex].result;
    } else {
      return Math.floor(Math.random() * 10); // Generate 0-9
    }
  }

  async function endGame(gameId: string, roundDuration: number) {
    console.log(`🎲 Ending game ${gameId} (${roundDuration}-minute)`);
    
    // Get all bets first to analyze them
    const bets = await storage.getBetsByGame(gameId);
    console.log(`📊 Found ${bets.length} bets for game ${gameId}`);
    
    // Check if there's a scheduled manual result for this game
    const activeGame = activeGames.get(roundDuration);
    let result: number;
    
    if (activeGame && activeGame.scheduledResult !== undefined) {
      // Use the manually scheduled result
      result = activeGame.scheduledResult;
      console.log(`🎯 Using scheduled result: ${result}`);
    } else {
      // Generate result based on selected algorithm
      result = await generateGameResult(bets);
      console.log(`🎲 Generated result: ${result}`);
    }
    
    const resultColor = getNumberColor(result);
    const resultSize = getNumberSize(result);

    const completedGame = await storage.updateGameResult(gameId, result, resultColor, resultSize);
    console.log(`✅ Game ${gameId} completed with result ${result} (${resultColor}, ${resultSize})`);
    
    if (completedGame) {
      // Track total bets for this game
      let totalBetsAmount = 0;
      let totalPayouts = 0;
      
      // STEP 1: First, calculate total bet amount from ALL bets (winning and losing)
      for (const bet of bets) {
        totalBetsAmount += parseFloat(bet.amount);
      }
      
      // STEP 2: Group bets by user to detect overlapping bets on same result
      const userBetsMap = new Map<string, any[]>();
      for (const bet of bets) {
        if (!userBetsMap.has(bet.userId)) {
          userBetsMap.set(bet.userId, []);
        }
        userBetsMap.get(bet.userId)!.push(bet);
      }
      
      // STEP 3: Process each user's bets to detect and handle overlapping wins
      const betsToMarkAsWon = new Set<string>();
      const betsToMarkAsLost = new Set<string>();
      
      for (const [userId, userBets] of Array.from(userBetsMap.entries())) {
        // Check which bets won
        const winningBets = userBets.filter((bet: any) => {
          switch (bet.betType) {
            case "color":
              return bet.betValue === resultColor;
            case "number":
              return parseInt(bet.betValue) === result;
            case "size":
              return bet.betValue === resultSize;
            default:
              return false;
          }
        });
        
        const losingBets = userBets.filter((bet: any) => !winningBets.includes(bet));
        
        // Mark all losing bets
        for (const bet of losingBets) {
          betsToMarkAsLost.add(bet.id);
        }
        
        // Check for overlapping wins (multiple bet types on same result)
        // Overlaps can happen when:
        // 1. color + number (e.g., violet + 0, when result is 0 which is violet)
        // 2. color + size (e.g., red + big, when result is 6 which is red and big)
        // 3. number + size (e.g., 7 + big, when result is 7 which is big)
        // 4. All three (color + number + size)
        
        // Group winning bets by type
        const colorWins = winningBets.filter((b: any) => b.betType === 'color');
        const numberWins = winningBets.filter((b: any) => b.betType === 'number');
        const sizeWins = winningBets.filter((b: any) => b.betType === 'size');
        
        // Count how many different bet types won
        const winningBetTypeCount = [colorWins.length > 0, numberWins.length > 0, sizeWins.length > 0].filter(Boolean).length;
        
        // If user has multiple winning bet types, they're betting on overlapping outcomes
        // Only award the bet type with the highest payout
        if (winningBetTypeCount > 1) {
          // Determine which bet type has the highest payout per bet
          // (number bets pay 9x, violet color pays 4.5x, other colors pay 2x, size pays 2x)
          
          // Priority order (highest payout first):
          // 1. Number bets (9x payout)
          // 2. Violet color (4.5x payout) 
          // 3. Size bets (2x payout)
          // 4. Other colors (2x payout)
          
          let betsToAward: any[] = [];
          
          // Always prefer number bets (highest payout)
          if (numberWins.length > 0) {
            betsToAward = numberWins;
            console.log(`⚠️  Overlapping bets detected for user ${userId}. Awarding all ${numberWins.length} number bet(s) (highest payout type)`);
          }
          // If no number bets, prefer violet color (4.5x)
          else if (colorWins.some((b: any) => b.betValue === 'violet')) {
            betsToAward = colorWins.filter((b: any) => b.betValue === 'violet');
            console.log(`⚠️  Overlapping bets detected for user ${userId}. Awarding violet color bet(s) (highest payout type)`);
          }
          // Otherwise, prefer size or other color (both 2x, so pick whichever exists)
          else if (sizeWins.length > 0) {
            betsToAward = sizeWins;
            console.log(`⚠️  Overlapping bets detected for user ${userId}. Awarding ${sizeWins.length} size bet(s)`);
          }
          else if (colorWins.length > 0) {
            betsToAward = colorWins;
            console.log(`⚠️  Overlapping bets detected for user ${userId}. Awarding ${colorWins.length} color bet(s)`);
          }
          
          // Mark awarded bets as winners
          for (const bet of betsToAward) {
            betsToMarkAsWon.add(bet.id);
          }
          
          // Mark all other winning bets (from other types) as lost due to overlap
          for (const bet of winningBets) {
            if (!betsToAward.includes(bet)) {
              betsToMarkAsLost.add(bet.id);
            }
          }
        } else {
          // Only one bet type won, or no winning bets
          // Award all winning bets normally (no overlap)
          for (const bet of winningBets) {
            betsToMarkAsWon.add(bet.id);
          }
        }
      }
      
      // STEP 4: Process all bets based on winning/losing determination
      for (const bet of bets) {
        if (betsToMarkAsWon.has(bet.id)) {
          // Process winning bet
          const totalPayout = parseFloat(bet.potential);
          const betAmount = parseFloat(bet.amount);
          const winnings = totalPayout - betAmount; // Only the profit part
          
          // Apply betting fee - deduct fee percentage from winnings only (not stake)
          let finalPayout = totalPayout;
          const feeSetting = await storage.getSystemSetting('betting_fee_percentage');
          if (feeSetting && feeSetting.value) {
            const feePercentage = parseFloat(feeSetting.value);
            if (feePercentage > 0) {
              const feeAmount = winnings * (feePercentage / 100);
              finalPayout = betAmount + (winnings - feeAmount); // Stake + (winnings - fee)
            }
          }
          
          // Update bet status with actual payout after fees
          await storage.updateBetStatus(bet.id, "won", finalPayout.toFixed(8));
          
          // FIXED: totalPayouts should include FULL payout (stake + winnings)
          totalPayouts += finalPayout;
          
          const user = await storage.getUser(bet.userId);
          if (user) {
            const oldBalance = user.balance;
            const newBalance = (parseFloat(user.balance) + finalPayout).toFixed(8);
            await storage.updateUserBalance(bet.userId, newBalance);
            
            // Broadcast balance update for wins
            broadcastBalanceUpdate(bet.userId, oldBalance, newBalance, 'win');
          }
        } else {
          // Process losing bet
          await storage.updateBetStatus(bet.id, "lost");
          
          // Broadcast loss notification for animation
          const user = await storage.getUser(bet.userId);
          if (user) {
            const lostAmount = parseFloat(bet.amount);
            const currentBalance = parseFloat(user.balance);
            // Simulate the loss by showing balance before bet was placed vs current balance
            const balanceBeforeBet = (currentBalance + lostAmount).toFixed(8);
            broadcastBalanceUpdate(bet.userId, balanceBeforeBet, user.balance, 'loss');
          }
        }
      }

      // Update profit tracker with actual amounts
      profitTracker.addBet(totalBetsAmount);
      profitTracker.addPayout(totalPayouts);

      // FIXED: Calculate house profit correctly
      // House profit = total bets collected - total payouts to winners
      const houseProfit = totalBetsAmount - totalPayouts;
      await storage.updateGameStats(gameId, {
        totalBetsAmount: totalBetsAmount.toFixed(8),
        totalPayouts: totalPayouts.toFixed(8),
        houseProfit: houseProfit.toFixed(8)
      });

      // Get updated game with stats for broadcast
      const updatedGame = await storage.getGameById(gameId);

      broadcastToClients({
        type: 'gameEnded',
        game: updatedGame || completedGame,
        result: {
          number: result,
          color: resultColor,
          size: resultSize
        }
      });

      // Broadcast admin dashboard update for game completion
      broadcastAdminDashboardUpdate();

      // STEP 5: Handle race condition - process any bets created during game ending
      // (Bets placed just before game ended but saved to DB after processing started)
      const allBetsAfterProcessing = await storage.getBetsByGame(gameId);
      const pendingBets = allBetsAfterProcessing.filter((b: any) => b.status === 'pending');
      
      if (pendingBets.length > 0) {
        console.log(`⚠️  Found ${pendingBets.length} pending bet(s) after game processing - handling race condition`);
        
        // Track additional amounts from late bets
        let additionalBetsAmount = 0;
        let additionalPayouts = 0;
        
        for (const bet of pendingBets) {
          // Add bet amount to total
          additionalBetsAmount += parseFloat(bet.amount);
          
          // Determine if this bet won or lost
          let isWinningBet = false;
          
          switch (bet.betType) {
            case "color":
              isWinningBet = bet.betValue === resultColor;
              break;
            case "number":
              isWinningBet = parseInt(bet.betValue) === result;
              break;
            case "size":
              isWinningBet = bet.betValue === resultSize;
              break;
          }
          
          if (isWinningBet) {
            // Process winning bet
            const totalPayout = parseFloat(bet.potential);
            const betAmount = parseFloat(bet.amount);
            const winnings = totalPayout - betAmount;
            
            // Apply betting fee
            let finalPayout = totalPayout;
            const feeSetting = await storage.getSystemSetting('betting_fee_percentage');
            if (feeSetting && feeSetting.value) {
              const feePercentage = parseFloat(feeSetting.value);
              if (feePercentage > 0) {
                const feeAmount = winnings * (feePercentage / 100);
                finalPayout = betAmount + (winnings - feeAmount);
              }
            }
            
            await storage.updateBetStatus(bet.id, "won", finalPayout.toFixed(8));
            
            // Add payout to total
            additionalPayouts += finalPayout;
            
            const user = await storage.getUser(bet.userId);
            if (user) {
              const oldBalance = user.balance;
              const newBalance = (parseFloat(user.balance) + finalPayout).toFixed(8);
              await storage.updateUserBalance(bet.userId, newBalance);
              broadcastBalanceUpdate(bet.userId, oldBalance, newBalance, 'win');
            }
            
            console.log(`✅ Late bet ${bet.id} marked as WON (${bet.betType}: ${bet.betValue})`);
          } else {
            // Process losing bet
            await storage.updateBetStatus(bet.id, "lost");
            
            const user = await storage.getUser(bet.userId);
            if (user) {
              const lostAmount = parseFloat(bet.amount);
              const currentBalance = parseFloat(user.balance);
              const balanceBeforeBet = (currentBalance + lostAmount).toFixed(8);
              broadcastBalanceUpdate(bet.userId, balanceBeforeBet, user.balance, 'loss');
            }
            
            console.log(`❌ Late bet ${bet.id} marked as LOST (${bet.betType}: ${bet.betValue})`);
          }
        }
        
        // FIXED: Update game stats to include late bets
        if (additionalBetsAmount > 0 || additionalPayouts > 0) {
          const updatedTotalBets = totalBetsAmount + additionalBetsAmount;
          const updatedTotalPayouts = totalPayouts + additionalPayouts;
          const updatedHouseProfit = updatedTotalBets - updatedTotalPayouts;
          
          await storage.updateGameStats(gameId, {
            totalBetsAmount: updatedTotalBets.toFixed(8),
            totalPayouts: updatedTotalPayouts.toFixed(8),
            houseProfit: updatedHouseProfit.toFixed(8)
          });
          
          // Update profit tracker with late bets
          profitTracker.addBet(additionalBetsAmount);
          profitTracker.addPayout(additionalPayouts);
          
          console.log(`📊 Updated game stats with late bets - Total Bets: $${updatedTotalBets.toFixed(2)}, Payouts: $${updatedTotalPayouts.toFixed(2)}, Profit: $${updatedHouseProfit.toFixed(2)}`);
          
          // Broadcast admin dashboard update for late bet stats update
          broadcastAdminDashboardUpdate();
        }
      }

      // Update period status to completed
      periodSyncService.updatePeriodStatus(roundDuration, 'completed');

      // Validate game result calculations
      calculationValidator.validateGameResult(gameId).then(validation => {
        if (!validation.isValid) {
          console.error(`⚠️  Game ${gameId} validation failed:`, validation.errors);
        } else {
          console.log(`✅ Game ${gameId} validation passed`);
        }
      }).catch(err => {
        console.error(`❌ Error validating game ${gameId}:`, err);
      });

      // Start next game automatically
      activeGames.delete(roundDuration);
      console.log(`⏳ Scheduling next ${roundDuration}-minute game to start in 5 seconds...`);
      setTimeout(() => {
        console.log(`🎮 Starting next ${roundDuration}-minute game now...`);
        startGame(roundDuration);
      }, 5000); // 5 second break between games
    }
  }

  // NOTE: Games are now initialized via startGames() callback after server.listen()
  // The old auto-initialization code has been removed to prevent duplicate games

  // WebSocket connection handling
  wss.on('connection', async (ws) => {

    // Send current active games
    for (const [duration, { game }] of Array.from(activeGames.entries())) {
      const timeRemaining = Math.max(0, Math.floor((new Date(game.endTime).getTime() - Date.now()) / 1000));
      ws.send(JSON.stringify({
        type: 'gameState',
        duration,
        game: {
          ...game,
          timeRemaining
        }
      }));
    }
    
    // Send recent balance updates (last 10) to newly connected client as backfill
    const updates = recentBalanceUpdates.slice(0, 10);
    for (const update of updates) {
      const backfillMessage = {
        ...update,
        balanceUpdate: {
          ...update.balanceUpdate,
          isBackfill: true
        }
      };
      ws.send(JSON.stringify(backfillMessage));
    }

    ws.on('close', () => {
    });
  });

  // API Routes
  app.get('/api/games/active/:duration', async (req, res) => {
    try {
      const duration = parseInt(req.params.duration);
      const activeGame = activeGames.get(duration);
      
      if (activeGame) {
        const timeRemaining = Math.max(0, Math.floor((new Date(activeGame.game.endTime).getTime() - Date.now()) / 1000));
        res.json({
          ...activeGame.game,
          timeRemaining
        });
      } else {
        res.status(404).json({ message: 'No active game found' });
      }
    } catch (error) {
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.get('/api/games/history', async (req, res) => {
    try {
      const history = await storage.getGameHistory(10);
      res.json(history);
    } catch (error) {
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.post('/api/bets', requireAuth, async (req, res) => {
    try {
      const betData = insertBetSchema.parse(req.body);
      
      const userId = (req as any).session.userId; // Use authenticated user ID
      
      // Validate user exists and has sufficient balance
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      if (!user.isActive) {
        return res.status(403).json({ message: 'Account is deactivated' });
      }

      const amount = parseFloat(betData.amount);
      
      if (parseFloat(user.balance) < amount) {
        return res.status(400).json({ message: 'Insufficient balance' });
      }

      // Look up game by gameId to get the UUID
      const game = await storage.getGameById(betData.gameId);
      if (!game) {
        return res.status(404).json({ message: 'Game not found' });
      }

      // Calculate effective bet limit based on VIP level from VIP settings (cached)
      // Note: VIP levels are already cached, no need to refresh on every bet
      const vipMaxBet = vipService.getMaxBetLimit(user.vipLevel);
      const userMaxBet = parseFloat(user.maxBetLimit || '999999');
      const effectiveMaxBet = Math.min(vipMaxBet, userMaxBet);

      // Calculate potential payout
      const potential = calculatePayout(betData.betType, betData.betValue, amount);

      // Calculate new balance
      const oldBalance = user.balance;
      const newBalance = (parseFloat(user.balance) - amount).toFixed(8);

      // Create bet and update balance in a SINGLE transaction for speed
      const bet = await storage.createBetAndUpdateBalance({
        userId,
        gameId: game.gameId, // Use the period ID (e.g., "20251029010711")
        betType: betData.betType,
        betValue: betData.betValue,
        amount: betData.amount,
        potential: potential.toFixed(8)
      }, newBalance, effectiveMaxBet);
      
      // Send response immediately for instant bet placement
      res.json(bet);
      
      // Run broadcasts and commissions AFTER response (non-blocking)
      setImmediate(async () => {
        try {
          // Broadcast balance update for bet placement
          broadcastBalanceUpdate(userId, oldBalance, newBalance, 'bet');
          
          // Broadcast live betting update to admins
          await broadcastLiveBettingUpdate();
          
          // Distribute commissions through referral chain
          await distributeCommissions(userId, amount);
        } catch (err) {
          console.error('Error in post-bet operations:', err);
        }
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid bet data', errors: error.errors });
      } else if (error instanceof Error && error.message.includes('maximum bet limit')) {
        res.status(400).json({ message: error.message });
      } else {
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });


  app.get('/api/bets/user/active', requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId; // Use authenticated user ID
      const activeBets = await storage.getActiveBetsByUser(userId);
      res.json(activeBets);
    } catch (error) {
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Get all user bets for activity history
  app.get('/api/bets/user/all', requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId; // Use authenticated user ID
      const allBets = await storage.getBetsByUser(userId);
      res.json(allBets);
    } catch (error) {
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Get user's game history based on games they placed bets on
  app.get('/api/games/user/history', requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId;
      
      // Get all user bets
      const userBets = await storage.getBetsByUser(userId);
      
      // Get unique game IDs from user's bets
      const uniqueGameIds = new Set(userBets.map(bet => bet.gameId));
      const gameIds = Array.from(uniqueGameIds);
      
      // Fetch games for these IDs
      const userGames = await Promise.all(
        gameIds.map(gameId => storage.getGameById(gameId))
      );
      
      // Filter out undefined and incomplete games, then sort by creation date (newest first)
      const completedGames = userGames
        .filter(game => game && game.status === 'completed' && game.result !== null && game.result !== undefined)
        .sort((a, b) => new Date(b!.createdAt).getTime() - new Date(a!.createdAt).getTime())
        .slice(0, 10); // Limit to last 10
      
      res.json(completedGames);
    } catch (error) {
      console.error('Error fetching user game history:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Coin flip game endpoint
  app.post('/api/coin-flip/play', requireAuth, async (req, res) => {
    try {
      const coinFlipSchema = z.object({
        side: z.enum(['head', 'tail']),
        amount: z.string().refine((val) => {
          const num = parseFloat(val);
          return !isNaN(num) && num >= 0.10; // Minimum 10 coins (0.10 USD)
        })
      });

      const { side, amount } = coinFlipSchema.parse(req.body);
      const userId = (req as any).session.userId;

      // Get user
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      if (!user.isActive) {
        return res.status(403).json({ message: 'Account is deactivated' });
      }

      const betAmount = parseFloat(amount);
      
      if (parseFloat(user.balance) < betAmount) {
        return res.status(400).json({ message: 'Insufficient balance' });
      }

      // Deduct bet amount
      const oldBalance = user.balance;
      const newBalance = (parseFloat(user.balance) - betAmount).toFixed(8);
      await storage.updateUserBalance(userId, newBalance);
      
      // Update total_bets_amount for withdrawal requirement tracking
      const currentTotalBets = parseFloat(user.totalBetsAmount || '0');
      const newTotalBets = (currentTotalBets + betAmount).toFixed(8);
      await storage.updateUser(userId, { totalBetsAmount: newTotalBets });
      
      // Broadcast balance update for bet placement
      broadcastBalanceUpdate(userId, oldBalance, newBalance, 'bet');

      // Get win probability from settings (default 50%)
      const winProbabilitySetting = await storage.getSystemSetting('coin_flip_win_probability');
      const winProbability = winProbabilitySetting ? parseFloat(winProbabilitySetting.value) / 100 : 0.5;
      
      // Flip coin with adjusted probability
      const playerWins = Math.random() < winProbability;
      const result: 'head' | 'tail' = playerWins ? side : (side === 'head' ? 'tail' : 'head');
      const won = result === side;

      if (won) {
        // Player wins - pay 2x
        const winAmount = betAmount * 2;
        const afterWinBalance = (parseFloat(newBalance) + winAmount).toFixed(8);
        await storage.updateUserBalance(userId, afterWinBalance);
        
        // Broadcast balance update for win
        broadcastBalanceUpdate(userId, newBalance, afterWinBalance, 'win');

        // Distribute commissions on the bet amount
        await distributeCommissions(userId, betAmount);

        res.json({
          won: true,
          result,
          winAmount: winAmount.toFixed(8),
          newBalance: afterWinBalance
        });
      } else {
        // Player loses
        // Distribute commissions on the bet amount
        await distributeCommissions(userId, betAmount);

        res.json({
          won: false,
          result,
          newBalance
        });
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid coin flip data', errors: error.errors });
      } else {
        console.error('Coin flip error:', error);
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  // Authentication routes
  app.post('/api/auth/signup', async (req, res) => {
    try {
      const userData = insertUserSchema.parse(req.body);
      
      // Check if email already exists
      const existingEmail = await storage.getUserByEmail(userData.email);
      if (existingEmail) {
        return res.status(400).json({ message: 'Email already registered' });
      }

      // Get user IP, Country, and User Agent
      const ipAddress = getRealIP(req);
      const country = (req.headers['cf-ipcountry'] as string) || (req as any).cloudflare?.country || null;
      const userAgent = req.headers['user-agent'] || 'unknown';
      const parsedUA = parseUserAgent(userAgent);

      const user = await storage.createUser(userData, ipAddress, country);
      const { passwordHash, ...safeUser } = user;
      
      // Create session and log login
      (req as any).session.userId = user.id;
      await storage.createUserSession({
        userId: user.id,
        ipAddress,
        userAgent,
        browserName: parsedUA.browserName,
        browserVersion: parsedUA.browserVersion,
        deviceType: parsedUA.deviceType,
        deviceModel: parsedUA.deviceModel,
        operatingSystem: parsedUA.operatingSystem,
        isActive: true
      });
      
      // Send welcome email
      try {
        await sendWelcomeEmail(
          user.email,
          user.email.split('@')[0], // Use email username as name
          user.referralCode || '',
          storage
        );
      } catch (emailError) {
        console.error(`Failed to send welcome email to ${user.email}:`, emailError);
      }
      
      // Broadcast admin dashboard update for new user signup
      broadcastAdminDashboardUpdate();
      
      res.json(safeUser);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid signup data', errors: error.errors });
      } else {
        console.error('Signup error:', error);
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const credentials = loginSchema.parse(req.body);
      
      const user = await storage.validateUser(credentials);
      if (!user) {
        // Send Telegram notification for failed login attempt
        const ipAddress = getRealIP(req);
        const timestamp = new Date().toLocaleString('en-US', { 
          timeZone: 'Asia/Colombo',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: true
        });
        
        // Send notification asynchronously (don't block response)
        sendFailedLoginNotification(credentials.email, ipAddress, timestamp).catch(err => {
          console.error('Failed to send failed login notification:', err);
        });
        
        return res.status(401).json({ message: 'Invalid email or password' });
      }

      if (!user.isActive) {
        return res.status(403).json({ message: 'Account is deactivated' });
      }

      // Check if user is banned
      const banStatus = await checkUserBanStatus(user.id);
      if (banStatus.banned) {
        return res.status(403).json({ message: banStatus.message });
      }
      
      // Refresh user object in case ban was auto-removed
      const refreshedUser = await storage.getUser(user.id);
      if (!refreshedUser) {
        return res.status(401).json({ message: 'User not found' });
      }

      // Check if 2FA is enabled
      if (refreshedUser.twoFactorEnabled) {
        // Don't create session yet, return that 2FA is required
        return res.json({ 
          requires2FA: true, 
          userId: refreshedUser.id,
          email: refreshedUser.email,
          message: 'Please enter your 2FA code'
        });
      }

      // Get user IP and User Agent for tracking
      const ipAddress = getRealIP(req);
      const userAgent = req.headers['user-agent'] || 'unknown';
      const parsedUA = parseUserAgent(userAgent);

      // Update last login IP
      await storage.updateUser(user.id, { lastLoginIp: ipAddress });

      // Create user session
      await storage.createUserSession({
        userId: user.id,
        ipAddress,
        userAgent,
        browserName: parsedUA.browserName,
        browserVersion: parsedUA.browserVersion,
        deviceType: parsedUA.deviceType,
        deviceModel: parsedUA.deviceModel,
        operatingSystem: parsedUA.operatingSystem,
        isActive: true
      });

      const { passwordHash, ...safeUser } = user;
      
      // Create session
      (req as any).session.userId = user.id;
      
      // Send Telegram notification if admin login
      if (user.role === 'admin') {
        const timestamp = new Date().toLocaleString('en-US', { 
          timeZone: 'Asia/Colombo',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: true
        });
        
        // Send notification asynchronously (don't block login)
        sendAdminLoginNotification(user.email, ipAddress, timestamp).catch(err => {
          console.error('Failed to send admin login notification:', err);
        });
      }
      
      res.json(safeUser);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid login data', errors: error.errors });
      } else {
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  // 2FA login verification endpoint
  app.post('/api/auth/login/verify-2fa', async (req, res) => {
    try {
      const { userId, token } = req.body;
      
      if (!userId || !token) {
        return res.status(400).json({ message: 'User ID and 2FA token are required' });
      }

      // Get user first (we need email for notification)
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      // Validate 2FA token
      const isValid = await storage.validate2FAToken(userId, token);
      
      if (!isValid) {
        // Send Telegram notification for invalid 2FA attempt
        const ipAddress = getRealIP(req);
        const timestamp = new Date().toLocaleString('en-US', { 
          timeZone: 'Asia/Colombo',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: true
        });
        
        // Send notification asynchronously (don't block response)
        sendInvalid2FANotification(user.email, ipAddress, timestamp).catch(err => {
          console.error('Failed to send invalid 2FA notification:', err);
        });
        
        return res.status(401).json({ message: 'Invalid 2FA code' });
      }

      if (!user.isActive) {
        return res.status(403).json({ message: 'Account is deactivated' });
      }

      // Check if user is banned
      if (user.isBanned) {
        if (user.bannedUntil && new Date(user.bannedUntil) <= new Date()) {
          // Temporary ban has expired, unban the user automatically
          await storage.unbanUser(user.id);
        } else {
          // User is still banned
          const banMessage = user.bannedUntil 
            ? `Account is banned until ${new Date(user.bannedUntil).toLocaleDateString()}. Reason: ${user.banReason || 'No reason provided'}`
            : `Account is permanently banned. Reason: ${user.banReason || 'No reason provided'}`;
          return res.status(403).json({ message: banMessage });
        }
      }

      // Get user IP and User Agent for tracking
      const ipAddress = getRealIP(req);
      const userAgent = req.headers['user-agent'] || 'unknown';
      const parsedUA = parseUserAgent(userAgent);

      // Update last login IP
      await storage.updateUser(user.id, { lastLoginIp: ipAddress });

      // Create user session
      await storage.createUserSession({
        userId: user.id,
        ipAddress,
        userAgent,
        browserName: parsedUA.browserName,
        browserVersion: parsedUA.browserVersion,
        deviceType: parsedUA.deviceType,
        deviceModel: parsedUA.deviceModel,
        operatingSystem: parsedUA.operatingSystem,
        isActive: true
      });

      const { passwordHash, twoFactorSecret, ...safeUser } = user;
      
      // Create session
      (req as any).session.userId = user.id;
      
      // Send Telegram notification if admin login
      if (user.role === 'admin') {
        const timestamp = new Date().toLocaleString('en-US', { 
          timeZone: 'Asia/Colombo',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: true
        });
        
        // Send notification asynchronously (don't block login)
        sendAdminLoginNotification(user.email, ipAddress, timestamp).catch(err => {
          console.error('Failed to send admin login notification:', err);
        });
      }
      
      res.json(safeUser);
    } catch (error) {
      console.error('2FA login verification error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    (req as any).session.destroy((err: any) => {
      if (err) {
        return res.status(500).json({ message: 'Could not log out' });
      }
      res.json({ message: 'Logged out successfully' });
    });
  });

  app.get('/api/auth/me', async (req, res) => {
    try {
      const userId = (req as any).session?.userId;
      if (!userId) {
        return res.status(401).json({ message: 'Not authenticated' });
      }

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      const { passwordHash, ...safeUser } = user;
      res.json(safeUser);
    } catch (error) {
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Get betting requirement status for current user
  app.get('/api/auth/betting-requirement', requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId;
      const user = await storage.getUser(userId);
      
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      // Get betting requirement percentage from system settings (default 60%)
      const betRequirementSetting = await storage.getSystemSetting('betting_requirement_percentage');
      const betRequirementPercentage = betRequirementSetting ? parseFloat(betRequirementSetting.value) : 60;
      
      // Get daily notification interval from system settings (default 24 hours)
      const notificationIntervalSetting = await storage.getSystemSetting('betting_requirement_notification_interval');
      const notificationIntervalHours = notificationIntervalSetting ? parseFloat(notificationIntervalSetting.value) : 24;
      
      const totalDeposits = parseFloat(user.totalDeposits) || 0;
      const totalBetsAmount = parseFloat(user.totalBetsAmount) || 0;
      const totalCommission = parseFloat(user.totalCommission) || 0;
      
      const requiredBetAmount = totalDeposits > 0 ? totalDeposits * (betRequirementPercentage / 100) : 0;
      const remainingBetAmount = Math.max(0, requiredBetAmount - totalBetsAmount);
      const betPercentage = totalDeposits > 0 ? ((totalBetsAmount / totalDeposits) * 100) : 0;
      
      // Use same epsilon tolerance as withdrawal endpoint to handle floating-point precision
      const EPSILON = 0.01; // Allow 0.01 USD tolerance (1 cent)
      // Ensure epsilon doesn't make requirement negative for very small deposits
      const adjustedRequirement = Math.max(0, requiredBetAmount - EPSILON);
      const canWithdraw = totalDeposits === 0 || totalBetsAmount >= adjustedRequirement;
      
      // Check time since last notification was shown (using lastWagerResetDate as notification timestamp)
      const now = new Date();
      const lastNotificationDate = user.lastWagerResetDate ? new Date(user.lastWagerResetDate) : new Date(0);
      const hoursSinceLastNotification = (now.getTime() - lastNotificationDate.getTime()) / (1000 * 60 * 60);
      
      // Only show notification if betting requirement is not met AND enough time has passed
      const shouldShowNotification = !canWithdraw && hoursSinceLastNotification >= notificationIntervalHours;
      
      res.json({
        totalDeposits: totalDeposits.toFixed(2),
        totalBetsAmount: totalBetsAmount.toFixed(2),
        requiredBetAmount: requiredBetAmount.toFixed(2),
        remainingBetAmount: remainingBetAmount.toFixed(2),
        betPercentage: betPercentage.toFixed(2),
        requiredPercentage: betRequirementPercentage,
        canWithdraw,
        withdrawableCommission: totalCommission.toFixed(2),
        notificationIntervalHours,
        hoursSinceLastNotification: hoursSinceLastNotification.toFixed(1),
        shouldShowNotification
      });
    } catch (error) {
      console.error('Betting requirement status error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Acknowledge/dismiss betting requirement notification
  app.post('/api/auth/dismiss-betting-notification', requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId;
      
      // Update lastWagerResetDate to record that notification was shown/dismissed
      const now = new Date();
      await storage.updateUser(userId, {
        lastWagerResetDate: now
      });
      
      console.log(`✅ Betting requirement notification dismissed for user ${userId}`);
      res.json({ message: 'Notification dismissed', timestamp: now });
    } catch (error) {
      console.error('Dismiss notification error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Password reset routes
  app.post('/api/auth/request-reset', async (req, res) => {
    try {
      const { email } = resetPasswordSchema.parse(req.body);
      
      // Check if user with this email exists
      const user = await storage.getUserByEmail(email);
      if (!user) {
        // Don't reveal if email exists or not for security
        return res.json({ message: 'If an account with that email exists, a reset link has been sent.' });
      }

      // Create reset token
      const token = await storage.createPasswordResetToken(email);
      
      // Send reset email
      const emailSent = await sendPasswordResetEmail(email, token, storage);
      
      if (!emailSent) {
        console.error('Failed to send password reset email to:', email);
        return res.status(500).json({ message: 'Failed to send reset email. Please try again.' });
      }

      res.json({ message: 'If an account with that email exists, a reset link has been sent.' });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid email format', errors: error.errors });
      } else {
        console.error('Password reset request error:', error);
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  app.post('/api/auth/confirm-reset', async (req, res) => {
    try {
      const { token, newPassword } = resetPasswordConfirmSchema.parse(req.body);
      
      // Validate reset token
      const email = await storage.validatePasswordResetToken(token);
      if (!email) {
        return res.status(400).json({ message: 'Invalid or expired reset token' });
      }

      // Update password
      const passwordUpdated = await storage.updatePassword(email, newPassword);
      if (!passwordUpdated) {
        return res.status(500).json({ message: 'Failed to update password' });
      }

      // Mark token as used
      await storage.markPasswordResetTokenUsed(token);

      res.json({ message: 'Password reset successfully' });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid reset data', errors: error.errors });
      } else {
        console.error('Password reset confirm error:', error);
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  // Change password for authenticated user
  app.post('/api/auth/change-password', requireAuth, async (req, res) => {
    try {
      const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
      const userId = (req as any).session.userId;
      
      // Get user
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      // Verify current password
      const bcrypt = await import('bcrypt');
      const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!isValid) {
        return res.status(400).json({ message: 'Current password is incorrect' });
      }

      // Update password
      const passwordUpdated = await storage.updatePassword(user.email, newPassword);
      if (!passwordUpdated) {
        return res.status(500).json({ message: 'Failed to update password' });
      }

      res.json({ message: 'Password changed successfully' });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid password data', errors: error.errors });
      } else {
        console.error('Password change error:', error);
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  // Change withdrawal password for authenticated user
  app.post('/api/auth/change-withdrawal-password', requireAuth, async (req, res) => {
    try {
      const { currentWithdrawalPassword, newWithdrawalPassword } = changeWithdrawalPasswordSchema.parse(req.body);
      const userId = (req as any).session.userId;
      
      // Get user
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      // Verify current withdrawal password
      const bcrypt = await import('bcrypt');
      const isValid = await bcrypt.compare(currentWithdrawalPassword, user.withdrawalPasswordHash || '');
      if (!isValid) {
        return res.status(400).json({ message: 'Current withdrawal password is incorrect' });
      }

      // Hash new withdrawal password
      const saltRounds = 10;
      const newHash = await bcrypt.hash(newWithdrawalPassword, saltRounds);

      // Update withdrawal password
      const updated = await storage.updateUser(user.id, { withdrawalPasswordHash: newHash });
      if (!updated) {
        return res.status(500).json({ message: 'Failed to update withdrawal password' });
      }

      res.json({ message: 'Withdrawal password changed successfully' });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid password data', errors: error.errors });
      } else {
        console.error('Withdrawal password change error:', error);
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  // Mock user endpoint for demo (for backward compatibility)
  app.get('/api/user/demo', async (req, res) => {
    try {
      // Create or get demo user
      let user = await storage.getUserByEmail('demo@example.com');
      if (!user) {
        user = await storage.createUser({ 
          password: 'demo', 
          confirmPassword: 'demo',
          withdrawalPassword: 'demo123',
          acceptedTerms: true,
          email: 'demo@example.com'
        });
      } else {
        // Update existing demo user balance to 9 coins (0.09 USD)
        user = await storage.updateUserBalance(user.id, "0.09000000");
      }
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      // Create session for demo user so they can place bets
      (req as any).session.userId = user.id;
      
      const { passwordHash, ...safeUser } = user;
      res.json(safeUser);
    } catch (error) {
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Current authenticated user endpoint
  app.get('/api/user/current', requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId;
      const user = await storage.getUser(userId);
      
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      const { passwordHash, withdrawalPasswordHash, twoFactorSecret, ...safeUser } = user;
      res.json(safeUser);
    } catch (error) {
      console.error('Get current user error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Profile photo upload endpoint
  app.post('/api/user/profile-photo', requireAuth, async (req, res) => {
    try {
      const { profilePhoto } = req.body;
      
      if (!validatePhoto(profilePhoto)) {
        return res.status(400).json({ 
          message: 'Invalid photo format or size. Please use PNG, JPEG, or WebP under 5MB.' 
        });
      }
      
      const userId = (req as any).session.userId;
      const updatedUser = await storage.updateUser(userId, { profilePhoto });
      
      if (!updatedUser) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      const { passwordHash, ...safeUser } = updatedUser;
      res.json({ message: 'Profile photo updated successfully', user: safeUser });
    } catch (error) {
      console.error('Profile photo upload error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Update animation preferences endpoint
  app.post('/api/user/animation-preferences', requireAuth, async (req, res) => {
    try {
      const { enableAnimations } = req.body;
      
      if (typeof enableAnimations !== 'boolean') {
        return res.status(400).json({ 
          message: 'Invalid animation preference value' 
        });
      }
      
      const userId = (req as any).session.userId;
      const updatedUser = await storage.updateUser(userId, { enableAnimations });
      
      if (!updatedUser) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      const { passwordHash, withdrawalPasswordHash, twoFactorSecret, ...safeUser } = updatedUser;
      res.json({ message: 'Animation preferences updated successfully', user: safeUser });
    } catch (error) {
      console.error('Animation preferences update error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Update Wingo Mode preference endpoint
  app.post('/api/user/wingo-mode', requireAuth, async (req, res) => {
    try {
      const { wingoMode } = req.body;
      
      if (typeof wingoMode !== 'boolean') {
        return res.status(400).json({ 
          message: 'Invalid Wingo Mode preference value' 
        });
      }
      
      const userId = (req as any).session.userId;
      const updatedUser = await storage.updateUser(userId, { wingoMode });
      
      if (!updatedUser) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      const { passwordHash, withdrawalPasswordHash, twoFactorSecret, ...safeUser } = updatedUser;
      res.json({ message: 'Wingo Mode preference updated successfully', user: safeUser });
    } catch (error) {
      console.error('Wingo Mode preference update error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Withdraw commission to wallet endpoint
  app.post('/api/user/withdraw-commission', requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId;
      console.log(`💰 Commission withdrawal request from user: ${userId}`);
      
      const user = await storage.getUser(userId);
      
      if (!user) {
        console.error(`❌ User not found: ${userId}`);
        return res.status(404).json({ message: 'User not found' });
      }
      
      // Check commission balance from user record
      let commissionBalance = parseFloat(user.totalCommission || "0");
      console.log(`💵 User record commission balance: $${commissionBalance}`);
      
      // If user.totalCommission is 0 or very small, verify against referrals table
      // This handles cases where the two sources might be out of sync
      if (commissionBalance < 0.00000001) {
        console.log(`🔍 Checking referrals table for commission...`);
        const stats = await storage.getReferralStats(userId);
        const referralCommission = parseFloat(stats.totalCommission || "0");
        console.log(`💵 Referrals table commission: $${referralCommission}`);
        
        if (referralCommission > 0) {
          // Sync the values - use referrals table as source of truth
          commissionBalance = referralCommission;
          await storage.updateUser(userId, { 
            totalCommission: referralCommission.toFixed(8)
          });
          console.log(`✅ Synced commission from referrals table: $${referralCommission}`);
        }
      }
      
      if (commissionBalance <= 0) {
        console.log(`⚠️ No commission available for user ${userId}`);
        return res.status(400).json({ message: 'No commission available to withdraw' });
      }
      
      // Calculate new balances
      const currentBalance = parseFloat(user.balance);
      const newBalance = (currentBalance + commissionBalance).toFixed(8);
      console.log(`📊 Balance update: $${currentBalance} → $${newBalance} (added $${commissionBalance})`);
      
      // Update user balance and reset available commission (but keep lifetime earnings)
      await storage.updateUser(userId, { 
        balance: newBalance,
        totalCommission: "0.00000000"
        // NOTE: lifetimeCommissionEarned is NOT reset - it tracks all-time earnings
      });
      console.log(`✅ User balance updated, available commission reset to 0`);
      
      // NOTE: We do NOT reset individual referral.totalCommission values
      // Those values represent the lifetime commission earned from each referral
      // and should be displayed in the Referral Program "Total Earned" section
      
      // Create transaction record
      await storage.createTransaction({
        userId,
        type: "commission_withdrawal",
        fiatAmount: commissionBalance.toFixed(8),
        fiatCurrency: "USD",
        status: "completed",
        paymentMethod: "internal",
        fee: "0.00000000"
      });
      console.log(`✅ Transaction record created`);
      
      res.json({ 
        message: 'Commission transferred to wallet successfully',
        amount: commissionBalance.toFixed(8),
        newBalance 
      });
      console.log(`✅ Commission withdrawal completed for user ${userId}`);
    } catch (error) {
      console.error('❌ Commission withdrawal error:', error);
      res.status(500).json({ message: 'Failed to withdraw commission. Please try again later.' });
    }
  });

  // Image border removal endpoint
  app.post('/api/image/remove-border', async (req, res) => {
    try {
      const { imageData, borderSize = 10 } = req.body;
      
      if (!imageData) {
        return res.status(400).json({ message: 'Image data is required' });
      }
      
      // Validate image format (base64 data URL)
      const dataUrlRegex = /^data:image\/(png|jpeg|jpg|gif|webp);base64,/;
      if (!dataUrlRegex.test(imageData)) {
        return res.status(400).json({ message: 'Invalid image format' });
      }
      
      // Extract base64 data
      const base64Data = imageData.split(',')[1];
      const imageBuffer = Buffer.from(base64Data, 'base64');
      
      // Get image metadata to determine crop dimensions
      const { width, height } = await sharp(imageBuffer).metadata();
      
      if (!width || !height) {
        return res.status(400).json({ message: 'Could not process image' });
      }
      
      // Calculate crop dimensions (remove border from all sides)
      const cropWidth = Math.max(1, width - (borderSize * 2));
      const cropHeight = Math.max(1, height - (borderSize * 2));
      
      // Process image to remove border
      const processedImageBuffer = await sharp(imageBuffer)
        .extract({
          left: borderSize,
          top: borderSize,
          width: cropWidth,
          height: cropHeight
        })
        .png() // Convert to PNG for consistent output
        .toBuffer();
      
      // Convert back to base64 data URL
      const processedBase64 = `data:image/png;base64,${processedImageBuffer.toString('base64')}`;
      
      res.json({ 
        processedImage: processedBase64,
        originalSize: { width, height },
        processedSize: { width: cropWidth, height: cropHeight }
      });
    } catch (error) {
      console.error('Image processing error:', error);
      res.status(500).json({ message: 'Failed to process image' });
    }
  });

  // DEVELOPMENT ONLY: Create admin user endpoint (remove in production)
  app.post('/api/dev/create-admin', async (req, res) => {
    try {
      // Check if admin already exists
      const existingAdmin = await storage.getUserByEmail('pursuer.ail-4d@icloud.com');
      if (existingAdmin) {
        return res.status(400).json({ message: 'Admin user already exists' });
      }
      
      const adminUser = await storage.createUser({
        password: 'admin123',
        confirmPassword: 'admin123',
        withdrawalPassword: 'admin456',
        acceptedTerms: true,
        email: 'pursuer.ail-4d@icloud.com'
      });
      
      // Update role to admin
      const updatedAdmin = await storage.updateUser(adminUser.id, { 
        role: "admin",
        balance: "10000.00000000"
      });
      
      if (updatedAdmin) {
        const { passwordHash, ...safeUser } = updatedAdmin;
        res.json({ message: 'Admin user created', user: safeUser });
      } else {
        res.status(500).json({ message: 'Failed to update admin user' });
      }
    } catch (error) {
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Admin routes
  app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      
      const result = await storage.getAllUsers(page, limit);
      const safeUsers = result.users.map(user => {
        const { passwordHash, ...safeUser } = user;
        return safeUser;
      });
      
      res.json({ users: safeUsers, total: result.total });
    } catch (error) {
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.get('/api/admin/users/:userId/sessions', requireAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      const sessions = await storage.getUserSessions(userId);
      res.json(sessions);
    } catch (error) {
      console.error('Error fetching user sessions:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.get('/api/admin/users/country-stats', requireAdmin, async (req, res) => {
    try {
      const countryCounts = await storage.getUserCountsByCountry();
      res.json(countryCounts);
    } catch (error) {
      console.error('Error fetching user country statistics:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.post('/api/admin/users/:userId/toggle', requireAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      const user = await storage.toggleUserStatus(userId);
      
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      // Broadcast admin dashboard update for user status toggle
      broadcastAdminDashboardUpdate();
      
      const { passwordHash, ...safeUser } = user;
      res.json(safeUser);
    } catch (error) {
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.post('/api/admin/users/:userId/adjust-balance', requireAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      const adjustBalanceSchema = z.object({
        amount: z.string().refine((val) => {
          const num = parseFloat(val);
          return !isNaN(num) && isFinite(num) && Math.abs(num) <= 1000000;
        }, {
          message: "Amount must be a valid number within reasonable limits"
        })
      });
      
      const { amount } = adjustBalanceSchema.parse(req.body);
      
      const adminId = (req as any).session.userId;
      const user = await storage.adjustUserBalance(userId, amount, adminId);
      
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      // Send deposit confirmation email if amount is positive (deposit)
      const amountNum = parseFloat(amount);
      if (amountNum > 0) {
        try {
          // Create a transaction record for the email
          const transaction = await storage.createTransaction({
            userId: user.id,
            type: 'deposit',
            fiatAmount: amount,
            paymentMethod: 'agent',
            status: 'completed',
            externalId: `admin-deposit-${Date.now()}`
          });
          
          await sendDepositConfirmationEmail(
            user.email,
            amountNum.toFixed(2),
            'USD',
            transaction.id,
            user.balance,
            storage
          );
        } catch (emailError) {
          console.error(`Failed to send admin deposit email to ${user.email}:`, emailError);
          // Don't fail the request if email fails
        }
      }
      
      // Broadcast admin dashboard update for balance adjustment
      broadcastAdminDashboardUpdate();
      
      const { passwordHash, ...safeUser } = user;
      res.json(safeUser);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid balance adjustment data', errors: error.errors });
      } else {
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  app.post('/api/admin/users/:userId/award-commission', requireAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      const awardCommissionSchema = z.object({
        coins: z.number().int().positive().max(1000000),
      });
      
      const { coins } = awardCommissionSchema.parse(req.body);
      
      const usdAmount = (coins / 100).toFixed(8);
      
      const adminId = (req as any).session.userId;
      const user = await storage.getUser(userId);
      
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      const newTotalCommission = (parseFloat(user.totalCommission) + parseFloat(usdAmount)).toFixed(8);
      const newLifetimeCommission = (parseFloat(user.lifetimeCommissionEarned || "0") + parseFloat(usdAmount)).toFixed(8);
      
      const updatedUser = await storage.updateUser(userId, {
        totalCommission: newTotalCommission,
        lifetimeCommissionEarned: newLifetimeCommission
      });
      
      if (!updatedUser) {
        return res.status(404).json({ message: 'Failed to update user' });
      }
      
      await storage.createTransaction({
        userId,
        type: 'referral_bonus',
        fiatAmount: usdAmount,
        paymentMethod: 'internal',
        status: 'completed',
        externalId: `admin-commission-${Date.now()}`
      });
      
      await storage.logAdminAction({
        adminId,
        action: 'award_commission',
        targetId: userId,
        details: { 
          coins, 
          usdAmount,
          previousCommission: user.totalCommission,
          newCommission: newTotalCommission
        }
      });
      
      broadcastAdminDashboardUpdate();
      
      const { passwordHash, ...safeUser } = updatedUser;
      res.json(safeUser);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid commission data', errors: error.errors });
      } else {
        console.error('Award commission error:', error);
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  app.post('/api/admin/users/:userId/ban', requireAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      
      // Check if user is admin before banning
      const targetUser = await storage.getUser(userId);
      if (!targetUser) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      if (targetUser.role === 'admin') {
        return res.status(403).json({ message: 'Admin users cannot be banned' });
      }
      
      const banSchema = z.object({
        reason: z.string().min(1, 'Ban reason is required'),
        bannedUntil: z.string().optional()
      });
      
      const { reason, bannedUntil } = banSchema.parse(req.body);
      
      const bannedUntilDate = bannedUntil ? new Date(bannedUntil) : undefined;
      const user = await storage.banUser(userId, reason, bannedUntilDate);
      
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      // Broadcast admin dashboard update for user ban
      broadcastAdminDashboardUpdate();
      
      const { passwordHash, ...safeUser } = user;
      res.json(safeUser);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid ban data', errors: error.errors });
      } else {
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  app.post('/api/admin/users/:userId/unban', requireAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      const user = await storage.unbanUser(userId);
      
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      // Broadcast admin dashboard update for user unban
      broadcastAdminDashboardUpdate();
      
      const { passwordHash, ...safeUser } = user;
      res.json(safeUser);
    } catch (error) {
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Update user bet limit endpoint
  app.post('/api/admin/users/:userId/bet-limit', requireAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      const betLimitSchema = z.object({
        maxBetLimit: z.string().refine((val) => {
          const num = parseFloat(val);
          return !isNaN(num) && isFinite(num) && num >= 0 && num <= 1000000;
        }, {
          message: "Bet limit must be a valid positive number within reasonable limits"
        })
      });
      
      const { maxBetLimit } = betLimitSchema.parse(req.body);
      
      const adminId = (req as any).session.userId;
      const user = await storage.updateUser(userId, { maxBetLimit });
      
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      // Log admin action
      await storage.logAdminAction({
        adminId,
        action: 'bet_limit_update',
        targetId: userId,
        details: { newBetLimit: maxBetLimit }
      });
      
      // Broadcast admin dashboard update for bet limit change
      broadcastAdminDashboardUpdate();
      
      const { passwordHash, ...safeUser } = user;
      res.json(safeUser);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid bet limit data', errors: error.errors });
      } else {
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  app.get('/api/admin/analytics', requireAdmin, async (req, res) => {
    try {
      const analytics = await storage.getOverallAnalytics();
      res.json(analytics);
    } catch (error) {
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Get payment statistics
  app.get('/api/admin/payment-statistics', requireAdmin, async (req, res) => {
    try {
      const users = await storage.getAllUsers(1, 100000);
      
      // Calculate total deposits amount
      const totalDepositsAmount = users.users.reduce((sum, user) => {
        return sum + parseFloat(user.totalDeposits || '0');
      }, 0);

      // Calculate total withdrawals amount
      const totalWithdrawalsAmount = users.users.reduce((sum, user) => {
        return sum + parseFloat(user.totalWithdrawals || '0');
      }, 0);

      // Get all withdrawal requests to calculate pending and cancelled counts
      const allWithdrawals = await storage.getAllWithdrawalRequests(1, 100000);
      const pendingWithdrawalsCount = allWithdrawals.requests.filter((w: any) => w.status === 'pending').length;
      const cancelledWithdrawalsCount = allWithdrawals.requests.filter((w: any) => w.status === 'rejected' || w.status === 'cancelled').length;

      // Get all deposit transactions to calculate pending and cancelled deposits count
      let pendingDepositsCount = 0;
      let cancelledDepositsCount = 0;
      for (const user of users.users) {
        const transactions = await storage.getTransactionsByUser(user.id);
        const pendingDeposits = transactions.filter(t => t.type === 'deposit' && t.status === 'pending');
        const cancelledDeposits = transactions.filter(t => t.type === 'deposit' && (t.status === 'cancelled' || t.status === 'failed'));
        pendingDepositsCount += pendingDeposits.length;
        cancelledDepositsCount += cancelledDeposits.length;
      }

      // Total pending payments = pending deposits + pending withdrawals
      const pendingPaymentsCount = pendingDepositsCount + pendingWithdrawalsCount;
      
      // Total cancelled payments = cancelled deposits + cancelled withdrawals
      const cancelledPaymentsCount = cancelledDepositsCount + cancelledWithdrawalsCount;

      res.json({
        totalDepositsAmount: totalDepositsAmount.toFixed(2),
        totalWithdrawalsAmount: totalWithdrawalsAmount.toFixed(2),
        pendingPaymentsCount,
        cancelledPaymentsCount
      });
    } catch (error) {
      console.error('Error fetching payment statistics:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Get revenue forecasting data
  app.get('/api/admin/analytics/revenue-forecast', requireAdmin, async (req, res) => {
    try {
      const days = parseInt(req.query.days as string) || 30;
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
      
      const games = await storage.getGameHistory(1000);
      
      // Group games by day
      const revenueByDay = new Map<string, { date: string; revenue: number; bets: number; volume: number }>();
      
      games.forEach(game => {
        const gameDate = new Date(game.endTime || game.createdAt);
        if (gameDate >= startDate && gameDate <= endDate && game.status === 'completed') {
          const dayKey = gameDate.toISOString().split('T')[0];
          const existing = revenueByDay.get(dayKey) || { date: dayKey, revenue: 0, bets: 0, volume: 0 };
          existing.revenue += parseFloat(game.houseProfit || '0');
          existing.bets += 1;
          existing.volume += parseFloat(game.totalBetsAmount || '0');
          revenueByDay.set(dayKey, existing);
        }
      });
      
      const data = Array.from(revenueByDay.values()).sort((a, b) => a.date.localeCompare(b.date));
      
      // Calculate simple linear forecast for next 7 days
      const forecast = [];
      if (data.length > 1) {
        const recent = data.slice(-7);
        const avgRevenue = recent.reduce((sum, d) => sum + d.revenue, 0) / recent.length;
        const avgGrowth = recent.length > 1 
          ? (recent[recent.length - 1].revenue - recent[0].revenue) / (recent.length - 1)
          : 0;
        
        for (let i = 1; i <= 7; i++) {
          const forecastDate = new Date(endDate.getTime() + i * 24 * 60 * 60 * 1000);
          forecast.push({
            date: forecastDate.toISOString().split('T')[0],
            revenue: Math.max(0, avgRevenue + avgGrowth * i),
            isForecast: true
          });
        }
      }
      
      res.json({ historical: data, forecast });
    } catch (error) {
      console.error('Error fetching revenue forecast:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Get player behavior analysis
  app.get('/api/admin/analytics/player-behavior', requireAdmin, async (req, res) => {
    try {
      const users = await storage.getAllUsers(1, 10000);
      
      // Calculate behavior metrics
      const activePlayers = users.users.filter(u => parseFloat(u.totalBetsAmount || '0') > 0).length;
      const totalBets = users.users.reduce((sum, u) => sum + (parseInt(u.totalBetsAmount || '0') > 0 ? 1 : 0), 0);
      const avgBetsPerPlayer = users.users.length > 0 
        ? totalBets / users.users.length 
        : 0;
      
      // Player segmentation by activity
      const playerSegments = {
        high: users.users.filter(u => parseFloat(u.totalBetsAmount || '0') > 1000).length,
        medium: users.users.filter(u => {
          const amount = parseFloat(u.totalBetsAmount || '0');
          return amount > 100 && amount <= 1000;
        }).length,
        low: users.users.filter(u => {
          const amount = parseFloat(u.totalBetsAmount || '0');
          return amount > 0 && amount <= 100;
        }).length,
        inactive: users.users.filter(u => parseFloat(u.totalBetsAmount || '0') === 0).length
      };
      
      // VIP level distribution
      const vipDistribution = users.users.reduce((acc, user) => {
        acc[user.vipLevel] = (acc[user.vipLevel] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      // Win/Loss player analysis
      const winningPlayers = users.users.filter(u => parseFloat(u.totalWinnings || '0') > parseFloat(u.totalLosses || '0')).length;
      const losingPlayers = users.users.filter(u => parseFloat(u.totalLosses || '0') > parseFloat(u.totalWinnings || '0')).length;
      
      res.json({
        totalPlayers: users.total,
        activePlayers,
        avgBetsPerPlayer: Math.round(avgBetsPerPlayer * 100) / 100,
        playerSegments,
        vipDistribution,
        winningPlayers,
        losingPlayers,
        retentionRate: users.total > 0 ? (activePlayers / users.total * 100).toFixed(2) : '0'
      });
    } catch (error) {
      console.error('Error fetching player behavior:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Get win/loss ratio data
  app.get('/api/admin/analytics/win-loss-ratio', requireAdmin, async (req, res) => {
    try {
      const users = await storage.getAllUsers(1, 10000);
      const games = await storage.getGameHistory(1000);
      
      // Calculate overall win/loss ratio
      const totalWinnings = users.users.reduce((sum, u) => sum + parseFloat(u.totalWinnings || '0'), 0);
      const totalLosses = users.users.reduce((sum, u) => sum + parseFloat(u.totalLosses || '0'), 0);
      const overallRatio = totalLosses > 0 ? totalWinnings / totalLosses : 0;
      
      // Calculate win rate for completed games
      const completedGames = games.filter(g => g.status === 'completed');
      const totalRevenue = completedGames.reduce((sum, g) => sum + parseFloat(g.houseProfit || '0'), 0);
      const totalVolume = completedGames.reduce((sum, g) => sum + parseFloat(g.totalBetsAmount || '0'), 0);
      const houseEdge = totalVolume > 0 ? (totalRevenue / totalVolume * 100).toFixed(2) : '0';
      
      // Distribution by result type
      const resultDistribution = completedGames.reduce((acc, game) => {
        if (game.result !== null) {
          const color = game.resultColor || 'unknown';
          acc[color] = (acc[color] || 0) + 1;
        }
        return acc;
      }, {} as Record<string, number>);
      
      // Player profit distribution
      const profitDistribution = {
        highProfit: users.users.filter(u => parseFloat(u.totalWinnings || '0') - parseFloat(u.totalLosses || '0') > 500).length,
        smallProfit: users.users.filter(u => {
          const profit = parseFloat(u.totalWinnings || '0') - parseFloat(u.totalLosses || '0');
          return profit > 0 && profit <= 500;
        }).length,
        smallLoss: users.users.filter(u => {
          const profit = parseFloat(u.totalWinnings || '0') - parseFloat(u.totalLosses || '0');
          return profit < 0 && profit >= -500;
        }).length,
        highLoss: users.users.filter(u => parseFloat(u.totalWinnings || '0') - parseFloat(u.totalLosses || '0') < -500).length
      };
      
      res.json({
        overallRatio: overallRatio.toFixed(2),
        totalWinnings: totalWinnings.toFixed(2),
        totalLosses: totalLosses.toFixed(2),
        houseEdge,
        resultDistribution,
        profitDistribution
      });
    } catch (error) {
      console.error('Error fetching win/loss ratio:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Get peak hours analysis
  app.get('/api/admin/analytics/peak-hours', requireAdmin, async (req, res) => {
    try {
      const days = parseInt(req.query.days as string) || 7;
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
      
      const games = await storage.getGameHistory(1000);
      
      // Initialize hourly data
      const hourlyActivity = Array.from({ length: 24 }, (_, i) => ({
        hour: i,
        bets: 0,
        revenue: 0,
        visitors: 0
      }));
      
      // Aggregate games by hour
      games.forEach(game => {
        const gameDate = new Date(game.createdAt);
        if (gameDate >= startDate && gameDate <= endDate) {
          const hour = gameDate.getHours();
          hourlyActivity[hour].bets += 1;
          hourlyActivity[hour].revenue += parseFloat(game.houseProfit || '0');
        }
      });
      
      // Get traffic stats for visitor data by hour (approximate)
      const trafficStats = await storage.getTrafficStats(startDate, endDate);
      if (trafficStats.dailyStats && trafficStats.dailyStats.length > 0) {
        const avgVisitorsPerDay = trafficStats.dailyStats.reduce((sum, day) => sum + day.uniqueVisitors, 0) / trafficStats.dailyStats.length;
        const avgVisitorsPerHour = Math.round(avgVisitorsPerDay / 24);
        hourlyActivity.forEach((h, i) => {
          h.visitors = Math.round(avgVisitorsPerHour * (0.8 + Math.random() * 0.4));
        });
      }
      
      // Find peak hours
      const peakBettingHour = hourlyActivity.reduce((max, curr) => curr.bets > max.bets ? curr : max);
      const peakRevenueHour = hourlyActivity.reduce((max, curr) => curr.revenue > max.revenue ? curr : max);
      const peakVisitorHour = hourlyActivity.reduce((max, curr) => curr.visitors > max.visitors ? curr : max);
      
      res.json({
        hourlyActivity,
        peakHours: {
          betting: peakBettingHour.hour,
          revenue: peakRevenueHour.hour,
          visitors: peakVisitorHour.hour
        }
      });
    } catch (error) {
      console.error('Error fetching peak hours:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Generate user data report PDF
  app.get('/api/admin/user-report/:userId', requireAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      const PDFDocument = (await import('pdfkit')).default;
      const path = await import('path');
      
      // Fetch all user data
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      // Get user sessions (login history with IPs)
      const sessions = await storage.getUserSessions(userId);
      
      // Get user bets
      const bets = await storage.getBetsByUser(userId);
      
      // Get user transactions
      const transactions = await storage.getTransactionsByUser(userId);

      // Create PDF document with custom styling
      const doc = new PDFDocument({ 
        size: 'A4',
        margin: 40,
        info: {
          Title: `3xBet User Report - ${user.email}`,
          Author: '3xBet Gaming Platform',
          Subject: 'Comprehensive User Activity Report'
        }
      });

      // Collect PDF chunks in a buffer
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => {
        const pdfBuffer = Buffer.concat(chunks);
        // Set response headers for PDF download
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="3xbet-user-report-${user.publicId || userId}.pdf"`);
        res.setHeader('Content-Length', pdfBuffer.length.toString());
        res.send(pdfBuffer);
      });
      doc.on('error', (err) => {
        console.error('PDF generation stream error:', err);
        if (!res.headersSent) {
          res.status(500).json({ message: 'Error generating PDF report' });
        }
      });

      // Brand colors
      const brandPurple = '#7c3aed';
      const brandBlue = '#6366f1';
      const darkBg = '#1e1b4b';
      const lightText = '#e0e7ff';
      const successGreen = '#10b981';
      const warningRed = '#ef4444';

      // Helper function to draw a header background
      const drawHeaderBg = () => {
        doc.save()
           .rect(0, 0, doc.page.width, 120)
           .fillAndStroke(brandPurple, brandPurple)
           .restore();
      };

      // Helper function to add logo
      const addLogo = async () => {
        try {
          // Try multiple logo paths
          const logoPaths = [
            path.join(process.cwd(), 'attached_assets', 'generated_images', '3Xbet_PWA_app_icon_d87f3d00.png'),
            path.join(process.cwd(), 'attached_assets', 'generated_images', '3Xbet_icon_with_green_ring_361ec355.png'),
            path.join(process.cwd(), 'attached_assets', 'generated_images', '3Xbet_purple-slate_gradient_icon_d346749c.png')
          ];
          
          for (const logoPath of logoPaths) {
            try {
              const fs = await import('fs');
              if (fs.existsSync(logoPath)) {
                doc.image(logoPath, 50, 30, { width: 70, height: 70 });
                return;
              }
            } catch {}
          }
        } catch (err) {
          console.error('Logo not found, skipping:', err);
        }
      };

      // Helper function to add section header with style
      const addSectionHeader = (title: string, icon = '●') => {
        doc.fontSize(18)
           .fillColor(brandPurple)
           .text(`${icon} ${title}`, { underline: true });
        doc.moveDown(0.5);
        doc.fillColor('#000000');
      };

      // Helper function to add data row with label and value
      const addDataRow = (label: string, value: any, color = '#000000') => {
        doc.fontSize(11)
           .fillColor('#4b5563')
           .font('Helvetica-Bold')
           .text(label, { continued: true, width: 200 })
           .fillColor(color)
           .font('Helvetica')
           .text(value || 'N/A');
        doc.moveDown(0.4);
      };

      // Helper function to create a styled table
      const createTable = (headers: string[], rows: any[][], columnWidths: number[]) => {
        const startX = 50;
        let startY = doc.y;
        const rowHeight = 25;

        // Draw header
        doc.save()
           .rect(startX, startY, doc.page.width - 100, rowHeight)
           .fillAndStroke(brandPurple, brandPurple);
        
        doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold');
        headers.forEach((header, i) => {
          const x = startX + columnWidths.slice(0, i).reduce((a, b) => a + b, 0) + 10;
          doc.text(header, x, startY + 8, { width: columnWidths[i] - 20 });
        });
        doc.restore();

        startY += rowHeight;

        // Draw rows
        rows.forEach((row, rowIdx) => {
          const bgColor = rowIdx % 2 === 0 ? '#f9fafb' : '#ffffff';
          doc.save()
             .rect(startX, startY, doc.page.width - 100, rowHeight)
             .fillAndStroke(bgColor, '#e5e7eb');

          doc.fillColor('#000000').fontSize(9).font('Helvetica');
          row.forEach((cell, i) => {
            const x = startX + columnWidths.slice(0, i).reduce((a, b) => a + b, 0) + 10;
            doc.text(String(cell || ''), x, startY + 8, { width: columnWidths[i] - 20 });
          });
          doc.restore();

          startY += rowHeight;
        });

        doc.y = startY + 10;
      };

      // Draw header background and add logo
      drawHeaderBg();
      await addLogo();

      // Add title
      doc.fontSize(32)
         .fillColor('#ffffff')
         .font('Helvetica-Bold')
         .text('USER ACTIVITY REPORT', 140, 40);
      
      doc.fontSize(14)
         .fillColor(lightText)
         .font('Helvetica')
         .text('3xBet Gaming Platform | Comprehensive User Analysis', 140, 78);
      
      // Add report metadata
      doc.fontSize(10)
         .fillColor('#c7d2fe')
         .text(`Generated: ${new Date().toLocaleString('en-US', { 
           year: 'numeric', month: 'long', day: 'numeric', 
           hour: '2-digit', minute: '2-digit' 
         })}`, 140, 100);

      doc.moveDown(1.5);

      // User Information Box
      const infoBoxY = doc.y;
      doc.save()
         .roundedRect(50, infoBoxY, doc.page.width - 100, 350, 10)
         .fillAndStroke('#f3f4f6', '#e5e7eb')
         .restore();

      doc.y = infoBoxY + 15;
      doc.x = 60;

      addSectionHeader('👤 User Information', '');
      addDataRow('User ID:', user.publicId || user.id, brandBlue);
      addDataRow('Email Address:', user.email, brandBlue);
      addDataRow('Account Role:', user.role.toUpperCase(), brandPurple);
      addDataRow('VIP Level:', user.vipLevel.toUpperCase(), '#f59e0b');
      addDataRow('Account Status:', user.isActive ? '✓ Active' : '✗ Inactive', user.isActive ? successGreen : warningRed);
      addDataRow('Current Balance:', `$${parseFloat(user.balance || '0').toFixed(2)}`, successGreen);
      addDataRow('Registration Country:', user.registrationCountry || 'Not available');
      addDataRow('Registration IP:', user.registrationIp || 'Not recorded');
      addDataRow('Last Login IP:', user.lastLoginIp || 'Not recorded');
      addDataRow('2FA Security:', user.twoFactorEnabled ? '✓ Enabled' : '✗ Disabled', user.twoFactorEnabled ? successGreen : warningRed);
      addDataRow('Withdrawal Password:', user.withdrawalPasswordHash ? '✓ Set' : '✗ Not Set', user.withdrawalPasswordHash ? successGreen : warningRed);
      addDataRow('Profile Photo:', user.profilePhoto ? '✓ Uploaded' : '✗ Not Set', user.profilePhoto ? successGreen : '#9ca3af');
      addDataRow('Member Since:', new Date(user.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }));

      doc.moveDown(1);

      // Executive Summary Box
      doc.addPage();
      const summaryBoxY = doc.y;
      doc.save()
         .roundedRect(50, summaryBoxY, doc.page.width - 100, 180, 10)
         .fillAndStroke('#ede9fe', '#c4b5fd')
         .restore();

      doc.y = summaryBoxY + 15;
      doc.x = 60;

      addSectionHeader('📊 Executive Summary', '');
      
      const accountAge = Math.floor((new Date().getTime() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24));
      const totalActivity = bets.length + transactions.length;
      const avgDailyActivity = accountAge > 0 ? (totalActivity / accountAge).toFixed(1) : '0';
      const lifetimeValue = parseFloat(user.totalDeposits || '0');
      const riskLevel = lifetimeValue > 5000 ? 'High Value' : lifetimeValue > 1000 ? 'Medium Value' : 'Low Value';
      
      addDataRow('Account Age:', `${accountAge} days`, brandPurple);
      addDataRow('Total Activities:', `${totalActivity} (${avgDailyActivity}/day avg)`, brandBlue);
      addDataRow('Lifetime Value (LTV):', `$${lifetimeValue.toFixed(2)}`, successGreen);
      addDataRow('User Classification:', riskLevel, lifetimeValue > 5000 ? successGreen : '#f59e0b');
      addDataRow('Activity Status:', sessions.length > 0 ? '✓ Active User' : '⚠ Inactive', sessions.length > 0 ? successGreen : warningRed);
      addDataRow('Last Activity:', sessions.length > 0 ? new Date(sessions[0].loginTime).toLocaleDateString('en-US') : 'No activity recorded');

      doc.moveDown(2);

      // Financial Summary with Stats Cards
      addSectionHeader('💰 Financial Summary');
      
      const netProfit = parseFloat(user.totalWinnings || '0') - parseFloat(user.totalLosses || '0');
      const winRate = bets.length > 0 ? ((bets.filter(b => b.status === 'won').length / bets.length) * 100).toFixed(1) : '0';
      
      const financialStats = [
        ['Total Deposits', `$${parseFloat(user.totalDeposits || '0').toFixed(2)}`, successGreen],
        ['Total Withdrawals', `$${parseFloat(user.totalWithdrawals || '0').toFixed(2)}`, brandBlue],
        ['Total Winnings', `$${parseFloat(user.totalWinnings || '0').toFixed(2)}`, successGreen],
        ['Total Losses', `$${parseFloat(user.totalLosses || '0').toFixed(2)}`, warningRed],
        ['Net Profit/Loss', `$${netProfit.toFixed(2)}`, netProfit >= 0 ? successGreen : warningRed],
        ['Total Bets Amount', `$${parseFloat(user.totalBetsAmount || '0').toFixed(2)}`, brandPurple],
        ['Commission Earned', `$${parseFloat(user.totalCommission || '0').toFixed(2)}`, '#f59e0b'],
        ['Win Rate', `${winRate}%`, parseFloat(winRate) > 50 ? successGreen : warningRed]
      ];

      financialStats.forEach(([label, value, color]) => {
        addDataRow(label, value, color);
      });

      doc.moveDown(1.5);

      // Referral & Team Information
      addSectionHeader('🔗 Referral & Team');
      addDataRow('Referral Code:', user.referralCode || 'Not set', brandPurple);
      addDataRow('Referred By:', user.referredBy || 'Direct signup');
      addDataRow('Qualified Team Size:', user.teamSize || 0);
      addDataRow('Total Team Members:', user.totalTeamMembers || 0);

      // New page for login history
      doc.addPage();
      addSectionHeader('🔐 Login History & Security');
      
      if (sessions && sessions.length > 0) {
        const uniqueIPs = Array.from(new Set(sessions.map(s => s.ipAddress)));
        doc.fontSize(11).fillColor('#4b5563').text(`Total Unique IP Addresses: ${uniqueIPs.length}`);
        doc.fontSize(11).fillColor('#4b5563').text(`Total Login Sessions: ${sessions.length}`);
        doc.moveDown(1);
        
        const sessionRows = sessions.slice(0, 15).map((s, idx) => [
          `${idx + 1}`,
          s.ipAddress,
          s.deviceType || 'Unknown',
          new Date(s.loginTime).toLocaleString()
        ]);

        createTable(['#', 'IP Address', 'Device', 'Login Time'], sessionRows, [40, 150, 120, 200]);

        if (sessions.length > 15) {
          doc.fontSize(10).fillColor('#6b7280').text(`... and ${sessions.length - 15} more sessions`);
        }
      } else {
        doc.fontSize(11).fillColor('#9ca3af').text('No login history available');
      }

      // Transaction History
      doc.addPage();
      addSectionHeader('💳 Transaction History');
      
      if (transactions && transactions.length > 0) {
        doc.fontSize(11).fillColor('#4b5563').text(`Total Transactions: ${transactions.length}`);
        doc.moveDown(1);
        
        const txnRows = transactions.slice(0, 20).map((txn, idx) => {
          const amount = txn.fiatAmount || txn.cryptoAmount || '0';
          const currency = txn.fiatCurrency || txn.cryptoCurrency || 'USD';
          return [
            `${idx + 1}`,
            txn.type.toUpperCase(),
            `$${parseFloat(amount).toFixed(2)} ${currency}`,
            txn.status,
            new Date(txn.createdAt).toLocaleDateString()
          ];
        });

        createTable(['#', 'Type', 'Amount', 'Status', 'Date'], txnRows, [40, 100, 120, 100, 150]);

        if (transactions.length > 20) {
          doc.fontSize(10).fillColor('#6b7280').text(`... and ${transactions.length - 20} more transactions`);
        }
      } else {
        doc.fontSize(11).fillColor('#9ca3af').text('No transactions available');
      }

      // Wallet Addresses
      if (transactions && transactions.length > 0) {
        const walletAddresses = Array.from(new Set(transactions
          .filter(t => t.paymentAddress)
          .map(t => t.paymentAddress)));
        
        if (walletAddresses.length > 0) {
          doc.moveDown(2);
          addSectionHeader('🔑 Wallet Addresses Used');
          doc.fontSize(11).fillColor('#4b5563').text(`Total Unique Wallets: ${walletAddresses.length}`);
          doc.moveDown(0.5);
          
          walletAddresses.slice(0, 10).forEach((addr, idx) => {
            doc.fontSize(9).fillColor('#000000').text(`${idx + 1}. ${addr}`);
            doc.moveDown(0.3);
          });

          if (walletAddresses.length > 10) {
            doc.fontSize(10).fillColor('#6b7280').text(`... and ${walletAddresses.length - 10} more wallets`);
          }
        }
      }

      // Betting History
      doc.addPage();
      addSectionHeader('🎲 Betting History');
      
      if (bets && bets.length > 0) {
        const wonBets = bets.filter(b => b.status === 'won').length;
        const lostBets = bets.filter(b => b.status === 'lost').length;
        
        doc.fontSize(11).fillColor('#4b5563').text(`Total Bets: ${bets.length}`);
        doc.fontSize(11).fillColor(successGreen).text(`Won: ${wonBets} (${((wonBets / bets.length) * 100).toFixed(1)}%)`);
        doc.fontSize(11).fillColor(warningRed).text(`Lost: ${lostBets} (${((lostBets / bets.length) * 100).toFixed(1)}%)`);
        doc.moveDown(1);
        
        const betRows = bets.slice(0, 25).map((bet, idx) => {
          const payout = bet.actualPayout ? `$${parseFloat(bet.actualPayout).toFixed(2)}` : '-';
          return [
            `${idx + 1}`,
            bet.betType.toUpperCase(),
            bet.betValue,
            `$${parseFloat(bet.amount).toFixed(2)}`,
            payout,
            bet.status.toUpperCase()
          ];
        });

        createTable(['#', 'Type', 'Value', 'Bet', 'Payout', 'Status'], betRows, [30, 80, 80, 80, 80, 80]);

        if (bets.length > 25) {
          doc.fontSize(10).fillColor('#6b7280').text(`... and ${bets.length - 25} more bets`);
        }
        
        // Betting Patterns Analysis
        doc.moveDown(2);
        addSectionHeader('📈 Betting Patterns & Analytics');
        
        const betTypes = bets.reduce((acc, bet) => {
          acc[bet.betType] = (acc[bet.betType] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);
        
        const favoriteBetType = Object.entries(betTypes).sort((a, b) => b[1] - a[1])[0];
        const avgBetAmount = bets.length > 0 ? (bets.reduce((sum, b) => sum + parseFloat(b.amount), 0) / bets.length).toFixed(2) : '0';
        const totalWagered = bets.reduce((sum, b) => sum + parseFloat(b.amount), 0).toFixed(2);
        const largestBet = bets.length > 0 ? Math.max(...bets.map(b => parseFloat(b.amount))).toFixed(2) : '0';
        const smallestBet = bets.length > 0 ? Math.min(...bets.map(b => parseFloat(b.amount))).toFixed(2) : '0';
        
        addDataRow('Favorite Bet Type:', favoriteBetType ? `${favoriteBetType[0].toUpperCase()} (${favoriteBetType[1]} bets)` : 'N/A', brandPurple);
        addDataRow('Total Amount Wagered:', `$${totalWagered}`, brandBlue);
        addDataRow('Average Bet Size:', `$${avgBetAmount}`, '#000000');
        addDataRow('Largest Single Bet:', `$${largestBet}`, successGreen);
        addDataRow('Smallest Single Bet:', `$${smallestBet}`, '#9ca3af');
        
        // Bet type distribution
        if (Object.keys(betTypes).length > 0) {
          doc.moveDown(1);
          doc.fontSize(12).fillColor(brandPurple).text('Bet Type Distribution:', { underline: true });
          doc.moveDown(0.5);
          
          Object.entries(betTypes).forEach(([type, count]) => {
            const percentage = ((count / bets.length) * 100).toFixed(1);
            doc.fontSize(10)
               .fillColor('#000000')
               .text(`${type.toUpperCase()}: ${count} bets (${percentage}%)`);
            doc.moveDown(0.3);
          });
        }
        
      } else {
        doc.fontSize(11).fillColor('#9ca3af').text('No betting history available');
      }

      // Professional Footer on all pages
      const pageRange = doc.bufferedPageRange();
      const totalPages = pageRange.count;
      for (let i = 0; i < totalPages; i++) {
        const pageNumber = pageRange.start + i;
        doc.switchToPage(pageNumber);
        
        // Footer background with gradient effect (simulated with rectangles)
        doc.save()
           .rect(0, doc.page.height - 60, doc.page.width, 60)
           .fillAndStroke(darkBg, darkBg)
           .restore();

        // Top border line
        doc.save()
           .moveTo(0, doc.page.height - 60)
           .lineTo(doc.page.width, doc.page.height - 60)
           .lineWidth(2)
           .strokeColor(brandPurple)
           .stroke()
           .restore();

        // Footer text - Company name and tagline
        doc.fontSize(11)
           .fillColor('#ffffff')
           .font('Helvetica-Bold')
           .text(
             '3xBet Gaming Platform',
             50,
             doc.page.height - 45,
             { align: 'center' }
           );

        doc.fontSize(8)
           .fillColor('#c7d2fe')
           .font('Helvetica')
           .text(
             'Professional Betting Solutions | Comprehensive User Analytics',
             50,
             doc.page.height - 32,
             { align: 'center' }
           );

        // Page number and confidentiality notice
        doc.fontSize(8)
           .fillColor(lightText)
           .text(
             `Page ${i + 1} of ${totalPages} | Generated: ${new Date().toLocaleDateString('en-US')} ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} | CONFIDENTIAL`,
             50,
             doc.page.height - 18,
             { align: 'center' }
           );
      }

      // Finalize the PDF
      doc.end();
      
    } catch (error) {
      console.error('Error generating user report PDF:', error);
      // Only send error response if headers haven't been sent yet
      if (!res.headersSent) {
        res.status(500).json({ message: 'Error generating report' });
      }
    }
  });

  // Get daily visitor statistics
  app.get('/api/admin/traffic/daily', requireAdmin, async (req, res) => {
    try {
      const dateStr = req.query.date as string;
      const date = dateStr ? new Date(dateStr) : new Date();
      const stats = await storage.getDailyVisitors(date);
      res.json(stats);
    } catch (error) {
      console.error('Error fetching daily visitors:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Get comprehensive traffic statistics
  app.get('/api/admin/traffic/stats', requireAdmin, async (req, res) => {
    try {
      const startDateStr = req.query.startDate as string;
      const endDateStr = req.query.endDate as string;
      
      // Default to last 7 days if no dates provided
      const endDate = endDateStr ? new Date(endDateStr) : new Date();
      const startDate = startDateStr ? new Date(startDateStr) : new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
      
      const stats = await storage.getTrafficStats(startDate, endDate);
      res.json(stats);
    } catch (error) {
      console.error('Error fetching traffic stats:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Track page view (for SPA navigation)
  app.post('/api/analytics/page-view', async (req, res) => {
    try {
      const session = (req as any).session;
      const clientIP = getRealIP(req);
      const country = (req.headers['cf-ipcountry'] as string) || (req as any).cloudflare?.country || null;
      const userAgent = req.headers['user-agent'];
      const parsedUA = parseUserAgent(userAgent);
      const { path } = req.body;

      if (!path) {
        return res.status(400).json({ message: 'Path is required' });
      }

      await storage.createPageView({
        userId: session?.userId || null,
        path,
        ipAddress: clientIP,
        country: country,
        userAgent: userAgent || null,
        browserName: parsedUA.browserName,
        deviceType: parsedUA.deviceType,
        operatingSystem: parsedUA.operatingSystem,
        referrer: req.headers.referer || null,
        sessionId: session?.id || null,
      });

      res.json({ success: true });
    } catch (error) {
      console.error('Error tracking page view:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Get user activity/sessions for admin
  app.get('/api/admin/user-activity', requireAdmin, async (req, res) => {
    try {
      const userId = req.query.userId as string;
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      
      if (userId) {
        // Get sessions for specific user
        const sessions = await storage.getUserSessions(userId);
        
        // Parse user agent for each session to extract browser/device info
        const enrichedSessions = sessions.map(session => {
          const parsedUA = parseUserAgent(session.userAgent || '');
          return {
            ...session,
            browserName: parsedUA.browserName,
            browserVersion: parsedUA.browserVersion,
            deviceType: parsedUA.deviceType,
            operatingSystem: parsedUA.operatingSystem
          };
        });
        
        res.json({ sessions: enrichedSessions, total: enrichedSessions.length });
      } else {
        // Get all users with their session count and last activity
        const usersResult = await storage.getAllUsers(page, limit);
        const enrichedUsers = await Promise.all(
          usersResult.users.map(async (user) => {
            const sessions = await storage.getUserSessions(user.id);
            const uniqueIPs = Array.from(new Set(sessions.map(s => s.ipAddress)));
            
            // Sort sessions by loginTime descending to get the most recent first
            const sortedSessions = sessions.sort((a, b) => 
              new Date(b.loginTime).getTime() - new Date(a.loginTime).getTime()
            );
            const lastSession = sortedSessions.length > 0 ? sortedSessions[0] : null;
            
            // Parse last session user agent for browser/device info
            let lastBrowserInfo = null;
            if (lastSession) {
              const parsedUA = parseUserAgent(lastSession.userAgent || '');
              lastBrowserInfo = {
                browserName: parsedUA.browserName,
                browserVersion: parsedUA.browserVersion,
                deviceType: parsedUA.deviceType,
                operatingSystem: parsedUA.operatingSystem
              };
            }
            
            // Use sanitizeUserData to prevent sensitive data leakage
            const safeUser = sanitizeUserData(user);
            return {
              ...safeUser,
              sessionCount: sessions.length,
              uniqueIPCount: uniqueIPs.length,
              lastActivity: lastSession ? lastSession.loginTime : user.createdAt,
              lastIP: user.lastLoginIp || 'Unknown',
              lastBrowserInfo
            };
          })
        );
        
        res.json({ users: enrichedUsers, total: usersResult.total });
      }
    } catch (error) {
      console.error('User activity error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Export all user data for backup - COMPLETE BACKUP OF ALL TABLES
  app.get('/api/admin/export', requireAdmin, async (req, res) => {
    try {
      const adminId = (req as any).session.userId;
      
      console.log('🔄 Starting COMPLETE database export...');
      
      // Only proceed if using database storage
      if (!(storage as any).db) {
        return res.status(400).json({ message: 'Database export only available when using database storage' });
      }
      
      // Import all tables from schema
      const schema = await import("@shared/schema");
      const db = (storage as any).db;
      
      // Export ALL tables directly from database
      const [
        users,
        games,
        bets,
        referrals,
        transactions,
        adminActions,
        gameAnalytics,
        userSessions,
        pageViews,
        passwordResetTokens,
        systemSettings,
        databaseConnections,
        withdrawalRequests,
        agentProfiles,
        agentActivities,
        passkeys,
        notifications,
        pushSubscriptions,
        promoCodes,
        promoCodeRedemptions,
        vipSettings,
        goldenLiveStats,
        goldenLiveEvents
      ] = await Promise.all([
        db.select().from(schema.users),
        db.select().from(schema.games),
        db.select().from(schema.bets),
        db.select().from(schema.referrals),
        db.select().from(schema.transactions),
        db.select().from(schema.adminActions),
        db.select().from(schema.gameAnalytics),
        db.select().from(schema.userSessions),
        db.select().from(schema.pageViews),
        db.select().from(schema.passwordResetTokens),
        db.select().from(schema.systemSettings),
        db.select().from(schema.databaseConnections),
        db.select().from(schema.withdrawalRequests),
        db.select().from(schema.agentProfiles),
        db.select().from(schema.agentActivities),
        db.select().from(schema.passkeys),
        db.select().from(schema.notifications),
        db.select().from(schema.pushSubscriptions),
        db.select().from(schema.promoCodes),
        db.select().from(schema.promoCodeRedemptions),
        db.select().from(schema.vipSettings),
        db.select().from(schema.goldenLiveStats),
        db.select().from(schema.goldenLiveEvents)
      ]);
      
      // Create complete export data structure with ALL tables
      const exportData = {
        version: '3.0', // Updated version for complete backup
        exportDate: new Date().toISOString(),
        exportedBy: adminId,
        isCompleteBackup: true,
        data: {
          // Core tables
          users,
          games,
          bets,
          referrals,
          transactions,
          
          // Admin & Analytics
          adminActions,
          gameAnalytics,
          
          // Session & Activity
          userSessions,
          pageViews,
          
          // Security & Auth
          passwordResetTokens,
          passkeys,
          
          // System
          systemSettings,
          databaseConnections,
          
          // Financial
          withdrawalRequests,
          
          // Agent system
          agentProfiles,
          agentActivities,
          
          // Notifications
          notifications,
          pushSubscriptions,
          
          // Promotions
          promoCodes,
          promoCodeRedemptions,
          
          // VIP & Golden
          vipSettings,
          goldenLiveStats,
          goldenLiveEvents,
          
          // Statistics
          stats: {
            totalUsers: users.length,
            totalGames: games.length,
            totalBets: bets.length,
            totalReferrals: referrals.length,
            totalTransactions: transactions.length,
            totalAdminActions: adminActions.length,
            totalGameAnalytics: gameAnalytics.length,
            totalUserSessions: userSessions.length,
            totalPageViews: pageViews.length,
            totalPasswordResetTokens: passwordResetTokens.length,
            totalSystemSettings: systemSettings.length,
            totalDatabaseConnections: databaseConnections.length,
            totalWithdrawalRequests: withdrawalRequests.length,
            totalAgentProfiles: agentProfiles.length,
            totalAgentActivities: agentActivities.length,
            totalPasskeys: passkeys.length,
            totalNotifications: notifications.length,
            totalPushSubscriptions: pushSubscriptions.length,
            totalPromoCodes: promoCodes.length,
            totalPromoCodeRedemptions: promoCodeRedemptions.length,
            totalVipSettings: vipSettings.length,
            totalGoldenLiveStats: goldenLiveStats.length,
            totalGoldenLiveEvents: goldenLiveEvents.length
          }
        }
      };
      
      console.log('✅ Complete database export ready:');
      console.log(`   📊 Total tables: 23`);
      console.log(`   👥 Users: ${users.length}`);
      console.log(`   🎮 Games: ${games.length}`);
      console.log(`   🎲 Bets: ${bets.length}`);
      console.log(`   📝 Transactions: ${transactions.length}`);
      console.log(`   🔐 User Sessions: ${userSessions.length}`);
      console.log(`   📄 Page Views: ${pageViews.length}`);
      console.log(`   ⚙️ Admin Actions: ${adminActions.length}`);
      console.log(`   💰 Withdrawal Requests: ${withdrawalRequests.length}`);
      console.log(`   🔔 Notifications: ${notifications.length}`);
      console.log(`   🔑 Passkeys: ${passkeys.length}`);
      console.log(`   🎁 Promo Codes: ${promoCodes.length}`);
      
      // Log admin action
      await storage.logAdminAction({
        adminId,
        action: 'complete_data_export',
        targetId: null,
        details: { 
          totalTables: 23,
          totalRecords: Object.values(exportData.data.stats).reduce((sum: number, val: any) => sum + (typeof val === 'number' ? val : 0), 0),
          exportDate: exportData.exportDate,
          isCompleteBackup: true
        }
      });
      
      res.json(exportData);
    } catch (error) {
      console.error('Export error:', error);
      res.status(500).json({ message: 'Internal server error', error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  // Import user data from backup
  app.post('/api/admin/import', requireAdmin, async (req, res) => {
    try {
      const adminId = (req as any).session.userId;
      const importData = req.body;
      const clearBeforeImport = importData.clearBeforeImport || false;
      
      // Validate import data structure
      if (!importData.data || !importData.data.users || !Array.isArray(importData.data.users)) {
        return res.status(400).json({ message: 'Invalid import data structure' });
      }
      
      // Clear demo data before import if requested (preserves admin users)
      if (clearBeforeImport) {
        console.log('🗑️ Clearing demo data before import (admin users will be preserved)...');
        await storage.clearDemoData();
        console.log('✅ Demo data cleared successfully');
      }
      
      let newUsersCount = 0;
      let skippedCount = 0;
      let errors: Array<{ email: string; error: string }> = [];
      
      // Import users with their data
      console.log(`📥 Starting import of ${importData.data.users.length} users...`);
      for (const userData of importData.data.users) {
        try {
          // Check if user already exists
          const existingUser = await storage.getUserByEmail(userData.email);
          
          if (existingUser) {
            // Skip existing user - do not update or add any data
            console.log(`⏭️ Skipping existing user: ${userData.email}`);
            skippedCount++;
            continue;
          } else {
            // Create new user
            const newUser = await storage.createUser({
              email: userData.email,
              password: 'IMPORTED_HASH:' + userData.passwordHash, // Mark as imported
              confirmPassword: 'IMPORTED_HASH:' + userData.passwordHash,
              referralCode: userData.referralCode,
              withdrawalPassword: userData.withdrawalPasswordHash ? 'IMPORTED_HASH:' + userData.withdrawalPasswordHash : 'default123',
              acceptedTerms: true
            }, userData.registrationIp);
            
            // Update additional fields after creation
            await storage.updateUser(newUser.id, {
              publicId: userData.publicId,
              profilePhoto: userData.profilePhoto,
              balance: userData.balance,
              role: userData.role,
              vipLevel: userData.vipLevel,
              isActive: userData.isActive,
              referredBy: userData.referredBy,
              totalDeposits: userData.totalDeposits,
              totalWithdrawals: userData.totalWithdrawals,
              totalWinnings: userData.totalWinnings,
              totalLosses: userData.totalLosses,
              totalCommission: userData.totalCommission,
              lastLoginIp: userData.lastLoginIp,
              maxBetLimit: userData.maxBetLimit,
              twoFactorEnabled: userData.twoFactorEnabled,
              twoFactorSecret: userData.twoFactorSecret
            });
            
            // Import user sessions for new user
            if (userData.sessions && Array.isArray(userData.sessions)) {
              for (const sessionData of userData.sessions) {
                try {
                  await storage.createUserSession({
                    userId: newUser.id,
                    ipAddress: sessionData.ipAddress,
                    userAgent: sessionData.userAgent,
                    browserName: sessionData.browserName,
                    browserVersion: sessionData.browserVersion,
                    deviceType: sessionData.deviceType,
                    operatingSystem: sessionData.operatingSystem,
                    logoutTime: sessionData.logoutTime,
                    isActive: sessionData.isActive
                  });
                } catch (sessionError) {
                  // Silently skip duplicate sessions
                  console.log(`Skipping duplicate session for user: ${userData.email}`);
                }
              }
            }
            
            // Import user transactions for new user
            if (userData.transactions && Array.isArray(userData.transactions)) {
              for (const transactionData of userData.transactions) {
                try {
                  await storage.createTransaction({
                    userId: newUser.id,
                    agentId: transactionData.agentId,
                    type: transactionData.type,
                    fiatAmount: transactionData.fiatAmount,
                    cryptoAmount: transactionData.cryptoAmount,
                    fiatCurrency: transactionData.fiatCurrency,
                    cryptoCurrency: transactionData.cryptoCurrency,
                    status: transactionData.status,
                    paymentMethod: transactionData.paymentMethod,
                    externalId: transactionData.externalId,
                    paymentAddress: transactionData.paymentAddress,
                    txHash: transactionData.txHash,
                    fee: transactionData.fee
                  });
                } catch (txError) {
                  // Silently skip duplicate transactions
                  console.log(`Skipping duplicate transaction for user: ${userData.email}`);
                }
              }
            }
            
            newUsersCount++;
            console.log(`✅ Created new user: ${userData.email}`);
          }
        } catch (userError) {
          console.error(`❌ Error importing user ${userData.email}:`, userError);
          const errorMessage = userError instanceof Error ? userError.message : String(userError);
          errors.push({ email: userData.email, error: errorMessage });
        }
      }
      
      console.log(`📊 User import summary: ${newUsersCount} new, ${skippedCount} skipped, ${errors.length} errors`);
      
      // Import games (if available)
      let gamesImported = 0;
      if (importData.data.games && Array.isArray(importData.data.games)) {
        for (const gameData of importData.data.games) {
          try {
            if ((storage as any).db) {
              const { games } = await import("@shared/schema");
              const { sql } = await import("drizzle-orm");
              await (storage as any).db.insert(games).values({
                gameId: gameData.gameId,
                gameType: gameData.gameType,
                roundDuration: gameData.roundDuration,
                startTime: new Date(gameData.startTime),
                endTime: new Date(gameData.endTime),
                status: gameData.status,
                result: gameData.result,
                resultColor: gameData.resultColor,
                resultSize: gameData.resultSize,
                crashPoint: gameData.crashPoint,
                currentMultiplier: gameData.currentMultiplier,
                crashedAt: gameData.crashedAt ? new Date(gameData.crashedAt) : undefined,
                isManuallyControlled: gameData.isManuallyControlled,
                manualResult: gameData.manualResult,
                totalBetsAmount: gameData.totalBetsAmount,
                totalPayouts: gameData.totalPayouts,
                houseProfit: gameData.houseProfit
              }).onConflictDoNothing();
            } else {
              const newGame = await storage.createGame({
                gameId: gameData.gameId,
                gameType: gameData.gameType,
                roundDuration: gameData.roundDuration,
                startTime: new Date(gameData.startTime),
                endTime: new Date(gameData.endTime),
                status: gameData.status,
                crashPoint: gameData.crashPoint,
                currentMultiplier: gameData.currentMultiplier,
                crashedAt: gameData.crashedAt ? new Date(gameData.crashedAt) : undefined,
                isManuallyControlled: gameData.isManuallyControlled,
                manualResult: gameData.manualResult
              });
              
              if (newGame) {
                if (gameData.result !== undefined && gameData.resultColor && gameData.resultSize) {
                  await storage.updateGameResult(newGame.id, gameData.result, gameData.resultColor, gameData.resultSize);
                }
                
                if (gameData.totalBetsAmount || gameData.totalPayouts || gameData.houseProfit) {
                  await storage.updateGameStats(newGame.id, {
                    totalBetsAmount: gameData.totalBetsAmount,
                    totalPayouts: gameData.totalPayouts,
                    houseProfit: gameData.houseProfit
                  });
                }
              }
            }
            gamesImported++;
          } catch (gameError) {
            console.error(`Error importing game ${gameData.gameId}:`, gameError);
          }
        }
      }
      
      // Import referrals and bets for each user (needs to be done after all users are imported)
      let referralsImported = 0;
      let betsImported = 0;
      for (const userData of importData.data.users) {
        try {
          const user = await storage.getUserByEmail(userData.email);
          if (!user) continue;
          
          // Import referrals
          if (userData.referrals && Array.isArray(userData.referrals)) {
            for (const referralData of userData.referrals) {
              try {
                if ((storage as any).db) {
                  const { referrals } = await import("@shared/schema");
                  await (storage as any).db.insert(referrals).values({
                    referrerId: user.id,
                    referredId: referralData.referredId,
                    referralLevel: referralData.referralLevel,
                    commissionRate: referralData.commissionRate,
                    totalCommission: referralData.totalCommission,
                    hasDeposited: referralData.hasDeposited,
                    status: referralData.status
                  }).onConflictDoNothing();
                } else {
                  await storage.createReferral({
                    referrerId: user.id,
                    referredId: referralData.referredId,
                    referralLevel: referralData.referralLevel,
                    commissionRate: referralData.commissionRate,
                    hasDeposited: referralData.hasDeposited,
                    status: referralData.status
                  });
                }
                referralsImported++;
              } catch (refError) {
                console.error(`Error importing referral:`, refError);
              }
            }
          }
          
          // Import bets
          if (userData.bets && Array.isArray(userData.bets)) {
            for (const betData of userData.bets) {
              try {
                if ((storage as any).db) {
                  const { bets } = await import("@shared/schema");
                  await (storage as any).db.insert(bets).values({
                    userId: user.id,
                    gameId: betData.gameId,
                    betType: betData.betType,
                    betValue: betData.betValue,
                    amount: betData.amount,
                    potential: betData.potential,
                    actualPayout: betData.actualPayout,
                    status: betData.status,
                    cashOutMultiplier: betData.cashOutMultiplier,
                    autoCashOut: betData.autoCashOut,
                    cashedOutAt: betData.cashedOutAt ? new Date(betData.cashedOutAt) : undefined
                  }).onConflictDoNothing();
                } else {
                  const newBet = await storage.createBet({
                    userId: user.id,
                    gameId: betData.gameId,
                    betType: betData.betType,
                    betValue: betData.betValue,
                    amount: betData.amount,
                    potential: betData.potential || betData.amount,
                    cashOutMultiplier: betData.cashOutMultiplier,
                    autoCashOut: betData.autoCashOut,
                    cashedOutAt: betData.cashedOutAt ? new Date(betData.cashedOutAt) : undefined
                  });
                  if (newBet && betData.status) {
                    await storage.updateBetStatus(newBet.id, betData.status, betData.actualPayout);
                  }
                }
                betsImported++;
              } catch (betError) {
                console.error(`Error importing bet:`, betError);
              }
            }
          }
        } catch (error) {
          console.error(`Error importing user data for ${userData.email}:`, error);
        }
      }
      
      // Import agent profiles (if available)
      let agentProfilesImported = 0;
      if (importData.data.agentProfiles && Array.isArray(importData.data.agentProfiles)) {
        for (const agentData of importData.data.agentProfiles) {
          try {
            // Find the user by their agent's userId
            const user = await storage.getUser(agentData.userId);
            if (user && user.role === 'agent') {
              // Check if agent profile already exists
              const existingProfile = await storage.getAgentProfile(user.id);
              if (!existingProfile) {
                // Create agent profile directly in DB
                if ((storage as any).db) {
                  const { agentProfiles } = await import("@shared/schema");
                  await (storage as any).db.insert(agentProfiles).values({
                    userId: user.id,
                    commissionRate: agentData.commissionRate,
                    earningsBalance: agentData.earningsBalance,
                    isActive: agentData.isActive
                  }).onConflictDoNothing();
                  agentProfilesImported++;
                }
              }
            }
          } catch (agentError) {
            console.error(`Error importing agent profile:`, agentError);
          }
        }
      }
      
      // Import withdrawal requests (if available)
      let withdrawalRequestsImported = 0;
      if (importData.data.withdrawalRequests && Array.isArray(importData.data.withdrawalRequests)) {
        for (const withdrawalData of importData.data.withdrawalRequests) {
          try {
            if ((storage as any).db) {
              const { withdrawalRequests } = await import("@shared/schema");
              await (storage as any).db.insert(withdrawalRequests).values({
                userId: withdrawalData.userId,
                amount: withdrawalData.amount,
                currency: withdrawalData.currency,
                walletAddress: withdrawalData.walletAddress,
                status: withdrawalData.status,
                adminNote: withdrawalData.adminNote,
                requiredBetAmount: withdrawalData.requiredBetAmount,
                currentBetAmount: withdrawalData.currentBetAmount,
                eligible: withdrawalData.eligible !== undefined ? withdrawalData.eligible : withdrawalData.canWithdraw,
                processedAt: withdrawalData.processedAt ? new Date(withdrawalData.processedAt) : undefined,
                processedBy: withdrawalData.processedBy
              }).onConflictDoNothing();
              withdrawalRequestsImported++;
            }
          } catch (withdrawalError) {
            console.error(`Error importing withdrawal request:`, withdrawalError);
          }
        }
      }
      
      // Import admin actions (if available)
      let adminActionsImported = 0;
      if (importData.data.adminActions && Array.isArray(importData.data.adminActions)) {
        for (const actionData of importData.data.adminActions) {
          try {
            if ((storage as any).db) {
              const { adminActions } = await import("@shared/schema");
              await (storage as any).db.insert(adminActions).values({
                adminId: actionData.adminId,
                action: actionData.action,
                targetId: actionData.targetId,
                details: actionData.details,
                createdAt: actionData.createdAt ? new Date(actionData.createdAt) : new Date()
              }).onConflictDoNothing();
              adminActionsImported++;
            }
          } catch (adminActionError) {
            console.error(`Error importing admin action:`, adminActionError);
          }
        }
      }
      
      console.log(`📊 Full import summary:
        - New users created: ${newUsersCount}
        - Existing users skipped: ${skippedCount}
        - Games imported: ${gamesImported}
        - Referrals imported: ${referralsImported}
        - Bets imported: ${betsImported}
        - Agent profiles imported: ${agentProfilesImported}
        - Withdrawal requests imported: ${withdrawalRequestsImported}
        - Admin actions imported: ${adminActionsImported}
        - Errors: ${errors.length}
      `);
      
      // Log admin action
      await storage.logAdminAction({
        adminId,
        action: 'data_import',
        targetId: null,
        details: { 
          newUsersCount,
          skippedCount,
          gamesImported,
          referralsImported,
          betsImported,
          agentProfilesImported,
          withdrawalRequestsImported,
          adminActionsImported,
          totalAttempted: importData.data.users.length,
          importDate: new Date().toISOString(),
          clearedDemoData: clearBeforeImport,
          errors: errors.length > 0 ? errors : undefined
        }
      });
      
      res.json({
        message: `Import completed successfully. Created ${newUsersCount} new users, skipped ${skippedCount} existing users.`,
        newUsersCount,
        skippedCount,
        gamesImported,
        referralsImported,
        betsImported,
        agentProfilesImported,
        withdrawalRequestsImported,
        adminActionsImported,
        totalAttempted: importData.data.users.length,
        clearedDemoData: clearBeforeImport,
        errors: errors.length > 0 ? errors : undefined
      });
    } catch (error) {
      console.error('Import error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Clear all data with security code + 2FA validation
  app.post('/api/admin/clear-all-data', requireAdmin, async (req, res) => {
    try {
      const adminId = (req as any).session.userId;
      const { securityCode, twoFactorCode } = req.body;
      
      // Get admin user to check 2FA
      const adminUser = await storage.getUser(adminId);
      if (!adminUser) {
        return res.status(403).json({ message: 'Admin user not found.' });
      }
      
      // Check if 2FA is enabled for this admin
      if (adminUser.twoFactorEnabled && adminUser.twoFactorSecret) {
        // Validate 2FA code
        if (!twoFactorCode) {
          return res.status(403).json({ message: '2FA code required. Please enter your 2FA code.' });
        }
        
        const is2FAValid = await storage.validate2FAToken(adminId, twoFactorCode);
        if (!is2FAValid) {
          return res.status(403).json({ message: 'Invalid 2FA code. Access denied.' });
        }
      }
      
      // Valid security codes
      const validCodes = [
        'K8n9pQ2rS4tU6vW8xY0zA1bC3dE5fG7',
        'mL2nJ4pK6rL8tM0vN2xP4zQ6rS8tU0',
        'X9yZ2aB4cD6eF8gH0jK2lM4nO6pQ8',
        'R7sT9uV1wX3yZ5aB7cD9eF1gH3jK5',
        'P8qR0tS2uV4wX6yZ8aB0cD2eF4gH6'
      ];
      
      // Validate security code
      if (!securityCode || !validCodes.includes(securityCode)) {
        return res.status(403).json({ message: 'Invalid security code. Access denied.' });
      }
      
      // Track counts before deletion
      const usersBeforeClear = await storage.getAllUsers(1, 10000);
      const totalUsersCleared = usersBeforeClear.users.length;
      
      // Clear all demo data using the storage method
      await storage.clearDemoData();
      
      // Log admin action for audit
      await storage.logAdminAction({
        adminId,
        action: 'clear_all_data',
        targetId: null,
        details: { 
          totalUsersCleared,
          securityCodeUsed: securityCode.substring(0, 8) + '***', // Log partial code for audit
          clearedAt: new Date().toISOString()
        }
      });
      
      res.json({
        message: 'All data cleared successfully',
        totalUsersCleared,
        adminActionsPreserved: true,
        systemSettingsPreserved: true
      });
    } catch (error) {
      console.error('Clear all data error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.get('/api/admin/games/active', requireAdmin, async (req, res) => {
    try {
      const games = [];
      for (const [duration, { game }] of Array.from(activeGames.entries())) {
        const timeRemaining = Math.max(0, Math.floor((new Date(game.endTime).getTime() - Date.now()) / 1000));
        games.push({
          ...game,
          timeRemaining
        });
      }
      res.json(games);
    } catch (error) {
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.get('/api/admin/live-bets', requireAdmin, async (req, res) => {
    try {
      // Disable caching for real-time data
      res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });

      const periods = [1, 3, 5, 10];
      const periodData = [];

      for (const duration of periods) {
        const colorTotals = {
          green: 0,
          red: 0,
          violet: 0
        };

        const activeGameData = activeGames.get(duration);
        if (activeGameData && activeGameData.game.status === 'active') {
          const bets = await storage.getBetsByGame(activeGameData.game.gameId);
          
          for (const bet of bets) {
            if (bet.betType === 'color' && bet.status === 'pending') {
              const color = bet.betValue.toLowerCase();
              if (color === 'green' || color === 'red' || color === 'violet') {
                colorTotals[color] += parseFloat(bet.amount);
              }
            }
          }
        }

        periodData.push({
          duration,
          green: colorTotals.green.toFixed(2),
          red: colorTotals.red.toFixed(2),
          violet: colorTotals.violet.toFixed(2)
        });
      }

      res.json({ periods: periodData });
    } catch (error) {
      console.error('Error fetching live bets:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Period synchronization status endpoint
  app.get('/api/admin/period-sync/status', requireAdmin, async (req, res) => {
    try {
      const syncStatus = periodSyncService.getSyncStatus();
      res.json(syncStatus);
    } catch (error) {
      console.error('Error fetching period sync status:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Trigger period sync auto-fix
  app.post('/api/admin/period-sync/fix', requireAdmin, async (req, res) => {
    try {
      const result = await periodSyncService.autoFixPeriods();
      res.json(result);
    } catch (error) {
      console.error('Error fixing period sync:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Calculation validation report endpoint
  app.get('/api/admin/validation/report', requireAdmin, async (req, res) => {
    try {
      const report = calculationValidator.getValidationReport();
      res.json(report);
    } catch (error) {
      console.error('Error fetching validation report:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Run comprehensive validation
  app.post('/api/admin/validation/run', requireAdmin, async (req, res) => {
    try {
      const report = await calculationValidator.runComprehensiveValidation();
      res.json(report);
    } catch (error) {
      console.error('Error running validation:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Get critical validation errors only
  app.get('/api/admin/validation/critical', requireAdmin, async (req, res) => {
    try {
      const criticalErrors = calculationValidator.getCriticalErrors();
      res.json({ errors: criticalErrors });
    } catch (error) {
      console.error('Error fetching critical validation errors:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.get('/api/admin/games/history', requireAdmin, async (req, res) => {
    try {
      const history = await storage.getGameHistory(20); // Get more for admin
      res.json(history);
    } catch (error) {
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.post('/api/admin/games/:gameId/manual-result', requireAdmin, async (req, res) => {
    try {
      const { gameId } = req.params;
      const resultSchema = z.object({
        result: z.number().min(0).max(9),
        betAmount: z.number().optional()
      });
      
      const { result, betAmount } = resultSchema.parse(req.body);
      
      const adminId = (req as any).session.userId;
      
      // Find the game in active games
      let targetDuration: number | null = null;
      for (const [duration, { game }] of Array.from(activeGames.entries())) {
        if (game.id === gameId) {
          targetDuration = duration;
          break;
        }
      }
      
      if (targetDuration === null) {
        return res.status(404).json({ message: 'Active game not found' });
      }
      
      const activeGame = activeGames.get(targetDuration);
      if (!activeGame) {
        return res.status(404).json({ message: 'Game not found' });
      }
      
      // If betAmount is provided, create a bet for the admin
      if (betAmount && betAmount > 0) {
        const admin = await storage.getUser(adminId);
        if (!admin) {
          return res.status(404).json({ message: 'Admin user not found' });
        }

        const amount = betAmount;
        
        if (parseFloat(admin.balance) < amount) {
          return res.status(400).json({ message: 'Insufficient balance' });
        }

        // Deduct amount from admin balance
        const oldBalance = admin.balance;
        const newBalance = (parseFloat(admin.balance) - amount).toFixed(8);
        await storage.updateUserBalance(adminId, newBalance);
        
        // Broadcast balance update
        broadcastBalanceUpdate(adminId, oldBalance, newBalance, 'bet');

        // Calculate potential payout for number bet
        const potential = calculatePayout('number', result.toString(), amount);

        // Create bet for the admin (use game's period ID)
        await storage.createBet({
          userId: adminId,
          gameId: activeGame.game.gameId,
          betType: 'number',
          betValue: result.toString(),
          amount: amount.toFixed(8),
          potential: potential.toFixed(8)
        });
      }
      
      // Schedule the manual result to be applied when the game naturally ends
      // Don't clear the timer - let the game run until its natural end time
      await storage.setManualGameResult(gameId, result, adminId);
      
      // Add scheduled result to the active game object so endGame can use it
      activeGame.scheduledResult = result;
      
      res.json({ 
        message: `Manual result ${result} scheduled for game ${gameId}. Will be applied when the period ends.`,
        game: activeGame.game,
        scheduledResult: result
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid result data', errors: error.errors });
      } else {
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  // Cancel game endpoint
  app.post('/api/admin/games/:gameId/cancel', requireAdmin, async (req, res) => {
    try {
      const { gameId } = req.params;
      
      // Find the game in active games
      let targetDuration: number | null = null;
      for (const [duration, { game }] of Array.from(activeGames.entries())) {
        if (game.id === gameId) {
          targetDuration = duration;
          break;
        }
      }
      
      if (targetDuration === null) {
        return res.status(404).json({ message: 'Active game not found' });
      }
      
      const activeGame = activeGames.get(targetDuration);
      if (!activeGame) {
        return res.status(404).json({ message: 'Game not found' });
      }
      
      // Clear the timer to stop the game
      clearTimeout(activeGame.timer);
      
      // Update game status to cancelled
      await storage.updateGameStats(gameId, { status: 'cancelled' });
      
      // Get all pending bets for this game and refund them
      const pendingBets = await storage.getBetsByGame(gameId);
      for (const bet of pendingBets) {
        if (bet.status === 'pending') {
          // Refund the bet amount to user balance
          const user = await storage.getUser(bet.userId);
          if (user) {
            const newBalance = (parseFloat(user.balance) + parseFloat(bet.amount)).toFixed(8);
            await storage.updateUserBalance(bet.userId, newBalance);
          }
          // Mark bet as cancelled to reflect the refund in analytics and history
          await storage.updateBetStatus(bet.id, 'cancelled');
        }
      }
      
      // Remove from active games
      activeGames.delete(targetDuration);
      
      // Broadcast cancellation
      broadcastToClients({
        type: 'gameCancelled',
        gameId: gameId,
        duration: targetDuration
      });
      
      // Broadcast admin dashboard update for game cancellation
      broadcastAdminDashboardUpdate();
      
      // Start new game after a short delay
      setTimeout(() => startGame(targetDuration as number), 3000);
      
      res.json({ 
        message: `Game ${gameId} has been cancelled successfully`,
        gameId: gameId
      });
    } catch (error) {
      console.error('Error cancelling game:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Complete game endpoint (force complete with random result)
  app.post('/api/admin/games/:gameId/complete', requireAdmin, async (req, res) => {
    try {
      const { gameId } = req.params;
      
      // Find the game in active games
      let targetDuration: number | null = null;
      for (const [duration, { game }] of Array.from(activeGames.entries())) {
        if (game.id === gameId) {
          targetDuration = duration;
          break;
        }
      }
      
      if (targetDuration === null) {
        return res.status(404).json({ message: 'Active game not found' });
      }
      
      const activeGame = activeGames.get(targetDuration);
      if (!activeGame) {
        return res.status(404).json({ message: 'Game not found' });
      }
      
      // Clear the timer
      clearTimeout(activeGame.timer);
      
      // End the game immediately (use game's period ID, not internal ID)
      await endGame(activeGame.game.gameId, targetDuration);
      
      res.json({ 
        message: `Game ${gameId} has been completed successfully`,
        gameId: gameId
      });
    } catch (error) {
      console.error('Error completing game:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // NOWPayments integration routes
  app.post('/api/payments/create', requireAuth, async (req, res) => {
    try {
      const paymentSchema = z.object({
        amount: z.string().refine((val) => {
          const num = parseFloat(val);
          return !isNaN(num) && isFinite(num) && num >= 11;
        }, {
          message: "Amount must be a valid number with minimum 11 USD"
        }),
        currency: z.enum(["TRX", "USDTTRC20", "USDTMATIC"])
      });
      
      const { amount, currency } = paymentSchema.parse(req.body);
      const userId = (req as any).session.userId;
      
      // Get user for validation
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      // Create payment with NOWPayments (amount is in USD)
      const nowPayment = await createNOWPayment(amount, currency, storage);
      
      if (!nowPayment) {
        return res.status(500).json({ message: 'Failed to create payment' });
      }

      // Generate QR code for the payment address
      const qrCodeDataUrl = await QRCode.toDataURL(nowPayment.pay_address);

      // Save transaction to database with NOWPayments response data
      const transaction = await storage.createTransaction({
        userId,
        type: "deposit",
        fiatAmount: nowPayment.price_amount.toString(),
        fiatCurrency: nowPayment.price_currency || "USD",
        cryptoAmount: nowPayment.pay_amount.toString(),
        cryptoCurrency: nowPayment.pay_currency,
        status: "pending",
        paymentMethod: "crypto",
        externalId: nowPayment.payment_id.toString(),
        paymentAddress: nowPayment.pay_address,
        fee: "0"
      });

      res.json({
        payment_id: nowPayment.payment_id,
        pay_address: nowPayment.pay_address,
        pay_amount: nowPayment.pay_amount,
        pay_currency: nowPayment.pay_currency,
        price_amount: nowPayment.price_amount,
        price_currency: nowPayment.price_currency,
        qr_code: qrCodeDataUrl,
        transaction_id: transaction.id,
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() // 30 minutes from now
      });
    } catch (error) {
      console.error('Payment creation error:', error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid payment data', errors: error.errors });
      } else {
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  // NOWPayments IPN webhook endpoint
  app.post('/api/payments/webhook', async (req, res) => {
    try {
      // Get raw body for signature verification (captured by express.json verify callback)
      const rawBody = (req as any).rawBody as Buffer;
      const signature = req.headers['x-nowpayments-sig'] as string;

      // Check for missing raw body or signature
      if (!rawBody) {
        return res.status(400).json({ message: 'Missing raw body' });
      }

      if (!signature && !process.env.NODE_ENV?.includes('development')) {
        return res.status(400).json({ message: 'Missing signature' });
      }

      // Verify IPN signature
      if (!(await verifyIPNSignature(rawBody, signature, storage))) {
        return res.status(401).json({ message: 'Invalid signature' });
      }

      // Body is already parsed by express.json middleware

      // Validate IPN payload
      const ipnSchema = z.object({
        payment_id: z.number(),
        payment_status: z.string(),
        pay_address: z.string().optional(),
        pay_amount: z.number().optional(),
        pay_currency: z.string().optional(),
        price_amount: z.number().optional(),
        price_currency: z.string().optional(),
        outcome_amount: z.number().optional(),
        outcome_currency: z.string().optional()
      });

      const ipnData = ipnSchema.parse(req.body);

      // Find transaction by external payment ID
      const transaction = await storage.getTransactionByExternalId(ipnData.payment_id.toString());
      
      if (!transaction) {
        return res.status(404).json({ message: 'Transaction not found' });
      }

      // Idempotency check - don't process if already completed
      if (transaction.status === 'completed') {
        return res.json({ message: 'Transaction already processed' });
      }

      // Update transaction status based on NOWPayments status
      let newStatus: "pending" | "completed" | "failed" | "cancelled" = transaction.status;
      switch (ipnData.payment_status) {
        case 'finished':
          newStatus = 'completed';
          
          // Atomically update transaction status only if not already completed (prevents double-crediting)
          const updatedTransaction = await storage.updateTransactionStatusConditional(
            transaction.id, 
            newStatus, 
            'pending'
          );
          
          if (updatedTransaction && updatedTransaction.status === 'completed') {
            // Check if this is an agent self-deposit (userId === agentId)
            const isAgentSelfDeposit = transaction.agentId && transaction.userId === transaction.agentId;
            
            if (isAgentSelfDeposit) {
              // Handle agent self-deposit - credit agent's wallet balance
              const agent = await storage.getUser(transaction.userId);
              if (agent) {
                // Use actual received amount (outcome_amount) if available, otherwise fall back to original amount
                let usdAmount: number;
                if (ipnData.outcome_amount && ipnData.outcome_amount > 0) {
                  // Validate currency - ensure we're receiving USD
                  const receivedCurrency = ipnData.outcome_currency || ipnData.price_currency || 'USD';
                  if (receivedCurrency.toLowerCase() !== 'usd') {
                    // Use original amount instead for non-USD currencies
                    usdAmount = parseFloat(transaction.fiatAmount || '0');
                  } else {
                    // Use the actual USD amount received from NOWPayments
                    usdAmount = ipnData.outcome_amount;
                  }
                } else if (transaction.fiatAmount) {
                  // Fallback to original requested amount if outcome_amount not available
                  usdAmount = parseFloat(transaction.fiatAmount);
                } else {
                  // Don't return error - acknowledge IPN to prevent retries
                  usdAmount = 0;
                }
                
                if (usdAmount > 0) {
                  // Update agent's wallet balance (not earnings balance)
                  const newBalance = (parseFloat(agent.balance) + usdAmount).toFixed(8);
                  const newTotalDeposits = (parseFloat(agent.totalDeposits) + usdAmount).toFixed(8);
                  
                  // Add 60% of deposit amount to remaining required bet amount
                  const requiredBetFromDeposit = usdAmount * 0.6;
                  const newRemainingRequiredBetAmount = (parseFloat(agent.remainingRequiredBetAmount || '0') + requiredBetFromDeposit).toFixed(8);
                  
                  // Update agent balance, totalDeposits, and remainingRequiredBetAmount
                  await storage.updateUser(transaction.userId, {
                    balance: newBalance,
                    totalDeposits: newTotalDeposits,
                    remainingRequiredBetAmount: newRemainingRequiredBetAmount
                  });
                  
                  // Broadcast balance update via WebSocket
                  broadcastBalanceUpdate(transaction.userId, agent.balance, newBalance, 'deposit');
                  
                  // Send deposit confirmation email to agent
                  try {
                    await sendDepositConfirmationEmail(
                      agent.email,
                      usdAmount.toFixed(2),
                      'USD',
                      transaction.id,
                      newBalance,
                      storage
                    );
                  } catch (emailError) {
                    console.error(`Failed to send agent deposit confirmation email to ${agent.email}:`, emailError);
                  }
                }
              }
            } else {
              // Regular user deposit - credit user balance in USD based on actual received amount
              const user = await storage.getUser(transaction.userId);
              if (user) {
                // Use actual received amount (outcome_amount) if available, otherwise fall back to original amount
                let usdAmount: number;
                if (ipnData.outcome_amount && ipnData.outcome_amount > 0) {
                  // Validate currency - ensure we're receiving USD
                  const receivedCurrency = ipnData.outcome_currency || ipnData.price_currency || 'USD';
                  if (receivedCurrency.toLowerCase() !== 'usd') {
                    // Use original amount instead for non-USD currencies
                    usdAmount = parseFloat(transaction.fiatAmount || '0');
                  } else {
                    // Use the actual USD amount received from NOWPayments
                    usdAmount = ipnData.outcome_amount;
                  }
                } else if (transaction.fiatAmount) {
                  // Fallback to original requested amount if outcome_amount not available
                  usdAmount = parseFloat(transaction.fiatAmount);
                } else {
                  // Don't return error - acknowledge IPN to prevent retries
                  usdAmount = 0;
                }
                
                if (usdAmount > 0) {
                  const newBalance = (parseFloat(user.balance) + usdAmount).toFixed(8);
                  const newTotalDeposits = (parseFloat(user.totalDeposits) + usdAmount).toFixed(8);
                  
                  // Add 60% of deposit amount to remaining required bet amount
                  const requiredBetFromDeposit = usdAmount * 0.6;
                  const newRemainingRequiredBetAmount = (parseFloat(user.remainingRequiredBetAmount || '0') + requiredBetFromDeposit).toFixed(8);
                  
                  // Store old VIP level before update
                  const oldVipLevel = user.vipLevel;
                  
                  // Update user balance, totalDeposits, and remainingRequiredBetAmount
                  await storage.updateUser(transaction.userId, {
                    balance: newBalance,
                    totalDeposits: newTotalDeposits,
                    remainingRequiredBetAmount: newRemainingRequiredBetAmount
                  });
                  
                  // Update VIP level based on new deposit
                  const updatedUser = await storage.updateUserVipLevel(transaction.userId);
                  
                  // Send VIP upgrade email if level changed
                  if (updatedUser && updatedUser.vipLevel !== oldVipLevel) {
                    try {
                      const allVipLevels = await vipService.getVipLevels();
                      const newVipSetting = allVipLevels[updatedUser.vipLevel];
                      
                      const benefits = [
                        `Higher commission rates on team bets`,
                        `Max bet limit: ${newVipSetting?.maxBetLimit || 'Unlimited'}`,
                        `Daily wager reward: ${((newVipSetting?.dailyWagerReward || 0) * 100).toFixed(2)}%`,
                        `Access to exclusive features`
                      ];
                      
                      // Get Telegram link for the new VIP level
                      const vipSettingRecord = await storage.getVipSettingByLevelKey(updatedUser.vipLevel);
                      const telegramLink = vipSettingRecord?.telegramLink || undefined;
                      
                      await sendVipLevelUpgradeEmail(
                        user.email,
                        user.email.split('@')[0],
                        oldVipLevel,
                        updatedUser.vipLevel,
                        benefits,
                        storage,
                        telegramLink
                      );
                      console.log(`✅ VIP upgrade email sent to ${user.email}: ${oldVipLevel} → ${updatedUser.vipLevel}`);
                    } catch (emailError) {
                      console.error(`Failed to send VIP upgrade email to ${user.email}:`, emailError);
                    }
                  }
                  
                  // Broadcast balance update via WebSocket
                  broadcastBalanceUpdate(transaction.userId, user.balance, newBalance, 'deposit');
                  
                  // Send deposit confirmation email
                  try {
                    await sendDepositConfirmationEmail(
                      user.email,
                      usdAmount.toFixed(2),
                      'USD',
                      transaction.id,
                      newBalance,
                      storage
                    );
                  } catch (emailError) {
                    console.error(`Failed to send deposit confirmation email to ${user.email}:`, emailError);
                  }
                  
                  // Update referral tracking if user has a referrer and deposit >= $10
                  if (user.referredBy && usdAmount >= 10) {
                    try {
                      // Get referral record
                      const referrals = await storage.getReferralsByUser(user.referredBy);
                      const userReferral = referrals.find(r => r.referredId === user.id);
                      
                      // If this is the first qualifying deposit (atomic check and update)
                      if (userReferral && !userReferral.hasDeposited) {
                        // Update referral to mark as deposited (atomic operation)
                        const updatedReferral = await storage.updateReferralHasDeposited(userReferral.id, true);
                        
                        // Only increment teamSize if we successfully updated hasDeposited
                        if (updatedReferral) {
                          // Get referrer and increment qualified team size (for VIP level)
                          const referrer = await storage.getUser(user.referredBy);
                          if (referrer) {
                            // Award referral bonus to REFERRER ONLY on first deposit
                            try {
                              const referralBonusSetting = await storage.getSystemSetting('referral_bonus_amount');
                              const referralReward = referralBonusSetting?.value || "2.99000000";
                              
                              // Award to referrer only (the person who referred)
                              await storage.createTransaction({
                                userId: referrer.id,
                                type: "referral_bonus", 
                                fiatAmount: referralReward,
                                fiatCurrency: "USD",
                                status: "completed",
                                paymentMethod: "internal",
                                fee: "0.00000000"
                              });
                              
                              // Update referrer's total commission (available rewards)
                              // User must withdraw to wallet to add to main balance
                              const newCommission = (parseFloat(referrer.totalCommission || '0') + parseFloat(referralReward)).toFixed(8);
                              const newLifetime = (parseFloat(referrer.lifetimeCommissionEarned || '0') + parseFloat(referralReward)).toFixed(8);
                              await storage.updateUser(referrer.id, {
                                totalCommission: newCommission,
                                lifetimeCommissionEarned: newLifetime
                              });
                              
                              // Update referral record's totalCommission
                              const referralCommission = (parseFloat(updatedReferral.totalCommission || '0') + parseFloat(referralReward)).toFixed(8);
                              await storage.updateReferralCommission(updatedReferral.id, referralCommission);
                              
                              console.log(`✅ Referral bonus awarded: ${referralReward} to referrer ${referrer.id} available rewards only`);
                            } catch (bonusError) {
                              console.error(`Failed to award referral bonus:`, bonusError);
                            }
                            
                            const oldTeamSize = referrer.teamSize || 0;
                            const newTeamSize = oldTeamSize + 1;
                            const oldVipLevel = referrer.vipLevel;
                            
                            await storage.updateUser(user.referredBy, {
                              teamSize: newTeamSize
                            });
                            
                            // Check if VIP level should be upgraded
                            const updatedReferrer = await storage.updateUserVipLevel(user.referredBy);
                            
                            if (updatedReferrer) {
                              // Send level up email for team growth
                              try {
                                await sendLevelUpEmail(
                                  referrer.email,
                                  referrer.email.split('@')[0],
                                  newTeamSize,
                                  `Team Member ${newTeamSize}`,
                                  'Increased commission rates',
                                  storage
                                );
                              } catch (emailError) {
                                console.error(`Failed to send level up email to ${referrer.email}:`, emailError);
                              }
                              
                              // If VIP level changed, send VIP upgrade email
                              if (updatedReferrer.vipLevel !== oldVipLevel) {
                                try {
                                  const allVipLevels = await vipService.getVipLevels();
                                  const newVipSetting = allVipLevels[updatedReferrer.vipLevel];
                                  
                                  const benefits = [
                                    `Higher commission rates on team bets`,
                                    `Max bet limit: ${newVipSetting?.maxBetLimit || 'Unlimited'}`,
                                    `Daily wager reward: ${((newVipSetting?.dailyWagerReward || 0) * 100).toFixed(2)}%`,
                                    `Access to exclusive features`
                                  ];
                                  
                                  // Get Telegram link for the new VIP level
                                  const vipSettingRecord = await storage.getVipSettingByLevelKey(updatedReferrer.vipLevel);
                                  const telegramLink = vipSettingRecord?.telegramLink || undefined;
                                  
                                  await sendVipLevelUpgradeEmail(
                                    referrer.email,
                                    referrer.email.split('@')[0],
                                    oldVipLevel,
                                    updatedReferrer.vipLevel,
                                    benefits,
                                    storage,
                                    telegramLink
                                  );
                                } catch (emailError) {
                                  console.error(`Failed to send VIP upgrade email to ${referrer.email}:`, emailError);
                                }
                              }
                            }
                          }
                        }
                      }
                    } catch (error) {
                      console.error(`IPN: Error updating referral tracking for user ${transaction.userId}:`, error);
                      // Continue even if referral tracking fails
                    }
                  }
                }
              } else {
              }
            }
            
            // Broadcast admin dashboard update for deposit completion
            broadcastAdminDashboardUpdate();
          } else {
          }
          break;
        case 'failed':
        case 'expired':
        case 'refunded':
          newStatus = 'failed';
          // Use conditional update to prevent overwriting completed transactions
          await storage.updateTransactionStatusConditional(
            transaction.id, 
            newStatus, 
            'pending'
          );
          break;
        case 'confirming':
        case 'confirmed':
        case 'sending':
          // Keep as pending for these intermediate states
          break;
      }

      res.json({ message: 'IPN processed successfully' });
    } catch (error) {
      console.error('IPN processing error:', error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid IPN data', errors: error.errors });
      } else {
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  // Get payment status endpoint
  app.get('/api/payments/:paymentId/status', requireAuth, async (req, res) => {
    try {
      const { paymentId } = req.params;
      const userId = (req as any).session.userId;
      
      // Find transaction
      const transaction = await storage.getTransactionByExternalId(paymentId);
      
      if (!transaction || transaction.userId !== userId) {
        return res.status(404).json({ message: 'Transaction not found' });
      }

      // Get status from NOWPayments
      const paymentStatus = await getNOWPaymentStatus(paymentId, storage);
      
      if (paymentStatus) {
        res.json({
          payment_id: paymentId,
          status: paymentStatus.payment_status,
          pay_address: paymentStatus.pay_address,
          pay_amount: paymentStatus.pay_amount,
          transaction_status: transaction.status
        });
      } else {
        res.json({
          payment_id: paymentId,
          transaction_status: transaction.status
        });
      }
    } catch (error) {
      console.error('Payment status error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // 2FA Routes
  app.post('/api/2fa/setup', requireAuth, async (req, res) => {
    try {
      const { userId } = setup2FASchema.parse(req.body);
      const sessionUserId = (req as any).session.userId;
      
      // Only allow users to setup 2FA for themselves (security requirement)
      if (userId !== sessionUserId) {
        return res.status(403).json({ message: 'Users can only setup 2FA for themselves' });
      }
      
      // Generate secret
      const secret = authenticator.generateSecret();
      
      // Store secret temporarily for this user
      await storage.startPending2FASetup(userId, secret);
      
      // Get target user info
      const targetUser = await storage.getUser(userId);
      if (!targetUser) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      // Create service info
      const serviceName = 'Gaming Platform';
      const otpauthUrl = authenticator.keyuri(targetUser.email, serviceName, secret);
      
      // Generate QR code
      const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);
      
      // Only return QR code, never expose the secret to client
      res.json({
        qrCode: qrCodeDataUrl,
        message: 'Scan the QR code with Google Authenticator and verify with a token'
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid request data', errors: error.errors });
      } else {
        console.error('2FA setup error:', error);
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  app.post('/api/2fa/verify', requireAuth, async (req, res) => {
    try {
      const { userId, token } = validate2FASchema.parse(req.body);
      const sessionUserId = (req as any).session.userId;
      
      // Only allow users to verify 2FA for themselves
      if (userId !== sessionUserId) {
        return res.status(403).json({ message: 'Users can only verify 2FA for themselves' });
      }
      
      // Get the pending secret from server storage
      const secret = await storage.getPending2FASecret(userId);
      if (!secret) {
        return res.status(400).json({ message: 'No pending 2FA setup found. Please start setup again.' });
      }
      
      const isValid = authenticator.verify({
        token,
        secret
      });
      
      if (isValid) {
        // Complete the 2FA setup
        await storage.completePending2FASetup(userId);
        
        res.json({ success: true, message: '2FA enabled successfully' });
      } else {
        res.status(400).json({ success: false, message: 'Invalid token' });
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid request data', errors: error.errors });
      } else {
        console.error('2FA verification error:', error);
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  app.post('/api/2fa/validate', requireAuth, async (req, res) => {
    try {
      const { userId, token } = validate2FASchema.parse(req.body);
      const sessionUserId = (req as any).session.userId;
      
      // Check if user is trying to validate 2FA for themselves or if admin
      const user = await storage.getUser(sessionUserId);
      if (!user || (userId !== sessionUserId && user.role !== 'admin')) {
        return res.status(403).json({ message: 'Access denied' });
      }
      
      const isValid = await storage.validate2FAToken(userId, token);
      
      if (isValid) {
        res.json({ success: true, message: 'Authentication successful' });
      } else {
        res.status(401).json({ success: false, message: 'Invalid 2FA token' });
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid request data', errors: error.errors });
      } else {
        console.error('2FA validation error:', error);
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  app.post('/api/2fa/disable', requireAuth, async (req, res) => {
    try {
      const { userId } = setup2FASchema.parse(req.body);
      const sessionUserId = (req as any).session.userId;
      
      // Check if user is trying to disable 2FA for themselves or if admin
      const user = await storage.getUser(sessionUserId);
      if (!user || (userId !== sessionUserId && user.role !== 'admin')) {
        return res.status(403).json({ message: 'Access denied' });
      }
      
      await storage.disable2FA(userId);
      
      res.json({ success: true, message: '2FA disabled successfully' });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid request data', errors: error.errors });
      } else {
        console.error('2FA disable error:', error);
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  // Public System Settings Route (for non-sensitive settings)
  app.get('/api/settings/public', async (req, res) => {
    try {
      const settings = await storage.getAllSystemSettings();
      // Only return non-sensitive settings that users need
      const publicKeys = [
        'withdrawals_enabled',
        'telegram_support_link',
        'referral_bonus_amount',
        'minimum_withdrawal_amount',
        'maximum_withdrawal_amount'
      ];
      const publicSettings = settings
        .filter(setting => publicKeys.includes(setting.key))
        .map(setting => ({
          id: setting.id,
          key: setting.key,
          value: setting.value,
          description: setting.description
        }));
      res.json(publicSettings);
    } catch (error) {
      console.error('Get public settings error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // System Settings Admin Routes
  app.get('/api/admin/settings', requireAdmin, async (req, res) => {
    try {
      const settings = await storage.getAllSystemSettings();
      // Hide sensitive values for security
      const safeSettings = settings.map(setting => ({
        ...setting,
        value: setting.isEncrypted || setting.key.toLowerCase().includes('key') || setting.key.toLowerCase().includes('secret') 
          ? '***HIDDEN***' 
          : setting.value
      }));
      res.json(safeSettings);
    } catch (error) {
      console.error('Get settings error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.get('/api/admin/settings/:key', requireAdmin, async (req, res) => {
    try {
      const { key } = req.params;
      const setting = await storage.getSystemSetting(key);
      
      if (!setting) {
        return res.status(404).json({ message: 'Setting not found' });
      }
      
      // Hide sensitive values for security
      const safeSetting = {
        ...setting,
        value: setting.isEncrypted || setting.key.toLowerCase().includes('key') || setting.key.toLowerCase().includes('secret') 
          ? '***HIDDEN***' 
          : setting.value
      };
      
      res.json(safeSetting);
    } catch (error) {
      console.error('Get setting error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.put('/api/admin/settings/:key', requireAdmin, async (req, res) => {
    try {
      const { key } = req.params;
      const setting = updateSystemSettingSchema.parse({ ...req.body, key });
      const adminId = (req as any).session.userId;
      
      const updatedSetting = await storage.upsertSystemSetting(setting, adminId);
      
      // Log admin action
      await storage.logAdminAction({
        adminId,
        action: 'update_system_setting',
        targetId: key,
        details: { settingKey: key, description: setting.description }
      });
      
      // Hide sensitive values for security
      const safeSetting = {
        ...updatedSetting,
        value: updatedSetting.isEncrypted || updatedSetting.key.toLowerCase().includes('key') || updatedSetting.key.toLowerCase().includes('secret') 
          ? '***HIDDEN***' 
          : updatedSetting.value
      };
      
      res.json(safeSetting);
    } catch (error) {
      console.error('Update setting error:', error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid setting data', errors: error.errors });
      } else {
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  app.delete('/api/admin/settings/:key', requireAdmin, async (req, res) => {
    try {
      const { key } = req.params;
      const adminId = (req as any).session.userId;
      
      const deleted = await storage.deleteSystemSetting(key, adminId);
      
      if (!deleted) {
        return res.status(404).json({ message: 'Setting not found' });
      }
      
      res.json({ message: 'Setting deleted successfully' });
    } catch (error) {
      console.error('Delete setting error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Public System Settings Endpoint (for non-sensitive settings like Christmas mode)
  // This endpoint exposes only allowlisted system settings to the frontend without authentication.
  // IMPORTANT: When adding new public settings, ensure they contain NO sensitive information
  // (API keys, secrets, tokens, passwords, internal configurations, etc.)
  app.get('/api/system-settings/public', async (req, res) => {
    try {
      const settings = await storage.getAllSystemSettings();
      
      // Allowlist of settings that are safe to expose publicly
      // Add new settings here deliberately after security review
      const publicSettingsAllowlist = [
        'christmas_mode_enabled',      // Controls festive snow animation
        'withdrawals_enabled',         // Public withdrawal availability status
        'country_blocking_mode'        // Country blocking mode (blacklist/whitelist)
      ];
      
      // Only return allowlisted settings
      const publicSettings = settings
        .filter(setting => publicSettingsAllowlist.includes(setting.key))
        .map(setting => ({
          key: setting.key,
          value: setting.value
        }));
      
      res.json(publicSettings);
    } catch (error) {
      console.error('Get public settings error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Database Management Routes - Coming Soon
  // TODO: Implement multi-database management feature
  
  // Country Blocking Management Routes
  app.get('/api/admin/country-blocking', requireAdmin, async (req, res) => {
    try {
      const [blockedSetting] = await db.select()
        .from(systemSettings)
        .where(eq(systemSettings.key, 'blocked_countries'))
        .limit(1);
      
      const [allowedSetting] = await db.select()
        .from(systemSettings)
        .where(eq(systemSettings.key, 'allowed_countries'))
        .limit(1);
      
      const [modeSetting] = await db.select()
        .from(systemSettings)
        .where(eq(systemSettings.key, 'country_blocking_mode'))
        .limit(1);

      let blockedCountries: string[] = [];
      let allowedCountries: string[] = [];
      let mode = 'blacklist';

      try {
        if (blockedSetting?.value) {
          blockedCountries = JSON.parse(blockedSetting.value);
        }
      } catch (e) {
        console.error('Error parsing blocked countries:', e);
      }

      try {
        if (allowedSetting?.value) {
          allowedCountries = JSON.parse(allowedSetting.value);
        }
      } catch (e) {
        console.error('Error parsing allowed countries:', e);
      }

      if (modeSetting?.value) {
        mode = modeSetting.value;
      }

      res.json({
        blockedCountries,
        allowedCountries,
        mode
      });
    } catch (error) {
      console.error('Get country blocking settings error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.put('/api/admin/country-blocking', requireAdmin, async (req, res) => {
    try {
      const { blockedCountries, allowedCountries, mode } = req.body;
      const adminId = (req as any).session.userId;

      // Validate input
      if (!Array.isArray(blockedCountries) || !Array.isArray(allowedCountries)) {
        return res.status(400).json({ message: 'Invalid country lists format' });
      }

      if (mode !== 'blacklist' && mode !== 'whitelist') {
        return res.status(400).json({ message: 'Invalid blocking mode. Must be "blacklist" or "whitelist"' });
      }

      // Validate country codes (should be 2-letter ISO codes)
      const countryCodePattern = /^[A-Z]{2}$/;
      const invalidBlocked = blockedCountries.filter(code => !countryCodePattern.test(code));
      const invalidAllowed = allowedCountries.filter(code => !countryCodePattern.test(code));

      if (invalidBlocked.length > 0 || invalidAllowed.length > 0) {
        return res.status(400).json({ 
          message: 'Invalid country codes. Must be 2-letter uppercase ISO codes (e.g., US, GB, LK)',
          invalidBlocked,
          invalidAllowed
        });
      }

      // Update settings in database
      await storage.upsertSystemSetting({
        key: 'blocked_countries',
        value: JSON.stringify(blockedCountries),
        description: 'JSON array of country codes to block (e.g., ["CN", "RU", "KP"]). Leave empty [] to block none.'
      }, adminId);

      await storage.upsertSystemSetting({
        key: 'allowed_countries',
        value: JSON.stringify(allowedCountries),
        description: 'JSON array of allowed country codes for whitelist mode (e.g., ["US", "GB", "LK"]). Leave empty [] to allow all.'
      }, adminId);

      await storage.upsertSystemSetting({
        key: 'country_blocking_mode',
        value: mode,
        description: 'Country blocking mode: "blacklist" (block specific countries) or "whitelist" (only allow specific countries)'
      }, adminId);

      // Force reload the country blocking service
      const { countryBlockingService } = await import('./country-blocking-service');
      await countryBlockingService.loadSettings();

      // Log admin action
      await storage.logAdminAction({
        adminId,
        action: 'update_country_blocking',
        targetId: null,
        details: { 
          mode,
          blockedCountries,
          allowedCountries,
          totalBlocked: blockedCountries.length,
          totalAllowed: allowedCountries.length
        }
      });

      res.json({
        success: true,
        message: 'Country blocking settings updated successfully',
        blockedCountries,
        allowedCountries,
        mode
      });
    } catch (error) {
      console.error('Update country blocking settings error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // VIP Bet Limits Management Routes
  app.get('/api/admin/vip-bet-limits', requireAdmin, async (req, res) => {
    try {
      const vipLevels = ['lv1', 'lv2', 'vip', 'vip1', 'vip2', 'vip3', 'vip4', 'vip5', 'vip6', 'vip7'];
      const vipBetLimits: Record<string, string> = {};
      
      // Get bet limits from vipSettings table (stored in USD, display as coins)
      for (const level of vipLevels) {
        const vipSetting = await storage.getVipSettingByLevelKey(level);
        
        if (vipSetting) {
          // Convert USD to gold coins for display (1 USD = 100 coins)
          const limitInUsd = parseFloat(vipSetting.maxBet);
          const limitInCoins = (limitInUsd * 100).toFixed(8);
          vipBetLimits[level] = limitInCoins;
        } else {
          // Fallback to safe defaults (in USD, so multiply by 100 for coins)
          const safeFallbacksUsd: Record<string, string> = {
            'lv1': '1',      // 100 coins
            'lv2': '5',      // 500 coins
            'vip': '10',     // 1000 coins
            'vip1': '20',    // 2000 coins
            'vip2': '50',    // 5000 coins
            'vip3': '100',   // 10000 coins
            'vip4': '200',   // 20000 coins
            'vip5': '500',   // 50000 coins
            'vip6': '1000',  // 100000 coins
            'vip7': '2000'   // 200000 coins
          };
          const usdValue = parseFloat(safeFallbacksUsd[level] || '1');
          vipBetLimits[level] = (usdValue * 100).toFixed(8);
        }
      }
      
      res.json(vipBetLimits);
    } catch (error) {
      console.error('Get VIP bet limits error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.put('/api/admin/vip-bet-limits/:vipLevel', requireAdmin, async (req, res) => {
    try {
      const { vipLevel } = req.params;
      const { limit } = req.body;
      
      // Validate VIP level
      const validLevels = ['lv1', 'lv2', 'vip', 'vip1', 'vip2', 'vip3', 'vip4', 'vip5', 'vip6', 'vip7'];
      if (!validLevels.includes(vipLevel)) {
        return res.status(400).json({ message: 'Invalid VIP level' });
      }
      
      // Validate limit (received in gold coins from frontend)
      const limitInCoins = parseFloat(limit);
      if (isNaN(limitInCoins) || limitInCoins < 0 || limitInCoins > 10000000) {
        return res.status(400).json({ message: 'Limit must be a valid positive number within reasonable bounds (0-10,000,000 coins)' });
      }
      
      // Convert gold coins to USD (100 gold coins = 1 USD)
      const limitInUsd = (limitInCoins / 100).toFixed(8);
      
      console.log(`💰 VIP BET LIMIT UPDATE: ${vipLevel}`);
      console.log(`   Input: ${limitInCoins} coins → Stored as: ${limitInUsd} USD`);
      
      const adminId = (req as any).session.userId;
      
      // Update the vipSettings table directly instead of systemSettings
      const vipSettingRecord = await storage.getVipSettingByLevelKey(vipLevel);
      
      if (vipSettingRecord) {
        // Update existing vipSettings record with USD value
        await storage.updateVipSetting(vipSettingRecord.id, {
          maxBet: limitInUsd
        });
      } else {
        // If no record exists, log a warning but don't fail
        console.warn(`VIP setting not found for level: ${vipLevel}`);
        return res.status(404).json({ message: `VIP setting not found for level: ${vipLevel}` });
      }
      
      // Log admin action
      await storage.logAdminAction({
        adminId,
        action: 'update_vip_bet_limit',
        targetId: vipLevel,
        details: { vipLevel, newLimit: limit }
      });

      // Force refresh VIP service cache to apply new limits immediately
      await vipService.forceRefresh();

      // Broadcast VIP settings update via WebSocket
      broadcastToClients({
        type: 'vipSettingsUpdated',
        message: 'VIP bet limits have been updated'
      });
      
      res.json({ success: true, vipLevel, limit: limit.toString() });
    } catch (error) {
      console.error('Update VIP bet limit error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Get VIP deposit requirements
  app.get('/api/admin/vip-deposit-requirements', requireAdmin, async (req, res) => {
    try {
      const vipLevels = ['lv1', 'lv2', 'vip', 'vip1', 'vip2', 'vip3', 'vip4', 'vip5', 'vip6', 'vip7'];
      const vipDepositReqs: Record<string, string> = {};
      
      // Get deposit requirements from vipSettings table
      for (const level of vipLevels) {
        const vipSetting = await storage.getVipSettingByLevelKey(level);
        
        // Default values based on level
        const defaults: Record<string, string> = {
          'lv1': '0',
          'lv2': '100',
          'vip': '500',
          'vip1': '1000',
          'vip2': '2000',
          'vip3': '3000',
          'vip4': '4000',
          'vip5': '5000',
          'vip6': '6000',
          'vip7': '7000'
        };
        
        vipDepositReqs[level] = vipSetting?.rechargeAmount || defaults[level] || '0';
      }
      
      res.json(vipDepositReqs);
    } catch (error) {
      console.error('Get VIP deposit requirements error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Update VIP deposit requirement
  app.put('/api/admin/vip-deposit-requirements/:vipLevel', requireAdmin, async (req, res) => {
    try {
      const { vipLevel } = req.params;
      const { depositRequirement } = req.body;
      
      // Validate VIP level
      const validLevels = ['lv1', 'lv2', 'vip', 'vip1', 'vip2', 'vip3', 'vip4', 'vip5', 'vip6', 'vip7'];
      if (!validLevels.includes(vipLevel)) {
        return res.status(400).json({ message: 'Invalid VIP level' });
      }
      
      // Validate deposit requirement
      const depositNum = parseFloat(depositRequirement);
      if (isNaN(depositNum) || depositNum < 0 || depositNum > 100000000) {
        return res.status(400).json({ message: 'Deposit requirement must be a valid positive number within reasonable bounds (0-100,000,000 USD)' });
      }
      
      const adminId = (req as any).session.userId;
      
      // Update the vipSettings table directly instead of systemSettings
      const vipSettingRecord = await storage.getVipSettingByLevelKey(vipLevel);
      
      if (vipSettingRecord) {
        // Update existing vipSettings record
        await storage.updateVipSetting(vipSettingRecord.id, {
          rechargeAmount: depositRequirement.toString()
        });
      } else {
        // If no record exists, log a warning but don't fail
        console.warn(`VIP setting not found for level: ${vipLevel}`);
        return res.status(404).json({ message: `VIP setting not found for level: ${vipLevel}` });
      }
      
      // Log admin action
      await storage.logAdminAction({
        adminId,
        action: 'update_vip_deposit_requirement',
        targetId: vipLevel,
        details: { vipLevel, newDepositRequirement: depositRequirement }
      });

      // Force refresh VIP service cache to apply new requirements immediately
      await vipService.forceRefresh();

      // Broadcast VIP settings update via WebSocket
      broadcastToClients({
        type: 'vipSettingsUpdated',
        message: 'VIP deposit requirements have been updated'
      });
      
      res.json({ success: true, vipLevel, depositRequirement: depositRequirement.toString() });
    } catch (error) {
      console.error('Update VIP deposit requirement error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });


  // Telegram notification test route
  app.post('/api/admin/telegram/test', requireAdmin, async (req, res) => {
    try {
      const success = await testTelegramConnection();
      
      if (success) {
        res.json({ message: 'Test notification sent successfully!' });
      } else {
        res.status(400).json({ message: 'Failed to send test notification. Please check your Telegram bot token and chat ID settings.' });
      }
    } catch (error) {
      console.error('Telegram test error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Telegram send photo to signal channel route
  app.post('/api/admin/telegram/send-photo', requireAdmin, async (req, res) => {
    try {
      const { photoUrl, caption } = req.body;
      
      if (!photoUrl) {
        return res.status(400).json({ message: 'Photo URL is required' });
      }
      
      const success = await sendPhotoToSignalChannel(photoUrl, caption);
      
      if (success) {
        res.json({ message: 'Photo sent to Telegram signal channel successfully!' });
      } else {
        res.status(400).json({ message: 'Failed to send photo. Please check your Telegram settings and signal chat ID.' });
      }
    } catch (error) {
      console.error('Telegram send photo error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Test endpoint to simulate crypto deposit status update
  app.post('/api/admin/test-deposit-update', requireAdmin, async (req, res) => {
    try {
      const adminId = (req as any).session.userId;
      
      // Create a test user or use existing admin
      const testUser = await storage.getUser(adminId);
      if (!testUser) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      const initialBalance = testUser.balance;
      
      // Step 1: Create a pending deposit transaction (simulating crypto payment creation)
      const testAmount = 50.00; // $50 test deposit
      const testTransaction = await storage.createTransaction({
        userId: testUser.id,
        type: 'deposit',
        fiatAmount: testAmount.toString(),
        fiatCurrency: 'USD',
        cryptoAmount: '0.001', // Simulated crypto amount
        cryptoCurrency: 'USDT',
        status: 'pending',
        paymentMethod: 'crypto',
        externalId: `test-${Date.now()}`, // Unique test payment ID
        paymentAddress: 'TTestAddress123456789',
        fee: '0'
      });
      
      console.log(`🧪 Test deposit created - Transaction ID: ${testTransaction.id}, Status: ${testTransaction.status}`);
      
      // Step 2: Simulate webhook completion (what happens when payment is confirmed)
      const updatedTransaction = await storage.updateTransactionStatusConditional(
        testTransaction.id,
        'completed',
        'pending'
      );
      
      if (updatedTransaction && updatedTransaction.status === 'completed') {
        // Step 3: Credit user balance (simulating webhook handler logic)
        const newBalance = (parseFloat(initialBalance) + testAmount).toFixed(8);
        const newTotalDeposits = (parseFloat(testUser.totalDeposits) + testAmount).toFixed(8);
        
        await storage.updateUser(testUser.id, {
          balance: newBalance,
          totalDeposits: newTotalDeposits
        });
        
        console.log(`✅ Test deposit completed - Status: ${updatedTransaction.status}, Balance updated: ${initialBalance} → ${newBalance}`);
        
        // Broadcast balance update
        broadcastBalanceUpdate(testUser.id, initialBalance, newBalance, 'deposit');
        
        res.json({
          success: true,
          message: 'Crypto deposit status update test completed successfully!',
          test_results: {
            transaction_id: testTransaction.id,
            initial_status: 'pending',
            final_status: updatedTransaction.status,
            amount: testAmount,
            balance_before: initialBalance,
            balance_after: newBalance,
            status_updated: true
          }
        });
      } else {
        res.status(500).json({ 
          message: 'Failed to update transaction status',
          transaction_id: testTransaction.id 
        });
      }
    } catch (error) {
      console.error('Test deposit update error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // APK rebuild route
  app.post('/api/admin/rebuild-apk', requireAdmin, async (req, res) => {
    try {
      const { serverUrl } = req.body;
      const adminId = (req as any).session.userId;
      
      if (!serverUrl) {
        return res.status(400).json({ message: 'Server URL is required' });
      }
      
      // Update server URL setting
      await storage.upsertSystemSetting({
        key: 'backend_server_url',
        value: serverUrl,
        description: 'Backend server URL for mobile APK configuration'
      }, adminId);
      
      // Import rebuild script dynamically
      const { rebuildAPK } = await import('../scripts/rebuild-apk.js');
      
      // Start rebuild in background
      res.json({ message: 'APK rebuild started. This may take 2-3 minutes. Check the server logs for progress.' });
      
      // Run rebuild asynchronously
      rebuildAPK({ serverUrl }).then(result => {
        console.log('APK rebuild completed:', result.message);
        
        // Log admin action
        storage.logAdminAction({
          adminId,
          action: 'rebuild_apk',
          targetId: serverUrl,
          details: { serverUrl, success: result.success }
        });
      }).catch(error => {
        console.error('APK rebuild error:', error);
      });
      
    } catch (error) {
      console.error('APK rebuild request error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Public VIP Levels endpoint (for frontend)
  app.get('/api/vip/levels', async (req, res) => {
    try {
      const vipLevels = await vipService.getVipLevels();
      res.json(vipLevels);
    } catch (error) {
      console.error('Get VIP levels error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // VIP Settings Admin Routes
  app.get('/api/admin/vip-settings', requireAdmin, async (req, res) => {
    try {
      const settings = await storage.getAllVipSettings();
      res.json(settings);
    } catch (error) {
      console.error('Get VIP settings error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.get('/api/admin/vip-settings/:id', requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const setting = await storage.getVipSettingById(id);
      
      if (!setting) {
        return res.status(404).json({ message: 'VIP setting not found' });
      }
      
      res.json(setting);
    } catch (error) {
      console.error('Get VIP setting error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.post('/api/admin/vip-settings', requireAdmin, async (req, res) => {
    try {
      const settingData = req.body;
      const adminId = (req as any).session.userId;
      
      const newSetting = await storage.createVipSetting(settingData);
      
      // Refresh VIP service cache
      await vipService.forceRefresh();
      
      // Broadcast VIP settings update to all clients
      broadcastToClients({
        type: 'vipSettingsUpdated',
        timestamp: Date.now()
      });
      
      // Log admin action
      await storage.logAdminAction({
        adminId,
        action: 'create_vip_setting',
        targetId: newSetting.id,
        details: { levelName: newSetting.levelName, levelOrder: newSetting.levelOrder }
      });
      
      res.json(newSetting);
    } catch (error) {
      console.error('Create VIP setting error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.put('/api/admin/vip-settings/:id', requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const updates = req.body;
      const adminId = (req as any).session.userId;
      
      const updatedSetting = await storage.updateVipSetting(id, updates);
      
      if (!updatedSetting) {
        return res.status(404).json({ message: 'VIP setting not found' });
      }
      
      // Refresh VIP service cache
      await vipService.forceRefresh();
      
      // Broadcast VIP settings update to all clients
      broadcastToClients({
        type: 'vipSettingsUpdated',
        timestamp: Date.now()
      });
      
      // Log admin action
      await storage.logAdminAction({
        adminId,
        action: 'update_vip_setting',
        targetId: id,
        details: { levelName: updatedSetting.levelName, updates }
      });
      
      res.json(updatedSetting);
    } catch (error) {
      console.error('Update VIP setting error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.delete('/api/admin/vip-settings/:id', requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const adminId = (req as any).session.userId;
      
      const deleted = await storage.deleteVipSetting(id);
      
      if (!deleted) {
        return res.status(404).json({ message: 'VIP setting not found' });
      }
      
      // Refresh VIP service cache
      await vipService.forceRefresh();
      
      // Broadcast VIP settings update to all clients
      broadcastToClients({
        type: 'vipSettingsUpdated',
        timestamp: Date.now()
      });
      
      // Log admin action
      await storage.logAdminAction({
        adminId,
        action: 'delete_vip_setting',
        targetId: id,
        details: { deleted: true }
      });
      
      res.json({ message: 'VIP setting deleted successfully' });
    } catch (error) {
      console.error('Delete VIP setting error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Admin email sending route
  app.post('/api/admin/send-email', requireAdmin, async (req, res) => {
    try {
      const emailSchema = z.object({
        recipientType: z.enum(['all', 'specific']),
        userIds: z.array(z.string()).optional(),
        subject: z.string().min(1, 'Subject is required'),
        message: z.string().min(1, 'Message is required')
      });
      
      const emailData = emailSchema.parse(req.body);
      const adminId = (req as any).session.userId;
      
      let recipients: string[] = [];
      let recipientEmails: string[] = [];
      
      if (emailData.recipientType === 'all') {
        // Get all users
        const result = await storage.getAllUsers(1, 10000);
        recipients = result.users.map(u => u.id);
        recipientEmails = result.users.map(u => u.email);
      } else if (emailData.recipientType === 'specific' && emailData.userIds) {
        // Get specific users
        for (const userId of emailData.userIds) {
          const user = await storage.getUser(userId);
          if (user) {
            recipients.push(user.id);
            recipientEmails.push(user.email);
          }
        }
      }
      
      if (recipientEmails.length === 0) {
        return res.status(400).json({ message: 'No valid recipients found' });
      }
      
      // Send email
      const emailSent = await sendCustomEmail(
        recipientEmails,
        emailData.subject,
        emailData.message,
        storage
      );
      
      if (!emailSent) {
        return res.status(500).json({ message: 'Failed to send email' });
      }
      
      // Log admin action
      await storage.logAdminAction({
        adminId,
        action: 'send_email',
        targetId: emailData.recipientType === 'all' ? 'all_users' : recipients.join(','),
        details: { 
          subject: emailData.subject,
          recipientCount: recipientEmails.length,
          recipientType: emailData.recipientType
        }
      });
      
      res.json({ 
        message: `Email sent successfully to ${recipientEmails.length} recipient(s)`,
        recipientCount: recipientEmails.length
      });
    } catch (error) {
      console.error('Send email error:', error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid email data', errors: error.errors });
      } else {
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  // User management routes for admin
  app.get('/api/admin/users/search', requireAdmin, async (req, res) => {
    try {
      const { q } = req.query;
      if (!q || typeof q !== 'string') {
        return res.status(400).json({ message: 'Search query is required' });
      }
      
      // Get all users and filter by email
      const result = await storage.getAllUsers(1, 1000); // Get a large set to search
      const filteredUsers = result.users.filter(user => 
        user.email.toLowerCase().includes(q.toLowerCase()) ||
        user.id.includes(q)
      );
      
      const safeUsers = filteredUsers.map(user => {
        const { passwordHash, ...safeUser } = user;
        return safeUser;
      });
      
      res.json({ users: safeUsers, total: safeUsers.length });
    } catch (error) {
      console.error('User search error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.post('/api/admin/users/:userId/update-password', requireAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      const passwordSchema = z.object({
        newPassword: z.string().min(8, 'Password must be at least 8 characters')
      });
      
      const { newPassword } = passwordSchema.parse(req.body);
      const adminId = (req as any).session.userId;
      
      // Get the user
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      // Hash the new password
      const bcrypt = await import('bcrypt');
      const passwordHash = await bcrypt.hash(newPassword, 10);
      
      // Update the password
      const updatedUser = await storage.updateUser(userId, { passwordHash });
      
      if (!updatedUser) {
        return res.status(404).json({ message: 'Failed to update user password' });
      }
      
      // Log admin action
      await storage.logAdminAction({
        adminId,
        action: 'password_reset_by_admin',
        targetId: userId,
        details: { targetEmail: user.email }
      });
      
      res.json({ message: 'Password updated successfully' });
    } catch (error) {
      console.error('Password update error:', error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid password data', errors: error.errors });
      } else {
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  app.post('/api/admin/users/:userId/update-withdrawal-password', requireAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      const passwordSchema = z.object({
        newWithdrawalPassword: z.string().min(6, 'Withdrawal password must be at least 6 characters')
      });
      
      const { newWithdrawalPassword } = passwordSchema.parse(req.body);
      const adminId = (req as any).session.userId;
      
      // Get the user
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      // Hash the new withdrawal password
      const bcrypt = await import('bcrypt');
      const withdrawalPasswordHash = await bcrypt.hash(newWithdrawalPassword, 10);
      
      // Update the withdrawal password
      const updatedUser = await storage.updateUser(userId, { withdrawalPasswordHash });
      
      if (!updatedUser) {
        return res.status(404).json({ message: 'Failed to update user withdrawal password' });
      }
      
      // Log admin action
      await storage.logAdminAction({
        adminId,
        action: 'withdrawal_password_reset_by_admin',
        targetId: userId,
        details: { targetEmail: user.email }
      });
      
      res.json({ message: 'Withdrawal password updated successfully' });
    } catch (error) {
      console.error('Withdrawal password update error:', error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid withdrawal password data', errors: error.errors });
      } else {
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  // =================== Admin Financial Management Routes ===================
  
  // Get all deposits for admin view
  app.get('/api/admin/deposits', requireAdmin, async (req, res) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      const statusFilter = req.query.status as string;
      
      // Get all transactions of type 'deposit'
      const allUsers = await storage.getAllUsers(1, 1000);
      const allDeposits = [];
      
      for (const user of allUsers.users) {
        const transactions = await storage.getTransactionsByUser(user.id);
        let deposits = transactions.filter(t => t.type === 'deposit');
        
        // Apply status filter if provided and valid (not "all")
        if (statusFilter && statusFilter !== 'all') {
          deposits = deposits.filter(d => d.status === statusFilter);
        }
        
        for (const deposit of deposits) {
          allDeposits.push({
            ...deposit,
            userEmail: user.email,
            userPublicId: user.publicId
          });
        }
      }
      
      // Sort by creation date, newest first
      allDeposits.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      
      // Paginate
      const startIndex = (page - 1) * limit;
      const endIndex = startIndex + limit;
      const paginatedDeposits = allDeposits.slice(startIndex, endIndex);
      
      res.json({
        deposits: paginatedDeposits,
        total: allDeposits.length,
        page,
        totalPages: Math.ceil(allDeposits.length / limit)
      });
    } catch (error) {
      console.error('Get deposits error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Get all withdrawal requests for admin view
  app.get('/api/admin/withdrawals', requireAdmin, async (req, res) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      const statusFilter = req.query.status as string;
      
      // Only pass status filter to storage if it's not "all"
      const validStatus = statusFilter && statusFilter !== 'all' ? statusFilter : undefined;
      
      // Get withdrawal requests from the dedicated table with IP duplicate info
      const { requests, total } = await storage.getAllWithdrawalRequests(page, limit, validStatus);
      
      // Enrich with user data
      const enrichedRequests = await Promise.all(
        requests.map(async (request) => {
          const user = await storage.getUser(request.userId);
          if (!user) return null;
          
          // Get duplicate user info if there are duplicates
          let duplicateUsers: any[] = [];
          if (request.duplicateIpCount > 0 && request.duplicateIpUserIds) {
            duplicateUsers = await Promise.all(
              request.duplicateIpUserIds.map(async (userId) => {
                const dupUser = await storage.getUser(userId);
                return dupUser ? {
                  id: dupUser.id,
                  publicId: dupUser.publicId,
                  email: dupUser.email,
                  registrationIp: dupUser.registrationIp
                } : null;
              })
            );
            duplicateUsers = duplicateUsers.filter(u => u !== null);
          }
          
          // Calculate bet percentage
          const totalDeposits = parseFloat(user.totalDeposits);
          const totalBets = parseFloat(user.totalBetsAmount);
          const betPercentage = totalDeposits > 0 ? (totalBets / totalDeposits) * 100 : 0;
          
          return {
            ...request,
            userEmail: user.email,
            userPublicId: user.publicId,
            userRegistrationIp: user.registrationIp,
            userTotalDeposits: user.totalDeposits,
            userTotalBets: user.totalBetsAmount,
            userBetPercentage: betPercentage,
            duplicateUsers
          };
        })
      );
      
      // Filter out any null entries
      const validRequests = enrichedRequests.filter(r => r !== null);
      
      res.json({
        withdrawals: validRequests,
        total,
        page,
        totalPages: Math.ceil(total / limit)
      });
    } catch (error) {
      console.error('Get withdrawals error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Process withdrawal request (approve/reject)
  app.post('/api/admin/withdrawals/:transactionId/process', requireAdmin, async (req, res) => {
    try {
      const { transactionId } = req.params;
      const processSchema = z.object({
        action: z.enum(['approve', 'reject']),
        adminNote: z.string().optional()
      });
      
      const { action, adminNote } = processSchema.parse(req.body);
      const adminId = (req as any).session.userId;
      
      // Find the withdrawal request from the withdrawalRequests table
      const withdrawalRequest = await storage.getWithdrawalRequestById(transactionId);
      
      if (!withdrawalRequest) {
        return res.status(404).json({ message: 'Withdrawal request not found' });
      }
      
      if (withdrawalRequest.status !== 'pending') {
        return res.status(400).json({ message: 'Withdrawal request has already been processed' });
      }
      
      const user = await storage.getUser(withdrawalRequest.userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      const newStatus = action === 'approve' ? 'approved' : 'rejected';
      
      // Update withdrawal request status
      const updatedRequest = await storage.updateWithdrawalRequestStatus(
        withdrawalRequest.id,
        newStatus,
        adminId,
        adminNote
      );
      
      if (!updatedRequest) {
        return res.status(400).json({ message: 'Request could not be updated - may have already been processed' });
      }
      
      // Find and update the corresponding transaction
      // Match by userId, type='withdrawal', and amount
      const userTransactions = await storage.getTransactionsByUser(withdrawalRequest.userId);
      const matchingTransaction = userTransactions.find(t => 
        t.type === 'withdrawal' &&
        t.status === 'pending' &&
        parseFloat(t.fiatAmount || '0') === parseFloat(withdrawalRequest.amount)
      );
      
      if (matchingTransaction) {
        // Update transaction status: approve → completed, reject → cancelled
        const transactionStatus = action === 'approve' ? 'completed' : 'cancelled';
        await storage.updateTransactionStatus(matchingTransaction.id, transactionStatus);
        console.log(`📝 Updated transaction ${matchingTransaction.id} status to ${transactionStatus}`);
      } else {
        console.log(`⚠️ No matching pending transaction found for withdrawal request ${withdrawalRequest.id}`);
      }
      
      if (action === 'approve') {
        const withdrawalAmount = parseFloat(withdrawalRequest.amount);
        const balanceFrozen = withdrawalRequest.balanceFrozen || false;
        
        // Check if balance was already frozen
        if (!balanceFrozen) {
          // Legacy request: balance was NOT frozen, need to deduct now
          if (user.role === 'agent') {
            const agentProfile = await storage.getAgentProfile(user.id);
            if (!agentProfile || !agentProfile.isActive) {
              await storage.updateWithdrawalRequestStatus(withdrawalRequest.id, 'pending');
              return res.status(400).json({ message: 'Agent profile not found or inactive' });
            }
            const currentBalance = parseFloat(agentProfile.earningsBalance);
            
            if (currentBalance < withdrawalAmount) {
              await storage.updateWithdrawalRequestStatus(withdrawalRequest.id, 'pending');
              return res.status(400).json({ message: 'Insufficient agent earnings balance for withdrawal' });
            }
            
            const newEarningsBalance = (currentBalance - withdrawalAmount).toFixed(8);
            await storage.updateAgentBalance(user.id, newEarningsBalance);
            console.log(`💰 Deducting ${withdrawalAmount} USD from agent earnings balance (legacy request)`);
          } else {
            const currentBalance = parseFloat(user.balance);
            
            if (currentBalance < withdrawalAmount) {
              await storage.updateWithdrawalRequestStatus(withdrawalRequest.id, 'pending');
              return res.status(400).json({ message: 'Insufficient user balance for withdrawal' });
            }
            
            const newBalance = (currentBalance - withdrawalAmount).toFixed(8);
            await storage.updateUserBalance(user.id, newBalance);
            console.log(`💰 Deducting ${withdrawalAmount} USD from user balance (legacy request)`);
          }
        } else {
          // New request: balance was already frozen, no need to deduct again
          console.log(`💰 Balance already frozen for withdrawal (${withdrawalAmount} USD)`);
        }
        
        // Update user's total withdrawals for both agents and regular users
        const newTotalWithdrawals = (parseFloat(user.totalWithdrawals) + withdrawalAmount).toFixed(8);
        await storage.updateUser(user.id, { totalWithdrawals: newTotalWithdrawals });
        
        // Log approval
        await storage.logAdminAction({
          adminId,
          action: 'approve_withdrawal',
          targetId: user.id,
          details: { 
            withdrawalRequestId: withdrawalRequest.id,
            amount: withdrawalRequest.amount,
            currency: withdrawalRequest.currency,
            walletAddress: withdrawalRequest.walletAddress,
            balanceFrozen,
            adminNote 
          }
        });
        
        console.log(`✅ Withdrawal ${withdrawalRequest.id} approved for user ${user.email} - Amount: ${withdrawalRequest.amount} ${withdrawalRequest.currency}`);
      } else {
        // Rejection: refund the frozen amount back to user's balance (only if it was frozen)
        const withdrawalAmount = parseFloat(withdrawalRequest.amount);
        const balanceFrozen = withdrawalRequest.balanceFrozen || false;
        
        if (balanceFrozen) {
          // Only refund if balance was actually frozen
          if (user.role === 'agent') {
            const agentProfile = await storage.getAgentProfile(user.id);
            if (agentProfile) {
              const currentBalance = parseFloat(agentProfile.earningsBalance);
              const refundedBalance = (currentBalance + withdrawalAmount).toFixed(8);
              await storage.updateAgentBalance(user.id, refundedBalance);
              console.log(`💰 Refunded ${withdrawalAmount} USD to agent earnings balance (withdrawal rejected)`);
            }
          } else {
            const currentBalance = parseFloat(user.balance);
            const refundedBalance = (currentBalance + withdrawalAmount).toFixed(8);
            await storage.updateUserBalance(user.id, refundedBalance);
            console.log(`💰 Refunded ${withdrawalAmount} USD to user balance (withdrawal rejected)`);
          }
        } else {
          // Legacy request: balance was never frozen, no refund needed
          console.log(`💰 No refund needed for legacy request (balance was never frozen)`);
        }
        
        // Log rejection
        await storage.logAdminAction({
          adminId,
          action: 'reject_withdrawal',
          targetId: user.id,
          details: { 
            withdrawalRequestId: withdrawalRequest.id,
            amount: withdrawalRequest.amount,
            currency: withdrawalRequest.currency,
            balanceFrozen,
            adminNote 
          }
        });
        
        console.log(`❌ Withdrawal ${withdrawalRequest.id} rejected for user ${user.email} - Reason: ${adminNote || 'No reason provided'}`);
      }
      
      // Broadcast admin dashboard update for withdrawal processing
      broadcastAdminDashboardUpdate();
      
      res.json({ 
        message: `Withdrawal request ${action}d successfully`,
        transactionId,
        status: newStatus
      });
    } catch (error) {
      console.error('Process withdrawal error:', error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid processing data', errors: error.errors });
      } else {
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  // =================== Agent Management Routes ===================
  
  // Admin routes for agent management
  app.post('/api/admin/agents', requireAdmin, async (req, res) => {
    try {
      const agentData = createAgentSchema.parse(req.body);
      const adminId = (req as any).session.userId;
      
      const { user, agentProfile } = await storage.createAgent(
        agentData.email, 
        agentData.password, 
        agentData.commissionRate
      );
      
      // Log admin action
      await storage.logAdminAction({
        adminId,
        action: 'create_agent',
        targetId: user.id,
        details: { agentEmail: user.email, commissionRate: agentProfile.commissionRate }
      });
      
      // Broadcast admin dashboard update for agent creation
      broadcastAdminDashboardUpdate();
      
      const safeUser = sanitizeUserData(user);
      res.json({ user: safeUser, agentProfile });
    } catch (error) {
      console.error('Create agent error:', error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid agent data', errors: error.errors });
      } else {
        res.status(500).json({ message: error instanceof Error ? error.message : 'Internal server error' });
      }
    }
  });

  app.get('/api/admin/agents', requireAdmin, async (req, res) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      
      const result = await storage.getAllAgents(page, limit);
      const safeAgents = result.agents.map(agent => {
        return sanitizeAgentData(agent);
      });
      
      res.json({ agents: safeAgents, total: result.total });
    } catch (error) {
      console.error('Get agents error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.post('/api/admin/agents/:agentId/toggle', requireAdmin, async (req, res) => {
    try {
      const { agentId } = req.params;
      const adminId = (req as any).session.userId;
      
      const agentProfile = await storage.toggleAgentStatus(agentId);
      
      if (!agentProfile) {
        return res.status(404).json({ message: 'Agent not found' });
      }
      
      // Log admin action
      await storage.logAdminAction({
        adminId,
        action: 'toggle_agent_status',
        targetId: agentId,
        details: { newStatus: agentProfile.isActive }
      });
      
      // Broadcast admin dashboard update for agent status toggle
      broadcastAdminDashboardUpdate();
      
      res.json(agentProfile);
    } catch (error) {
      console.error('Toggle agent status error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.put('/api/admin/agents/:agentId/commission', requireAdmin, async (req, res) => {
    try {
      const { agentId } = req.params;
      const commissionData = updateCommissionSchema.parse({ ...req.body, agentId });
      const adminId = (req as any).session.userId;
      
      const agentProfile = await storage.updateAgentCommission(agentId, commissionData.commissionRate);
      
      if (!agentProfile) {
        return res.status(404).json({ message: 'Agent not found' });
      }
      
      // Log admin action
      await storage.logAdminAction({
        adminId,
        action: 'update_agent_commission',
        targetId: agentId,
        details: { newCommissionRate: commissionData.commissionRate }
      });
      
      // Broadcast admin dashboard update for agent commission update
      broadcastAdminDashboardUpdate();
      
      res.json(agentProfile);
    } catch (error) {
      console.error('Update commission error:', error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid commission data', errors: error.errors });
      } else {
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  app.post('/api/admin/agents/:agentId/adjust-balance', requireAdmin, async (req, res) => {
    try {
      const { agentId } = req.params;
      const adjustBalanceSchema = z.object({
        amount: z.string().refine((val) => {
          const num = parseFloat(val);
          return !isNaN(num) && isFinite(num) && Math.abs(num) <= 1000000;
        }, {
          message: "Amount must be a valid number within reasonable limits"
        })
      });
      
      const { amount } = adjustBalanceSchema.parse(req.body);
      
      const adminId = (req as any).session.userId;
      const agentProfile = await storage.adjustAgentBalance(agentId, amount, adminId);
      
      if (!agentProfile) {
        return res.status(404).json({ message: 'Agent not found' });
      }
      
      // Broadcast admin dashboard update for agent balance adjustment
      broadcastAdminDashboardUpdate();
      
      res.json(agentProfile);
    } catch (error) {
      console.error('Adjust agent balance error:', error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid balance adjustment data', errors: error.errors });
      } else {
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  // Promote user to agent endpoint
  app.post('/api/admin/users/:userId/promote-to-agent', requireAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      const adminId = (req as any).session.userId;
      
      const { user, agentProfile } = await storage.promoteUserToAgent(userId);
      
      // Log admin action
      await storage.logAdminAction({
        adminId,
        action: 'promote_user_to_agent',
        targetId: userId,
        details: { email: user.email, commissionRate: agentProfile.commissionRate }
      });
      
      // Send agent approval email with all details
      try {
        await sendAgentApprovalEmail(
          user.email,
          user.email.split('@')[0], // Use email prefix as username
          agentProfile.commissionRate,
          storage
        );
        console.log(`✅ Agent approval email sent to ${user.email}`);
      } catch (emailError) {
        console.error('Failed to send agent approval email:', emailError);
        // Don't fail the whole request if email fails
      }
      
      // Broadcast admin dashboard update for user promotion to agent
      broadcastAdminDashboardUpdate();
      
      const safeUser = sanitizeUserData(user);
      res.json({ user: safeUser, agentProfile });
    } catch (error) {
      console.error('Promote user to agent error:', error);
      res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to promote user to agent' });
    }
  });

  // Agent authentication and operations
  app.post('/api/agent/login', async (req, res) => {
    try {
      const credentials = loginSchema.parse(req.body);
      
      const user = await storage.validateUser(credentials);
      if (!user || user.role !== 'agent') {
        return res.status(401).json({ message: 'Invalid agent credentials' });
      }

      if (!user.isActive) {
        return res.status(403).json({ message: 'Agent account is deactivated' });
      }

      // Check if user is banned
      if (user.isBanned) {
        if (user.bannedUntil && new Date(user.bannedUntil) <= new Date()) {
          // Temporary ban has expired, unban the user automatically
          await storage.unbanUser(user.id);
        } else {
          // User is still banned
          const banMessage = user.bannedUntil 
            ? `Account is banned until ${new Date(user.bannedUntil).toLocaleDateString()}. Reason: ${user.banReason || 'No reason provided'}`
            : `Account is permanently banned. Reason: ${user.banReason || 'No reason provided'}`;
          return res.status(403).json({ message: banMessage });
        }
      }

      // Check agent profile status
      const agentProfile = await storage.getAgentProfile(user.id);
      if (!agentProfile || !agentProfile.isActive) {
        return res.status(403).json({ message: 'Agent profile is inactive' });
      }

      // Get user IP and User Agent for tracking
      const ipAddress = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || (req.connection as any)?.socket?.remoteAddress || 'unknown';
      const userAgent = req.headers['user-agent'] || 'unknown';
      const parsedUA = parseUserAgent(userAgent);

      // Update last login IP
      await storage.updateUser(user.id, { lastLoginIp: ipAddress });

      // Create user session
      await storage.createUserSession({
        userId: user.id,
        ipAddress,
        userAgent,
        browserName: parsedUA.browserName,
        browserVersion: parsedUA.browserVersion,
        deviceType: parsedUA.deviceType,
        deviceModel: parsedUA.deviceModel,
        operatingSystem: parsedUA.operatingSystem,
        isActive: true
      });

      const safeUser = sanitizeUserData(user);
      
      // Create session
      (req as any).session.userId = user.id;
      
      res.json({ ...safeUser, agentProfile });
    } catch (error) {
      console.error('Agent login error:', error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid login data', errors: error.errors });
      } else {
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  // Agent deposit processing
  app.post('/api/agent/deposit', requireAuth, async (req, res) => {
    try {
      const agentId = (req as any).session.userId;
      
      // Verify user is an agent
      const agent = await storage.getUser(agentId);
      if (!agent || agent.role !== 'agent') {
        return res.status(403).json({ message: 'Access denied: Agent role required' });
      }

      const depositData = agentDepositSchema.parse(req.body);
      
      // Get old balances before the deposit
      const oldAgentBalance = agent.balance;
      const targetUserBefore = await storage.getUserByPublicIdOrEmail(depositData.userIdentifier);
      const oldTargetBalance = targetUserBefore?.balance || "0.00000000";
      
      const result = await storage.processAgentDeposit(
        agentId, 
        depositData.userIdentifier, 
        depositData.amount
      );
      
      // Get target user for email and activity broadcast
      const targetUser = await storage.getUserByPublicIdOrEmail(depositData.userIdentifier);
      
      // Get new balances after the deposit
      const agentAfter = await storage.getUser(agentId);
      const newAgentBalance = agentAfter?.balance || "0.00000000";
      const newTargetBalance = targetUser?.balance || "0.00000000";
      
      // Broadcast balance updates for both agent and target user
      broadcastBalanceUpdate(agentId, oldAgentBalance, newAgentBalance, 'withdrawal');
      if (targetUser) {
        broadcastBalanceUpdate(targetUser.id, oldTargetBalance, newTargetBalance, 'deposit');
      }
      
      // Broadcast agent activity to connected clients with targetUserPublicId
      if (result.activity && targetUser) {
        broadcastAgentActivity({
          ...result.activity,
          targetUserPublicId: targetUser.publicId
        });
      }
      
      // Broadcast admin dashboard update for agent deposit
      broadcastAdminDashboardUpdate();
      
      // Send deposit confirmation email to user
      if (targetUser) {
        try {
          await sendDepositConfirmationEmail(
            targetUser.email,
            depositData.amount,
            'USD',
            result.transaction.id,
            targetUser.balance,
            storage
          );
          console.log(`📧 Agent deposit confirmation email sent to ${targetUser.email}`);
        } catch (emailError) {
          console.error(`Failed to send agent deposit confirmation email:`, emailError);
        }
      }
      
      res.json(result);
    } catch (error) {
      console.error('Agent deposit error:', error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid deposit data', errors: error.errors });
      } else {
        res.status(500).json({ message: error instanceof Error ? error.message : 'Internal server error' });
      }
    }
  });

  // Agent withdrawal processing
  app.post('/api/agent/withdrawal', requireAuth, async (req, res) => {
    try {
      const agentId = (req as any).session.userId;
      
      // Verify user is an agent
      const agent = await storage.getUser(agentId);
      if (!agent || agent.role !== 'agent') {
        return res.status(403).json({ message: 'Access denied: Agent role required' });
      }

      // Check if agent withdrawals are enabled
      const agentWithdrawalsEnabledSetting = await storage.getSystemSetting('agent_withdrawals_enabled');
      const agentWithdrawalsEnabled = agentWithdrawalsEnabledSetting?.value !== 'false'; // Default to enabled if not set
      
      if (!agentWithdrawalsEnabled) {
        return res.status(403).json({ message: 'Agent withdrawals are currently suspended. Only deposits are allowed.' });
      }

      const withdrawalData = agentWithdrawalSchema.parse(req.body);
      
      const result = await storage.processAgentWithdrawal(
        agentId, 
        withdrawalData.userIdentifier, 
        withdrawalData.amount
      );
      
      // Get target user for activity broadcast
      const targetUser = await storage.getUserByPublicIdOrEmail(withdrawalData.userIdentifier);
      
      // Broadcast agent activity to connected clients with targetUserPublicId
      if (result.activity && targetUser) {
        broadcastAgentActivity({
          ...result.activity,
          targetUserPublicId: targetUser.publicId
        });
      }
      
      // Broadcast admin dashboard update for agent withdrawal
      broadcastAdminDashboardUpdate();
      
      res.json(result);
    } catch (error) {
      console.error('Agent withdrawal error:', error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid withdrawal data', errors: error.errors });
      } else {
        res.status(500).json({ message: error instanceof Error ? error.message : 'Internal server error' });
      }
    }
  });

  // User withdrawal request
  app.post('/api/payments/withdraw', requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId;
      
      const withdrawalData = createWithdrawalRequestSchema.parse(req.body);
      
      // Get user to verify balance
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      // Verify withdrawal password
      const bcrypt = await import('bcrypt');
      const isValidPassword = await bcrypt.compare(withdrawalData.withdrawalPassword, user.withdrawalPasswordHash || '');
      if (!isValidPassword) {
        return res.status(401).json({ message: 'Incorrect withdrawal password' });
      }

      // Check withdrawal cooldown period
      const cooldownSetting = await storage.getSystemSetting('withdrawal_cooldown_hours');
      const cooldownHours = cooldownSetting ? parseFloat(cooldownSetting.value) : 24; // Default 24 hours
      
      if (user.lastWithdrawalRequestAt) {
        const lastRequestTime = new Date(user.lastWithdrawalRequestAt).getTime();
        const currentTime = new Date().getTime();
        const hoursSinceLastRequest = (currentTime - lastRequestTime) / (1000 * 60 * 60);
        
        if (hoursSinceLastRequest < cooldownHours) {
          const remainingHours = Math.ceil(cooldownHours - hoursSinceLastRequest);
          const remainingMinutes = Math.ceil((cooldownHours - hoursSinceLastRequest) * 60);
          
          let timeMessage = '';
          if (remainingHours < 1) {
            timeMessage = `${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}`;
          } else {
            timeMessage = `${remainingHours} hour${remainingHours !== 1 ? 's' : ''}`;
          }
          
          return res.status(429).json({ 
            message: `You can only request a withdrawal once every ${cooldownHours} hours. Please wait ${timeMessage} before making another withdrawal request.`,
            remainingHours: parseFloat(remainingHours.toFixed(2)),
            cooldownHours
          });
        }
      }

      // Check minimum VIP level requirement for withdrawals
      const minVipLevelSetting = await storage.getSystemSetting('minimum_withdrawal_vip_level');
      if (minVipLevelSetting && minVipLevelSetting.value !== 'lv1') {
        const { VIP_LEVELS } = await import("@shared/schema");
        const vipLevelOrder: Record<string, number> = {
          'lv1': 1, 'lv2': 2, 'vip': 3, 'vip1': 4, 'vip2': 5, 
          'vip3': 6, 'vip4': 7, 'vip5': 8, 'vip6': 9, 'vip7': 10
        };
        
        const userVipOrder = vipLevelOrder[user.vipLevel] || 1;
        const minVipOrder = vipLevelOrder[minVipLevelSetting.value] || 1;
        
        if (userVipOrder < minVipOrder) {
          const minLevelName = VIP_LEVELS[minVipLevelSetting.value as keyof typeof VIP_LEVELS]?.displayName || minVipLevelSetting.value;
          const userLevelName = VIP_LEVELS[user.vipLevel as keyof typeof VIP_LEVELS]?.displayName || user.vipLevel;
          return res.status(403).json({ 
            message: `Withdrawals are only available for ${minLevelName} and above. Your current level is ${userLevelName}. Invite more friends to upgrade your VIP level.`
          });
        }
      }

      // Get betting requirement percentage from system settings (default 60%)
      const betRequirementSetting = await storage.getSystemSetting('betting_requirement_percentage');
      const betRequirementPercentage = betRequirementSetting ? parseFloat(betRequirementSetting.value) : 60;
      
      // Check betting requirement with separate handling for commission/referral money
      // Commission/referral earnings are ALWAYS withdrawable without betting requirements
      // Only deposit-based balance requires wagering to prevent abuse
      const totalDeposits = parseFloat(user.totalDeposits) || 0;
      const totalBetsAmount = parseFloat(user.totalBetsAmount) || 0;
      const totalCommission = parseFloat(user.totalCommission) || 0;
      
      // Only apply betting requirement if user has made deposits
      if (totalDeposits > 0) {
        const requiredBetAmount = totalDeposits * (betRequirementPercentage / 100);
        
        // Use a small epsilon for floating-point comparison to handle precision issues
        // For example, if user bets exactly 60%, floating point arithmetic might result in 59.9999%
        const EPSILON = 0.01; // Allow 0.01 USD tolerance (1 cent)
        // Ensure epsilon doesn't make requirement negative for very small deposits
        const adjustedRequirement = Math.max(0, requiredBetAmount - EPSILON);
        const hasBetEnough = totalBetsAmount >= adjustedRequirement;
        
        // Check if user has met the wagering requirement
        if (!hasBetEnough) {
          // User hasn't met requirement yet - but they can still withdraw commission money
          const withdrawalAmountUSD = parseFloat(withdrawalData.amount) / 100; // Convert coins to USD
          
          // If withdrawal amount is covered by commission balance, allow it
          if (withdrawalAmountUSD <= totalCommission) {
            // This withdrawal is from commission/referral earnings - allow without restriction
            console.log(`💰 Allowing commission withdrawal: $${withdrawalAmountUSD} USD from commission balance: $${totalCommission}`);
          } else {
            // Withdrawal amount exceeds commission - they need to meet the requirement
            const betPercentage = totalDeposits > 0 ? ((totalBetsAmount / totalDeposits) * 100).toFixed(2) : '0.00';
            const remainingBetAmount = Math.max(0, requiredBetAmount - totalBetsAmount);
            const withdrawableCommission = totalCommission;
            
            console.log(`❌ Withdrawal blocked - Betting requirement not met:`, {
              totalDeposits: totalDeposits.toFixed(2),
              totalBets: totalBetsAmount.toFixed(2),
              requiredBet: requiredBetAmount.toFixed(2),
              betPercentage,
              requiredPercentage: betRequirementPercentage
            });
            
            return res.status(400).json({ 
              message: `You need to bet more to unlock withdrawals`,
              betPercentage: parseFloat(betPercentage),
              requiredPercentage: betRequirementPercentage,
              totalDeposits: totalDeposits.toFixed(2),
              totalBets: totalBetsAmount.toFixed(2),
              remainingBetAmount: remainingBetAmount.toFixed(2),
              withdrawableCommission: withdrawableCommission.toFixed(2)
            });
          }
        } else {
          // Betting requirement met
          console.log(`✅ Betting requirement satisfied:`, {
            totalDeposits: totalDeposits.toFixed(2),
            totalBets: totalBetsAmount.toFixed(2),
            requiredBet: requiredBetAmount.toFixed(2),
            betPercentage: ((totalBetsAmount / totalDeposits) * 100).toFixed(2) + '%'
          });
        }
      }

      const coinAmount = parseFloat(withdrawalData.amount);
      
      // Server-side validation for minimum withdrawal amount
      const MIN_WITHDRAWAL_COINS = 1200;
      if (coinAmount < MIN_WITHDRAWAL_COINS) {
        return res.status(400).json({ message: `Minimum withdrawal amount is ${MIN_WITHDRAWAL_COINS} coins` });
      }
      
      // Calculate network fee based on currency
      let networkFeeCoins = 0;
      const cryptoCurrencies = {
        "USDT_TRC20": { networkFeeCoins: 100 },
        "USDT_POLYGON": { networkFeeCoins: 80 }
      };
      
      const selectedCrypto = cryptoCurrencies[withdrawalData.currency as keyof typeof cryptoCurrencies];
      if (selectedCrypto) {
        networkFeeCoins = selectedCrypto.networkFeeCoins;
      }
      
      const totalCoinsNeeded = coinAmount + networkFeeCoins;
      let availableBalanceUSD: number;
      
      // For agents, check their earnings balance instead of regular balance
      if (user.role === 'agent') {
        const agentProfile = await storage.getAgentProfile(userId);
        if (!agentProfile || !agentProfile.isActive) {
          return res.status(403).json({ message: 'Agent profile not found or inactive' });
        }
        availableBalanceUSD = parseFloat(agentProfile.earningsBalance);
      } else {
        availableBalanceUSD = parseFloat(user.balance);
      }
      
      const USD_TO_COINS_RATE = 100; // Use constant instead of magic number
      const userBalanceInCoins = availableBalanceUSD * USD_TO_COINS_RATE;

      if (userBalanceInCoins < totalCoinsNeeded) {
        return res.status(400).json({ message: 'Insufficient balance for withdrawal including network fee' });
      }

      // Check for duplicate accounts from same IP
      let duplicateIpCount = 0;
      let duplicateIpUsers: User[] = [];
      if (user.registrationIp) {
        duplicateIpUsers = await storage.getUsersByRegistrationIp(user.registrationIp);
        // Exclude current user from count
        duplicateIpCount = duplicateIpUsers.filter(u => u.id !== userId).length;
        
        if (duplicateIpCount > 0) {
          console.log(`⚠️  WARNING: User ${user.email} has ${duplicateIpCount} other account(s) from same IP: ${user.registrationIp}`);
        }
      }

      // Deduct balance immediately to freeze coins during pending approval
      const withdrawalAmountUSD = coinAmount / 100; // Convert coins to USD
      
      // Deduct the withdrawal amount from user's balance (freeze the coins)
      if (user.role === 'agent') {
        const agentProfile = await storage.getAgentProfile(userId);
        if (agentProfile) {
          const newEarningsBalance = (parseFloat(agentProfile.earningsBalance) - withdrawalAmountUSD).toFixed(8);
          await storage.updateAgentBalance(userId, newEarningsBalance);
          console.log(`💰 Frozen ${withdrawalAmountUSD} USD from agent earnings balance (pending approval)`);
        }
      } else {
        const newBalance = (parseFloat(user.balance) - withdrawalAmountUSD).toFixed(8);
        await storage.updateUserBalance(userId, newBalance);
        console.log(`💰 Frozen ${withdrawalAmountUSD} USD from user balance (pending approval)`);
      }
      
      let transaction;
      try {
        // Create transaction with pending status - balance already deducted above
        transaction = await storage.createTransaction({
          userId,
          type: 'withdrawal',
          fiatAmount: (coinAmount / 100).toString(), // Convert coins to USD for storage
          cryptoAmount: withdrawalData.amount, // Store original coin amount
          fiatCurrency: 'USD',
          cryptoCurrency: withdrawalData.currency,
          status: 'pending',
          paymentMethod: 'crypto',
          paymentAddress: withdrawalData.address,
          fee: '0'
        });
      } catch (transactionError) {
        // Rollback balance if transaction creation fails
        if (user.role === 'agent') {
          const agentProfile = await storage.getAgentProfile(userId);
          if (agentProfile) {
            const refundedBalance = (parseFloat(agentProfile.earningsBalance) + withdrawalAmountUSD).toFixed(8);
            await storage.updateAgentBalance(userId, refundedBalance);
          }
        } else {
          const refundedBalance = (parseFloat(user.balance) + withdrawalAmountUSD).toFixed(8);
          await storage.updateUserBalance(userId, refundedBalance);
        }
        throw new Error('Failed to create withdrawal transaction: ' + (transactionError instanceof Error ? transactionError.message : 'Unknown error'));
      }

      // Create withdrawal request with duplicate IP detection info
      const requiredBetAmount = totalDeposits > 0 ? totalDeposits * (betRequirementPercentage / 100) : 0;
      const eligible = totalDeposits === 0 || totalBetsAmount >= requiredBetAmount || withdrawalAmountUSD <= totalCommission;
      const duplicateIpUserIds = duplicateIpUsers
        .filter(u => u.id !== userId)
        .map(u => u.id);

      // Calculate withdrawal source breakdown
      // NOTE: This is an approximation based on current balance composition
      // For accurate tracking, the system would need to maintain separate balance pools
      // Currently we estimate based on the user's financial profile at withdrawal time
      
      // Calculate net winnings (total winnings minus total losses)
      const totalWinnings = parseFloat(user.totalWinnings) || 0;
      const totalLosses = parseFloat(user.totalLosses) || 0;
      const netWinnings = Math.max(0, totalWinnings - totalLosses);
      
      // Current balance is composed of: deposits + commission + net winnings - withdrawals
      // We approximate the source by allocating in order: commission first, then winnings, then deposits
      const currentBalance = availableBalanceUSD;
      
      // Estimate how much of current balance is from commission (capped at total commission earned)
      const estimatedCommissionInBalance = Math.min(totalCommission, currentBalance);
      
      // Remaining balance after commission
      const remainingAfterCommission = currentBalance - estimatedCommissionInBalance;
      
      // Estimate how much of remaining balance is from net winnings
      const estimatedWinningsInBalance = Math.min(netWinnings, remainingAfterCommission);
      
      // Now allocate the withdrawal amount to sources
      // Priority: commission first, then winnings, then other (deposits)
      const commissionAmountInWithdrawal = Math.min(withdrawalAmountUSD, estimatedCommissionInBalance);
      const remainingWithdrawalAmount = withdrawalAmountUSD - commissionAmountInWithdrawal;
      const winningsAmountInWithdrawal = Math.min(remainingWithdrawalAmount, estimatedWinningsInBalance);

      try {
        await storage.createWithdrawalRequest({
          userId,
          amount: withdrawalAmountUSD.toString(),
          currency: withdrawalData.currency,
          walletAddress: withdrawalData.address,
          requiredBetAmount: requiredBetAmount.toFixed(8),
          currentBetAmount: totalBetsAmount.toFixed(8),
          eligible,
          duplicateIpCount,
          duplicateIpUserIds,
          commissionAmount: commissionAmountInWithdrawal.toFixed(8),
          winningsAmount: winningsAmountInWithdrawal.toFixed(8),
          balanceFrozen: true, // Mark that balance was frozen when this request was created
        });
        
        // Update user's last withdrawal request timestamp
        await storage.updateUser(userId, {
          lastWithdrawalRequestAt: new Date()
        });
      } catch (withdrawalRequestError) {
        console.error('Failed to create withdrawal request:', withdrawalRequestError);
        // Continue anyway, transaction is already created
      }

      console.log(`💰 Withdrawal request created: ${withdrawalAmountUSD} USD for user ${userId}, waiting for admin approval`);

      // Send Telegram notification
      try {
        const currentTime = new Date().toLocaleTimeString('en-US', { 
          hour: '2-digit', 
          minute: '2-digit',
          hour12: true 
        });
        await sendWithdrawalNotification(
          user.email,
          withdrawalAmountUSD.toString(),
          withdrawalData.currency,
          currentTime
        );
      } catch (telegramError) {
        console.error('Failed to send Telegram notification:', telegramError);
        // Don't fail the withdrawal request if Telegram fails
      }

      // Send email notification to user (only shows withdrawal amount, no balance)
      try {
        await sendWithdrawalRequestEmail(
          user.email,
          withdrawalAmountUSD.toFixed(2),
          'USD',
          withdrawalData.address,
          storage
        );
      } catch (emailError) {
        console.error('Failed to send withdrawal email:', emailError);
        // Don't fail the withdrawal request if email fails
      }

      res.json({ 
        message: 'Withdrawal request created successfully',
        transactionId: transaction.id
      });
    } catch (error) {
      console.error('User withdrawal error:', error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid withdrawal data', errors: error.errors });
      } else {
        res.status(500).json({ message: error instanceof Error ? error.message : 'Internal server error' });
      }
    }
  });

  // Agent activities and earnings
  app.get('/api/agent/activities', requireAuth, async (req, res) => {
    try {
      const agentId = (req as any).session.userId;
      
      // Verify user is an agent
      const agent = await storage.getUser(agentId);
      if (!agent || agent.role !== 'agent') {
        return res.status(403).json({ message: 'Access denied: Agent role required' });
      }

      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      
      const result = await storage.getAgentActivities(agentId, page, limit);
      res.json(result);
    } catch (error) {
      console.error('Get agent activities error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.get('/api/agent/earnings', requireAuth, async (req, res) => {
    try {
      const agentId = (req as any).session.userId;
      
      // Verify user is an agent
      const agent = await storage.getUser(agentId);
      if (!agent || agent.role !== 'agent') {
        return res.status(403).json({ message: 'Access denied: Agent role required' });
      }

      const earnings = await storage.getAgentEarnings(agentId);
      res.json(earnings);
    } catch (error) {
      console.error('Get agent earnings error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.get('/api/agent/profile', requireAuth, async (req, res) => {
    try {
      const agentId = (req as any).session.userId;
      
      // Verify user is an agent
      const agent = await storage.getUser(agentId);
      if (!agent || agent.role !== 'agent') {
        return res.status(403).json({ message: 'Access denied: Agent role required' });
      }

      const agentProfile = await storage.getAgentProfile(agentId);
      if (!agentProfile) {
        return res.status(404).json({ message: 'Agent profile not found' });
      }

      const safeUser = sanitizeUserData(agent);
      res.json({ user: safeUser, agentProfile });
    } catch (error) {
      console.error('Get agent profile error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Agent self-deposit through NOWPayments
  app.post('/api/agent/self-deposit', requireAuth, async (req, res) => {
    try {
      const agentId = (req as any).session.userId;
      
      // Verify user is an agent
      const agent = await storage.getUser(agentId);
      if (!agent || agent.role !== 'agent') {
        return res.status(403).json({ message: 'Access denied: Agent role required' });
      }

      // Verify agent profile is active
      const agentProfile = await storage.getAgentProfile(agentId);
      if (!agentProfile || !agentProfile.isActive) {
        return res.status(403).json({ message: 'Agent account is inactive' });
      }

      const depositData = agentSelfDepositSchema.parse(req.body);
      
      // Create payment with NOWPayments
      const nowPayment = await createNOWPayment(depositData.amount, depositData.currency, storage);
      
      if (!nowPayment) {
        return res.status(500).json({ message: 'Failed to create payment' });
      }

      // Generate QR code for the payment address
      const qrCodeDataUrl = await QRCode.toDataURL(nowPayment.pay_address);

      // Save transaction to database with agent-specific flag
      const transaction = await storage.createTransaction({
        userId: agentId,
        agentId: agentId, // Mark as agent self-deposit
        type: "deposit",
        fiatAmount: nowPayment.price_amount.toString(),
        fiatCurrency: nowPayment.price_currency || "USD",
        cryptoAmount: nowPayment.pay_amount.toString(),
        cryptoCurrency: nowPayment.pay_currency,
        status: "pending",
        paymentMethod: "crypto",
        externalId: nowPayment.payment_id.toString(),
        paymentAddress: nowPayment.pay_address,
        fee: "0"
      });

      res.json({
        payment_id: nowPayment.payment_id,
        pay_address: nowPayment.pay_address,
        pay_amount: nowPayment.pay_amount,
        pay_currency: nowPayment.pay_currency,
        price_amount: nowPayment.price_amount,
        price_currency: nowPayment.price_currency,
        qr_code: qrCodeDataUrl,
        transaction_id: transaction.id,
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() // 30 minutes from now
      });
    } catch (error) {
      console.error('Agent self-deposit error:', error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid deposit data', errors: error.errors });
      } else {
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  // Referral endpoints
  app.get('/api/user/referral', requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId;
      
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      // Get referral statistics
      const stats = await storage.getReferralStats(userId);
      
      // Get list of referred users (just basic info)
      const referrals = await storage.getReferralsByUser(userId);
      
      // Generate referral link using request origin
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const referralLink = `${baseUrl}/signup?ref=${user.referralCode}`;
      
      res.json({
        referralCode: user.referralCode,
        referralLink,
        totalReferrals: stats.totalReferrals,
        totalCommission: user.lifetimeCommissionEarned || stats.totalCommission,
        referrals: referrals.map(ref => ({
          id: ref.id,
          referredId: ref.referredId,
          commissionRate: ref.commissionRate,
          totalCommission: ref.totalCommission,
          status: ref.status,
          createdAt: ref.createdAt
        }))
      });
    } catch (error) {
      console.error('Get referral info error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.get('/api/user/referral/qr', requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId;
      
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      // Generate referral link using request origin
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const referralLink = `${baseUrl}/signup?ref=${user.referralCode}`;
      
      // Generate QR code
      const qrCodeDataUrl = await QRCode.toDataURL(referralLink, {
        width: 256,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      });
      
      res.json({
        qrCode: qrCodeDataUrl,
        referralLink,
        referralCode: user.referralCode
      });
    } catch (error) {
      console.error('Generate QR code error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Get commission earnings history
  app.get('/api/user/commission-history', requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId;
      
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      // Get all transactions for this user that are commission-related
      const allTransactions = await storage.getTransactionsByUser(userId);
      
      // Filter for referral bonuses and get referred user info
      const commissionHistory = await Promise.all(
        allTransactions
          .filter(tx => tx.type === 'referral_bonus')
          .map(async (tx) => {
            // Try to find which referral this belongs to
            let referredUserEmail = 'Unknown User';
            const referrals = await storage.getReferralsByUser(userId);
            
            // Match by approximate timing or amount if possible
            // For now, just show the transaction
            return {
              id: tx.id,
              type: 'referral_bonus',
              amount: tx.fiatAmount || '0',
              currency: tx.fiatCurrency || 'USD',
              date: tx.createdAt,
              description: 'Referral Bonus - New user joined and deposited',
              referredUser: referredUserEmail
            };
          })
      );
      
      // Get bet commission history from referral records
      const referrals = await storage.getReferralsByUser(userId);
      const betCommissions = await Promise.all(
        referrals
          .filter(ref => parseFloat(ref.totalCommission || '0') > 0)
          .map(async (ref) => {
            const referredUser = await storage.getUser(ref.referredId);
            return {
              id: ref.id,
              type: 'bet_commission',
              amount: ref.totalCommission,
              currency: 'USD',
              date: ref.createdAt,
              description: 'Betting Commission',
              referredUser: referredUser?.email || 'Unknown User',
              commissionRate: ref.commissionRate
            };
          })
      );
      
      // Combine and sort by date (newest first)
      const allHistory = [...commissionHistory, ...betCommissions].sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
      );
      
      res.json({
        history: allHistory,
        totalEarnings: user.totalCommission
      });
    } catch (error) {
      console.error('Get commission history error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Get genuine referred users (users with first deposit)
  app.get('/api/user/referral/genuine', requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId;
      
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      // Get all referrals
      const referrals = await storage.getReferralsByUser(userId);
      
      // Filter genuine users (those with deposits) - double check both referral flag and user's actual deposits
      const genuineUsersData = await Promise.all(
        referrals.map(async (ref) => {
          const referredUser = await storage.getUser(ref.referredId);
          if (!referredUser) return null;
          
          // Check both hasDeposited flag AND actual total deposits to be certain
          const hasActuallyDeposited = ref.hasDeposited === true && parseFloat(referredUser.totalDeposits || '0') > 0;
          
          if (!hasActuallyDeposited) return null;
          
          return {
            publicId: referredUser.publicId || 'Unknown',
            balance: referredUser.balance || '0.00000000'
          };
        })
      );
      
      // Filter out null entries
      const genuineUsers = genuineUsersData.filter(user => user !== null);
      
      res.json({
        count: genuineUsers.length,
        users: genuineUsers
      });
    } catch (error) {
      console.error('Get genuine referrals error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Get user transactions (deposits and withdrawals)
  app.get('/api/user/transactions', requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId;
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      const type = req.query.type as string; // Optional filter: 'deposit', 'withdrawal', or 'all'
      
      // Get user transactions
      const allTransactions = await storage.getTransactionsByUser(userId);
      
      // Filter by type if specified
      const filteredTransactions = type && type !== 'all' 
        ? allTransactions.filter(t => t.type === type)
        : allTransactions;
      
      // Sort by creation date, newest first
      filteredTransactions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      
      // Paginate
      const startIndex = (page - 1) * limit;
      const endIndex = startIndex + limit;
      const paginatedTransactions = filteredTransactions.slice(startIndex, endIndex);
      
      // Map transactions to include timestamp and amount fields for frontend compatibility
      const transactionsWithTimestamp = paginatedTransactions.map(transaction => ({
        ...transaction,
        timestamp: transaction.createdAt, // Add timestamp field mapped from createdAt
        amount: transaction.fiatAmount || '0', // Add amount field for frontend (USD amount)
        network: transaction.cryptoCurrency ? 
          (transaction.cryptoCurrency.includes('TRC20') ? 'TRC20' : 
           transaction.cryptoCurrency.includes('POLYGON') ? 'POLYGON' : 
           transaction.cryptoCurrency === 'TRX' ? 'TRON' : '') : '',
        address: transaction.paymentAddress || '' // Add address field for frontend
      }));

      res.json({
        transactions: transactionsWithTimestamp,
        total: filteredTransactions.length,
        page,
        totalPages: Math.ceil(filteredTransactions.length / limit)
      });
    } catch (error) {
      console.error('Get user transactions error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Passkey API Routes
  // Start passkey registration
  app.post('/api/passkeys/register/start', requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId;
      const { deviceName } = passkeyDeviceNameSchema.parse(req.body);
      
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      const options = await generateRegistrationOptions({
        rpName,
        rpID,
        userName: user.email,
        userDisplayName: user.email,
        excludeCredentials: [], // TODO: get existing credentials to exclude
        authenticatorSelection: {
          residentKey: 'discouraged',
          userVerification: 'preferred',
          // Remove authenticatorAttachment to allow both platform and cross-platform authenticators
        },
        attestationType: 'none',
      });

      // Store challenge in session for later verification
      (req as any).session.challenge = options.challenge;
      (req as any).session.deviceName = deviceName;

      res.json(options);
    } catch (error) {
      console.error('Start passkey registration error:', error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid request data', errors: error.errors });
      } else {
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  // Finish passkey registration
  app.post('/api/passkeys/register/finish', requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId;
      const expectedChallenge = (req as any).session.challenge;
      const deviceName = (req as any).session.deviceName;

      if (!expectedChallenge) {
        return res.status(400).json({ message: 'No registration in progress' });
      }

      const verification = await verifyRegistrationResponse({
        response: req.body,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
      });

      if (verification.verified && verification.registrationInfo) {
        const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

        // Store the passkey
        const passkey = await storage.createPasskey({
          userId,
          credentialId: Buffer.from(credential.id).toString('base64url'),
          publicKey: Buffer.from(credential.publicKey).toString('base64url'),
          counter: credential.counter,
          deviceName: deviceName || 'Unknown Device',
          isActive: true
        });

        // Clear session data
        delete (req as any).session.challenge;
        delete (req as any).session.deviceName;

        res.json({ 
          verified: true, 
          passkey: {
            id: passkey.id,
            deviceName: passkey.deviceName,
            createdAt: passkey.createdAt
          }
        });
      } else {
        res.status(400).json({ message: 'Passkey registration failed' });
      }
    } catch (error) {
      console.error('Finish passkey registration error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Start passkey authentication
  app.post('/api/passkeys/authenticate/start', requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId;
      const { purpose } = startPasskeyAuthenticationSchema.parse(req.body);
      
      // Get user's passkeys
      const userPasskeys = await storage.getUserPasskeys(userId);
      if (userPasskeys.length === 0) {
        return res.status(400).json({ message: 'No passkeys registered' });
      }

      const allowCredentials = userPasskeys
        .filter(pk => pk.isActive)
        .map(pk => ({
          id: pk.credentialId,
          transports: ['internal'] as AuthenticatorTransport[]
        }));

      const options = await generateAuthenticationOptions({
        rpID,
        allowCredentials,
        userVerification: 'preferred'
      });

      // Store challenge and purpose in session
      (req as any).session.authChallenge = options.challenge;
      (req as any).session.authPurpose = purpose;

      res.json(options);
    } catch (error) {
      console.error('Start passkey authentication error:', error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid request data', errors: error.errors });
      } else {
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  // Finish passkey authentication
  app.post('/api/passkeys/authenticate/finish', requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId;
      const expectedChallenge = (req as any).session.authChallenge;
      const purpose = (req as any).session.authPurpose;

      if (!expectedChallenge) {
        return res.status(400).json({ message: 'No authentication in progress' });
      }

      const credentialId = req.body.id;
      const passkey = await storage.getPasskeyByCredentialId(credentialId);

      if (!passkey || passkey.userId !== userId || !passkey.isActive) {
        return res.status(400).json({ message: 'Invalid passkey' });
      }

      const verification = await verifyAuthenticationResponse({
        response: req.body,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: passkey.credentialId,
          publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64url')),
          counter: passkey.counter
        }
      });

      if (verification.verified) {
        // Update counter
        await storage.updatePasskeyCounter(passkey.credentialId, verification.authenticationInfo.newCounter);

        // Clear session data
        delete (req as any).session.authChallenge;
        delete (req as any).session.authPurpose;

        // Store authentication result in session for withdrawal use
        (req as any).session.passkeyVerified = true;
        (req as any).session.passkeyVerifiedAt = Date.now();
        (req as any).session.passkeyPurpose = purpose;

        res.json({ 
          verified: true,
          purpose,
          deviceName: passkey.deviceName
        });
      } else {
        res.status(400).json({ message: 'Passkey authentication failed' });
      }
    } catch (error) {
      console.error('Finish passkey authentication error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Get user's passkeys
  app.get('/api/user/passkeys', requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId;
      const passkeys = await storage.getUserPasskeys(userId);
      
      // Don't send sensitive data to frontend
      const safePasskeys = passkeys.map(pk => ({
        id: pk.id,
        deviceName: pk.deviceName,
        isActive: pk.isActive,
        lastUsedAt: pk.lastUsedAt,
        createdAt: pk.createdAt
      }));

      res.json(safePasskeys);
    } catch (error) {
      console.error('Get user passkeys error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Update a passkey
  app.put('/api/passkeys/update', requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId;
      const { passkeyId, deviceName, isActive } = updatePasskeySchema.parse(req.body);
      
      // Verify the passkey belongs to the user
      const passkey = await storage.getUserPasskeys(userId);
      const targetPasskey = passkey.find(pk => pk.id === passkeyId);
      
      if (!targetPasskey) {
        return res.status(404).json({ message: 'Passkey not found' });
      }

      const updates: Partial<typeof targetPasskey> = {};
      if (deviceName !== undefined) updates.deviceName = deviceName;
      if (isActive !== undefined) updates.isActive = isActive;

      const updatedPasskey = await storage.updatePasskey(passkeyId, updates);
      
      if (updatedPasskey) {
        res.json({
          id: updatedPasskey.id,
          deviceName: updatedPasskey.deviceName,
          isActive: updatedPasskey.isActive,
          lastUsedAt: updatedPasskey.lastUsedAt,
          createdAt: updatedPasskey.createdAt
        });
      } else {
        res.status(500).json({ message: 'Failed to update passkey' });
      }
    } catch (error) {
      console.error('Update passkey error:', error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: 'Invalid request data', errors: error.errors });
      } else {
        res.status(500).json({ message: 'Internal server error' });
      }
    }
  });

  // Delete a passkey
  app.delete('/api/passkeys/:passkeyId', requireAuth, async (req, res) => {
    try {
      const userId = (req as any).session.userId;
      const { passkeyId } = req.params;
      
      // Verify the passkey belongs to the user
      const passkeys = await storage.getUserPasskeys(userId);
      const targetPasskey = passkeys.find(pk => pk.id === passkeyId);
      
      if (!targetPasskey) {
        return res.status(404).json({ message: 'Passkey not found' });
      }

      const deleted = await storage.deletePasskey(passkeyId);
      
      if (deleted) {
        res.json({ success: true });
      } else {
        res.status(500).json({ message: 'Failed to delete passkey' });
      }
    } catch (error) {
      console.error('Delete passkey error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Admin Passkey Management Routes
  // Get passkeys for a specific user (admin only)
  app.get('/api/admin/users/:userId/passkeys', requireAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      
      const passkeys = await storage.getUserPasskeys(userId);
      
      // Return full passkey info for admin
      const adminPasskeys = passkeys.map(pk => ({
        id: pk.id,
        userId: pk.userId,
        credentialId: pk.credentialId,
        deviceName: pk.deviceName,
        isActive: pk.isActive,
        lastUsedAt: pk.lastUsedAt,
        createdAt: pk.createdAt,
        counter: pk.counter
      }));
      
      res.json(adminPasskeys);
    } catch (error) {
      console.error('Get user passkeys (admin) error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Start passkey registration for a user (admin only)
  app.post('/api/admin/users/:userId/passkeys/start-registration', requireAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      const { deviceName } = req.body;
      
      // Verify user exists
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      // Get user's existing passkeys for excludeCredentials
      const existingPasskeys = await storage.getUserPasskeys(userId);
      const excludeCredentials = existingPasskeys.map(pk => ({
        id: pk.credentialId,
        transports: ['internal', 'hybrid'] as AuthenticatorTransport[]
      }));

      // Generate registration options
      const options = await generateRegistrationOptions({
        rpName,
        rpID,
        userID: new Uint8Array(Buffer.from(user.id, 'utf8')),
        userName: user.email,
        userDisplayName: user.email,
        excludeCredentials,
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: 'preferred',
          authenticatorAttachment: 'platform',
        },
        attestationType: 'none',
      });

      // Store challenge in session for this user
      (req as any).session[`regChallenge_${userId}`] = options.challenge;

      res.json({
        registrationOptions: options,
        userEmail: user.email,
        deviceName: deviceName || 'New Device',
        instructions: 'Share these registration options with the user so they can complete passkey setup on their device.'
      });
    } catch (error) {
      console.error('Start admin passkey registration error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Complete passkey registration for a user (admin only)
  app.post('/api/admin/users/:userId/passkeys/finish-registration', requireAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      const { deviceName, registrationResponse } = req.body;
      
      const expectedChallenge = (req as any).session[`regChallenge_${userId}`];
      if (!expectedChallenge) {
        return res.status(400).json({ message: 'No registration in progress for this user' });
      }

      // Verify user exists
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      const verification = await verifyRegistrationResponse({
        response: registrationResponse,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
      });

      if (verification.verified && verification.registrationInfo) {
        const { credential } = verification.registrationInfo;
        const counter = 0; // Initial counter value for new passkeys
        const credentialID = credential.id;
        const credentialPublicKey = credential.publicKey;

        // Store the passkey
        const passkey = await storage.createPasskey({
          userId,
          credentialId: Buffer.from(credentialID).toString('base64url'),
          publicKey: Buffer.from(credentialPublicKey).toString('base64url'),
          deviceName: deviceName || 'New Device',
          counter,
          isActive: true,
        });

        // Clear session data
        delete (req as any).session[`regChallenge_${userId}`];

        res.json({
          success: true,
          passkey: {
            id: passkey.id,
            deviceName: passkey.deviceName,
            createdAt: passkey.createdAt
          }
        });
      } else {
        res.status(400).json({ message: 'Passkey registration failed' });
      }
    } catch (error) {
      console.error('Finish admin passkey registration error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Delete passkey for any user (admin only)
  app.delete('/api/admin/passkeys/:passkeyId', requireAdmin, async (req, res) => {
    try {
      const { passkeyId } = req.params;
      
      // Get the passkey first to verify it exists
      const allUsers = await storage.getAllUsers();
      let targetPasskey = null;
      let targetUser = null;
      
      for (const user of allUsers.users) {
        const userPasskeys = await storage.getUserPasskeys(user.id);
        const passkey = userPasskeys.find(pk => pk.id === passkeyId);
        if (passkey) {
          targetPasskey = passkey;
          targetUser = user;
          break;
        }
      }
      
      if (!targetPasskey) {
        return res.status(404).json({ message: 'Passkey not found' });
      }

      const deleted = await storage.deletePasskey(passkeyId);
      
      if (deleted) {
        res.json({ 
          success: true, 
          deletedPasskey: {
            id: targetPasskey.id,
            userId: targetPasskey.userId,
            deviceName: targetPasskey.deviceName,
            userEmail: targetUser?.email
          }
        });
      } else {
        res.status(500).json({ message: 'Failed to delete passkey' });
      }
    } catch (error) {
      console.error('Admin delete passkey error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Golden Live endpoints
  app.get('/api/golden-live/stats', async (req, res) => {
    try {
      const stats = await storage.getGoldenLiveStats();
      if (!stats) {
        return res.status(404).json({ message: 'Golden Live stats not found' });
      }
      res.json(stats);
    } catch (error) {
      console.error('Get Golden Live stats error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.get('/api/golden-live/events', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const events = await storage.getGoldenLiveEvents(limit);
      res.json(events);
    } catch (error) {
      console.error('Get Golden Live events error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.post('/api/golden-live/update-active-players', async (req, res) => {
    try {
      const { count } = req.body;
      if (typeof count !== 'number' || count < 0) {
        return res.status(400).json({ message: 'Invalid active player count' });
      }
      
      const updatedStats = await storage.updateActivePlayersCount(count);
      if (!updatedStats) {
        return res.status(404).json({ message: 'Golden Live stats not found' });
      }
      
      // Broadcast the updated stats to all connected clients
      broadcastToClients({
        type: 'goldenLiveUpdate',
        stats: updatedStats
      });
      
      res.json(updatedStats);
    } catch (error) {
      console.error('Update active players error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.post('/api/golden-live/increment-total', requireAdmin, async (req, res) => {
    try {
      const updatedStats = await storage.incrementTotalPlayersBy28();
      if (!updatedStats) {
        return res.status(404).json({ message: 'Golden Live stats not found' });
      }
      
      // Broadcast the updated stats to all connected clients
      broadcastToClients({
        type: 'goldenLiveUpdate',
        stats: updatedStats
      });
      
      res.json(updatedStats);
    } catch (error) {
      console.error('Increment total players error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Notification endpoints
  app.post('/api/notifications/send', requireAdmin, async (req, res) => {
    try {
      const session = (req as any).session;
      const admin = await storage.getUser(session.userId);
      if (!admin) {
        return res.status(401).json({ message: 'Admin not found' });
      }

      const validation = sendNotificationSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ 
          message: 'Invalid notification data', 
          errors: validation.error.errors 
        });
      }

      const { userId: userIdentifier, title, message, type, imageUrl } = validation.data;

      if (userIdentifier) {
        // Send to specific user - resolve identifier to user
        let targetUser = await storage.getUserByPublicIdOrEmail(userIdentifier);
        if (!targetUser) {
          // Try getting by ID directly
          targetUser = await storage.getUser(userIdentifier);
        }
        
        if (!targetUser) {
          return res.status(404).json({ 
            message: 'User not found', 
            details: 'No user found with that ID or email' 
          });
        }

        const notification = await storage.createNotification({
          userId: targetUser.id,
          title,
          message,
          type: type || "info",
          imageUrl: imageUrl || null,
          sentBy: admin.id
        });
        
        // Send PWA push notification
        try {
          const userSubscriptions = await storage.getUserPushSubscriptions(targetUser.id);
          const pushPromises = userSubscriptions.map(sub => {
            const pushSubscription = {
              endpoint: sub.endpoint,
              keys: {
                p256dh: sub.p256dhKey,
                auth: sub.authKey
              }
            };
            
            const payload = JSON.stringify({
              title,
              message,
              type: type || "info",
              imageUrl: imageUrl || null,
              notificationId: notification.id,
              url: '/'
            });
            
            return webPush.sendNotification(pushSubscription, payload)
              .catch(error => {
                console.error('Failed to send push to endpoint:', sub.endpoint, error);
                if (error.statusCode === 410) {
                  // Subscription expired, remove it
                  storage.deletePushSubscription(sub.endpoint);
                }
              });
          });
          
          await Promise.all(pushPromises);
        } catch (pushError) {
          console.error('Error sending push notifications:', pushError);
        }
        
        res.json({ success: true, notification, targetUser: { id: targetUser.id, email: targetUser.email } });
      } else {
        // Send to all users
        const allUsers = await storage.getAllUsers();
        const notifications = [];
        
        for (const user of allUsers.users) {
          const notification = await storage.createNotification({
            userId: user.id,
            title,
            message,
            type: type || "info",
            imageUrl: imageUrl || null,
            sentBy: admin.id
          });
          notifications.push(notification);
        }
        
        // Send PWA push notifications to all users
        try {
          const allSubscriptions = await storage.getAllActivePushSubscriptions();
          const pushPromises = allSubscriptions.map(sub => {
            const pushSubscription = {
              endpoint: sub.endpoint,
              keys: {
                p256dh: sub.p256dhKey,
                auth: sub.authKey
              }
            };
            
            const payload = JSON.stringify({
              title,
              message,
              type: type || "info",
              imageUrl: imageUrl || null,
              url: '/'
            });
            
            return webPush.sendNotification(pushSubscription, payload)
              .catch(error => {
                console.error('Failed to send push to endpoint:', sub.endpoint, error);
                if (error.statusCode === 410) {
                  // Subscription expired, remove it
                  storage.deletePushSubscription(sub.endpoint);
                }
              });
          });
          
          await Promise.all(pushPromises);
        } catch (pushError) {
          console.error('Error sending push notifications to all users:', pushError);
        }
        
        // Broadcast to all users (safe for broadcast-to-all scenario)
        broadcastToClients({
          type: 'notificationsRefresh',
          message: 'New notification available'
        });
        
        res.json({ success: true, count: notifications.length });
      }
    } catch (error) {
      console.error('Send notification error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.get('/api/notifications', requireAuth, async (req, res) => {
    try {
      const session = (req as any).session;
      const limit = parseInt(req.query.limit as string) || 50;
      
      const notifications = await storage.getUserNotifications(session.userId, limit);
      res.json(notifications);
    } catch (error) {
      console.error('Get notifications error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.get('/api/notifications/unread', requireAuth, async (req, res) => {
    try {
      const session = (req as any).session;
      const notifications = await storage.getUnreadNotifications(session.userId);
      res.json(notifications);
    } catch (error) {
      console.error('Get unread notifications error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.post('/api/notifications/mark-read', requireAuth, async (req, res) => {
    try {
      const validation = markNotificationReadSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ 
          message: 'Invalid request data', 
          errors: validation.error.errors 
        });
      }

      const { notificationId } = validation.data;
      const notification = await storage.markNotificationRead(notificationId);
      
      if (!notification) {
        return res.status(404).json({ message: 'Notification not found' });
      }
      
      res.json({ success: true, notification });
    } catch (error) {
      console.error('Mark notification read error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.post('/api/notifications/mark-all-read', requireAuth, async (req, res) => {
    try {
      const session = (req as any).session;
      await storage.markAllNotificationsRead(session.userId);
      res.json({ success: true });
    } catch (error) {
      console.error('Mark all notifications read error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });
  
  // Push notification endpoints
  app.get('/api/push/vapid-public-key', (req, res) => {
    res.json({ publicKey: VAPID_PUBLIC_KEY });
  });

  app.post('/api/push/subscribe', requireAuth, async (req, res) => {
    try {
      const session = (req as any).session;
      const validation = subscribeToPushSchema.safeParse(req.body);
      
      if (!validation.success) {
        return res.status(400).json({ 
          message: 'Invalid subscription data', 
          errors: validation.error.errors 
        });
      }

      const { endpoint, keys } = validation.data;
      const userAgent = req.headers['user-agent'] || 'Unknown';

      await storage.createPushSubscription({
        userId: session.userId,
        endpoint,
        p256dhKey: keys.p256dh,
        authKey: keys.auth,
        userAgent,
        isActive: true
      });

      res.json({ success: true, message: 'Subscribed to push notifications' });
    } catch (error) {
      console.error('Push subscription error:', error);
      res.status(500).json({ message: 'Failed to subscribe to push notifications' });
    }
  });

  app.post('/api/push/unsubscribe', requireAuth, async (req, res) => {
    try {
      const validation = unsubscribeFromPushSchema.safeParse(req.body);
      
      if (!validation.success) {
        return res.status(400).json({ 
          message: 'Invalid request data', 
          errors: validation.error.errors 
        });
      }

      const { endpoint } = validation.data;
      await storage.deletePushSubscription(endpoint);

      res.json({ success: true, message: 'Unsubscribed from push notifications' });
    } catch (error) {
      console.error('Push unsubscribe error:', error);
      res.status(500).json({ message: 'Failed to unsubscribe from push notifications' });
    }
  });

  // Promo code endpoints
  app.post('/api/admin/promo-codes', requireAdmin, async (req, res) => {
    try {
      const { createPromoCodeSchema } = await import('@shared/schema');
      const validation = createPromoCodeSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ 
          message: 'Invalid request data', 
          errors: validation.error.errors 
        });
      }

      const session = (req as any).session;
      const promoCode = await storage.createPromoCode({
        ...validation.data,
        createdBy: session.userId,
        expiresAt: validation.data.expiresAt ? new Date(validation.data.expiresAt) : null,
      });

      await storage.logAdminAction({
        adminId: session.userId,
        action: 'create_promo_code',
        targetId: promoCode.id,
        details: { code: promoCode.code, totalValue: promoCode.totalValue },
      });

      res.json({ success: true, promoCode });
    } catch (error) {
      console.error('Create promo code error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.get('/api/admin/promo-codes', requireAdmin, async (req, res) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      
      const result = await storage.getAllPromoCodes(page, limit);
      res.json(result);
    } catch (error) {
      console.error('Get promo codes error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.patch('/api/admin/promo-codes/:id/status', requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { isActive } = req.body;

      if (typeof isActive !== 'boolean') {
        return res.status(400).json({ message: 'isActive must be a boolean' });
      }

      const updated = await storage.updatePromoCodeStatus(id, isActive);
      if (!updated) {
        return res.status(404).json({ message: 'Promo code not found' });
      }

      const session = (req as any).session;
      await storage.logAdminAction({
        adminId: session.userId,
        action: isActive ? 'activate_promo_code' : 'deactivate_promo_code',
        targetId: id,
        details: { code: updated.code },
      });

      res.json({ success: true, promoCode: updated });
    } catch (error) {
      console.error('Update promo code status error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.delete('/api/admin/promo-codes/:id', requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const success = await storage.deletePromoCode(id);

      if (!success) {
        return res.status(404).json({ message: 'Promo code not found' });
      }

      const session = (req as any).session;
      await storage.logAdminAction({
        adminId: session.userId,
        action: 'delete_promo_code',
        targetId: id,
        details: {},
      });

      res.json({ success: true });
    } catch (error) {
      console.error('Delete promo code error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.post('/api/promo-codes/redeem', requireAuth, async (req, res) => {
    try {
      const { redeemPromoCodeSchema } = await import('@shared/schema');
      const validation = redeemPromoCodeSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ 
          message: 'Invalid request data', 
          errors: validation.error.errors 
        });
      }

      const session = (req as any).session;
      const result = await storage.redeemPromoCode(validation.data.code, session.userId);

      if (!result.success) {
        return res.status(400).json({ message: result.reason });
      }

      // Get updated user balance
      const user = await storage.getUser(session.userId);
      
      res.json({ 
        success: true, 
        amountAwarded: result.amountAwarded,
        newBalance: user?.balance 
      });
    } catch (error) {
      console.error('Redeem promo code error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.get('/api/promo-codes/my-redemptions', requireAuth, async (req, res) => {
    try {
      const session = (req as any).session;
      const redemptions = await storage.getUserPromoCodeRedemptions(session.userId);
      res.json(redemptions);
    } catch (error) {
      console.error('Get user promo code redemptions error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // VIP Level Telegram Links routes
  app.get('/api/vip-telegram-links', async (req, res) => {
    try {
      const links = await storage.getAllVipLevelTelegramLinks();
      res.json(links);
    } catch (error) {
      console.error('Get VIP telegram links error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Get current user's VIP level Telegram link
  app.get('/api/user/vip-telegram-link', requireAuth, async (req, res) => {
    try {
      const session = (req as any).session;
      const user = await storage.getUser(session.userId);
      
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      const link = await storage.getVipLevelTelegramLink(user.vipLevel);
      
      if (!link || !link.isActive) {
        return res.json({ telegramLink: null });
      }

      res.json({ 
        telegramLink: link.telegramLink,
        description: link.description,
        vipLevel: user.vipLevel
      });
    } catch (error) {
      console.error('Get user VIP telegram link error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.get('/api/admin/vip-telegram-links', requireAdmin, async (req, res) => {
    try {
      const links = await storage.getAllVipLevelTelegramLinks();
      // Transform array to key-value object for frontend
      const linksMap = links.reduce((acc, link) => {
        acc[link.vipLevel] = link.telegramLink || '';
        return acc;
      }, {} as Record<string, string>);
      res.json(linksMap);
    } catch (error) {
      console.error('Get VIP telegram links error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.post('/api/admin/vip-telegram-links', requireAdmin, async (req, res) => {
    try {
      const { upsertVipLevelTelegramLinkSchema } = await import('@shared/schema');
      const validation = upsertVipLevelTelegramLinkSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ 
          message: 'Invalid request data', 
          errors: validation.error.errors 
        });
      }

      const session = (req as any).session;
      const link = await storage.upsertVipLevelTelegramLink({
        ...validation.data,
        updatedBy: session.userId
      });

      await storage.logAdminAction({
        adminId: session.userId,
        action: 'update_vip_telegram_link',
        targetId: link.id,
        details: { 
          vipLevel: link.vipLevel,
          telegramLink: link.telegramLink,
          description: link.description 
        },
      });

      res.json({ success: true, link });
    } catch (error) {
      console.error('Upsert VIP telegram link error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.put('/api/admin/vip-telegram-links/:vipLevel', requireAdmin, async (req, res) => {
    try {
      const { vipLevel } = req.params;
      const { telegramLink } = req.body;
      
      // Validate VIP level
      const validLevels = ['lv1', 'lv2', 'vip', 'vip1', 'vip2', 'vip3', 'vip4', 'vip5', 'vip6', 'vip7'] as const;
      if (!validLevels.includes(vipLevel as any)) {
        return res.status(400).json({ message: 'Invalid VIP level' });
      }
      
      // Validate telegram link (optional, can be empty to clear)
      if (telegramLink && typeof telegramLink !== 'string') {
        return res.status(400).json({ message: 'Telegram link must be a string' });
      }
      
      const session = (req as any).session;
      const link = await storage.upsertVipLevelTelegramLink({
        vipLevel: vipLevel as typeof validLevels[number],
        telegramLink: telegramLink || '',
        description: `Exclusive Telegram channel for ${vipLevel.toUpperCase()} members`,
        isActive: true,
        updatedBy: session.userId
      });

      await storage.logAdminAction({
        adminId: session.userId,
        action: 'update_vip_telegram_link',
        targetId: link.id,
        details: { 
          vipLevel: link.vipLevel,
          telegramLink: link.telegramLink 
        },
      });

      res.json({ success: true, link });
    } catch (error) {
      console.error('Update VIP telegram link error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Database connection routes
  app.get('/api/admin/database-connections', requireAdmin, async (req, res) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      
      const result = await storage.getAllDatabaseConnections(page, limit);
      res.json(result);
    } catch (error) {
      console.error('Get database connections error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.post('/api/admin/database-connections', requireAdmin, async (req, res) => {
    try {
      const session = (req as any).session;
      const { setAsPrimary, enableRealtimeSync, ...connectionData } = req.body;
      
      const connection = await storage.createDatabaseConnection({
        ...connectionData,
        createdBy: session.userId
      });

      await storage.logAdminAction({
        adminId: session.userId,
        action: 'create_database_connection',
        targetId: connection.id,
        details: { name: connection.name, host: connection.host, setAsPrimary, enableRealtimeSync },
      });

      const { multiDatabaseService } = await import('./multi-database-service');
      
      console.log(`[DB Setup] Testing connection to ${connection.name}...`);
      const testResult = await multiDatabaseService.testConnection(connection);
      
      await storage.updateDatabaseConnection(connection.id, {
        lastTestAt: new Date(),
        connectionStatus: testResult.message,
        updatedBy: session.userId
      });

      if (!testResult.success) {
        return res.json({ 
          success: false, 
          connection,
          testResult,
          message: `Connection created but test failed: ${testResult.message}. Please check your connection settings.`
        });
      }

      console.log(`[DB Setup] Connection test successful! Starting data sync...`);
      
      const syncResult = await multiDatabaseService.syncDataToExternalDatabase(
        connection,
        (status, progress) => {
          console.log(`[DB Setup] Sync progress: ${status} (${progress}%)`);
        }
      );

      if (syncResult.success) {
        const updates: any = {
          lastSyncAt: new Date(),
          status: 'active',
          updatedBy: session.userId
        };

        if (setAsPrimary) {
          updates.isActive = true;
          console.log(`[DB Setup] 🎯 Setting ${connection.name} as PRIMARY database...`);
        }

        await storage.updateDatabaseConnection(connection.id, updates);

        if (setAsPrimary) {
          await storage.setActiveDatabaseConnection(connection.id);
          console.log(`[DB Setup] ✅ ${connection.name} is now the PRIMARY database!`);
        }

        if (enableRealtimeSync) {
          const { realtimeSyncService } = await import('./realtime-sync-service');
          await realtimeSyncService.enableForConnection(connection.id);
          console.log(`[DB Setup] ⚡ Real-time sync enabled for ${connection.name}`);
        }

        await storage.logAdminAction({
          adminId: session.userId,
          action: 'sync_database',
          targetId: connection.id,
          details: { name: connection.name, stats: syncResult.stats, setAsPrimary, enableRealtimeSync },
        });

        console.log(`[DB Setup] ✅ Database setup complete! Tables created and data synced.`);
      }

      res.json({ 
        success: true, 
        connection,
        testResult,
        syncResult,
        setAsPrimary,
        enableRealtimeSync,
        message: syncResult.success 
          ? `Successfully created ${connection.name}! All tables created and data synced automatically.${setAsPrimary ? ' Now set as PRIMARY database.' : ''}${enableRealtimeSync ? ' Real-time sync enabled.' : ''}`
          : `Connection created and tested, but sync failed: ${syncResult.message}`
      });
    } catch (error) {
      console.error('Create database connection error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.post('/api/admin/database-connections/:id/test', requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const connection = await storage.getDatabaseConnectionById(id);

      if (!connection) {
        return res.status(404).json({ message: 'Database connection not found' });
      }

      const { multiDatabaseService } = await import('./multi-database-service');
      const result = await multiDatabaseService.testConnection(connection);

      await storage.updateDatabaseConnection(id, {
        lastTestAt: new Date(),
        connectionStatus: result.message,
        updatedBy: (req as any).session.userId
      });

      res.json(result);
    } catch (error) {
      console.error('Test database connection error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.post('/api/admin/database-connections/:id/sync', requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const connection = await storage.getDatabaseConnectionById(id);

      if (!connection) {
        return res.status(404).json({ message: 'Database connection not found' });
      }

      const { multiDatabaseService } = await import('./multi-database-service');
      
      const result = await multiDatabaseService.syncDataToExternalDatabase(
        connection,
        (status, progress) => {
          console.log(`Sync progress: ${status} (${progress}%)`);
        }
      );

      if (result.success) {
        await storage.updateDatabaseConnection(id, {
          lastSyncAt: new Date(),
          updatedBy: (req as any).session.userId
        });

        await storage.logAdminAction({
          adminId: (req as any).session.userId,
          action: 'sync_database',
          targetId: id,
          details: { name: connection.name, stats: result.stats },
        });
      }

      res.json(result);
    } catch (error) {
      console.error('Sync database connection error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.post('/api/admin/database-connections/:id/activate', requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const activated = await storage.setActiveDatabaseConnection(id);

      if (!activated) {
        return res.status(404).json({ message: 'Database connection not found' });
      }

      await storage.logAdminAction({
        adminId: (req as any).session.userId,
        action: 'activate_database_connection',
        targetId: id,
        details: { name: activated.name },
      });

      res.json({ success: true, connection: activated });
    } catch (error) {
      console.error('Activate database connection error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.post('/api/admin/database-connections/:id/set-primary', requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const primary = await storage.setPrimaryDatabaseConnection(id);

      if (!primary) {
        return res.status(404).json({ message: 'Database connection not found' });
      }

      await storage.logAdminAction({
        adminId: (req as any).session.userId,
        action: 'set_primary_database',
        targetId: id,
        details: { name: primary.name },
      });

      res.json({ 
        success: true, 
        connection: primary,
        message: `${primary.name} is now the primary database for the application` 
      });
    } catch (error: any) {
      console.error('Set primary database connection error:', error);
      res.status(400).json({ message: error.message || 'Internal server error' });
    }
  });

  app.post('/api/admin/database-connections/revert-to-replit-primary', requireAdmin, async (req, res) => {
    try {
      const { databaseConnections } = await import("@shared/schema");
      
      await db
        .update(databaseConnections)
        .set({ isPrimary: false, updatedAt: new Date() });

      await storage.logAdminAction({
        adminId: (req as any).session.userId,
        action: 'revert_to_replit_primary',
        targetId: null,
        details: { message: 'Reverted to Replit managed database as primary' },
      });

      res.json({ 
        success: true, 
        message: 'Replit managed database is now the primary database' 
      });
    } catch (error: any) {
      console.error('Revert to Replit primary error:', error);
      res.status(500).json({ message: error.message || 'Internal server error' });
    }
  });

  app.put('/api/admin/database-connections/:id', requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const updates = {
        ...req.body,
        updatedBy: (req as any).session.userId
      };

      const updated = await storage.updateDatabaseConnection(id, updates);

      if (!updated) {
        return res.status(404).json({ message: 'Database connection not found' });
      }

      await storage.logAdminAction({
        adminId: (req as any).session.userId,
        action: 'update_database_connection',
        targetId: id,
        details: { name: updated.name },
      });

      res.json({ success: true, connection: updated });
    } catch (error) {
      console.error('Update database connection error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.delete('/api/admin/database-connections/:id', requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const connection = await storage.getDatabaseConnectionById(id);

      if (!connection) {
        return res.status(404).json({ message: 'Database connection not found' });
      }

      if (connection.isActive) {
        return res.status(400).json({ message: 'Cannot delete active database connection' });
      }

      const success = await storage.deleteDatabaseConnection(id);

      if (!success) {
        return res.status(404).json({ message: 'Database connection not found' });
      }

      await storage.logAdminAction({
        adminId: (req as any).session.userId,
        action: 'delete_database_connection',
        targetId: id,
        details: { name: connection.name },
      });

      res.json({ success: true });
    } catch (error) {
      console.error('Delete database connection error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Digital Ocean Integration Routes
  app.get('/api/admin/digitalocean/droplets', requireAdmin, async (req, res) => {
    try {
      const apiKey = process.env.DIGITALOCEAN_API_KEY;
      
      if (!apiKey) {
        return res.json({ 
          droplets: [], 
          total: 0, 
          hasApiKey: false 
        });
      }

      const response = await fetch('https://api.digitalocean.com/v2/droplets', {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Digital Ocean API error: ${response.statusText}`);
      }

      const data = await response.json();
      
      res.json({
        droplets: data.droplets || [],
        total: data.droplets?.length || 0,
        hasApiKey: true
      });
    } catch (error) {
      console.error('Get Digital Ocean droplets error:', error);
      res.status(500).json({ 
        message: error instanceof Error ? error.message : 'Failed to fetch droplets',
        droplets: [],
        total: 0,
        hasApiKey: true
      });
    }
  });

  app.post('/api/admin/digitalocean/refresh', requireAdmin, async (req, res) => {
    try {
      const apiKey = process.env.DIGITALOCEAN_API_KEY;
      
      if (!apiKey) {
        return res.status(400).json({ 
          success: false, 
          message: 'Digital Ocean API key not configured' 
        });
      }

      const response = await fetch('https://api.digitalocean.com/v2/droplets', {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Digital Ocean API error: ${response.statusText}`);
      }

      await storage.logAdminAction({
        adminId: (req as any).session.userId,
        action: 'refresh_digitalocean_droplets',
        targetId: null,
        details: { timestamp: new Date().toISOString() },
      });

      res.json({ 
        success: true, 
        message: 'Droplets refreshed successfully' 
      });
    } catch (error) {
      console.error('Refresh Digital Ocean droplets error:', error);
      res.status(500).json({ 
        success: false,
        message: error instanceof Error ? error.message : 'Failed to refresh droplets' 
      });
    }
  });

  app.post('/api/admin/digitalocean/deploy/:dropletId', requireAdmin, async (req, res) => {
    try {
      const { dropletId } = req.params;
      const apiKey = process.env.DIGITALOCEAN_API_KEY;
      
      if (!apiKey) {
        return res.status(400).json({ 
          success: false, 
          message: 'Digital Ocean API key not configured' 
        });
      }

      // Get droplet details first
      const dropletResponse = await fetch(`https://api.digitalocean.com/v2/droplets/${dropletId}`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      if (!dropletResponse.ok) {
        throw new Error(`Failed to get droplet details: ${dropletResponse.statusText}`);
      }

      const dropletData = await dropletResponse.json();
      const droplet = dropletData.droplet;
      const publicIp = droplet.networks?.v4?.find((n: any) => n.type === 'public')?.ip_address;

      if (!publicIp) {
        return res.status(400).json({
          success: false,
          message: 'Droplet does not have a public IP address'
        });
      }

      // Log the deployment action
      await storage.logAdminAction({
        adminId: (req as any).session.userId,
        action: 'deploy_to_digitalocean',
        targetId: dropletId,
        details: { 
          dropletName: droplet.name,
          dropletIp: publicIp,
          timestamp: new Date().toISOString() 
        },
      });

      // Execute real deployment using deployment service
      const { deploymentService } = await import('./deployment-service');
      
      const deploymentResult = await deploymentService.deployToDroplet({
        dropletId: parseInt(dropletId),
        dropletName: droplet.name,
        ipAddress: publicIp
      });

      if (!deploymentResult.success) {
        return res.status(500).json({
          success: false,
          message: deploymentResult.message,
          error: deploymentResult.error,
          logs: deploymentResult.logs
        });
      }

      res.json({ 
        success: true, 
        message: `Successfully deployed to ${droplet.name}`,
        dropletId: dropletId,
        dropletName: droplet.name,
        logs: deploymentResult.logs
      });
    } catch (error) {
      console.error('Deploy to Digital Ocean error:', error);
      res.status(500).json({ 
        success: false,
        message: error instanceof Error ? error.message : 'Failed to deploy to server' 
      });
    }
  });

  // Setup load balancer endpoint
  app.post('/api/admin/digitalocean/setup-loadbalancer', requireAdmin, async (req, res) => {
    try {
      const apiKey = process.env.DIGITALOCEAN_API_KEY;
      const { method = 'least_conn', serverWeights = {} } = req.body;
      
      if (!apiKey) {
        return res.status(400).json({ 
          success: false, 
          message: 'Digital Ocean API key not configured' 
        });
      }

      // Validate load balancing method
      const validMethods = ['round_robin', 'least_conn', 'ip_hash'];
      if (!validMethods.includes(method)) {
        return res.status(400).json({
          success: false,
          message: `Invalid load balancing method. Must be one of: ${validMethods.join(', ')}`
        });
      }

      // Get all droplets
      const response = await fetch('https://api.digitalocean.com/v2/droplets', {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Digital Ocean API error: ${response.statusText}`);
      }

      const data = await response.json();
      const activeDroplets = data.droplets.filter((d: any) => d.status === 'active');

      if (activeDroplets.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No active droplets found to setup load balancer'
        });
      }

      // Use the first droplet as the load balancer
      const primaryDroplet = activeDroplets[0];
      const primaryIp = primaryDroplet.networks?.v4?.find((n: any) => n.type === 'public')?.ip_address;

      if (!primaryIp) {
        return res.status(400).json({
          success: false,
          message: 'Primary droplet does not have a public IP address'
        });
      }

      // Prepare backend servers list with custom weights
      const backendServers = activeDroplets.map((droplet: any, idx: number) => {
        const ip = droplet.networks?.v4?.find((n: any) => n.type === 'public')?.ip_address;
        // Use custom weight if provided, otherwise default: 1 for primary, 3 for others
        const weight = serverWeights[droplet.id] || (idx === 0 ? 1 : 3);
        return {
          ip,
          weight: parseInt(weight) || 1
        };
      }).filter((server: any) => server.ip);

      // Execute load balancer setup with method
      const { deploymentService } = await import('./deployment-service');
      
      const setupResult = await deploymentService.setupLoadBalancer(
        primaryIp,
        backendServers,
        method
      );

      // Log the action
      await storage.logAdminAction({
        adminId: (req as any).session.userId,
        action: 'setup_load_balancer',
        targetId: primaryDroplet.id.toString(),
        details: { 
          primaryServer: primaryDroplet.name,
          backendServers: backendServers.map((s: any) => s.ip),
          timestamp: new Date().toISOString() 
        },
      });

      if (!setupResult.success) {
        return res.status(500).json({
          success: false,
          message: setupResult.message,
          error: setupResult.error,
          logs: setupResult.logs
        });
      }

      res.json({
        success: true,
        message: `Load balancer configured on ${primaryDroplet.name}`,
        primaryServer: primaryDroplet.name,
        backendCount: backendServers.length,
        logs: setupResult.logs
      });
    } catch (error) {
      console.error('Setup load balancer error:', error);
      res.status(500).json({ 
        success: false,
        message: error instanceof Error ? error.message : 'Failed to setup load balancer' 
      });
    }
  });

  // ============================================================================
  // AUTO-FIX & SELF-HEALING ENDPOINTS
  // ============================================================================

  // Get self-healing system status
  app.get('/api/admin/self-healing/status', requireAdmin, async (req, res) => {
    try {
      const { selfHealingService } = await import('./self-healing-service');
      const status = selfHealingService.getHealthStatus();
      
      res.json({
        success: true,
        status,
      });
    } catch (error) {
      console.error('Get self-healing status error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Force a healing cycle
  app.post('/api/admin/self-healing/force-heal', requireAdmin, async (req, res) => {
    try {
      const { selfHealingService } = await import('./self-healing-service');
      await selfHealingService.forceHeal();
      
      await storage.logAdminAction({
        adminId: (req as any).session.userId,
        action: 'force_system_heal',
        targetId: null,
        details: { timestamp: new Date().toISOString() },
      });
      
      res.json({
        success: true,
        message: 'Healing cycle completed',
      });
    } catch (error) {
      console.error('Force heal error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Get recent errors from error monitor
  app.get('/api/admin/error-monitor/errors', requireAdmin, async (req, res) => {
    try {
      const { errorMonitorService } = await import('./error-monitor-service');
      const limit = parseInt(req.query.limit as string) || 50;
      const errors = errorMonitorService.getRecentErrors(limit);
      
      res.json({
        success: true,
        errors,
      });
    } catch (error) {
      console.error('Get errors error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Get data staleness monitor stats
  app.get('/api/admin/data-staleness/stats', requireAdmin, async (req, res) => {
    try {
      const { dataStalenessMonitor } = await import('./data-staleness-monitor');
      const stats = dataStalenessMonitor.getStats();
      
      res.json({
        success: true,
        stats,
      });
    } catch (error) {
      console.error('Get staleness stats error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Reset data staleness monitor stats
  app.post('/api/admin/data-staleness/reset', requireAdmin, async (req, res) => {
    try {
      const { dataStalenessMonitor } = await import('./data-staleness-monitor');
      dataStalenessMonitor.resetStats();
      
      await storage.logAdminAction({
        adminId: (req as any).session.userId,
        action: 'reset_staleness_monitor',
        targetId: null,
        details: { timestamp: new Date().toISOString() },
      });
      
      res.json({
        success: true,
        message: 'Staleness monitor stats reset',
      });
    } catch (error) {
      console.error('Reset staleness stats error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Get LSP auto-fix history
  app.get('/api/admin/lsp-autofix/history', requireAdmin, async (req, res) => {
    try {
      const { lspAutoFixService } = await import('./lsp-autofix-service');
      const limit = parseInt(req.query.limit as string) || 50;
      const history = lspAutoFixService.getFixHistory(limit);
      
      res.json({
        success: true,
        history,
      });
    } catch (error) {
      console.error('Get LSP history error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Get server usage metrics
  app.get('/api/admin/server-metrics', requireAdmin, async (req, res) => {
    try {
      const os = await import('os');
      
      // Get CPU information
      const cpus = os.cpus();
      const cpuCount = cpus.length;
      
      // Calculate CPU usage percentage
      const cpuUsage = cpus.map((cpu, i) => {
        const total = Object.values(cpu.times).reduce((acc, time) => acc + time, 0);
        const idle = cpu.times.idle;
        const usage = total > 0 ? ((total - idle) / total) * 100 : 0;
        return {
          core: i,
          usage: Math.round(usage * 100) / 100
        };
      });
      
      // Calculate average CPU usage
      const avgCpuUsage = cpuUsage.reduce((acc, cpu) => acc + cpu.usage, 0) / cpuCount;
      
      // Get memory information
      const totalMemory = os.totalmem();
      const freeMemory = os.freemem();
      const usedMemory = totalMemory - freeMemory;
      const memoryUsagePercent = (usedMemory / totalMemory) * 100;
      
      // Get system information
      const uptime = os.uptime();
      const platform = os.platform();
      const arch = os.arch();
      const hostname = os.hostname();
      const loadAvg = os.loadavg();
      
      // Format bytes to human readable
      const formatBytes = (bytes: number) => {
        const gb = bytes / (1024 ** 3);
        return `${gb.toFixed(2)} GB`;
      };
      
      res.json({
        success: true,
        metrics: {
          cpu: {
            count: cpuCount,
            model: cpus[0]?.model || 'Unknown',
            usage: Math.round(avgCpuUsage * 100) / 100,
            cores: cpuUsage,
            loadAverage: {
              '1min': Math.round(loadAvg[0] * 100) / 100,
              '5min': Math.round(loadAvg[1] * 100) / 100,
              '15min': Math.round(loadAvg[2] * 100) / 100
            }
          },
          memory: {
            total: totalMemory,
            used: usedMemory,
            free: freeMemory,
            usagePercent: Math.round(memoryUsagePercent * 100) / 100,
            totalFormatted: formatBytes(totalMemory),
            usedFormatted: formatBytes(usedMemory),
            freeFormatted: formatBytes(freeMemory)
          },
          system: {
            platform,
            arch,
            hostname,
            uptime: Math.floor(uptime),
            uptimeFormatted: formatUptime(uptime)
          },
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      console.error('Get server metrics error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  // Helper function to format uptime
  function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    
    return parts.length > 0 ? parts.join(' ') : '< 1m';
  }

  // Start server metrics broadcasting every 30 seconds (optimized for mobile/Android performance)
  setInterval(async () => {
    try {
      await broadcastServerMetrics();
    } catch (error) {
      console.error('Error in server metrics broadcast:', error);
    }
  }, 30000);

  return {
    httpServer,
    wss,
    startGames: async () => {
      // Start initial games after server is ready
      try {
        console.log('🎮 Starting game timers...');
        await startGame(1);  // 1-minute game
        console.log('✅ 1-minute game started');
        await startGame(3);  // 3-minute game
        console.log('✅ 3-minute game started');
        await startGame(5);  // 5-minute game
        console.log('✅ 5-minute game started');
        await startGame(10); // 10-minute game
        console.log('✅ 10-minute game started');
        console.log('🎮 All games initialized successfully');
        
        // Start broadcasting server metrics
        console.log('📊 Starting server metrics broadcast...');
        await broadcastServerMetrics();
        console.log('✅ Server metrics broadcast started');
        
        // Start automatic bet settlement service
        console.log('🔄 Starting automatic bet settlement service...');
        betSettlementService.start();
      } catch (error) {
        console.error('❌ Error initializing games:', error);
      }
    }
  };
}
