import React, { useState, memo } from "react";
import { useGameTimer } from "@/hooks/use-game-timer";
import { HelpCircle, X, Target, TrendingUp, Coins, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { getFullGameId } from "@/lib/utils";

interface GameTimerProps {
  selectedRound: number;
  onRoundChange: (round: number) => void;
  currentGame?: any;
}

const GameTimer = memo(function GameTimer({ selectedRound, onRoundChange, currentGame }: GameTimerProps) {
  const { timeRemaining, progressPercent, initializeAudio } = useGameTimer(currentGame);
  const [showHowToPlay, setShowHowToPlay] = useState(false);

  const handleRoundChange = async (round: number) => {
    await initializeAudio();
    onRoundChange(round);
  };

  const rounds = [1, 3, 5, 10];

  const formatTime = (seconds: number) => {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="space-y-3">
      {/* Game ID Display - Compact */}
      <div className="text-center">
        <div className="text-xs text-muted-foreground">
          Game ID: <span className="font-mono" data-testid="text-game-id">
            {getFullGameId(currentGame?.gameId)}
          </span>
        </div>
      </div>
      

      {/* Game Selection Buttons - Mobile Optimized */}
      <div className="glass-card p-3">
        <div className="grid grid-cols-4 gap-2">
          {rounds.map((round) => (
            <button
              key={round}
              className={`py-3 px-2 rounded-lg font-bold text-xs transition-all transform hover:scale-105 ${
                selectedRound === round
                  ? "golden-gradient text-black shadow-lg scale-105"
                  : "bg-muted text-white hover:bg-secondary"
              }`}
              onClick={() => handleRoundChange(round)}
              data-testid={`button-round-${round}`}
            >
              Win Go<br/>{round}Min
            </button>
          ))}
        </div>
      </div>
      
      {/* Main Timer Display - Prominent */}
      <div className="golden-gradient rounded-xl p-4 text-center relative overflow-hidden shadow-2xl">
        <div className="absolute inset-0 shimmer-effect opacity-30"></div>
        
        {/* How to Play Button - Inside Timer Box */}
        <Dialog open={showHowToPlay} onOpenChange={setShowHowToPlay}>
          <div className="absolute top-2 right-2 z-20">
            <DialogTrigger asChild>
              <Button
                size="icon"
                variant="secondary"
                className="h-8 w-8 rounded-full bg-white/80 text-black hover:bg-white focus-visible:ring-2 focus-visible:ring-black/40"
                aria-label="How to Play"
                data-testid="button-how-to-play"
              >
                <HelpCircle className="h-4 w-4" />
              </Button>
            </DialogTrigger>
          </div>
          <DialogContent className="glass-card-dark max-w-md mx-auto text-white border-blue-400/30" aria-describedby="how-to-play-description">
            <DialogHeader>
              <DialogTitle className="text-xl font-bold text-center text-blue-300">How to Play Win Go</DialogTitle>
            </DialogHeader>
            <div id="how-to-play-description" className="space-y-4 text-sm">
              <div className="flex items-start gap-3">
                <Target className="w-5 h-5 text-blue-400 mt-0.5 flex-shrink-0" />
                <div>
                  <h3 className="font-semibold text-blue-300 mb-1">Choose Your Bet</h3>
                  <p className="text-white/80">Select colors (Green, Violet, Red) or numbers (0-9) to predict the next result.</p>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <Coins className="w-5 h-5 text-yellow-400 mt-0.5 flex-shrink-0" />
                <div>
                  <h3 className="font-semibold text-blue-300 mb-1">Set Amount</h3>
                  <p className="text-white/80">Enter your bet amount and choose a multiplier (1x, 5x, 10x, etc.).</p>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <Clock className="w-5 h-5 text-green-400 mt-0.5 flex-shrink-0" />
                <div>
                  <h3 className="font-semibold text-blue-300 mb-1">Wait for Result</h3>
                  <p className="text-white/80">Results are announced when the timer reaches 00:00. Winners are paid automatically.</p>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <TrendingUp className="w-5 h-5 text-purple-400 mt-0.5 flex-shrink-0" />
                <div>
                  <h3 className="font-semibold text-blue-300 mb-1">Winning Odds</h3>
                  <div className="text-white/80 space-y-1">
                    <p>• <span className="text-green-400">Green/Red:</span> 2.00x payout</p>
                    <p>• <span className="text-violet-400">Violet:</span> 4.50x payout</p>
                    <p>• <span className="text-blue-400">Numbers:</span> 9.00x payout</p>
                  </div>
                </div>
              </div>
              
              <div className="bg-blue-600/20 p-3 rounded-lg border border-blue-400/30">
                <p className="text-xs text-blue-300 font-medium mb-1">💡 Pro Tip:</p>
                <p className="text-xs text-white/80">Start with small amounts to learn the game. Good luck!</p>
              </div>
            </div>
          </DialogContent>
        </Dialog>
        
        <div className="relative z-10">
          <div className="text-center mb-3">
            <span className="text-xs text-black font-medium">Time remaining</span>
          </div>
          <div className="text-black font-bold text-lg mb-2">
            Win Go {selectedRound}Min
          </div>
          <div className="text-5xl font-black text-black mb-3 drop-shadow-lg" data-testid="text-time-remaining">
            {formatTime(timeRemaining)}
          </div>
          <div className="text-xs text-black opacity-70 font-mono">
            {currentGame?.gameId || "----"}
          </div>
        </div>
      </div>
    </div>
  );
});

export default GameTimer;
