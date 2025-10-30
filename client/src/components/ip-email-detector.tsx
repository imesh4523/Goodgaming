import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AlertTriangle, Mail, Wifi, Eye, Clock, UserCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface User {
  id: string;
  email: string;
  registrationIp?: string;
  lastLoginIp?: string;
  createdAt: string;
  isActive: boolean;
}

interface IpEmailGroup {
  ipAddress: string;
  users: User[];
  emails: (string | null)[];
  isSignificant: boolean; // has multiple emails
}

interface IpEmailDetectorProps {
  users: User[];
}

export default function IpEmailDetector({ users }: IpEmailDetectorProps) {
  const [suspiciousGroups, setSuspiciousGroups] = useState<IpEmailGroup[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<IpEmailGroup | null>(null);
  const { toast } = useToast();

  // Analyze IP-Email patterns
  useEffect(() => {
    if (!users || users.length === 0) return;

    // Group users by IP addresses (both registration and login IPs)
    const ipGroups = new Map<string, User[]>();

    users.forEach(user => {
      // Check registration IP
      if (user.registrationIp && user.registrationIp !== 'unknown') {
        if (!ipGroups.has(user.registrationIp)) {
          ipGroups.set(user.registrationIp, []);
        }
        ipGroups.get(user.registrationIp)!.push(user);
      }

      // Check last login IP (if different from registration IP)
      if (user.lastLoginIp && user.lastLoginIp !== 'unknown' && user.lastLoginIp !== user.registrationIp) {
        if (!ipGroups.has(user.lastLoginIp)) {
          ipGroups.set(user.lastLoginIp, []);
        }
        // Avoid duplicates
        const existingUsers = ipGroups.get(user.lastLoginIp)!;
        if (!existingUsers.find(u => u.id === user.id)) {
          existingUsers.push(user);
        }
      }
    });

    // Filter for groups with multiple users and different emails
    const suspicious: IpEmailGroup[] = [];
    
    ipGroups.forEach((ipUsers, ipAddress) => {
      if (ipUsers.length > 1) {
        // Get unique emails for this IP
        const emails = Array.from(new Set(ipUsers.map(u => u.email).filter(email => email !== null)));
        const nullEmails = ipUsers.filter(u => u.email === null).length;
        
        // Flag as significant if there are multiple different emails, or emails mixed with null emails
        const isSignificant = emails.length > 1 || (emails.length >= 1 && nullEmails > 0);
        
        if (isSignificant) {
          suspicious.push({
            ipAddress,
            users: ipUsers,
            emails: [...emails, ...(nullEmails > 0 ? [null] : [])],
            isSignificant
          });
        }
      }
    });

    // Sort by risk level (more users = higher risk)
    suspicious.sort((a, b) => b.users.length - a.users.length);
    setSuspiciousGroups(suspicious);
  }, [users]);

  const getRiskLevel = (group: IpEmailGroup): "high" | "medium" | "low" => {
    if (group.users.length >= 5 || group.emails.length >= 4) return "high";
    if (group.users.length >= 3 || group.emails.length >= 3) return "medium";
    return "low";
  };

  const getRiskColor = (risk: "high" | "medium" | "low") => {
    switch (risk) {
      case "high": return "bg-red-500 text-white";
      case "medium": return "bg-orange-500 text-white";
      case "low": return "bg-yellow-500 text-black";
      default: return "bg-gray-500 text-white";
    }
  };

  const handleAnalyzeGroup = (group: IpEmailGroup) => {
    setSelectedGroup(group);
    toast({
      title: "🔍 IP Analysis",
      description: `Analyzing ${group.users.length} accounts from IP ${group.ipAddress}`,
    });
  };

  const handleCloseAnalysis = () => {
    setSelectedGroup(null);
  };

  const formatTimeAgo = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
    return `${Math.floor(diffDays / 30)} months ago`;
  };

  if (suspiciousGroups.length === 0) {
    return (
      <Card className="admin-card admin-glow border-green-500/20" data-testid="ip-email-detector-clean">
        <CardHeader>
          <CardTitle className="text-white flex items-center gap-2">
            <UserCheck className="h-5 w-5 text-green-400" />
            IP-Email Analysis: Clean
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-4">
            <UserCheck className="h-12 w-12 text-green-400 mx-auto mb-2" />
            <p className="text-green-300">No suspicious IP-email patterns detected</p>
            <p className="text-sm text-purple-300 mt-1">All users appear to be using unique IP-email combinations</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6" data-testid="ip-email-detector">
      {/* Summary Card */}
      <Card className="admin-card admin-glow border-red-500/20">
        <CardHeader>
          <CardTitle className="text-white flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-red-400" />
            IP-Email Detection: {suspiciousGroups.length} Suspicious Groups
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div className="text-center">
              <div className="text-2xl font-bold text-red-400">{suspiciousGroups.length}</div>
              <div className="text-sm text-purple-300">Suspicious IPs</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-orange-400">
                {suspiciousGroups.reduce((sum, group) => sum + group.users.length, 0)}
              </div>
              <div className="text-sm text-purple-300">Total Users</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-yellow-400">
                {suspiciousGroups.filter(g => getRiskLevel(g) === "high").length}
              </div>
              <div className="text-sm text-purple-300">High Risk</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Suspicious Groups Table */}
      <Card className="admin-card admin-glow border-purple-500/20">
        <CardHeader>
          <CardTitle className="text-white flex items-center gap-2">
            <Wifi className="h-5 w-5 text-purple-400" />
            Different Emails from Same IP Address
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-purple-500/20">
                  <TableHead className="text-purple-200">IP Address</TableHead>
                  <TableHead className="text-purple-200">Risk Level</TableHead>
                  <TableHead className="text-purple-200">Users</TableHead>
                  <TableHead className="text-purple-200">Different Emails</TableHead>
                  <TableHead className="text-purple-200">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {suspiciousGroups.map((group, index) => {
                  const risk = getRiskLevel(group);
                  return (
                    <TableRow key={group.ipAddress} className="border-purple-500/10 hover:bg-slate-800/30">
                      <TableCell>
                        <code className="text-sm bg-slate-800 px-2 py-1 rounded text-purple-300">
                          {group.ipAddress}
                        </code>
                      </TableCell>
                      <TableCell>
                        <Badge className={`${getRiskColor(risk)} font-semibold`}>
                          {risk.toUpperCase()}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center space-x-2">
                          <span className="text-white font-semibold">{group.users.length}</span>
                          <div className="flex -space-x-1">
                            {group.users.slice(0, 3).map((user, i) => (
                              <Avatar key={user.id} className="w-6 h-6 border-2 border-purple-500/30">
                                <AvatarFallback className="bg-purple-600 text-white text-xs">
                                  {user.email.charAt(0).toUpperCase()}
                                </AvatarFallback>
                              </Avatar>
                            ))}
                            {group.users.length > 3 && (
                              <div className="w-6 h-6 bg-purple-700 border-2 border-purple-500/30 rounded-full flex items-center justify-center text-xs text-white">
                                +{group.users.length - 3}
                              </div>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          {group.emails.map((email, i) => (
                            <div key={i} className="flex items-center gap-1">
                              <Mail className="h-3 w-3 text-purple-400" />
                              <span className="text-sm text-white">
                                {email || "No email"}
                              </span>
                            </div>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleAnalyzeGroup(group)}
                          className="border-purple-500/30 text-purple-300 hover:bg-purple-500/10"
                          data-testid={`analyze-group-${index}`}
                        >
                          <Eye className="h-4 w-4 mr-1" />
                          Analyze
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Detailed Analysis Modal */}
      {selectedGroup && (
        <Card className="admin-card admin-glow border-yellow-500/20">
          <CardHeader>
            <CardTitle className="text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Eye className="h-5 w-5 text-yellow-400" />
                Detailed Analysis: {selectedGroup.ipAddress}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleCloseAnalysis}
                className="border-purple-500/30 text-purple-300 hover:bg-purple-500/10"
              >
                Close
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-purple-300">Risk Level</p>
                  <Badge className={`${getRiskColor(getRiskLevel(selectedGroup))} font-semibold`}>
                    {getRiskLevel(selectedGroup).toUpperCase()}
                  </Badge>
                </div>
                <div>
                  <p className="text-sm text-purple-300">Total Users</p>
                  <p className="text-white font-semibold">{selectedGroup.users.length}</p>
                </div>
              </div>

              <div>
                <h4 className="text-white font-semibold mb-2">Users from this IP:</h4>
                <div className="space-y-2">
                  {selectedGroup.users.map((user) => (
                    <div key={user.id} className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg">
                      <div className="flex items-center space-x-3">
                        <Avatar className="border-2 border-purple-500/30">
                          <AvatarFallback className="bg-purple-600 text-white">
                            {user.email.charAt(0).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <p className="font-medium text-white">{user.email}</p>
                          <div className="flex items-center gap-2">
                            <Mail className="h-3 w-3 text-purple-400" />
                            <p className="text-sm text-purple-300">
                              {user.email || "No email"}
                            </p>
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="flex items-center gap-1 text-sm text-purple-300">
                          <Clock className="h-3 w-3" />
                          {formatTimeAgo(user.createdAt)}
                        </div>
                        <Badge variant={user.isActive ? "default" : "destructive"} className="text-xs">
                          {user.isActive ? "Active" : "Inactive"}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}