import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Eye, EyeOff, LogIn, Mail, Lock, Shield } from "lucide-react";
import { loginSchema, type LoginUser } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Compact3XBetLogo } from "@/components/enhanced-3xbet-logo";

export default function Login() {
  const [, setLocation] = useLocation();
  const [showPassword, setShowPassword] = useState(false);
  const [requires2FA, setRequires2FA] = useState(false);
  const [userId, setUserId] = useState("");
  const [twoFACode, setTwoFACode] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const form = useForm<LoginUser>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  const loginMutation = useMutation({
    mutationFn: async (data: LoginUser) => {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json"
        },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Login failed");
      }
      return response.json();
    },
    onSuccess: (data) => {
      if (data.requires2FA) {
        setRequires2FA(true);
        setUserId(data.userId);
        toast({
          title: "2FA Required",
          description: data.message || "Please enter your 2FA code",
        });
      } else {
        queryClient.setQueryData(["/api/auth/me"], data);
        toast({
          title: "Login successful",
          description: `Welcome back, ${data.username}!`,
        });
        if (data.role === "admin") {
          setLocation("/main-admin-md");
        } else {
          setLocation("/");
        }
      }
    },
    onError: (error: any) => {
      toast({
        title: "Login failed",
        description: error.message || "Invalid username or password",
        variant: "destructive",
      });
    },
  });

  const verify2FAMutation = useMutation({
    mutationFn: async (code: string) => {
      const response = await fetch("/api/auth/login/verify-2fa", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json"
        },
        credentials: "include",
        body: JSON.stringify({ userId, token: code }),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "2FA verification failed");
      }
      return response.json();
    },
    onSuccess: (user) => {
      queryClient.setQueryData(["/api/auth/me"], user);
      toast({
        title: "Login successful",
        description: `Welcome back, ${user.username}!`,
      });
      if (user.role === "admin") {
        setLocation("/main-admin-md");
      } else {
        setLocation("/");
      }
    },
    onError: (error: any) => {
      toast({
        title: "2FA Verification Failed",
        description: error.message || "Invalid 2FA code",
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: LoginUser) => {
    loginMutation.mutate(data);
  };

  const handle2FASubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (twoFACode.length === 6) {
      verify2FAMutation.mutate(twoFACode);
    } else {
      toast({
        title: "Invalid Code",
        description: "Please enter a 6-digit code",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 text-white relative overflow-hidden flex items-center justify-center p-4">
      <Card className="w-full max-w-md bg-white/10 backdrop-blur-md border-white/20">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <Compact3XBetLogo />
          </div>
          <CardTitle className="text-2xl font-bold text-white">
            {requires2FA ? "Two-Factor Authentication" : "Welcome Back"}
          </CardTitle>
          <CardDescription className="text-white/70">
            {requires2FA ? "Enter your 6-digit authentication code" : "Sign in to your gaming account"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {!requires2FA ? (
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email" className="text-white/90">Email</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-3 h-4 w-4 text-white/50" />
                  <Input
                    {...form.register("email")}
                    id="email"
                    type="email"
                    placeholder="Enter your email"
                    className="pl-10 bg-white/10 border-white/20 text-white placeholder:text-white/50 focus:border-yellow-500"
                    data-testid="input-email"
                  />
                </div>
                {form.formState.errors.email && (
                  <Alert variant="destructive" className="bg-red-500/10 border-red-500/20">
                    <AlertDescription className="text-red-400">
                      {form.formState.errors.email.message}
                    </AlertDescription>
                  </Alert>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="password" className="text-white/90">Password</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-3 h-4 w-4 text-white/50" />
                  <Input
                    {...form.register("password")}
                    id="password"
                    type={showPassword ? "text" : "password"}
                    placeholder="Enter your password"
                    className="pl-10 pr-10 bg-white/10 border-white/20 text-white placeholder:text-white/50 focus:border-yellow-500"
                    data-testid="input-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-3 h-4 w-4 text-white/50 hover:text-white"
                    data-testid="button-toggle-password"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {form.formState.errors.password && (
                  <Alert variant="destructive" className="bg-red-500/10 border-red-500/20">
                    <AlertDescription className="text-red-400">
                      {form.formState.errors.password.message}
                    </AlertDescription>
                  </Alert>
                )}
              </div>

              <Button
                type="submit"
                className="w-full bg-yellow-500 hover:bg-yellow-600 text-white font-semibold"
                disabled={loginMutation.isPending}
                data-testid="button-login"
              >
                {loginMutation.isPending ? "Signing in..." : "Sign In"}
              </Button>
            </form>
          ) : (
            <form onSubmit={handle2FASubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="2fa-code" className="text-white/90">Authentication Code</Label>
                <div className="relative">
                  <Shield className="absolute left-3 top-3 h-4 w-4 text-white/50" />
                  <Input
                    id="2fa-code"
                    type="text"
                    maxLength={6}
                    value={twoFACode}
                    onChange={(e) => setTwoFACode(e.target.value.replace(/\D/g, ''))}
                    placeholder="000000"
                    className="pl-10 bg-white/10 border-white/20 text-white placeholder:text-white/50 focus:border-yellow-500 text-center text-2xl tracking-widest"
                    data-testid="input-2fa-code"
                    autoFocus
                  />
                </div>
                <p className="text-xs text-white/60 text-center">
                  Enter the 6-digit code from your authenticator app
                </p>
              </div>

              <div className="space-y-2">
                <Button
                  type="submit"
                  className="w-full bg-yellow-500 hover:bg-yellow-600 text-white font-semibold"
                  disabled={verify2FAMutation.isPending || twoFACode.length !== 6}
                  data-testid="button-verify-2fa"
                >
                  {verify2FAMutation.isPending ? "Verifying..." : "Verify Code"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full bg-transparent border-white/20 text-white hover:bg-white/10"
                  onClick={() => {
                    setRequires2FA(false);
                    setUserId("");
                    setTwoFACode("");
                  }}
                  data-testid="button-back-to-login"
                >
                  Back to Login
                </Button>
              </div>
            </form>
          )}

          {!requires2FA && (
            <div className="text-center space-y-2">
              <p className="text-white/70 text-sm">
                <Link 
                  href="/reset-password" 
                  className="text-yellow-500 hover:text-yellow-400 font-semibold"
                  data-testid="link-forgot-password"
                >
                  Forgot your password?
                </Link>
              </p>
              <p className="text-white/70 text-sm">
                Don't have an account?{" "}
                <Link 
                  href="/signup" 
                  className="text-yellow-500 hover:text-yellow-400 font-semibold"
                  data-testid="link-signup"
                >
                  Sign up here
                </Link>
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
