import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { 
  Home, 
  Activity, 
  Gift, 
  User, 
  ArrowLeft,
  Settings,
  CreditCard,
  LogOut,
  Crown,
  Shield,
  Eye,
  EyeOff,
  Edit3,
  RefreshCw,
  Download,
  Upload,
  History,
  Wallet,
  Trophy,
  TrendingUp,
  TrendingDown,
  Gamepad2,
  Share,
  Copy,
  QrCode,
  Users,
  ExternalLink,
  Coins,
  Key,
  Lock,
  FileText,
  ScrollText,
  MessageCircle,
  Smartphone,
  Monitor,
  Info,
  Sparkles,
  Zap
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { formatGoldCoins, usdToGoldCoins } from "@/lib/currency";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/queryClient";
import BottomNav from "@/components/BottomNav";

// Helper function to format transaction amounts and fees correctly
const formatTransactionAmount = (transaction: Transaction & { timestamp: string }, includeSign = true) => {
  const sign = includeSign ? (transaction.type === 'deposit' ? '+' : '-') : '';
  
  if (transaction.fiatAmount) {
    return `${sign}$${Number(transaction.fiatAmount).toFixed(2)}`;
  } else if (transaction.cryptoAmount) {
    const currency = transaction.cryptoCurrency || 'CRYPTO';
    return `${sign}${Number(transaction.cryptoAmount).toFixed(8)} ${currency}`;
  }
  return `${sign}$0.00`;
};

const formatTransactionFee = (transaction: Transaction & { timestamp: string }) => {
  if (!transaction.fee || parseFloat(transaction.fee) === 0) return null;
  
  if (transaction.fiatCurrency) {
    return `Fee: $${Number(transaction.fee).toFixed(2)}`;
  } else if (transaction.cryptoCurrency) {
    return `Fee: ${Number(transaction.fee).toFixed(8)} ${transaction.cryptoCurrency}`;
  }
  return `Fee: $${Number(transaction.fee).toFixed(2)}`;
};
import { VIP_LEVELS, getVipDisplayName, getMaxBetLimit, Transaction } from "@shared/schema";
import FallingAnimation from "@/components/falling-animation";

interface ReferralData {
  referralCode: string;
  referralLink: string;
  totalReferrals: number;
  totalCommission: string;
  referrals: Array<{
    id: string;
    referredId: string;
    commissionRate: string;
    totalCommission: string;
    status: string;
    createdAt: string;
  }>;
}

interface QrData {
  qrCode: string;
  referralLink: string;
  referralCode: string;
}

interface GenuineUser {
  publicId: string;
  balance: string;
}

interface GenuineUsersData {
  count: number;
  users: GenuineUser[];
}

// Transaction API response interface
interface TransactionApiResponse {
  transactions: (Transaction & { timestamp: string })[];
  total: number;
  page: number;
  totalPages: number;
}

// Commission history interfaces
interface CommissionHistoryItem {
  id: string;
  type: 'referral_bonus' | 'bet_commission';
  amount: string;
  currency: string;
  date: string | Date;
  description: string;
  referredUser?: string;
  commissionRate?: string;
}

interface CommissionHistoryData {
  history: CommissionHistoryItem[];
  totalEarnings: string;
}

export default function AccountPage() {
  const [location, setLocation] = useLocation();
  const [showBalance, setShowBalance] = useState(true);
  const [showQrCode, setShowQrCode] = useState(false);
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [showWithdrawalPasswordChange, setShowWithdrawalPasswordChange] = useState(false);
  const [currentWithdrawalPassword, setCurrentWithdrawalPassword] = useState("");
  const [newWithdrawalPassword, setNewWithdrawalPassword] = useState("");
  const [confirmWithdrawalPassword, setConfirmWithdrawalPassword] = useState("");
  const [showCurrentWithdrawalPassword, setShowCurrentWithdrawalPassword] = useState(false);
  const [showNewWithdrawalPassword, setShowNewWithdrawalPassword] = useState(false);
  const [showConfirmWithdrawalPassword, setShowConfirmWithdrawalPassword] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [isPWAInstalled, setIsPWAInstalled] = useState(false);
  const [promoCode, setPromoCode] = useState("");
  const [showGenuineUsers, setShowGenuineUsers] = useState(false);
  const [showCommissionHistory, setShowCommissionHistory] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Get user data
  const { data: user, refetch: refetchUser, isFetching: isRefreshingUser } = useQuery<any>({
    queryKey: ['/api/auth/me'],
    retry: false,
    staleTime: 0,
    refetchOnMount: true,
  });

  // Apply animation preference on page load
  useEffect(() => {
    if (user && typeof user.enableAnimations === 'boolean') {
      if (user.enableAnimations) {
        document.documentElement.classList.remove('animations-disabled');
      } else {
        document.documentElement.classList.add('animations-disabled');
      }
    }
  }, [user]);

  const { data: demoUser } = useQuery<any>({
    queryKey: ['/api/user/demo'],
    enabled: !user,
    staleTime: 10 * 60 * 1000, // 10 minutes
    refetchOnWindowFocus: false,
    refetchInterval: false,
  });

  const currentUser = user || demoUser;

  // Redirect to signup if not authenticated
  useEffect(() => {
    if (!user) {
      setLocation('/signup');
    }
  }, [user, setLocation]);

  // PWA Install Prompt Handler
  useEffect(() => {
    // Check if app is already installed
    if (window.matchMedia('(display-mode: standalone)').matches) {
      setIsPWAInstalled(true);
    }

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };

    const handleAppInstalled = () => {
      setIsPWAInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  // Get referral data
  const { data: referralData, isLoading: isLoadingReferral } = useQuery<ReferralData>({
    queryKey: ['/api/user/referral'],
    enabled: !!user, // Only fetch when user is authenticated
    retry: false,
  });

  // Get user transactions
  const { data: transactionData, isLoading: isLoadingTransactions } = useQuery<TransactionApiResponse>({
    queryKey: ['/api/user/transactions'],
    enabled: !!user, // Only fetch when user is authenticated
    retry: false,
  });

  const transactions = transactionData?.transactions || [];

  // Get system settings to check if withdrawals are enabled
  const { data: systemSettings } = useQuery<any[]>({
    queryKey: ['/api/settings/public'],
    enabled: !!user, // Only fetch when user is authenticated
    retry: false,
  });

  // Check if withdrawals are enabled
  const withdrawalsEnabled = systemSettings?.find(s => s.key === 'withdrawals_enabled')?.value !== 'false';

  // Get QR code data
  const { data: qrData, refetch: refetchQr, isLoading: isLoadingQr, isError: isQrError } = useQuery<QrData>({
    queryKey: ['/api/user/referral/qr'],
    enabled: false, // Only fetch when explicitly requested
    retry: false,
  });

  // Get genuine referred users data
  const { data: genuineUsersData, isLoading: isLoadingGenuineUsers } = useQuery<GenuineUsersData>({
    queryKey: ['/api/user/referral/genuine'],
    enabled: !!user && showGenuineUsers, // Only fetch when user is authenticated and showing the list
    retry: false,
  });

  // Get commission history data
  const { data: commissionHistoryData, isLoading: isLoadingCommissionHistory } = useQuery<CommissionHistoryData>({
    queryKey: ['/api/user/commission-history'],
    enabled: !!user && showCommissionHistory, // Only fetch when modal is open
    retry: false,
  });

  const copyToClipboard = async (text: string, label: string) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for non-HTTPS environments
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      toast({
        title: "Copied!",
        description: `${label} copied to clipboard`,
      });
    } catch (err) {
      toast({
        title: "Copy failed",
        description: "Unable to copy to clipboard",
        variant: "destructive",
      });
    }
  };

  const handleShowQrCode = async () => {
    setShowQrCode(true);
    try {
      await refetchQr();
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to generate QR code",
        variant: "destructive",
      });
    }
  };

  const logoutMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        credentials: "include"
      });
      if (!response.ok) throw new Error("Logout failed");
      return response.json();
    },
    onSuccess: () => {
      queryClient.clear();
      toast({
        title: "Logged out successfully",
        description: "You have been signed out of your account",
      });
      setLocation('/login');
    },
    onError: (error: any) => {
      toast({
        title: "Logout failed",
        description: error.message || "Failed to logout",
        variant: "destructive",
      });
    },
  });

  const changePasswordMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/auth/change-password', {
        currentPassword,
        newPassword,
        confirmPassword
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Password change failed");
      }
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Password changed",
        description: "Your password has been updated successfully",
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setShowPasswordChange(false);
    },
    onError: (error: any) => {
      toast({
        title: "Password change failed",
        description: error.message || "Failed to change password",
        variant: "destructive",
      });
    },
  });

  const changeWithdrawalPasswordMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/auth/change-withdrawal-password', {
        currentWithdrawalPassword,
        newWithdrawalPassword,
        confirmWithdrawalPassword
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Withdrawal password change failed");
      }
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Withdrawal password changed",
        description: "Your withdrawal password has been updated successfully",
      });
      setCurrentWithdrawalPassword("");
      setNewWithdrawalPassword("");
      setConfirmWithdrawalPassword("");
      setShowWithdrawalPasswordChange(false);
    },
    onError: (error: any) => {
      toast({
        title: "Withdrawal password change failed",
        description: error.message || "Failed to change withdrawal password",
        variant: "destructive",
      });
    },
  });

  const withdrawCommissionMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/user/withdraw-commission", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Withdrawal failed");
      }
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      queryClient.invalidateQueries({ queryKey: ["/api/user/demo"] });
      queryClient.invalidateQueries({ queryKey: ["/api/user/transactions"] });
      toast({
        title: "Commission Withdrawn",
        description: `${parseFloat(data.amount).toFixed(0)} coins transferred to your wallet successfully`,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Withdrawal failed",
        description: error.message || "Failed to withdraw commission",
        variant: "destructive",
      });
    },
  });

  const updateAnimationPreferencesMutation = useMutation({
    mutationFn: async (enableAnimations: boolean) => {
      const response = await apiRequest('POST', '/api/user/animation-preferences', {
        enableAnimations
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to update animation preferences");
      }
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      queryClient.invalidateQueries({ queryKey: ["/api/user/demo"] });
      
      // Update the document element to toggle animations globally
      if (data.user?.enableAnimations) {
        document.documentElement.classList.remove('animations-disabled');
      } else {
        document.documentElement.classList.add('animations-disabled');
      }
      
      toast({
        title: "Settings updated",
        description: data.user?.enableAnimations 
          ? "Animations have been enabled" 
          : "Animations have been disabled for better performance",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Update failed",
        description: error.message || "Failed to update animation preferences",
        variant: "destructive",
      });
    },
  });

  const updateWingoModeMutation = useMutation({
    mutationFn: async (wingoMode: boolean) => {
      const response = await apiRequest('POST', '/api/user/wingo-mode', {
        wingoMode
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to update Wingo Mode preference");
      }
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      queryClient.invalidateQueries({ queryKey: ["/api/user/demo"] });
      
      toast({
        title: "Settings updated",
        description: data.user?.wingoMode 
          ? "Wingo Mode enabled - Enjoy focused gaming!" 
          : "Wingo Mode disabled",
      });
      
      if (data.user?.wingoMode) {
        setLocation('/wingo?modeon');
      }
    },
    onError: (error: any) => {
      toast({
        title: "Update failed",
        description: error.message || "Failed to update Wingo Mode preference",
        variant: "destructive",
      });
    },
  });

  const handleInstallPWA = async () => {
    if (!deferredPrompt) {
      toast({
        title: "Installation not available",
        description: "Please use the browser menu to install the app or check the instructions below",
        variant: "default",
      });
      return;
    }

    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    
    if (outcome === 'accepted') {
      toast({
        title: "App installed!",
        description: "3xbet has been installed on your device",
      });
      setDeferredPrompt(null);
      setIsPWAInstalled(true);
    } else {
      toast({
        title: "Installation cancelled",
        description: "You can install the app anytime from your browser menu",
      });
    }
  };

  const redeemPromoCodeMutation = useMutation({
    mutationFn: async () => {
      if (!promoCode.trim()) {
        throw new Error("Please enter a promo code");
      }
      
      const response = await apiRequest('POST', '/api/promo-codes/redeem', {
        code: promoCode.trim()
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to redeem promo code");
      }
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      queryClient.invalidateQueries({ queryKey: ["/api/user/demo"] });
      queryClient.invalidateQueries({ queryKey: ["/api/user/transactions"] });
      // Convert USD to coins for display (100 coins = 1 USD)
      const coinsAwarded = Math.round(parseFloat(data.amountAwarded) * 100);
      toast({
        title: "Promo code redeemed!",
        description: `You received ${coinsAwarded} coins bonus! 🎉`,
      });
      setPromoCode("");
    },
    onError: (error: any) => {
      toast({
        title: "Redemption failed",
        description: error.message || "Failed to redeem promo code",
        variant: "destructive",
      });
    },
  });

  if (!currentUser) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="text-center max-w-md">
          <User className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
          <h2 className="text-xl font-semibold mb-2">Authentication Required</h2>
          <p className="text-muted-foreground mb-4">
            Please sign up to view your account.
          </p>
          <Button onClick={() => setLocation('/signup')}>
            Sign Up
          </Button>
        </div>
      </div>
    );
  }

  const vipLevel = currentUser.vipLevel || 'lv1';
  const vipInfo = VIP_LEVELS[vipLevel as keyof typeof VIP_LEVELS];
  const balance = currentUser.balance || "0";
  const totalDeposits = parseFloat(currentUser.totalDeposits || "0");
  const totalWithdrawals = parseFloat(currentUser.totalWithdrawals || "0");

  const formatDate = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
      case 'approved':
        return 'bg-green-600/20 text-green-300 border-green-400/30';
      case 'pending':
        return 'bg-yellow-600/20 text-yellow-300 border-yellow-400/30';
      case 'failed':
      case 'rejected':
      case 'cancelled':
      case 'canceled':
        return 'bg-red-600/20 text-red-300 border-red-400/30';
      default:
        return 'bg-gray-600/20 text-gray-300 border-gray-400/30';
    }
  };

  const getStatusLabel = (status: string) => {
    const statusLabels: Record<string, string> = {
      'completed': 'Completed',
      'approved': 'Completed',
      'pending': 'Pending',
      'rejected': 'Canceled',
      'cancelled': 'Canceled',
      'canceled': 'Canceled',
      'failed': 'Failed'
    };
    return statusLabels[status] || status.charAt(0).toUpperCase() + status.slice(1);
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
            <h1 className="text-white text-lg font-semibold">Account</h1>
          </div>
          
          <Button
            variant="outline"
            size="sm"
            onClick={() => logoutMutation.mutate()}
            disabled={logoutMutation.isPending}
            className="border-red-400/30 text-red-300 hover:bg-red-400/10"
            data-testid="button-logout"
          >
            <LogOut className="w-4 h-4 mr-2" />
            Logout
          </Button>
        </div>
      </header>

      {/* Main Content */}
      <main className="pb-20 p-4 space-y-6">
        {/* Profile Card */}
        <Card className="bg-black/30 backdrop-blur-md border border-white/10">
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <Avatar className="h-16 w-16">
                <AvatarImage src={currentUser.profilePhoto || `https://api.dicebear.com/7.x/avataaars/svg?seed=${currentUser.email}`} />
                <AvatarFallback className="text-lg">
                  {currentUser.email?.[0]?.toUpperCase()}
                </AvatarFallback>
              </Avatar>
              
              <div className="flex-1">
                <h2 className="text-white text-xl font-semibold">{currentUser.email}</h2>
                
                {/* User ID for Agent Deposits */}
                {currentUser.publicId && (
                  <div className="bg-white/5 rounded-lg p-3 mt-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs text-white/70 mb-1">Your User ID</p>
                        <p className="text-white font-mono text-lg" data-testid="text-user-id">
                          {currentUser.publicId}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => copyToClipboard(currentUser.publicId, "User ID")}
                        className="text-white/60 hover:text-white hover:bg-white/10"
                        data-testid="button-copy-user-id"
                      >
                        <Copy className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                )}
                
                <div className="flex items-center gap-2 mt-3">
                  <Badge className="bg-yellow-600/20 text-yellow-300 border-yellow-400/30">
                    <Crown className="w-3 h-3 mr-1" />
                    {getVipDisplayName(vipLevel)}
                  </Badge>
                  <Badge className="bg-green-600/20 text-green-300 border-green-400/30">
                    <Shield className="w-3 h-3 mr-1" />
                    Verified
                  </Badge>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Balance Overview */}
        <Card className="bg-black/20 border-white/10">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between text-white">
              <div className="flex items-center gap-2">
                <Wallet className="w-5 h-5" />
                Balance Overview
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => refetchUser()}
                  disabled={isRefreshingUser}
                  className="text-white/60 hover:text-white hover:bg-white/10"
                  data-testid="button-refresh-balance"
                >
                  <RefreshCw className={`w-4 h-4 ${isRefreshingUser ? 'animate-spin' : ''}`} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowBalance(!showBalance)}
                  className="text-white/60 hover:text-white hover:bg-white/10"
                  data-testid="button-toggle-balance"
                >
                  {showBalance ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </Button>
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="text-center p-4 bg-green-600/10 rounded-lg">
                <p className="text-xs text-white/70 mb-1">Current Balance</p>
                <p className="text-lg font-bold text-green-400" data-testid="text-current-balance">
                  {showBalance ? formatGoldCoins(usdToGoldCoins(balance)) : '••••••'}
                </p>
              </div>
              
              <div className="text-center p-4 bg-purple-600/10 rounded-lg">
                <p className="text-xs text-white/70 mb-1">Total Referrals</p>
                <p className="text-lg font-bold text-purple-400" data-testid="text-total-referrals">
                  {referralData?.totalReferrals || 0}
                </p>
              </div>
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="text-center p-3 bg-blue-600/10 rounded-lg">
                <p className="text-xs text-white/70 mb-1">Total Deposits</p>
                <p className="text-sm font-semibold text-blue-400" data-testid="text-total-deposits">
                  ${totalDeposits.toFixed(2)}
                </p>
              </div>
              
              {withdrawalsEnabled && (
                <div className="text-center p-3 bg-orange-600/10 rounded-lg">
                  <p className="text-xs text-white/70 mb-1">Total Withdrawals</p>
                  <p className="text-sm font-semibold text-orange-400" data-testid="text-total-withdrawals">
                    ${totalWithdrawals.toFixed(2)}
                  </p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* PWA Installation Section */}
        <Card className="bg-gradient-to-br from-blue-900/30 to-purple-900/30 backdrop-blur-md border border-blue-400/20">
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-white">
              <Smartphone className="w-5 h-5 text-blue-400" />
              {isPWAInstalled ? "App Installed" : "Install App"}
            </CardTitle>
            <CardDescription className="text-white/60">
              {isPWAInstalled 
                ? "3xbet app is installed on your device" 
                : "Install 3xbet as a PWA for the best experience"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isPWAInstalled ? (
              <>
                {/* App Installed Status */}
                <div className="bg-green-600/20 border border-green-400/30 rounded-lg p-6 text-center">
                  <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-600/30 mb-3">
                    <Smartphone className="w-8 h-8 text-green-400" />
                  </div>
                  <h3 className="text-white text-lg font-semibold mb-2">App Installed Successfully!</h3>
                  <p className="text-white/70 text-sm">
                    You can now access 3xbet directly from your home screen
                  </p>
                </div>

                {/* Features */}
                <div className="space-y-2">
                  <p className="text-xs text-white/70 uppercase font-semibold">Features</p>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-sm text-white/80">
                      <div className="w-1.5 h-1.5 rounded-full bg-green-400"></div>
                      <span>Works offline</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-white/80">
                      <div className="w-1.5 h-1.5 rounded-full bg-green-400"></div>
                      <span>Fast loading & smooth experience</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-white/80">
                      <div className="w-1.5 h-1.5 rounded-full bg-green-400"></div>
                      <span>Real-time betting & live updates</span>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <>
                {/* Install Button */}
                <Button
                  onClick={handleInstallPWA}
                  className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white border-0 h-12"
                  data-testid="button-install-pwa"
                >
                  <Download className="w-5 h-5 mr-2" />
                  Install App
                </Button>

                {/* Installation Instructions */}
                <div className="bg-white/5 rounded-lg p-4">
                  <div className="flex items-start gap-3">
                    <Info className="w-5 h-5 text-blue-400 mt-0.5 flex-shrink-0" />
                    <div className="flex-1 space-y-3">
                      <div>
                        <h4 className="text-white text-sm font-semibold mb-2">Android / Chrome:</h4>
                        <ol className="text-xs text-white/80 space-y-1 list-decimal list-inside">
                          <li>Tap the "Install App" button above</li>
                          <li>Or tap the menu (⋮) and select "Install app"</li>
                          <li>Confirm installation</li>
                        </ol>
                      </div>
                      <div>
                        <h4 className="text-white text-sm font-semibold mb-2">iPhone / Safari:</h4>
                        <ol className="text-xs text-white/80 space-y-1 list-decimal list-inside">
                          <li>Tap the Share button (□↑)</li>
                          <li>Scroll down and tap "Add to Home Screen"</li>
                          <li>Tap "Add" in the top right</li>
                        </ol>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Benefits */}
                <div className="space-y-2">
                  <p className="text-xs text-white/70 uppercase font-semibold">Why Install?</p>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-sm text-white/80">
                      <div className="w-1.5 h-1.5 rounded-full bg-blue-400"></div>
                      <span>App-like experience</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-white/80">
                      <div className="w-1.5 h-1.5 rounded-full bg-blue-400"></div>
                      <span>Quick access from home screen</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-white/80">
                      <div className="w-1.5 h-1.5 rounded-full bg-blue-400"></div>
                      <span>No app store required</span>
                    </div>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Settings & Preferences */}
        <Card className="bg-gradient-to-br from-indigo-900/30 to-blue-900/30 backdrop-blur-md border border-indigo-400/20">
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-white">
              <Settings className="w-5 h-5 text-indigo-400" />
              Settings & Preferences
            </CardTitle>
            <CardDescription className="text-white/60">
              Customize your app experience
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Animation Toggle */}
            <div className="bg-white/5 rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-start gap-3">
                  <div className="p-2 bg-indigo-500/20 rounded-lg">
                    <Sparkles className="w-5 h-5 text-indigo-400" />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-white font-semibold text-sm">3D Animations & Effects</h3>
                    <p className="text-white/60 text-xs mt-1">
                      Disable for smoother performance on older devices
                    </p>
                  </div>
                </div>
                <Switch
                  checked={currentUser.enableAnimations !== false}
                  onCheckedChange={(checked) => {
                    updateAnimationPreferencesMutation.mutate(checked);
                  }}
                  disabled={updateAnimationPreferencesMutation.isPending}
                  data-testid="switch-animations"
                />
              </div>
              {!currentUser.enableAnimations && (
                <div className="mt-3 flex items-start gap-2 bg-green-600/10 border border-green-400/20 rounded-lg p-3">
                  <Zap className="w-4 h-4 text-green-400 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-green-200/90">
                    Performance mode enabled. The app will run faster with animations disabled.
                  </p>
                </div>
              )}
            </div>

            {/* Wingo Mode Toggle */}
            <div className="bg-white/5 rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-start gap-3">
                  <div className="p-2 bg-purple-500/20 rounded-lg">
                    <Gamepad2 className="w-5 h-5 text-purple-400" />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-white font-semibold text-sm">Wingo Mode</h3>
                    <p className="text-white/60 text-xs mt-1">
                      Focus mode - Shows only Win Go game for faster gaming experience
                    </p>
                  </div>
                </div>
                <Switch
                  checked={currentUser.wingoMode === true}
                  onCheckedChange={(checked) => {
                    updateWingoModeMutation.mutate(checked);
                  }}
                  disabled={updateWingoModeMutation.isPending}
                  data-testid="switch-wingo-mode"
                />
              </div>
              {currentUser.wingoMode && (
                <div className="mt-3 flex items-start gap-2 bg-purple-600/10 border border-purple-400/20 rounded-lg p-3">
                  <Zap className="w-4 h-4 text-purple-400 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-purple-200/90">
                    Wingo Mode active! Enjoy a distraction-free gaming experience focused only on Win Go.
                  </p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* VIP Information - Hidden */}
        {/* <Card className="bg-gradient-to-r from-purple-600/20 to-pink-600/20 border-purple-300/20">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-white">
              <Crown className="w-5 h-5 text-yellow-400" />
              VIP Information
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-white/80">Current Level</span>
              <Badge className="bg-yellow-600/20 text-yellow-300 border-yellow-400/30">
                {getVipDisplayName(vipLevel)}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-white/80">Team Requirement</span>
              <span className="text-white font-semibold">{vipInfo.teamRequirement === 0 ? 'No team required' : `${vipInfo.teamRequirement} friends`}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-white/80">Total Referrals</span>
              <span className="text-white font-semibold">{referralData?.totalReferrals || 0}</span>
            </div>
            
            {vipLevel !== 'vip5' && (
              <>
                <Separator className="bg-white/10" />
                <div className="text-center">
                  <Button 
                    variant="outline" 
                    onClick={() => setLocation('/promotions')}
                    className="border-yellow-400/30 text-yellow-300 hover:bg-yellow-400/10"
                    data-testid="button-upgrade-vip"
                  >
                    <Crown className="w-4 h-4 mr-1" />
                    Upgrade VIP Level
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card> */}

        {/* Commission Reward Section */}
        <Card className="bg-gradient-to-br from-red-900/30 to-red-800/20 backdrop-blur-md border border-red-400/20">
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-white">
              <Gift className="w-5 h-5 text-yellow-400" />
              Available Reward
            </CardTitle>
            <CardDescription className="text-white/60">
              Invitation Bonus + Commission Reward
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Commission Display */}
            <div className="text-center p-6 bg-gradient-to-br from-yellow-600/10 to-orange-600/10 rounded-xl border border-yellow-400/20">
              <div className="flex items-center justify-center gap-2 mb-2">
                <div className="w-8 h-8 bg-gradient-to-br from-yellow-400 to-orange-500 rounded-full flex items-center justify-center">
                  <Coins className="w-4 h-4 text-white" />
                </div>
                <span className="text-3xl font-bold text-yellow-400" data-testid="text-commission-amount">
                  {usdToGoldCoins(currentUser.totalCommission || "0").toLocaleString()} Coins
                </span>
              </div>
              <p className="text-xs text-white/50">Commission from betting and referrals</p>
            </div>

            {/* Action Buttons */}
            <div className="grid grid-cols-2 gap-3">
              <Button
                variant="outline"
                className="bg-red-800/20 border-red-400/30 text-red-300 hover:bg-red-700/30 hover:text-red-200"
                onClick={() => setShowCommissionHistory(true)}
                data-testid="button-order-info"
              >
                <History className="w-4 h-4 mr-2" />
                Order Info
              </Button>
              
              <Button
                variant="outline"
                className="bg-green-800/20 border-green-400/30 text-green-300 hover:bg-green-700/30 hover:text-green-200"
                onClick={() => withdrawCommissionMutation.mutate()}
                disabled={withdrawCommissionMutation.isPending || parseFloat(currentUser.totalCommission || "0") <= 0}
                data-testid="button-withdraw-commission"
              >
                <Download className="w-4 h-4 mr-2" />
                {withdrawCommissionMutation.isPending ? "Processing..." : "Withdraw to Wallet"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Referral Program Section */}
        {user && (
          <Card className="bg-black/20 border-white/10">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-white">
                <Users className="w-5 h-5 text-blue-400" />
                Referral Program
              </CardTitle>
              <CardDescription className="text-white/60">
                Invite friends and earn 4.89 USDT{' '}
                <svg viewBox="0 0 339.43 295.27" className="w-4 h-4 inline-block align-middle" style={{ filter: 'drop-shadow(0 2px 6px rgba(38, 161, 123, 0.8))' }}>
                  <g>
                    <path fill="#50AF95" d="M62.15,1.45l-61.89,130a2.52,2.52,0,0,0,.54,2.94L167.95,293.56a2.55,2.55,0,0,0,3.53,0L338.63,134.4a2.52,2.52,0,0,0,.54-2.94l-61.89-130A2.5,2.5,0,0,0,275,0H64.45a2.5,2.5,0,0,0-2.3,1.45h0Z"/>
                    <path fill="white" d="M191.19,144.8c-1.2.09-7.4,0.46-21.23,0.46-11,0-18.81-.33-21.55-0.46-42.51-1.87-74.24-9.27-74.24-18.13s31.73-16.25,74.24-18.15v28.91c2.78,0.2,10.74.67,21.74,0.67,13.2,0,19.81-.55,21-0.66v-28.9c42.42,1.89,74.08,9.29,74.08,18.13s-31.65,16.24-74.08,18.12h0Zm0-39.25V79.68h59.2V40.23H89.21V79.68H148.4v25.86c-48.11,2.21-84.29,11.74-84.29,23.16s36.18,20.94,84.29,23.16v82.9h42.78V151.83c48-2.21,84.12-11.73,84.12-23.14s-36.09-20.93-84.12-23.15h0Zm0,0h0Z"/>
                  </g>
                </svg>
                {' '}when they make their first deposit
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {referralData && (
                <>
                  {/* Referral Statistics */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="text-center p-4 bg-blue-600/10 rounded-lg">
                      <Users className="w-8 h-8 text-blue-400 mx-auto mb-2" />
                      <p className="text-xs text-white/70 mb-1">Total Referrals</p>
                      <p className="text-lg font-bold text-blue-400" data-testid="text-total-referrals">
                        {referralData.totalReferrals}
                      </p>
                    </div>
                    
                    <div className="text-center p-4 bg-green-600/10 rounded-lg">
                      <Gift className="w-8 h-8 text-green-400 mx-auto mb-2" />
                      <p className="text-xs text-white/70 mb-1">Total Earned</p>
                      <p className="text-lg font-bold text-green-400" data-testid="text-total-commission">
                        {formatGoldCoins(usdToGoldCoins(referralData.totalCommission || "0"))}
                      </p>
                    </div>
                  </div>

                  {/* Referral Code and Link */}
                  <div className="space-y-3">
                    <div className="bg-white/5 rounded-lg p-4">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-sm text-white/70">Your Referral Code</p>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => copyToClipboard(referralData.referralCode, "Referral code")}
                          className="text-white/60 hover:text-white h-8 px-2"
                          data-testid="button-copy-code"
                        >
                          <Copy className="w-4 h-4" />
                        </Button>
                      </div>
                      <p className="text-white font-mono text-lg" data-testid="text-referral-code">
                        {referralData.referralCode}
                      </p>
                    </div>

                    <div className="bg-white/5 rounded-lg p-4">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-sm text-white/70">Referral Link</p>
                        <div className="flex gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => copyToClipboard(referralData.referralLink, "Referral link")}
                            className="text-white/60 hover:text-white h-8 px-2"
                            data-testid="button-copy-link"
                          >
                            <Copy className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleShowQrCode}
                            className="text-white/60 hover:text-white h-8 px-2"
                            data-testid="button-show-qr"
                          >
                            <QrCode className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                      <p className="text-white/80 text-sm break-all" data-testid="text-referral-link">
                        {referralData.referralLink}
                      </p>
                    </div>

                    {/* QR Code Display */}
                    {showQrCode && (
                      <div className="bg-white/5 rounded-lg p-4 text-center" data-testid="section-qr-code">
                        <div className="flex items-center justify-between mb-3">
                          <p className="text-sm text-white/70">QR Code</p>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setShowQrCode(false)}
                            className="text-white/60 hover:text-white h-8 px-2"
                            data-testid="button-hide-qr"
                          >
                            ×
                          </Button>
                        </div>
                        <div className="flex justify-center">
                          {isLoadingQr ? (
                            <div className="w-32 h-32 bg-white/10 rounded-lg p-2 flex items-center justify-center" data-testid="loading-qr">
                              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
                            </div>
                          ) : isQrError ? (
                            <div className="w-32 h-32 bg-red-500/10 rounded-lg p-2 flex items-center justify-center text-red-400 text-sm" data-testid="error-qr">
                              Failed to load QR code
                            </div>
                          ) : qrData ? (
                            <img 
                              src={qrData.qrCode} 
                              alt="Referral QR Code"
                              className="w-32 h-32 bg-white rounded-lg p-2"
                              data-testid="img-qr-code"
                            />
                          ) : null}
                        </div>
                        <p className="text-xs text-white/60 mt-2" data-testid="text-qr-description">
                          Scan this QR code to share your referral link
                        </p>
                      </div>
                    )}

                    {/* Share Buttons */}
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (navigator.share) {
                            navigator.share({
                              title: '3XBET Referral',
                              text: `Join me on 3XBET! Use my referral code ${referralData.referralCode} and we both get 4.89 USDT!`,
                              url: referralData.referralLink,
                            });
                          } else {
                            copyToClipboard(
                              `Join me on 3XBET! Use my referral code ${referralData.referralCode} and we both get 4.89 USDT! ${referralData.referralLink}`,
                              "Referral message"
                            );
                          }
                        }}
                        className="flex-1 border-white/20 text-white/80 hover:bg-white/10"
                        data-testid="button-share"
                      >
                        <Share className="w-4 h-4 mr-2" />
                        Share
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => window.open(referralData.referralLink, '_blank')}
                        className="border-white/20 text-white/80 hover:bg-white/10"
                        data-testid="button-open-link"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </Button>
                    </div>

                    {/* Active Users Section */}
                    <div className="bg-gradient-to-br from-blue-600/10 to-purple-600/10 rounded-lg p-4 border border-blue-400/20">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <Users className="w-5 h-5 text-blue-400" />
                          <p className="text-sm font-semibold text-white">Active Users</p>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setShowGenuineUsers(!showGenuineUsers)}
                          className="text-blue-400 hover:text-blue-300 hover:bg-blue-400/10 h-8 w-8 p-0 rounded-full"
                          data-testid="button-toggle-genuine-users"
                        >
                          {showGenuineUsers ? (
                            <EyeOff className="w-4 h-4" />
                          ) : (
                            <Eye className="w-4 h-4" />
                          )}
                        </Button>
                      </div>
                      
                      <p className="text-xs text-white/60 mb-3">
                        Users who registered with your code and made their first deposit
                      </p>

                      {showGenuineUsers && (
                        <div className="space-y-2 max-h-64 overflow-y-auto">
                          {isLoadingGenuineUsers ? (
                            <div className="flex items-center justify-center py-4">
                              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-400"></div>
                            </div>
                          ) : genuineUsersData && genuineUsersData.users.length > 0 ? (
                            <>
                              <div className="text-xs text-white/50 mb-2">
                                Total: {genuineUsersData.count} active users
                              </div>
                              {genuineUsersData.users.map((user, index) => (
                                <div 
                                  key={index}
                                  className="flex items-center justify-between bg-black/20 rounded-lg p-3 border border-white/5"
                                  data-testid={`genuine-user-${index}`}
                                >
                                  <div className="flex items-center gap-2">
                                    <User className="w-4 h-4 text-blue-400" />
                                    <span className="text-white font-mono text-sm" data-testid={`user-id-${index}`}>
                                      {user.publicId}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-1">
                                    <span className="text-yellow-400 font-semibold" data-testid={`user-balance-${index}`}>
                                      {formatGoldCoins(usdToGoldCoins(user.balance))}
                                    </span>
                                    <Coins className="w-4 h-4 text-yellow-400" />
                                  </div>
                                </div>
                              ))}
                            </>
                          ) : (
                            <div className="text-center py-4 text-white/60 text-sm">
                              No active users yet. Share your referral code to get started!
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* Quick Actions */}
        <div className={`grid gap-4 ${withdrawalsEnabled ? 'grid-cols-2' : 'grid-cols-1'}`}>
          <Button 
            onClick={() => setLocation('/deposit')}
            className="h-16 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700"
            data-testid="button-deposit"
          >
            <div className="text-center">
              <Download className="w-5 h-5 mx-auto mb-1" />
              <span className="text-sm font-medium">Deposit</span>
            </div>
          </Button>
          
          {withdrawalsEnabled && (
            <Button 
              onClick={() => setLocation('/withdrawal')}
              className="h-16 bg-gradient-to-r from-orange-600 to-red-600 hover:from-orange-700 hover:to-red-700"
              data-testid="button-withdraw"
            >
              <div className="text-center">
                <Upload className="w-5 h-5 mx-auto mb-1" />
                <span className="text-sm font-medium">Withdraw</span>
              </div>
            </Button>
          )}
        </div>

        {/* Special Promotions */}
        {user && (
          <Card className="bg-gradient-to-br from-purple-900/30 to-pink-900/20 backdrop-blur-md border border-purple-400/20">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-white">
                <Gift className="w-5 h-5 text-purple-400" />
                Special Promotions
              </CardTitle>
              <CardDescription className="text-white/60">
                Redeem promo codes to get bonus coins
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                <Label htmlFor="promo-code" className="text-white/80">Enter Promo Code</Label>
                <div className="flex gap-2">
                  <Input
                    id="promo-code"
                    type="text"
                    value={promoCode}
                    onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
                    placeholder="Enter code here"
                    className="bg-black/30 border-white/20 text-white placeholder:text-white/40"
                    disabled={redeemPromoCodeMutation.isPending}
                    data-testid="input-promo-code"
                  />
                  <Button
                    onClick={() => redeemPromoCodeMutation.mutate()}
                    disabled={redeemPromoCodeMutation.isPending || !promoCode.trim()}
                    className="bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700"
                    data-testid="button-redeem-promo"
                  >
                    {redeemPromoCodeMutation.isPending ? "Redeeming..." : "Redeem"}
                  </Button>
                </div>
              </div>

              {/* Info Box */}
              <div className="flex items-start gap-2 p-3 bg-blue-500/10 rounded-lg border border-blue-400/20">
                <Info className="w-4 h-4 text-blue-400 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-blue-100/80">
                  Promo codes can be redeemed once per user. You'll receive a random bonus amount between the code's minimum and maximum value.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Transaction History */}
        <Card className="bg-black/20 border-white/10">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-white">
              <History className="w-5 h-5" />
              Transaction History
            </CardTitle>
            <CardDescription className="text-white/60">
              Your {withdrawalsEnabled ? 'deposit and withdrawal' : 'deposit'} history
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingTransactions ? (
              <div className="text-center py-8 text-white/60">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto mb-3"></div>
                <p>Loading transactions...</p>
              </div>
            ) : transactions.length === 0 ? (
              <div className="text-center py-8 text-white/60">
                <CreditCard className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p>No transactions yet</p>
                <p className="text-sm">Make your first deposit to get started</p>
              </div>
            ) : (
              <div className="space-y-3">
                {transactions
                  .filter(transaction => {
                    if (transaction.type === 'referral_bonus') return false;
                    if (!withdrawalsEnabled && transaction.type !== 'deposit' && transaction.type !== 'commission_withdrawal' && transaction.type !== 'agent_commission') return false;
                    return true;
                  })
                  .map((transaction) => (
                  <div
                    key={transaction.id}
                    className="flex items-center justify-between p-3 bg-white/5 rounded-lg hover:bg-white/10 transition-colors"
                    data-testid={`transaction-${transaction.id}`}
                  >
                    <div className="flex items-center gap-3">
                      {transaction.type === 'deposit' ? (
                        <Download className="w-4 h-4 text-green-500" />
                      ) : transaction.type === 'commission_withdrawal' || transaction.type === 'agent_commission' ? (
                        <Download className="w-4 h-4 text-blue-500" />
                      ) : (
                        <Upload className="w-4 h-4 text-orange-500" />
                      )}
                      <div>
                        <p className="text-white font-medium capitalize">
                          {transaction.type.replace(/_/g, ' ')} - {transaction.fiatCurrency || transaction.cryptoCurrency || 'USD'}
                        </p>
                        <p className="text-white/60 text-sm">{formatDate(transaction.timestamp)}</p>
                        {transaction.txHash && (
                          <p className="text-white/40 text-xs">
                            TX: {transaction.txHash.slice(0, 10)}...
                          </p>
                        )}
                        {transaction.paymentAddress && (
                          <p className="text-white/40 text-xs">
                            Address: {transaction.paymentAddress.slice(0, 15)}...
                          </p>
                        )}
                        {formatTransactionFee(transaction) && (
                          <p className="text-white/40 text-xs">
                            {formatTransactionFee(transaction)}
                          </p>
                        )}
                      </div>
                    </div>
                    
                    <div className="text-right">
                      <p className={`font-semibold ${
                        transaction.type === 'deposit' || transaction.type === 'commission_withdrawal' || transaction.type === 'agent_commission' || transaction.type === 'referral_bonus' ? 'text-green-400' : 
                        'text-red-400'
                      }`}>
                        {transaction.type === 'deposit' || transaction.type === 'commission_withdrawal' || transaction.type === 'agent_commission' || transaction.type === 'referral_bonus' ? 
                          `+${formatTransactionAmount(transaction, false)}` : 
                          `-${formatTransactionAmount(transaction, false)}`
                        }
                      </p>
                      <Badge className={getStatusColor(transaction.status)}>
                        {getStatusLabel(transaction.status)}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Password Security Card - Only show for real users */}
        {user && (
          <Card className="bg-black/30 backdrop-blur-md border border-white/10">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-white">
                <Lock className="w-5 h-5 text-blue-400" />
                Password Security
              </CardTitle>
              <CardDescription className="text-white/60">
                Change your password to keep your account secure
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowPasswordChange(!showPasswordChange)}
                className="border-white/20 text-white/80 hover:bg-white/10 w-full"
                data-testid="button-change-password"
              >
                <Key className="w-4 h-4 mr-2" />
                {showPasswordChange ? "Cancel" : "Change Password"}
              </Button>

              {showPasswordChange && (
                <div className="mt-4 space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="current-password" className="text-white/70">Current Password</Label>
                    <div className="relative">
                      <Input
                        id="current-password"
                        type={showCurrentPassword ? "text" : "password"}
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        placeholder="Enter current password"
                        className="bg-black/30 border-white/10 text-white pr-10"
                        data-testid="input-current-password"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                        onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                      >
                        {showCurrentPassword ? (
                          <EyeOff className="h-4 w-4 text-white/60" />
                        ) : (
                          <Eye className="h-4 w-4 text-white/60" />
                        )}
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="new-password" className="text-white/70">New Password</Label>
                    <div className="relative">
                      <Input
                        id="new-password"
                        type={showNewPassword ? "text" : "password"}
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="Enter new password"
                        className="bg-black/30 border-white/10 text-white pr-10"
                        data-testid="input-new-password"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                        onClick={() => setShowNewPassword(!showNewPassword)}
                      >
                        {showNewPassword ? (
                          <EyeOff className="h-4 w-4 text-white/60" />
                        ) : (
                          <Eye className="h-4 h-4 text-white/60" />
                        )}
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="confirm-password" className="text-white/70">Confirm New Password</Label>
                    <div className="relative">
                      <Input
                        id="confirm-password"
                        type={showConfirmPassword ? "text" : "password"}
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="Confirm new password"
                        className="bg-black/30 border-white/10 text-white pr-10"
                        data-testid="input-confirm-password"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                        onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      >
                        {showConfirmPassword ? (
                          <EyeOff className="h-4 w-4 text-white/60" />
                        ) : (
                          <Eye className="h-4 w-4 text-white/60" />
                        )}
                      </Button>
                    </div>
                  </div>

                  <Button
                    onClick={() => changePasswordMutation.mutate()}
                    disabled={changePasswordMutation.isPending || !currentPassword || !newPassword || !confirmPassword}
                    className="w-full bg-blue-600 hover:bg-blue-700"
                    data-testid="button-submit-password"
                  >
                    {changePasswordMutation.isPending ? "Changing..." : "Change Password"}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Withdrawal Password Security Card - Only show for real users */}
        {user && (
          <Card className="bg-black/30 backdrop-blur-md border border-white/10">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-white">
                <Shield className="w-5 h-5 text-green-400" />
                Withdrawal Password
              </CardTitle>
              <CardDescription className="text-white/60">
                Change your withdrawal password for secure withdrawals
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowWithdrawalPasswordChange(!showWithdrawalPasswordChange)}
                className="border-white/20 text-white/80 hover:bg-white/10 w-full"
                data-testid="button-change-withdrawal-password"
              >
                <Key className="w-4 h-4 mr-2" />
                {showWithdrawalPasswordChange ? "Cancel" : "Change Withdrawal Password"}
              </Button>

              {showWithdrawalPasswordChange && (
                <div className="mt-4 space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="current-withdrawal-password" className="text-white/70">Current Withdrawal Password</Label>
                    <div className="relative">
                      <Input
                        id="current-withdrawal-password"
                        type={showCurrentWithdrawalPassword ? "text" : "password"}
                        value={currentWithdrawalPassword}
                        onChange={(e) => setCurrentWithdrawalPassword(e.target.value)}
                        placeholder="Enter current withdrawal password"
                        className="bg-black/30 border-white/10 text-white pr-10"
                        data-testid="input-current-withdrawal-password"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                        onClick={() => setShowCurrentWithdrawalPassword(!showCurrentWithdrawalPassword)}
                      >
                        {showCurrentWithdrawalPassword ? (
                          <EyeOff className="h-4 w-4 text-white/60" />
                        ) : (
                          <Eye className="h-4 w-4 text-white/60" />
                        )}
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="new-withdrawal-password" className="text-white/70">New Withdrawal Password</Label>
                    <div className="relative">
                      <Input
                        id="new-withdrawal-password"
                        type={showNewWithdrawalPassword ? "text" : "password"}
                        value={newWithdrawalPassword}
                        onChange={(e) => setNewWithdrawalPassword(e.target.value)}
                        placeholder="Enter new withdrawal password"
                        className="bg-black/30 border-white/10 text-white pr-10"
                        data-testid="input-new-withdrawal-password"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                        onClick={() => setShowNewWithdrawalPassword(!showNewWithdrawalPassword)}
                      >
                        {showNewWithdrawalPassword ? (
                          <EyeOff className="h-4 w-4 text-white/60" />
                        ) : (
                          <Eye className="h-4 w-4 text-white/60" />
                        )}
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="confirm-withdrawal-password" className="text-white/70">Confirm New Withdrawal Password</Label>
                    <div className="relative">
                      <Input
                        id="confirm-withdrawal-password"
                        type={showConfirmWithdrawalPassword ? "text" : "password"}
                        value={confirmWithdrawalPassword}
                        onChange={(e) => setConfirmWithdrawalPassword(e.target.value)}
                        placeholder="Confirm new withdrawal password"
                        className="bg-black/30 border-white/10 text-white pr-10"
                        data-testid="input-confirm-withdrawal-password"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                        onClick={() => setShowConfirmWithdrawalPassword(!showConfirmWithdrawalPassword)}
                      >
                        {showConfirmWithdrawalPassword ? (
                          <EyeOff className="h-4 w-4 text-white/60" />
                        ) : (
                          <Eye className="h-4 w-4 text-white/60" />
                        )}
                      </Button>
                    </div>
                  </div>

                  <Button
                    onClick={() => changeWithdrawalPasswordMutation.mutate()}
                    disabled={changeWithdrawalPasswordMutation.isPending || !currentWithdrawalPassword || !newWithdrawalPassword || !confirmWithdrawalPassword}
                    className="w-full bg-green-600 hover:bg-green-700"
                    data-testid="button-submit-withdrawal-password"
                  >
                    {changeWithdrawalPasswordMutation.isPending ? "Changing..." : "Change Withdrawal Password"}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Customer Support */}
        <Card className="bg-gradient-to-r from-blue-600/20 to-cyan-600/20 border-blue-300/20">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-white">
              <MessageCircle className="w-5 h-5 text-cyan-400" />
              Customer Support
            </CardTitle>
            <CardDescription className="text-white/60">
              Need help? Contact our support team on Telegram
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={() => {
                const telegramLink = systemSettings?.find(s => s.key === 'telegram_support_link')?.value || 'https://t.me/';
                window.open(telegramLink, '_blank');
                toast({
                  title: "Opening Telegram",
                  description: "Redirecting you to our support channel",
                });
              }}
              className="w-full bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 text-white"
              data-testid="button-customer-support"
            >
              <MessageCircle className="w-4 h-4 mr-2" />
              Contact Support on Telegram
            </Button>
          </CardContent>
        </Card>

        {/* Privacy Policy & Terms */}
        <div className="px-4">
          <div className="flex items-center justify-center gap-4 text-sm">
            <button
              onClick={() => setLocation('/privacy-policy')}
              className="text-white/60 hover:text-white transition-colors underline"
              data-testid="link-privacy-policy"
            >
              Privacy Policy
            </button>
            <span className="text-white/40">|</span>
            <button
              onClick={() => setLocation('/terms-of-service')}
              className="text-white/60 hover:text-white transition-colors underline"
              data-testid="link-terms-of-service"
            >
              Terms of Service
            </button>
          </div>
        </div>
      </main>

      {/* Commission History Modal */}
      <Dialog open={showCommissionHistory} onOpenChange={setShowCommissionHistory}>
        <DialogContent className="bg-gradient-to-br from-gray-900 to-black border border-white/10 text-white max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-xl">
              <History className="w-5 h-5 text-yellow-400" />
              Commission Earnings History
            </DialogTitle>
            <DialogDescription className="text-white/60">
              View your referral bonuses and betting commission earnings
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Total Earnings Summary */}
            <div className="bg-gradient-to-br from-yellow-600/10 to-orange-600/10 rounded-xl p-4 border border-yellow-400/20">
              <p className="text-sm text-white/70 mb-1">Total Current Rewards</p>
              <p className="text-2xl font-bold text-yellow-400">
                {formatGoldCoins(usdToGoldCoins(commissionHistoryData?.totalEarnings || "0"))}
              </p>
            </div>

            {/* Loading State */}
            {isLoadingCommissionHistory && (
              <div className="text-center py-8">
                <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-yellow-400"></div>
                <p className="text-white/60 mt-2">Loading history...</p>
              </div>
            )}

            {/* Commission History List */}
            {!isLoadingCommissionHistory && commissionHistoryData && (
              <div className="space-y-3">
                {commissionHistoryData.history.length > 0 ? (
                  commissionHistoryData.history.map((item) => (
                    <div
                      key={item.id}
                      className="bg-white/5 rounded-lg p-4 border border-white/10 hover:bg-white/10 transition-colors"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            {item.type === 'referral_bonus' ? (
                              <Gift className="w-4 h-4 text-green-400" />
                            ) : (
                              <Coins className="w-4 h-4 text-blue-400" />
                            )}
                            <h4 className="text-white font-semibold text-sm">
                              {item.type === 'referral_bonus' ? 'Referral Bonus' : 'Betting Commission'}
                            </h4>
                            {item.type === 'bet_commission' && item.commissionRate && (
                              <Badge variant="outline" className="text-xs border-blue-400/30 text-blue-400">
                                {(parseFloat(item.commissionRate) * 100).toFixed(1)}% rate
                              </Badge>
                            )}
                          </div>
                          <p className="text-sm text-white/70 mb-2">
                            {item.description}
                          </p>
                          {item.referredUser && item.referredUser !== 'Unknown User' && (
                            <p className="text-xs text-white/50">
                              From: {item.referredUser.split('@')[0]}***
                            </p>
                          )}
                          <p className="text-xs text-white/40 mt-1">
                            {new Date(item.date).toLocaleDateString()} {new Date(item.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-lg font-bold text-green-400">
                            +{formatGoldCoins(usdToGoldCoins(item.amount))}
                          </p>
                          <p className="text-xs text-white/50">
                            ≈ ${parseFloat(item.amount).toFixed(2)}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-center py-8">
                    <Gift className="w-12 h-12 text-white/20 mx-auto mb-3" />
                    <p className="text-white/60">No commission earnings yet</p>
                    <p className="text-sm text-white/40 mt-1">
                      Start referring friends to earn bonuses!
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <BottomNav user={user} />
    </div>
  );
}