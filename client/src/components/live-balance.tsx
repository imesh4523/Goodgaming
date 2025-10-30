import { useState, useEffect, useRef, memo } from "react";
import { Coins, TrendingUp, TrendingDown } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { usdToGoldCoins, formatGoldCoins } from "@/lib/currency";

interface BalanceUpdate {
  id?: string;
  userId: string;
  oldBalance: string;
  newBalance: string;
  changeAmount: string;
  changeType: 'win' | 'loss' | 'deposit' | 'withdrawal' | 'bet';
  timestamp: string;
  isBackfill?: boolean;
}

interface LiveBalanceProps {
  user?: any;
  className?: string;
  showTrend?: boolean;
  balanceUpdates?: BalanceUpdate[];
  blockUpdate?: boolean;
}

const LiveBalance = memo(function LiveBalance({ user, className = "", showTrend = true, balanceUpdates = [], blockUpdate = false }: LiveBalanceProps) {
  const [displayBalance, setDisplayBalance] = useState<number>(0);
  const [previousBalance, setPreviousBalance] = useState<number>(0);
  const [balanceTrend, setBalanceTrend] = useState<'up' | 'down' | 'neutral'>('neutral');
  const [isAnimating, setIsAnimating] = useState(false);
  const [lastUpdateSource, setLastUpdateSource] = useState<'server' | 'websocket'>('server');
  const processedUpdateIdsRef = useRef<Set<string>>(new Set());
  const animationTimeoutRef = useRef<NodeJS.Timeout>();

  // Check if user is authenticated (not demo)
  // Use a more defensive check to avoid triggering queries with stale cached data
  const isAuthenticated = Boolean(
    user?.id && 
    user?.email && 
    user?.email !== 'demo@example.com' &&
    typeof user.id === 'string' && 
    user.id.length > 0
  );

  // Fetch user data only on mount - WebSocket handles all real-time updates (optimized for Android performance)
  const { data: liveUser } = useQuery({
    queryKey: ['/api/user/current'],
    refetchInterval: false, // Disabled polling - WebSocket provides real-time updates
    enabled: isAuthenticated && !blockUpdate, // Only enable for authenticated users and when updates not blocked
    retry: false,
    staleTime: 5 * 60 * 1000, // 5 minutes - rely on WebSocket for updates
  });

  // Use live user data for authenticated users, original user data for demo users
  const currentUser = isAuthenticated ? (liveUser || user) : user;
  const serverBalance = parseFloat(currentUser?.balance || "0");

  // Sync display balance to server data only when appropriate
  useEffect(() => {
    // Only sync from server if:
    // 1. Updates not blocked AND
    // 2. Server balance is different from display AND
    // 3. Server balance is valid (>= 0) AND
    // 4. Either we're in server mode OR server has caught up with websocket updates
    const serverCaughtUp = lastUpdateSource === 'websocket' && Math.abs(serverBalance - displayBalance) < 0.001;
    const shouldSync = lastUpdateSource === 'server' || serverCaughtUp;
    
    if (!blockUpdate && serverBalance !== displayBalance && serverBalance >= 0 && shouldSync) {
      setDisplayBalance(serverBalance);
      setPreviousBalance(serverBalance);
      if (serverCaughtUp) {
        setLastUpdateSource('server');
      }
    }
  }, [serverBalance, displayBalance, lastUpdateSource, blockUpdate]);

  // Track balance changes from WebSocket updates and update display immediately
  useEffect(() => {
    if (!blockUpdate && balanceUpdates.length > 0 && currentUser) {
      // Filter updates to find the latest non-backfill update for current user
      let latestValidUpdate: BalanceUpdate | null = null;
      
      for (const update of balanceUpdates) {
        // Skip if no ID (shouldn't happen but be safe)
        if (!update.id) continue;
        
        // Skip if already processed
        if (processedUpdateIdsRef.current.has(update.id)) continue;
        
        // Skip backfill updates
        if (update.isBackfill) {
          // Mark as processed so we don't check it again
          processedUpdateIdsRef.current.add(update.id);
          // Keep set size manageable
          if (processedUpdateIdsRef.current.size > 100) {
            const arr = Array.from(processedUpdateIdsRef.current);
            processedUpdateIdsRef.current = new Set(arr.slice(arr.length - 100));
          }
          continue;
        }
        
        // Check if this update is for current user
        const userMatches = update && (
          update.userId === currentUser?.id || 
          update.userId === currentUser?.publicId ||
          (currentUser?.email === 'demo@example.com' && update.userId === 'user-1')
        );
        
        if (userMatches) {
          // Found a valid update, use it
          latestValidUpdate = update;
          break; // Use the first (latest) valid update we find
        }
      }
      
      if (latestValidUpdate) {
        const newBalance = parseFloat(latestValidUpdate.newBalance);
        const currentPrevious = previousBalance;
        
        // Mark this update as processed
        processedUpdateIdsRef.current.add(latestValidUpdate.id!);
        // Keep set size manageable
        if (processedUpdateIdsRef.current.size > 100) {
          const arr = Array.from(processedUpdateIdsRef.current);
          processedUpdateIdsRef.current = new Set(arr.slice(arr.length - 100));
        }
        
        // Update display balance immediately
        setDisplayBalance(newBalance);
        setLastUpdateSource('websocket');
        
        // Animate for any balance change (including to/from zero)
        if (Math.abs(newBalance - currentPrevious) > 0.001) {
          setBalanceTrend(newBalance > currentPrevious ? 'up' : 'down');
          setIsAnimating(true);
          
          // Clear any existing animation timeout
          if (animationTimeoutRef.current) {
            clearTimeout(animationTimeoutRef.current);
          }
          
          // Reset animation after 2 seconds using ref to prevent cleanup issues
          animationTimeoutRef.current = setTimeout(() => {
            setIsAnimating(false);
            setBalanceTrend('neutral');
            setPreviousBalance(newBalance);
          }, 2000);
        } else {
          // No animation needed, update previous balance immediately
          setPreviousBalance(newBalance);
        }
      }
    }
  }, [balanceUpdates, currentUser?.id, currentUser?.publicId, currentUser?.email, previousBalance, blockUpdate]);

  // This effect is now handled in the main sync effect above

  // Cleanup animation timeout on unmount
  useEffect(() => {
    return () => {
      if (animationTimeoutRef.current) {
        clearTimeout(animationTimeoutRef.current);
      }
    };
  }, []);

  const goldCoinsBalance = usdToGoldCoins(displayBalance);

  const getTrendIcon = () => {
    if (!showTrend || balanceTrend === 'neutral') return null;
    
    return balanceTrend === 'up' ? (
      <TrendingUp className="w-4 h-4 text-green-400 animate-bounce" />
    ) : (
      <TrendingDown className="w-4 h-4 text-red-400 animate-bounce" />
    );
  };

  const getTrendColor = () => {
    if (!isAnimating) return "";
    return balanceTrend === 'up' ? "text-green-400" : "text-red-400";
  };

  return (
    <div 
      className={`live-balance-container ${className}`}
      data-testid="live-balance"
    >
      {/* Live Balance Display */}
      <div className="glass-card rounded-lg px-2 py-2 relative overflow-hidden group hover:scale-105 transition-all duration-300 max-w-fit">
        <div className="absolute inset-0 bg-gradient-to-br from-yellow-400/10 to-orange-500/10 rounded-xl"></div>
        
        {/* Live indicator */}
        <div className="absolute top-2 right-2">
          <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></span>
        </div>

        <div className="relative z-10">
          <div className="flex items-center gap-1 mb-1">
            <p className="text-xs text-white/90 font-medium">Balance</p>
            {getTrendIcon()}
          </div>
          
          <div 
            className={`text-xs font-bold text-white transition-all duration-500 ${
              isAnimating ? `${getTrendColor()} scale-110` : ""
            }`} 
            data-testid="text-live-balance"
          >
            {formatGoldCoins(goldCoinsBalance)}
          </div>
          
          {/* USD equivalent */}
          <div className="text-xs text-white/70">
            ${displayBalance.toFixed(2)} USD
          </div>
        </div>

        {/* Shimmer effect for live updates */}
        {isAnimating && (
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent rounded-xl animate-shimmer"></div>
        )}
      </div>

    </div>
  );
});

export default LiveBalance;