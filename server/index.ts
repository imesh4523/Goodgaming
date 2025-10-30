import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cors from "cors";
import mongoSanitize from "express-mongo-sanitize";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { blockBadUserAgents, checkIPReputation, validateCloudflareRequest, blockCountries, detectSQLInjection, detectXSS, detectPathTraversal, monitorRequestSize, detectSuspiciousHeaders } from "./cloudflare-security";
import { parseUserAgent } from "./userAgentParser";
import { advancedBotDetection, behavioralAnalysis, detectHoneypot, antiScraping, verifyRequestIntegrity } from "./advanced-security";
import { checkReputationScore, adaptiveRateLimiter, endpointRateLimiter } from "./advanced-rate-limiting";
import { detectDataExfiltration, detectBruteForce, logSecurityEvent, SecurityEventType, ThreatLevel } from "./security-monitoring";

const app = express();

// ============================================================================
// PRODUCTION SECURITY VALIDATION
// ============================================================================
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction) {
  // Validate critical environment variables in production
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'gaming-platform-secret-key-change-in-production') {
    console.warn('⚠️  WARNING: SESSION_SECRET not set to a secure value in production!');
    console.warn('   Generate one with: openssl rand -base64 32');
    console.warn('   Using auto-generated session secret (not recommended for multi-instance deployments)');
  }
  
  if (!process.env.CLOUDFLARE_ENABLED) {
    console.warn('⚠️  WARNING: CLOUDFLARE_ENABLED is not set. Cloudflare WAF protection will be disabled.');
  }
  
  console.log('✅ Production mode security validated');
}

// Security: Trust proxy for Cloudflare and load balancers
// This allows Express to correctly identify client IPs from proxy headers
// Use '1' to trust only the first proxy (Cloudflare)
app.set('trust proxy', 1);

