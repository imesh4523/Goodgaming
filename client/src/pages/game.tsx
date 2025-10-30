import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import GameTimer from "@/components/game-timer";
import ColorBetting from "@/components/color-betting";
import BettingControls from "@/components/betting-controls";
import GameHistory from "@/components/game-history";
import MyBets from "@/components/my-bets";
import LiveStatusIndicator from "@/components/live-status-indicator";
import Enhanced3XBetLogo from "@/components/enhanced-3xbet-logo";
import LiveBalance from "@/components/live-balance";
import GoldenArea from "@/components/golden-area";
import { useWebSocket } from "@/hooks/use-websocket";
import { Button } from "@/components/ui/button";
import { User } from "lucide-react";
import FallingAnimation from "@/components/falling-animation";
import WinCelebration from "@/components/win-celebration";
import LossAnimation from "@/components/loss-animation";
import { useIsMobile } from "@/hooks/use-mobile";

export default function GamePage() {
  const isMobile = useIsMobile();
  const [, setLocation] = useLocation();
  const [selectedRound, setSelectedRound] = useState(1);
  const [selectedColor, setSelectedColor] = useState<string | null>(null);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [betAmount, setBetAmount] = useState(10);
  const [multiplier, setMultiplier] = useState(1);
  const [showWinCelebration, setShowWinCelebration] = useState(false);
  const [winAmount, setWinAmount] = useState(0);
  const [showLossAnimation, setShowLossAnimation] = useState(false);
  const [lossAmount, setLossAmount] = useState(0);
  const [processedUpdateIds, setProcessedUpdateIds] = useState<Set<string>>(new Set());
  const [pendingWins, setPendingWins] = useState<number[]>([]);
  const [pendingLosses, setPendingLosses] = useState<number[]>([]);

  // Check authentication
  const { data: user, isLoading, error } = useQuery<any>({
    queryKey: ['/api/auth/me'],
    retry: false,
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
    refetchInterval: false,
  });

  // Fallback to demo user if not authenticated
  const { data: demoUser, isLoading: demoLoading } = useQuery<any>({
    queryKey: ['/api/user/demo'],
    enabled: !user && !!error,
    staleTime: 10 * 60 * 1000, // 10 minutes 
    refetchOnWindowFocus: false,
    refetchInterval: false,
  });

  // WebSocket connection for real-time updates - must be before conditional returns
  const { gameStates, gameResults, balanceUpdates, connectionStatus } = useWebSocket();

  const currentUser = user || demoUser;

  useEffect(() => {
    if (balanceUpdates.length === 0 || !currentUser) return;

    const newWins: number[] = [];
    const newLosses: number[] = [];

    for (const update of balanceUpdates) {
      if (!update.id || processedUpdateIds.has(update.id)) continue;

      if (update.isBackfill) {
        setProcessedUpdateIds(prev => new Set(Array.from(prev).concat(update.id)));
        continue;
      }

      const isAuthenticatedUser = !!user;
      const isDemoUser = !user && demoUser?.email === 'demo@example.com';
      
      const userMatches = update && (
        (isAuthenticatedUser && (update.userId === currentUser?.id || update.userId === currentUser?.publicId)) ||
        (isDemoUser && update.userId === 'user-1')
      );
      
      if (userMatches) {
        const changeAmount = parseFloat(update.changeAmount);
        
        if (update.changeType === 'win' && changeAmount > 0) {
          newWins.push(changeAmount);
          setProcessedUpdateIds(prev => {
            const newSet = new Set(Array.from(prev).concat(update.id));
            if (newSet.size > 100) {
              const arr = Array.from(newSet);
              return new Set(arr.slice(arr.length - 100));
            }
            return newSet;
          });
        } else if (update.changeType === 'loss' && changeAmount < 0) {
          newLosses.push(Math.abs(changeAmount));
          setProcessedUpdateIds(prev => {
            const newSet = new Set(Array.from(prev).concat(update.id));
            if (newSet.size > 100) {
              const arr = Array.from(newSet);
              return new Set(arr.slice(arr.length - 100));
            }
            return newSet;
          });
        }
      }
    }

    if (newWins.length > 0) {
      setPendingWins(prev => prev.concat(newWins));
    }
    if (newLosses.length > 0) {
      setPendingLosses(prev => prev.concat(newLosses));
    }
  }, [balanceUpdates, currentUser, processedUpdateIds]);

  useEffect(() => {
    if (pendingWins.length > 0) {
      const timer = setTimeout(() => {
        const totalWin = pendingWins.reduce((sum, amount) => sum + amount, 0);
        setWinAmount(totalWin);
        setShowWinCelebration(true);
        setPendingWins([]);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [pendingWins]);

  useEffect(() => {
    if (pendingLosses.length > 0) {
      const timer = setTimeout(() => {
        const totalLoss = pendingLosses.reduce((sum, amount) => sum + amount, 0);
        setLossAmount(totalLoss);
        setShowLossAnimation(true);
        setPendingLosses([]);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [pendingLosses]);

  // Show loading or redirect to login if no user available
  if (isLoading || (demoLoading && !user && !!error)) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="text-center max-w-md">
          <User className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
          <h2 className="text-xl font-semibold mb-2">Authentication Required</h2>
          <p className="text-muted-foreground mb-4">
            Please sign in to access the gaming platform.
          </p>
          <Button onClick={() => setLocation('/login')}>
            Sign In
          </Button>
        </div>
      </div>
    );
  }

  const currentGame = gameStates[selectedRound];

  return (
    <div className="min-h-screen gradient-bg-purple-blue" data-testid="game-container">
      {!isMobile && <FallingAnimation />}
      {showWinCelebration && (
        <WinCelebration 
          winAmount={winAmount} 
          onComplete={() => setShowWinCelebration(false)}
        />
      )}
      {showLossAnimation && (
        <LossAnimation 
          lossAmount={lossAmount} 
          onComplete={() => setShowLossAnimation(false)}
        />
      )}
      <div className="w-full glass-background min-h-screen">
        
        
        <main className="pt-4 px-4 space-y-6">
        {/* Logo Left, Balance Right */}
        <div className="flex justify-between items-center">
          <Enhanced3XBetLogo size="sm" />
          <LiveBalance user={currentUser} balanceUpdates={balanceUpdates} showTrend={true} />
        </div>
        
        
        {/* Live Status Indicator - Compact */}
        <LiveStatusIndicator compact={true} />
        
        {/* Game Chart Section */}
        <GameTimer
          selectedRound={selectedRound}
          onRoundChange={setSelectedRound}
          currentGame={currentGame}
          data-testid="game-timer"
        />
        
        {/* Place Bet Section */}
        <ColorBetting
          selectedColor={selectedColor}
          selectedNumber={selectedNumber}
          onColorSelect={setSelectedColor}
          onNumberSelect={setSelectedNumber}
          data-testid="color-betting"
        />
        
        <BettingControls
          betAmount={betAmount}
          onBetAmountChange={setBetAmount}
          multiplier={multiplier}
          onMultiplierChange={setMultiplier}
          selectedColor={selectedColor}
          selectedNumber={selectedNumber}
          currentGame={currentGame}
          user={user}
          data-testid="betting-controls"
        />
        
        {/* Golden Area - Live Numbers */}
        <GoldenArea data-testid="golden-area" />
        
        {/* Game History Section */}
        <GameHistory data-testid="game-history" />
        
        <div className="h-20" />
        </main>
      </div>
    </div>
  );
}
