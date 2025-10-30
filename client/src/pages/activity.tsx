import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { 
  Home, 
  Activity, 
  Gift, 
  User, 
  ArrowLeft,
  TrendingUp,
  TrendingDown,
  Clock,
  Gamepad2,
  Filter,
  Calendar,
  ChevronLeft,
  ChevronRight
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatGoldCoins, usdToGoldCoins } from "@/lib/currency";
import FallingAnimation from "@/components/falling-animation";
import BottomNav from "@/components/BottomNav";
import { useWebSocket } from "@/hooks/use-websocket";

interface ActivityItem {
  id: string;
  type: 'bet' | 'win' | 'loss' | 'deposit' | 'withdrawal';
  amount: string;
  description: string;
  timestamp: string;
  gameId?: string;
  status: 'completed' | 'pending' | 'failed';
}

// Helper function to get display value for bets
const getDisplayValue = (betType: string, betValue: string): string => {
  // For number bets, show the actual number (not the color)
  // For color and size bets, return as-is
  return betValue;
};

// Transform bet data into activity items
const transformBetsToActivity = (bets: any[]): ActivityItem[] => {
  const activities: ActivityItem[] = [];
  
  bets.forEach((bet: any) => {
    const displayValue = getDisplayValue(bet.betType, bet.betValue);
    
    // Only show win/loss activities, not individual bets
    // This gives a cleaner view of actual results
    if (bet.status === 'won') {
      activities.push({
        id: `win-${bet.id}`,
        type: 'win',
        amount: bet.actualPayout || bet.potential,
        description: `Won ${bet.betType === 'color' ? 'Color' : bet.betType === 'number' ? 'Number' : 'Size'} Bet - ${displayValue}`,
        timestamp: bet.createdAt,
        gameId: bet.gameId,
        status: 'completed'
      });
    } else if (bet.status === 'lost') {
      activities.push({
        id: `loss-${bet.id}`,
        type: 'loss',
        amount: bet.amount,
        description: `Lost ${bet.betType === 'color' ? 'Color' : bet.betType === 'number' ? 'Number' : 'Size'} Bet - ${displayValue}`,
        timestamp: bet.createdAt,
        gameId: bet.gameId,
        status: 'completed'
      });
    } else if (bet.status === 'pending') {
      // Show pending bets with pending status
      activities.push({
        id: `bet-${bet.id}`,
        type: 'bet',
        amount: bet.amount,
        description: `Pending ${bet.betType === 'color' ? 'Color' : bet.betType === 'number' ? 'Number' : 'Size'} Bet - ${displayValue}`,
        timestamp: bet.createdAt,
        gameId: bet.gameId,
        status: 'pending'
      });
    }
  });
  
  // Sort by timestamp (newest first)
  return activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
};

