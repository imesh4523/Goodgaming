import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { 
  DollarSign, 
  TrendingUp, 
  Users, 
  Activity, 
  LogOut, 
  CreditCard, 
  ArrowUp,
  UserCheck,
  Percent,
  Wallet,
  History,
  Plus,
  Minus,
  Copy,
  QrCode
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useWebSocket } from "@/hooks/use-websocket";
import * as z from "zod";

// Agent-specific currency formatter (uses $ symbol instead of coins)
function formatAgentCurrency(amount: number | string) {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  const formattedAmount = num.toLocaleString();
  
  return (
    <span className="flex items-center gap-1">
      <DollarSign className="w-4 h-4 text-yellow-400" />
      <span>{formattedAmount}</span>
    </span>
  );
}

interface AgentProfile {
  id: string;
  userId: string;
  commissionRate: string;
  earningsBalance: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AgentUser {
  id: string;
  publicId: string;
  email: string;
  username?: string;
  balance: string;
  role: string;
  isActive: boolean;
}

interface AgentData {
  user: AgentUser;
  agentProfile: AgentProfile;
}

interface AgentActivity {
  id: string;
  agentId: string;
  action: string;
  targetUserId?: string;
  targetUserPublicId?: string;
  amount: string;
  commissionAmount: string;
  transactionId?: string;
  createdAt: string;
}

interface PaymentData {
  payment_id: number;
  pay_address: string;
  pay_amount: number;
  pay_currency: string;
  price_amount: number;
  price_currency: string;
  qr_code: string;
  transaction_id: string;
  expires_at: string;
}

const cryptoCurrencies = [
  { value: "TRX", label: "TRX", icon: "◯", network: "TRON" },
  { value: "USDTTRC20", label: "USDT", icon: "₮", network: "TRC20" },
  { value: "USDTMATIC", label: "USDT", icon: "₮", network: "Polygon" }
];

// Display mapping for currency codes (backend API codes -> user-friendly display names)
const currencyDisplayNames: Record<string, string> = {
  'trx': 'TRX',
  'usdttrc20': 'USDTTRC20',
  'usdtmatic': 'USDTPOLYGON' // Display as USDTPOLYGON for better clarity
};

// Helper function to get display name for currency
const getCurrencyDisplayName = (currency: string): string => {
  const lowerCurrency = currency.toLowerCase();
  return currencyDisplayNames[lowerCurrency] || currency.toUpperCase();
};

const depositSchema = z.object({
  userIdentifier: z.string().min(1, "User identifier is required"),
  amount: z.string().min(1, "Amount is required").refine(val => parseFloat(val) >= 11, "Minimum deposit is 11 USD")
});

const agentDepositSchema = z.object({
  amount: z.string().min(1, "Amount is required").refine(val => parseFloat(val) >= 15, "Minimum deposit is 15 USD"),
  currency: z.enum(["TRX", "USDTTRC20", "USDTMATIC"])
});

type DepositForm = z.infer<typeof depositSchema>;

export default function AgentDashboard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  // Agent self-deposit state
  const [depositAmount, setDepositAmount] = useState("");
  const [depositCurrency, setDepositCurrency] = useState("");
  const [paymentData, setPaymentData] = useState<PaymentData | null>(null);
  const [timeLeft, setTimeLeft] = useState<number>(0);
  const [copied, setCopied] = useState(false);
  
  // Transaction detail dialog state
  const [selectedActivity, setSelectedActivity] = useState<AgentActivity | null>(null);

  // WebSocket for real-time updates
  const { agentActivities, connectionStatus } = useWebSocket();

  // Fetch agent profile
  const { data: agentData, isLoading: profileLoading, isError: profileError } = useQuery<AgentData>({
    queryKey: ["/api/agent/profile"],
    enabled: true,
    retry: false
  });

  // Redirect to login if not authenticated
  useEffect(() => {
    if (profileError) {
      toast({
        title: "Session expired",
        description: "Please login again",
        variant: "destructive"
      });
      window.location.href = "/agent-login";
    }
  }, [profileError, toast]);

  // Fetch agent activities with polling fallback when WebSocket is disconnected
  const { data: activitiesData, isLoading: activitiesLoading } = useQuery({
    queryKey: ["/api/agent/activities"],
    enabled: true,
    refetchInterval: connectionStatus === 'disconnected' ? 30000 : false
  });