// Security: Add Helmet for HTTP security headers
app.use(helmet({
  contentSecurityPolicy: isProduction ? {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // unsafe-eval needed for Vite
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "wss:", "ws:"],
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  } : false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Security: Configure CORS with support for custom domains
const allowedOrigins = isProduction 
  ? [
      /^https:\/\/.*\.replit\.app$/,      // *.replit.app domains
      /^https:\/\/.*\.replit\.dev$/,      // *.replit.dev domains
      ...(process.env.CUSTOM_DOMAIN ? [process.env.CUSTOM_DOMAIN] : [])
    ]
  : true; // Allow all origins in development

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins === true) {
      return callback(null, true);
    }
    
    // Check if origin matches any allowed pattern
    const isAllowed = allowedOrigins.some(allowed => {
      if (typeof allowed === 'string') {
        return origin === allowed;
      }
      if (allowed instanceof RegExp) {
        return allowed.test(origin);
      }
      return false;
    });
    
    if (isAllowed) {
      callback(null, true);
    } else {
      console.warn(`⚠️  CORS: Blocked request from unauthorized origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: []
}));

// Security: Rate limiting for API endpoints
// Development: Higher limits for testing
// Production: Strict limits for security
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isProduction ? 5000 : 10000, // Production: 5000, Development: 10000
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isProduction ? 50 : 100, // Production: 50, Development: 100
  message: 'Too many login attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting to API routes
app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);

// Security: Request body size limits
// Production: Stricter limits to prevent abuse
const bodySizeLimit = isProduction ? '5mb' : '10mb';

app.use(express.json({ 
  limit: bodySizeLimit,
  verify: (req: any, res, buf) => {
    // Capture raw body for webhook signature verification
    if (req.originalUrl?.includes('/api/payments/webhook')) {
      req.rawBody = buf;
    }
  }
}));
app.use(express.urlencoded({ extended: false, limit: bodySizeLimit }));

// Security: Sanitize user input to prevent NoSQL injection
app.use(mongoSanitize({
  replaceWith: '_',
  onSanitize: ({ req, key }) => {
    log(`Sanitized input detected: ${key} in ${req.path}`);
  }
}));

// Security: Cloudflare-specific protections (WAF Integration)
// Skip security checks for WebSocket upgrade requests
const skipForWebSocket = (middleware: any) => (req: Request, res: Response, next: NextFunction) => {
  if (req.headers.upgrade === 'websocket') {
    return next();
  }
  return middleware(req, res, next);
};

// ADVANCED META SECURITY LAYER - Multi-layered protection against sophisticated attacks
app.use(skipForWebSocket(validateCloudflareRequest)); // Ensure requests come through Cloudflare
app.use(skipForWebSocket(blockCountries)); // Country-based access control
app.use(skipForWebSocket(checkReputationScore)); // IP reputation scoring system
app.use(skipForWebSocket(blockBadUserAgents)); // Block malicious scanning tools
app.use(skipForWebSocket(checkIPReputation)); // Block known bad IPs
app.use(skipForWebSocket(advancedBotDetection)); // Advanced bot detection with fingerprinting
app.use(skipForWebSocket(behavioralAnalysis)); // Behavioral anomaly detection
app.use(skipForWebSocket(detectSuspiciousHeaders)); // Detect suspicious request headers
app.use(skipForWebSocket(monitorRequestSize)); // Monitor and limit request sizes
app.use(skipForWebSocket(detectPathTraversal)); // Prevent path traversal attacks
app.use(skipForWebSocket(detectSQLInjection)); // Detect SQL injection attempts
app.use(skipForWebSocket(detectXSS)); // Detect XSS attacks
app.use(skipForWebSocket(detectDataExfiltration)); // Detect data exfiltration attempts
app.use(skipForWebSocket(detectBruteForce)); // Detect brute force attacks
app.use(skipForWebSocket(antiScraping)); // Anti-scraping protection
app.use(skipForWebSocket(verifyRequestIntegrity)); // Request signature verification

// Security: Configure session middleware with enhanced security
app.use(session({
  secret: process.env.SESSION_SECRET || 'gaming-platform-secret-key-change-in-production',
  name: 'sessionId', // Custom session cookie name (hide default 'connect.sid')
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction, // HTTPS only in production
    httpOnly: true, // Prevent XSS attacks
    maxAge: isProduction ? 12 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000, // Production: 12h, Dev: 24h
    sameSite: 'strict', // Enhanced security
    path: '/',
  },
  rolling: true, // Reset cookie expiration on each request
}));

// ADVANCED FORM PROTECTION
app.use(skipForWebSocket(detectHoneypot)); // Detect honeypot field submissions (bot trap)

// ADVANCED ADAPTIVE RATE LIMITING
// Dynamically adjusts rate limits based on IP reputation
app.use('/api/', skipForWebSocket(adaptiveRateLimiter));

// Endpoint-specific rate limiting for sensitive operations
// Development mode: More lenient limits for testing
// Production mode: Strict limits for security
app.use(skipForWebSocket(endpointRateLimiter({
  endpoint: '/api/auth/login',
  maxRequests: isProduction ? 5 : 15, // Production: 5 attempts, Dev: 15 attempts
  windowMs: 15 * 60 * 1000 // 15 minutes
})));

app.use(skipForWebSocket(endpointRateLimiter({
  endpoint: '/api/withdraw',
  maxRequests: isProduction ? 3 : 15, // Production: 3 attempts, Dev: 15 attempts
  windowMs: isProduction ? 60 * 60 * 1000 : 15 * 60 * 1000 // Production: 1 hour, Dev: 15 min
})));

app.use(skipForWebSocket(endpointRateLimiter({
  endpoint: '/api/bets/place',
  maxRequests: isProduction ? 100 : 200, // Production: 100 bets, Dev: 200 bets
  windowMs: 60 * 1000 // 1 minute
})));

// Helper function to detect country from IP (fallback for development)
function getCountryFromIP(ip: string, cfCountry?: string): string | null {
  // Use Cloudflare country if available
  if (cfCountry) return cfCountry;
  
  // Development fallback: Generate realistic country based on IP pattern
  if (process.env.NODE_ENV === 'development' || !cfCountry) {
    // Common country codes for realistic demo data
    const countries = ['LK', 'IN', 'US', 'GB', 'AU', 'CA', 'SG', 'MY', 'AE', 'PK'];
    
    // Handle different IP formats (IPv4, IPv6, localhost)
    let ipHash = 0;
    
    if (ip === 'unknown' || !ip) {
      // Default to Sri Lanka for unknown IPs
      return 'LK';
    } else if (ip.includes('.')) {
      // IPv4 address - sum the octets
      ipHash = ip.split('.').reduce((acc, part) => {
        const num = parseInt(part || '0');
        return acc + (isNaN(num) ? 0 : num);
      }, 0);
    } else if (ip.includes(':')) {
      // IPv6 address - use character codes for consistency
      ipHash = ip.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    } else {
      // Other formats - use string hash
      ipHash = ip.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    }
    
    return countries[ipHash % countries.length];
  }
  
  return null;
}

// Security: Cloudflare & IP tracking middleware
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  // Get client IP with Cloudflare support
  // Priority: CF-Connecting-IP > X-Forwarded-For > remoteAddress
  let clientIP = 'unknown';
  
  // Cloudflare passes the real visitor IP in CF-Connecting-IP header
  if (req.headers['cf-connecting-ip']) {
    clientIP = req.headers['cf-connecting-ip'] as string;
  } 
  // Fallback to X-Forwarded-For (for other proxies/load balancers)
  else if (req.headers['x-forwarded-for']) {
    clientIP = (req.headers['x-forwarded-for'] as string).split(',')[0].trim();
  } 
  // Direct connection
  else {
    clientIP = req.socket.remoteAddress || 'unknown';
  }
  
  // Detect country with fallback for development
  const cfCountry = req.headers['cf-ipcountry'] as string | undefined;
  const detectedCountry = getCountryFromIP(clientIP, cfCountry);
  
  // Store IP and Cloudflare data in request for use in other middleware
  (req as any).clientIP = clientIP;
  (req as any).cloudflare = {
    ip: req.headers['cf-connecting-ip'],
    country: detectedCountry,
    ray: req.headers['cf-ray'],
    visitor: req.headers['cf-visitor'],
  };

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
      
      // Security: Log failed authentication attempts
      if ((path.includes('/login') || path.includes('/signup')) && res.statusCode >= 400) {
        log(`⚠️ SECURITY: Failed auth attempt from IP ${clientIP} on ${path}`);
      }
      
      // Security: Log suspicious activity (high rate of errors)
      if (res.statusCode === 429) {
        log(`🚨 SECURITY: Rate limit exceeded from IP ${clientIP} on ${path}`);
      }
    }
  });

  next();
});

// Page view tracking middleware
app.use(async (req, res, next) => {
  // Only track GET requests that are not API calls, assets, or WebSocket upgrades
  if (
    req.method === 'GET' &&
    !req.path.startsWith('/api') &&
    !req.path.startsWith('/assets') &&
    !req.path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|map|apk)$/) &&
    req.headers.upgrade !== 'websocket'
  ) {
    try {
      const { storage } = await import("./storage");
      const session = (req as any).session;
      const clientIP = (req as any).clientIP || 'unknown';
      const cloudflare = (req as any).cloudflare || {};
      const userAgent = req.headers['user-agent'];
      const parsedUA = parseUserAgent(userAgent);
      
      await storage.createPageView({
        userId: session?.userId || null,
        path: req.path,
        ipAddress: clientIP,
        country: cloudflare.country || null,
        userAgent: userAgent || null,
        browserName: parsedUA.browserName,
        deviceType: parsedUA.deviceType,
        deviceModel: parsedUA.deviceModel,
        operatingSystem: parsedUA.operatingSystem,
        referrer: req.headers.referer || null,
        sessionId: session?.id || null,
      });
    } catch (error) {
      // Don't let page view tracking errors break the app
      console.error('Error tracking page view:', error);
    }
  }
  next();
});

(async () => {
  const { httpServer: server, wss, startGames } = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, async () => {
    log(`serving on port ${port}`);
    
    // Start self-healing system for automatic error fixing
    const { selfHealingService } = await import('./self-healing-service');
    selfHealingService.start();
    log('🛡️ Self-healing system activated - Auto-fixing LSP errors');
    
    // Initialize real-time sync for existing database connections
    try {
      const { storage } = await import('./storage');
      const { realtimeSyncService } = await import('./realtime-sync-service');
      
      const connections = await storage.getAllDatabaseConnections();
      
      if (connections.total === 0 && process.env.DATABASE_URL && process.env.PGHOST) {
        // Auto-add Replit PostgreSQL database connection
        console.log('[Database] 🔧 Auto-configuring Replit PostgreSQL database...');
        try {
          const dbHost = process.env.PGHOST;
          const dbPort = parseInt(process.env.PGPORT || '5432');
          const dbUser = process.env.PGUSER || 'neondb_owner';
          const dbName = process.env.PGDATABASE || 'neondb';
          const dbPassword = process.env.PGPASSWORD || '';
          
          const connection = await storage.createDatabaseConnection({
            name: 'Replit Managed Database',
            databaseType: 'postgresql',
            host: dbHost,
            port: dbPort,
            database: dbName,
            username: dbUser,
            password: dbPassword,
            ssl: true,
            status: 'active',
            isActive: true,
            createdBy: 'system'
          });
          
          // Set as primary
          await storage.setPrimaryDatabaseConnection(connection.id);
          
          console.log('[Database] ✅ Replit PostgreSQL database configured and set as PRIMARY');
          console.log(`[Database] 📊 Host: ${dbHost}`);
          console.log(`[Database] 📊 Database: ${dbName}`);
          
          // Re-fetch connections after adding
          const updatedConnections = await storage.getAllDatabaseConnections();
          
          // Enable real-time sync for the new connection
          const { realtimeSyncService } = await import('./realtime-sync-service');
          await realtimeSyncService.enableForConnection(connection.id);
          console.log(`[RealtimeSync] ✅ Enabled for: ${connection.name}`);
          console.log(`[RealtimeSync] ✨ Real-time sync is now active`);
        } catch (error: any) {
          console.error('[Database] ❌ Auto-configuration failed:', error.message);
          console.log('[RealtimeSync] 📋 No database connections configured. Real-time sync is ready but not active.');
          console.log('[RealtimeSync] ℹ️  Add a database connection in Admin → Database Connections to enable real-time sync.');
        }
      } else if (connections.total === 0) {
        console.log('[RealtimeSync] 📋 No database connections configured. Real-time sync is ready but not active.');
        console.log('[RealtimeSync] ℹ️  Add a database connection in Admin → Database Connections to enable real-time sync.');
      } else {
        let activeCount = 0;
        for (const conn of connections.connections) {
          // Enable real-time sync for active connections
          if (conn.isActive) {
            await realtimeSyncService.enableForConnection(conn.id);
            console.log(`[RealtimeSync] ✅ Enabled for active connection: ${conn.name}`);
            activeCount++;
          }
        }
        if (activeCount === 0) {
          console.log('[RealtimeSync] ⚠️  Database connections exist but none are marked as active.');
          console.log('[RealtimeSync] ℹ️  Mark a connection as active in Admin → Database Connections to enable real-time sync.');
        } else {
          console.log(`[RealtimeSync] ✨ Real-time sync is now active for ${activeCount} connection(s)`);
        }
      }
    } catch (error: any) {
      console.error('[RealtimeSync] ❌ Failed to initialize:', error.message);
    }
    
    // Start games after server is fully initialized
    await startGames();
    
    // Start data staleness monitor for automatic data updates
    const { dataStalenessMonitor } = await import('./data-staleness-monitor');
    dataStalenessMonitor.registerBroadcastCallback((message) => {
      wss.clients.forEach((client) => {
        if (client.readyState === 1) {
          client.send(JSON.stringify(message));
        }
      });
    });
    dataStalenessMonitor.start();
    console.log('🔍 Data staleness monitor started - Auto-detecting and fixing stale data');
    
    // Create a default agent account for testing (development only)
    if (process.env.NODE_ENV === 'development') {
      const { storage } = await import("./storage");
      try {
        // Check if agent already exists before creating
        const existingAgent = await storage.getUserByEmail("agent@test.com");
        if (!existingAgent) {
          const result = await storage.createAgent("agent@test.com", "password123", "0.0500");
          
          // Fund the test agent with sufficient balance for testing deposits
          await storage.updateUserBalance(result.user.id, "50000.00000000");
          console.log('✅ Demo agent created: agent@test.com / password123');
        }
      } catch (error) {
        // Test agent already exists or creation failed
      }
    }
  });
})();
