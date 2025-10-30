import { useQuery } from "@tanstack/react-query";
import { usdToGoldCoins, formatGoldCoins } from "@/lib/currency";
import { cleanGameIdForDisplay } from "@/lib/utils";

export default function MyBets() {
  const { data: activeBets = [] } = useQuery<any[]>({
    queryKey: ['/api/bets/user/active'],
  });

  return (
    <div className="glass-card-dark p-6">
      <h3 className="text-lg font-semibold mb-4">My Active Bets</h3>
      
      <div className="space-y-3">
        {activeBets.length === 0 ? (
          <div className="text-center text-muted-foreground py-4" data-testid="text-no-bets">
            No active bets
          </div>
        ) : (
          activeBets.map((bet: any) => (
            <div key={bet.id} className="flex items-center justify-between p-3 bg-muted rounded-lg" data-testid={`card-bet-${bet.id}`}>
              <div>
                <p className="font-medium">
                  {bet.betType === "color" && `${bet.betValue} Color`}
                  {bet.betType === "number" && `Number ${bet.betValue}`}
                  {bet.betType === "size" && `${bet.betValue} Size`}
                </p>
                <p className="text-sm text-muted-foreground">
                  Period: {bet.periodId || bet.gameId}
                </p>
              </div>
              <div className="text-right">
                <p className="font-semibold text-primary">{formatGoldCoins(usdToGoldCoins(bet.amount))}</p>
                <p className="text-xs text-muted-foreground flex items-center justify-end gap-1">
                  <span>Potential:</span>
                  {formatGoldCoins(usdToGoldCoins(bet.potential))}
                </p>
              </div>
            </div>
          ))
        )}
      </div>
      
      {activeBets.length > 0 && (
        <div className="mt-4 pt-4 border-t border-border text-center text-sm text-muted-foreground">
          <p>Results will be announced when the timer ends</p>
        </div>
      )}
    </div>
  );
}
