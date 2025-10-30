import { storage } from "./storage";

class BetSettlementService {
  private isRunning = false;
  private intervalId: NodeJS.Timeout | null = null;
  private broadcastBalanceUpdate?: (userId: string, oldBalance: string, newBalance: string, changeType: 'win' | 'loss' | 'deposit' | 'withdrawal' | 'bet') => void;

  setBroadcastCallback(callback: (userId: string, oldBalance: string, newBalance: string, changeType: 'win' | 'loss' | 'deposit' | 'withdrawal' | 'bet') => void) {
    this.broadcastBalanceUpdate = callback;
  }

  start() {
    if (this.isRunning) {
      console.log('⚠️  Bet settlement service is already running');
      return;
    }

    this.isRunning = true;
    console.log('✅ Starting automatic bet settlement service (runs every 2 minutes)');

    this.intervalId = setInterval(async () => {
      await this.checkAndSettlePendingBets();
    }, 120000); // Run every 2 minutes (120,000 milliseconds)

    this.checkAndSettlePendingBets();
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.isRunning = false;
      console.log('⏹️  Bet settlement service stopped');
    }
  }

  private async checkAndSettlePendingBets() {
    try {
      console.log('🔄 Checking for pending bets to settle...');

      const pendingBets = await this.getAllPendingBets();
      
      if (pendingBets.length === 0) {
        console.log('✓ No pending bets found');
        return;
      }

      console.log(`📊 Found ${pendingBets.length} pending bet(s) to check`);

      let settledCount = 0;
      const groupedBets = this.groupBetsByGame(pendingBets);

      for (const [gameId, bets] of Array.from(groupedBets.entries())) {
        const game = await storage.getGameById(gameId);
        
        if (!game) {
          console.log(`⚠️  Game ${gameId} not found, skipping ${bets.length} bet(s)`);
          continue;
        }

        if (game.status !== 'completed' || game.result === null || game.result === undefined) {
          continue;
        }

        console.log(`🎯 Settling ${bets.length} pending bet(s) for completed game ${game.gameId}`);
        
        const result = game.result;
        const resultColor = game.resultColor || this.getNumberColor(result);
        const resultSize = game.resultSize || this.getNumberSize(result);

        for (const bet of bets) {
          try {
            await this.settleBet(bet, result, resultColor, resultSize);
            settledCount++;
          } catch (error) {
            console.error(`❌ Error settling bet ${bet.id}:`, error);
          }
        }
      }

      if (settledCount > 0) {
        console.log(`✅ Successfully settled ${settledCount} pending bet(s)`);
      }
    } catch (error) {
      console.error('❌ Error in bet settlement service:', error);
    }
  }

  private async getAllPendingBets() {
    const pendingBets = await storage.getAllPendingBets();
    return pendingBets;
  }

  private groupBetsByGame(bets: any[]): Map<string, any[]> {
    const grouped = new Map<string, any[]>();
    
    for (const bet of bets) {
      if (!grouped.has(bet.gameId)) {
        grouped.set(bet.gameId, []);
      }
      grouped.get(bet.gameId)!.push(bet);
    }
    
    return grouped;
  }

  private async settleBet(bet: any, result: number, resultColor: string, resultSize: string) {
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
      const totalPayout = parseFloat(bet.potential);
      const betAmount = parseFloat(bet.amount);
      const winnings = totalPayout - betAmount;

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

      const user = await storage.getUser(bet.userId);
      if (user) {
        const oldBalance = user.balance;
        const newBalance = (parseFloat(user.balance) + finalPayout).toFixed(8);
        await storage.updateUserBalance(bet.userId, newBalance);
        
        if (this.broadcastBalanceUpdate) {
          this.broadcastBalanceUpdate(bet.userId, oldBalance, newBalance, 'win');
        }
      }

      console.log(`✅ Bet ${bet.id} settled as WON (${bet.betType}: ${bet.betValue}, payout: ${finalPayout.toFixed(2)})`);
    } else {
      await storage.updateBetStatus(bet.id, "lost");

      const user = await storage.getUser(bet.userId);
      if (user) {
        const lostAmount = parseFloat(bet.amount);
        const currentBalance = parseFloat(user.balance);
        const balanceBeforeBet = (currentBalance + lostAmount).toFixed(8);
        
        if (this.broadcastBalanceUpdate) {
          this.broadcastBalanceUpdate(bet.userId, balanceBeforeBet, user.balance, 'loss');
        }
      }

      console.log(`❌ Bet ${bet.id} settled as LOST (${bet.betType}: ${bet.betValue})`);
    }
  }

  private getNumberColor(num: number): string {
    if (num === 5) return "violet";
    if ([1, 3, 7, 9].includes(num)) return "green";
    if (num === 0) return "violet";
    return "red";
  }

  private getNumberSize(num: number): string {
    return num >= 5 ? "big" : "small";
  }
}

export const betSettlementService = new BetSettlementService();