  // Fetch agent earnings
  const { data: earningsData, isLoading: earningsLoading } = useQuery({
    queryKey: ["/api/agent/earnings"],
    enabled: true
  });

  const depositForm = useForm<DepositForm>({
    resolver: zodResolver(depositSchema),
    defaultValues: {
      userIdentifier: "",
      amount: ""
    }
  });

  const depositMutation = useMutation({
    mutationFn: async (data: DepositForm) => {
      const response = await apiRequest("POST", "/api/agent/deposit", data);
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Deposit processed",
        description: "User deposit processed successfully"
      });
      depositForm.reset();
      // Invalidate queries to ensure fresh data is fetched
      queryClient.invalidateQueries({ queryKey: ["/api/agent/profile"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agent/activities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agent/earnings"] });
    },
    onError: (error: any) => {
      toast({
        title: "Deposit failed",
        description: error.message || "Failed to process deposit",
        variant: "destructive"
      });
    }
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/auth/logout");
      return response.json();
    },
    onSuccess: () => {
      queryClient.clear();
      toast({
        title: "Logged out",
        description: "You have been logged out successfully"
      });
      window.location.href = "/agent-login";
    }
  });

  // Agent self-deposit mutation
  const agentDepositMutation = useMutation({
    mutationFn: async (data: { amount: string; currency: string }) => {
      const response = await apiRequest("POST", "/api/agent/self-deposit", data);
      return response.json();
    },
    onSuccess: (data: PaymentData) => {
      setPaymentData(data);
      // Calculate initial time left
      const expiresAt = new Date(data.expires_at).getTime();
      const now = Date.now();
      const timeDiff = Math.max(0, Math.floor((expiresAt - now) / 1000));
      setTimeLeft(timeDiff);
      
      toast({
        title: "Payment Created",
        description: "Your deposit address has been generated. Please scan the QR code or copy the address.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/agent/profile"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agent/earnings"] });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to create payment",
        variant: "destructive",
      });
    },
  });

  const onDepositSubmit = (data: DepositForm) => {
    depositMutation.mutate(data);
  };

  // Agent self-deposit handlers
  const handleAgentDeposit = () => {
    if (!depositAmount || !depositCurrency) {
      toast({
        title: "Error",
        description: "Please enter amount and select currency",
        variant: "destructive",
      });
      return;
    }

    // Check minimum amounts
    const minAmount = depositCurrency === "TRX" ? 15 : 15; // 15 USDT or 15 TRX minimum
    if (parseFloat(depositAmount) < minAmount) {
      toast({
        title: "Error",
        description: `Minimum deposit amount is ${minAmount} ${depositCurrency === "TRX" ? "TRX" : "USDT"}`,
        variant: "destructive",
      });
      return;
    }

    agentDepositMutation.mutate({ amount: depositAmount, currency: depositCurrency });
  };

  // Countdown timer effect
  useEffect(() => {
    if (timeLeft <= 0) return;
    
    const timer = setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1) {
          setPaymentData(null);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    
    return () => clearInterval(timer);
  }, [timeLeft]);

  // Format countdown time
  const formatCountdown = (seconds: number) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  // Copy address to clipboard
  const copyAddress = async () => {
    if (!paymentData?.pay_address) return;
    
    try {
      await navigator.clipboard.writeText(paymentData.pay_address);
      setCopied(true);
      toast({
        title: "Address Copied",
        description: "The deposit address has been copied to your clipboard.",
      });
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      toast({
        title: "Copy Failed",
        description: "Failed to copy address. Please copy manually.",
        variant: "destructive",
      });
    }
  };