// Game History Section Component
function GameHistorySection() {
  const [location, setLocation] = useLocation();
  
  const { data: gameHistory = [], isLoading } = useQuery<any[]>({
    queryKey: ['/api/games/history'],
  });

  const getNumberColor = (num: number) => {
    if ([0, 5].includes(num)) return 'from-purple-500 to-red-500';
    if ([1, 3, 7, 9].includes(num)) return 'from-green-400 to-green-600';
    return 'from-red-400 to-red-600';
  };

  const getSizeLabel = (num: number) => {
    return num >= 5 ? 'Big' : 'Small';
  };

  if (isLoading) {
    return (
      <Card className="bg-black/20 border-white/10">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-white">
            <Gamepad2 className="w-5 h-5" />
            Game History
          </CardTitle>
          <CardDescription className="text-white/60">
            All recent game results
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-white/60">
            <Clock className="w-6 h-6 mx-auto mb-2 animate-spin" />
            <p>Loading...</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-black/20 border-white/10">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-white">
          <Gamepad2 className="w-5 h-5" />
          Game History
        </CardTitle>
        <CardDescription className="text-white/60">
          All recent game results
        </CardDescription>
      </CardHeader>
      <CardContent>
        {gameHistory.length === 0 ? (
          <div className="text-center py-8 text-white/60">
            <Gamepad2 className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p>No game history available</p>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => setLocation('/game')}
              className="mt-3 border-white/20 text-white/80 hover:bg-white/10"
              data-testid="button-start-playing"
            >
              Start Playing
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-4 gap-4 mb-3 p-2 rounded-lg bg-white/5 text-xs font-semibold text-white/70">
              <span>Period</span>
              <span>Number</span>
              <span>Size</span>
              <span>Color</span>
            </div>
            {gameHistory.slice(0, 10).map((game: any) => (
              <div 
                key={game.id}
                className="grid grid-cols-4 gap-4 items-center p-3 rounded-lg bg-white/5 hover:bg-white/10 transition-all"
                data-testid={`row-game-${game.id}`}
              >
                <span className="font-mono text-white/90 text-xs truncate">
                  {game.gameId?.slice(-8) || '----'}
                </span>
                <div className="flex items-center gap-2">
                  <div className={`w-8 h-8 bg-gradient-to-br ${getNumberColor(game.result)} rounded-lg flex items-center justify-center text-white font-bold text-sm`}>
                    {game.result}
                  </div>
                </div>
                <Badge variant="outline" className="text-xs text-white/80 border-white/20 w-fit">
                  {getSizeLabel(game.result)}
                </Badge>
                <Badge 
                  variant="outline" 
                  className={`text-xs border-white/20 w-fit ${
                    [1, 3, 7, 9].includes(game.result) ? 'text-green-400' : 
                    [0, 5].includes(game.result) ? 'text-purple-400' : 
                    'text-red-400'
                  }`}
                >
                  {[1, 3, 7, 9].includes(game.result) ? 'Green' : 
                   [0, 5].includes(game.result) ? 'Purple' : 'Red'}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function ActivityPage() {
  const [location, setLocation] = useLocation();
  const [filterType, setFilterType] = useState<string>('all');
  const [dateFilter, setDateFilter] = useState<string>('7d');
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [itemsPerPage] = useState<number>(5);

  // Enable WebSocket for real-time updates
  useWebSocket();

  // Get user data
  const { data: user, isLoading: isLoadingUser } = useQuery<any>({
    queryKey: ['/api/auth/me'],
    retry: false,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes - keeps user data in cache
    refetchOnWindowFocus: false,
    refetchInterval: false,
  });

  const { data: demoUser } = useQuery<any>({
    queryKey: ['/api/user/demo'],
    enabled: !user && !isLoadingUser,
    staleTime: 10 * 60 * 1000, // 10 minutes
    refetchOnWindowFocus: false,
    refetchInterval: false,
  });

  const currentUser = user || demoUser;

  // Redirect to Wingo Mode if enabled
  useEffect(() => {
    if (user && user.wingoMode) {
      setLocation('/wingo?modeon');
    }
  }, [user, setLocation]);

  // Redirect to signup if not authenticated (only after loading completes)
  useEffect(() => {
    if (!isLoadingUser && !user) {
      setLocation('/signup');
    }
  }, [user, isLoadingUser, setLocation]);

  // Get user bets for activity history
  const { data: userBets = [] } = useQuery<any[]>({
    queryKey: ['/api/bets/user/all'],
    enabled: !!user,
    staleTime: 5 * 60 * 1000, // 5 minutes - keeps data in cache
    gcTime: 10 * 60 * 1000, // 10 minutes - garbage collection time
  });

  // Transform bets to activity items
  const allActivity = transformBetsToActivity(userBets);

  const getActivityIcon = (type: string) => {
    switch (type) {
      case 'win':
        return <TrendingUp className="w-4 h-4 text-green-500" />;
      case 'loss':
        return <TrendingDown className="w-4 h-4 text-red-500" />;
      case 'bet':
        return <Gamepad2 className="w-4 h-4 text-blue-500" />;
      case 'deposit':
        return <TrendingUp className="w-4 h-4 text-blue-500" />;
      case 'withdrawal':
        return <TrendingDown className="w-4 h-4 text-orange-500" />;
      default:
        return <Clock className="w-4 h-4 text-gray-500" />;
    }
  };

  const getActivityColor = (type: string) => {
    switch (type) {
      case 'win':
        return 'text-green-400';
      case 'loss':
        return 'text-red-400';
      case 'bet':
        return 'text-blue-400';
      case 'deposit':
        return 'text-blue-400';
      case 'withdrawal':
        return 'text-orange-400';
      default:
        return 'text-gray-400';
    }
  };

  const formatDate = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const filteredActivity = allActivity.filter(item => {
    if (filterType === 'all') return true;
    return item.type === filterType;
  });

  // Pagination calculations
  const totalItems = filteredActivity.length;
  const totalPages = Math.ceil(totalItems / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedActivity = filteredActivity.slice(startIndex, endIndex);

  // Reset to first page when filters change
  const handleFilterChange = (newFilterType: string) => {
    setFilterType(newFilterType);
    setCurrentPage(1);
  };

  const handleDateFilterChange = (newDateFilter: string) => {
    setDateFilter(newDateFilter);
    setCurrentPage(1);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 text-white relative overflow-hidden">
      <FallingAnimation />
      {/* Header */}
      <header className="sticky top-0 z-50 bg-black/20 backdrop-blur-md border-b border-white/10">
        <div className="flex items-center justify-between p-4">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setLocation('/')}
              className="text-white hover:bg-white/10"
              data-testid="button-back"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back
            </Button>
            <h1 className="text-white text-lg font-semibold">Activity</h1>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="pb-20 p-4 space-y-6">
        {/* Filters */}
        <Card className="bg-black/20 border-white/10">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-white">
              <Filter className="w-5 h-5" />
              Filters
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-white/70 text-sm mb-2 block">Activity Type</label>
                <Select value={filterType} onValueChange={handleFilterChange}>
                  <SelectTrigger className="bg-white/10 border-white/20 text-white" data-testid="select-activity-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Activity</SelectItem>
                    <SelectItem value="bet">Bets</SelectItem>
                    <SelectItem value="win">Wins</SelectItem>
                    <SelectItem value="loss">Losses</SelectItem>
                    <SelectItem value="deposit">Deposits</SelectItem>
                    <SelectItem value="withdrawal">Withdrawals</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              
              <div>
                <label className="text-white/70 text-sm mb-2 block">Time Period</label>
                <Select value={dateFilter} onValueChange={handleDateFilterChange}>
                  <SelectTrigger className="bg-white/10 border-white/20 text-white" data-testid="select-date-filter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1d">Last 24 Hours</SelectItem>
                    <SelectItem value="7d">Last 7 Days</SelectItem>
                    <SelectItem value="30d">Last 30 Days</SelectItem>
                    <SelectItem value="all">All Time</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Activity List */}
        <Card className="bg-black/20 border-white/10">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-white">
              <Activity className="w-5 h-5" />
              Recent Activity
            </CardTitle>
            <CardDescription className="text-white/60">
              Your gaming and transaction history
            </CardDescription>
          </CardHeader>
          <CardContent>
            {totalItems === 0 ? (
              <div className="text-center py-8 text-white/60">
                <Activity className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p>No activity found</p>
                <p className="text-sm">Try adjusting your filters</p>
              </div>
            ) : (
              <>
                <div className="space-y-3">
                  {paginatedActivity.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between p-3 bg-white/5 rounded-lg hover:bg-white/10 transition-colors"
                    data-testid={`activity-item-${item.id}`}
                  >
                    <div className="flex items-center gap-3">
                      {getActivityIcon(item.type)}
                      <div>
                        <p className="text-white font-medium">{item.description}</p>
                        {item.gameId && (
                          <p className="text-white/80 text-sm font-mono">{item.gameId}</p>
                        )}
                        <p className="text-white/60 text-sm">{formatDate(item.timestamp)}</p>
                      </div>
                    </div>
                    
                    <div className="text-right">
                      <p className={`font-semibold ${getActivityColor(item.type)}`}>
                        {item.type === 'win' || item.type === 'deposit' ? '+' : item.type === 'bet' || item.type === 'withdrawal' ? '-' : ''}
                        {formatGoldCoins(usdToGoldCoins(item.amount))}
                      </p>
                      <Badge 
                        variant={item.status === 'completed' ? 'default' : item.status === 'pending' ? 'secondary' : 'destructive'}
                        className="text-xs"
                      >
                        {item.status}
                      </Badge>
                    </div>
                  </div>
                  ))}
                </div>

                {/* Pagination Controls */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between mt-6 pt-4 border-t border-white/10">
                    <div className="text-white/60 text-sm">
                      Showing {startIndex + 1}-{Math.min(endIndex, totalItems)} of {totalItems} items
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setCurrentPage(currentPage - 1)}
                        disabled={currentPage === 1}
                        className="border-white/20 text-white/80 hover:bg-white/10"
                        data-testid="button-prev-page"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </Button>
                      
                      <div className="flex items-center gap-1">
                        {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
                          <Button
                            key={page}
                            variant={page === currentPage ? "default" : "outline"}
                            size="sm"
                            onClick={() => setCurrentPage(page)}
                            className={
                              page === currentPage
                                ? "bg-blue-600 text-white hover:bg-blue-700"
                                : "border-white/20 text-white/80 hover:bg-white/10"
                            }
                            data-testid={`button-page-${page}`}
                          >
                            {page}
                          </Button>
                        ))}
                      </div>
                      
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setCurrentPage(currentPage + 1)}
                        disabled={currentPage === totalPages}
                        className="border-white/20 text-white/80 hover:bg-white/10"
                        data-testid="button-next-page"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* Game History Section */}
        <GameHistorySection />
      </main>

      <BottomNav user={user} />
    </div>
  );
}