  if (profileLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-900 via-indigo-900 to-purple-900 text-white flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-white"></div>
          <p className="mt-4 text-xl">Loading Agent Dashboard...</p>
        </div>
      </div>
    );
  }

  const agent = agentData?.user;
  const agentProfile = agentData?.agentProfile;
  
  // Combine query activities with WebSocket real-time activities
  const queryActivities = Array.isArray(activitiesData) ? activitiesData : ((activitiesData as any)?.activities || []);
  
  // Merge WebSocket activities with query activities, removing duplicates
  const activitiesMap = new Map();
  
  // Add query activities first
  queryActivities.forEach((activity: AgentActivity) => {
    activitiesMap.set(activity.id, activity);
  });
  
  // Add WebSocket activities (will overwrite if same ID, ensuring latest data)
  agentActivities.forEach((activity) => {
    activitiesMap.set(activity.id, activity);
  });
  
  // Convert back to array and sort by createdAt (newest first)
  const activities = Array.from(activitiesMap.values()).sort((a, b) => 
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  
  const earnings = (earningsData || {}) as { totalEarnings?: string; commissionRate?: string; totalDeposits?: string };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-900 via-indigo-900 to-purple-900 text-white">
      <div className="container mx-auto p-6">
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <div className="flex items-center space-x-4">
            <Avatar className="h-12 w-12">
              <AvatarFallback className="bg-blue-500 text-white">
                {agent?.username?.charAt(0)?.toUpperCase() || 'A'}
              </AvatarFallback>
            </Avatar>
            <div>
              <h1 className="text-3xl font-bold">Agent Dashboard</h1>
              <p className="text-blue-200">Welcome back, {agent?.username || agent?.publicId || 'Agent'}</p>
            </div>
          </div>
          <Button
            onClick={() => logoutMutation.mutate()}
            variant="outline"
            className="bg-white/10 border-white/20 text-white hover:bg-white/20"
            data-testid="button-agent-logout"
          >
            <LogOut className="h-4 w-4 mr-2" />
            Logout
          </Button>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-6 mb-8">
          <Card className="bg-white/10 backdrop-blur-md border-white/20">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-white/90">
                Commission Rate
              </CardTitle>
              <Percent className="h-4 w-4 text-blue-400" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-white" data-testid="text-commission-rate">
                {parseFloat(agentProfile?.commissionRate || "0") * 100}%
              </div>
            </CardContent>
          </Card>

          <Card className="bg-white/10 backdrop-blur-md border-white/20">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-white/90">
                My Wallet Balance
              </CardTitle>
              <DollarSign className="h-4 w-4 text-green-400" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-400" data-testid="text-agent-wallet-balance">
                {formatAgentCurrency(agent?.balance || "0")}
              </div>
            </CardContent>
          </Card>

          <Card className="bg-white/10 backdrop-blur-md border-white/20">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-white/90">
                Total Deposits
              </CardTitle>
              <DollarSign className="h-4 w-4 text-yellow-400" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-yellow-400" data-testid="text-total-deposits">
                {formatAgentCurrency(earnings?.totalDeposits || "0")}
              </div>
            </CardContent>
          </Card>

          <Card className="bg-white/10 backdrop-blur-md border-white/20">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-white/90">
                Status
              </CardTitle>
              <UserCheck className="h-4 w-4 text-green-400" />
            </CardHeader>
            <CardContent>
              <Badge 
                variant={agentProfile?.isActive ? "default" : "destructive"}
                className="text-sm"
                data-testid="badge-agent-status"
              >
                {agentProfile?.isActive ? "Active" : "Inactive"}
              </Badge>
            </CardContent>
          </Card>

          <Card className="bg-white/10 backdrop-blur-md border-white/20">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-white/90">
                Total Activities
              </CardTitle>
              <Activity className="h-4 w-4 text-purple-400" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-white" data-testid="text-total-activities">
                {activities.length}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Main Content Tabs */}
        <Tabs defaultValue="transactions" className="space-y-4">
          <TabsList className="grid grid-cols-4 bg-white/10 backdrop-blur-md">
            <TabsTrigger value="transactions" className="data-[state=active]:bg-blue-500">
              Transactions
            </TabsTrigger>
            <TabsTrigger value="deposit" className="data-[state=active]:bg-blue-500">
              My Wallet
            </TabsTrigger>
            <TabsTrigger value="activities" className="data-[state=active]:bg-blue-500">
              Activities
            </TabsTrigger>
            <TabsTrigger value="profile" className="data-[state=active]:bg-blue-500">
              Profile
            </TabsTrigger>
          </TabsList>

          <TabsContent value="transactions" className="space-y-6">
            {/* Deposit Form */}
            <Card className="bg-white/10 backdrop-blur-md border-white/20 max-w-2xl mx-auto">
              <CardHeader>
                <CardTitle className="text-white flex items-center">
                  <ArrowUp className="h-5 w-5 mr-2 text-green-400" />
                  Process Deposit
                </CardTitle>
                <CardDescription className="text-white/70">
                  Add funds to a user's account
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={depositForm.handleSubmit(onDepositSubmit)} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="deposit-user" className="text-white/90">
                      User Email or Public ID
                    </Label>
                    <Input
                      {...depositForm.register("userIdentifier")}
                      id="deposit-user"
                      placeholder="user@example.com or user123"
                      className="bg-white/10 border-white/20 text-white placeholder:text-white/50"
                      data-testid="input-deposit-user"
                    />
                    {depositForm.formState.errors.userIdentifier && (
                      <p className="text-red-400 text-sm">
                        {depositForm.formState.errors.userIdentifier.message}
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="deposit-amount" className="text-white/90">
                      Amount
                    </Label>
                    <Input
                      {...depositForm.register("amount")}
                      id="deposit-amount"
                      type="number"
                      step="0.01"
                      placeholder="0.00"
                      className="bg-white/10 border-white/20 text-white placeholder:text-white/50"
                      data-testid="input-deposit-amount"
                    />
                    {depositForm.formState.errors.amount && (
                      <p className="text-red-400 text-sm">
                        {depositForm.formState.errors.amount.message}
                      </p>
                    )}
                  </div>
                  <Button
                    type="submit"
                    className="w-full bg-green-500 hover:bg-green-600"
                    disabled={depositMutation.isPending}
                    data-testid="button-process-deposit"
                  >
                    {depositMutation.isPending ? "Processing..." : "Process Deposit"}
                  </Button>
                </form>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="deposit" className="space-y-6">
            <Card className="bg-white/10 backdrop-blur-md border-white/20">
              <CardHeader>
                <CardTitle className="text-white flex items-center">
                  <Wallet className="h-5 w-5 mr-2 text-yellow-400" />
                  Top Up My Wallet
                </CardTitle>
                <CardDescription className="text-white/70">
                  Add funds to your agent wallet balance using cryptocurrency
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!paymentData ? (
                  <div className="space-y-4">
                    {/* Amount Input */}
                    <div className="space-y-2">
                      <Label htmlFor="agent-deposit-amount" className="text-white/90">
                        Amount (USD)
                      </Label>
                      <Input
                        id="agent-deposit-amount"
                        type="number"
                        step="0.01"
                        min="15"
                        placeholder="15.00"
                        value={depositAmount}
                        onChange={(e) => setDepositAmount(e.target.value)}
                        className="bg-white/10 border-white/20 text-white placeholder:text-white/50"
                        data-testid="input-agent-deposit-amount"
                      />
                      <p className="text-white/60 text-sm">Minimum deposit: 15 USD</p>
                    </div>

                    {/* Currency Selection */}
                    <div className="space-y-2">
                      <Label className="text-white/90">Select Cryptocurrency</Label>
                      <div className="grid grid-cols-1 gap-3">
                        {cryptoCurrencies.map((crypto) => (
                          <Button
                            key={crypto.value}
                            type="button"
                            variant={depositCurrency === crypto.value ? "default" : "outline"}
                            className={`w-full justify-start p-4 h-auto ${
                              depositCurrency === crypto.value
                                ? "bg-blue-500 hover:bg-blue-600 text-white border-blue-500"
                                : "bg-white/10 border-white/20 text-white hover:bg-white/20"
                            }`}
                            onClick={() => setDepositCurrency(crypto.value)}
                            data-testid={`button-currency-${crypto.value}`}
                          >
                            <div className="flex items-center gap-3">
                              <span className="text-lg">{crypto.icon}</span>
                              <div className="text-left">
                                <div className="font-medium">{crypto.label}</div>
                                <div className="text-sm opacity-75">{crypto.network}</div>
                              </div>
                            </div>
                          </Button>
                        ))}
                      </div>
                    </div>

                    {/* Deposit Button */}
                    <Button
                      onClick={handleAgentDeposit}
                      disabled={agentDepositMutation.isPending || !depositAmount || !depositCurrency}
                      className="w-full bg-green-500 hover:bg-green-600"
                      data-testid="button-create-agent-deposit"
                    >
                      {agentDepositMutation.isPending ? "Creating Payment..." : "Create Deposit"}
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/* Payment Details */}
                    <div className="text-center space-y-4">
                      <div className="bg-white/5 border border-white/20 rounded-lg p-4">
                        <img 
                          src={paymentData.qr_code} 
                          alt="QR Code" 
                          className="w-48 h-48 mx-auto bg-white rounded-lg p-2"
                          data-testid="img-payment-qr"
                        />
                      </div>
                      
                      <div className="space-y-2">
                        <p className="text-white/90 font-medium">
                          Send exactly <span className="text-yellow-400 font-bold">{paymentData.pay_amount} {getCurrencyDisplayName(paymentData.pay_currency)}</span>
                        </p>
                        <p className="text-white/70 text-sm">to the address below</p>
                      </div>

                      {/* Payment Address */}
                      <div className="bg-white/5 border border-white/20 rounded-lg p-3">
                        <div className="flex items-center gap-2">
                          <code className="flex-1 text-white/90 text-sm break-all" data-testid="text-payment-address">
                            {paymentData.pay_address}
                          </code>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={copyAddress}
                            className="flex-shrink-0 text-white/70 hover:text-white hover:bg-white/10"
                            data-testid="button-copy-address"
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>

                      {/* Timer */}
                      <div className="text-center">
                        <p className="text-white/70 text-sm">Time remaining</p>
                        <p className="text-2xl font-bold text-yellow-400" data-testid="text-countdown">
                          {formatCountdown(timeLeft)}
                        </p>
                      </div>

                      {/* New Payment Button */}
                      <Button
                        onClick={() => {
                          setPaymentData(null);
                          setDepositAmount("");
                          setDepositCurrency("");
                          setTimeLeft(0);
                        }}
                        variant="outline"
                        className="w-full bg-white/10 border-white/20 text-white hover:bg-white/20"
                        data-testid="button-new-payment"
                      >
                        Create New Payment
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="activities" className="space-y-6">
            <Card className="bg-white/10 backdrop-blur-md border-white/20">
              <CardHeader>
                <CardTitle className="text-white flex items-center">
                  <History className="h-5 w-5 mr-2" />
                  Recent Activities
                </CardTitle>
                <CardDescription className="text-white/70">
                  Track your recent agent activities and commissions
                </CardDescription>
              </CardHeader>
              <CardContent>
                {activitiesLoading ? (
                  <div className="text-center py-8">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto"></div>
                    <p className="mt-2 text-white/70">Loading activities...</p>
                  </div>
                ) : activities.length === 0 ? (
                  <div className="text-center py-8 text-white/70">
                    No activities found
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow className="border-white/20">
                        <TableHead className="text-white/90">Action</TableHead>
                        <TableHead className="text-white/90">User Public ID</TableHead>
                        <TableHead className="text-white/90">Amount</TableHead>
                        <TableHead className="text-white/90">Commission</TableHead>
                        <TableHead className="text-white/90">Date</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {activities.map((activity: AgentActivity) => (
                        <TableRow 
                          key={activity.id} 
                          className="border-white/20 cursor-pointer hover:bg-white/10 transition-colors"
                          onClick={() => setSelectedActivity(activity)}
                          data-testid={`row-activity-${activity.id}`}
                        >
                          <TableCell className="text-white">
                            <Badge 
                              variant={activity.action === 'deposit' ? 'default' : 'destructive'}
                              data-testid={`badge-activity-${activity.id}`}
                            >
                              {activity.action}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-white/90" data-testid={`text-user-publicid-${activity.id}`}>
                            {activity.targetUserPublicId || 'N/A'}
                          </TableCell>
                          <TableCell className="text-white" data-testid={`text-amount-${activity.id}`}>
                            {formatAgentCurrency(activity.amount)}
                          </TableCell>
                          <TableCell className="text-green-400" data-testid={`text-commission-${activity.id}`}>
                            +{formatAgentCurrency(activity.commissionAmount)}
                          </TableCell>
                          <TableCell className="text-white/70" data-testid={`text-date-${activity.id}`}>
                            {new Date(activity.createdAt).toLocaleDateString()}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="profile" className="space-y-6">
            <Card className="bg-white/10 backdrop-blur-md border-white/20">
              <CardHeader>
                <CardTitle className="text-white flex items-center">
                  <UserCheck className="h-5 w-5 mr-2" />
                  Agent Profile
                </CardTitle>
                <CardDescription className="text-white/70">
                  Your agent account information
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <Label className="text-white/90">Email</Label>
                    <p className="text-white" data-testid="text-agent-email">{agent?.email}</p>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-white/90">Public ID</Label>
                    <p className="text-white" data-testid="text-agent-publicid">{agent?.publicId}</p>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-white/90">Commission Rate</Label>
                    <p className="text-white" data-testid="text-profile-commission-rate">
                      {parseFloat(agentProfile?.commissionRate || "0") * 100}%
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-white/90">Account Status</Label>
                    <Badge 
                      variant={agentProfile?.isActive ? "default" : "destructive"}
                      data-testid="badge-profile-status"
                    >
                      {agentProfile?.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-white/90">Total Earnings</Label>
                    <p className="text-green-400 font-semibold" data-testid="text-profile-earnings">
                      {formatAgentCurrency(agentProfile?.earningsBalance || "0")}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-white/90">Member Since</Label>
                    <p className="text-white/70" data-testid="text-member-since">
                      {new Date(agentProfile?.createdAt || Date.now()).toLocaleDateString()}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* Transaction Details Dialog */}
      <Dialog open={!!selectedActivity} onOpenChange={(open) => !open && setSelectedActivity(null)}>
        <DialogContent className="bg-gradient-to-br from-blue-900 to-indigo-900 border-white/20 text-white" data-testid="dialog-transaction-details">
          <DialogHeader>
            <DialogTitle className="text-white text-xl">Transaction Details</DialogTitle>
          </DialogHeader>
          {selectedActivity && (
            <div className="space-y-4 mt-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label className="text-white/70 text-sm">Activity ID</Label>
                  <p className="text-white font-mono text-xs break-all" data-testid="text-detail-activity-id">
                    {selectedActivity.id}
                  </p>
                </div>
                <div className="space-y-1">
                  <Label className="text-white/70 text-sm">Action Type</Label>
                  <Badge 
                    variant={selectedActivity.action === 'deposit' ? 'default' : 'destructive'}
                    data-testid="badge-detail-action"
                  >
                    {selectedActivity.action}
                  </Badge>
                </div>
              </div>

              <Separator className="bg-white/20" />

              <div className="grid grid-cols-1 gap-4">
                {selectedActivity.transactionId && (
                  <div className="space-y-1">
                    <Label className="text-white/70 text-sm">Transaction ID</Label>
                    <p className="text-white font-mono text-sm break-all" data-testid="text-detail-transaction-id">
                      {selectedActivity.transactionId}
                    </p>
                  </div>
                )}

                <div className="space-y-1">
                  <Label className="text-white/70 text-sm">User ID</Label>
                  <p className="text-white font-mono" data-testid="text-detail-userid">
                    {selectedActivity.targetUserId || 'N/A'}
                  </p>
                </div>

                <div className="space-y-1">
                  <Label className="text-white/70 text-sm">Date</Label>
                  <p className="text-white" data-testid="text-detail-date">
                    {new Date(selectedActivity.createdAt).toLocaleDateString('en-US', { 
                      year: 'numeric', 
                      month: 'long', 
                      day: 'numeric' 
                    })}
                  </p>
                </div>

                <div className="space-y-1">
                  <Label className="text-white/70 text-sm">Time</Label>
                  <p className="text-white" data-testid="text-detail-time">
                    {new Date(selectedActivity.createdAt).toLocaleTimeString('en-US', { 
                      hour: '2-digit', 
                      minute: '2-digit', 
                      second: '2-digit' 
                    })}
                  </p>
                </div>

                <div className="space-y-1">
                  <Label className="text-white/70 text-sm">Amount</Label>
                  <p className="text-white text-lg font-semibold" data-testid="text-detail-amount">
                    {formatAgentCurrency(selectedActivity.amount)}
                  </p>
                </div>

                <div className="space-y-1">
                  <Label className="text-white/70 text-sm">Commission Earned</Label>
                  <p className="text-green-400 text-lg font-semibold" data-testid="text-detail-commission">
                    +{formatAgentCurrency(selectedActivity.commissionAmount)}
                  </p>
                </div>
              </div>

              <Separator className="bg-white/20" />

              <Button 
                onClick={() => setSelectedActivity(null)}
                className="w-full bg-blue-500 hover:bg-blue-600"
                data-testid="button-close-dialog"
              >
                Close
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}