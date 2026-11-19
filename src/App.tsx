import React, { useEffect, useState } from 'react';
import {
  BarChart3,
  Bell,
  Building2,
  CalendarCheck,
  Clock,
  LayoutDashboard,
  LogOut,
  Menu,
  Users,
  X,
} from 'lucide-react';
import { apiFetch, setStoredToken } from './api';
import { AuthScreen, ForcePasswordChangeScreen } from './components/AuthViews';
import { AttendanceModule } from './components/AttendanceModule';
import { EmployeeManagement } from './components/EmployeeManagement';
import { LeaveModule } from './components/LeaveModule';
import {
  DashboardView,
  OrganizationSetupView,
  ReportsView,
  SecurityNotificationsView,
} from './components/WorkspaceModules';
import type { AuthUser } from './types';

type WorkspaceTab =
  | 'dashboard'
  | 'attendance'
  | 'leaves'
  | 'employees'
  | 'organization'
  | 'reports'
  | 'security';

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('dashboard');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const loadSession = async () => {
    try {
      const res = await apiFetch<{ user: AuthUser }>('/api/auth/me');
      setUser(res.user);
    } catch {
      setUser(null);
      setStoredToken(null);
    } finally {
      setBootstrapping(false);
    }
  };

  useEffect(() => {
    loadSession();
  }, []);

  const handleLogout = async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    setStoredToken(null);
    setUser(null);
    setActiveTab('dashboard');
  };

  if (bootstrapping) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-500">
        Verifying session...
      </div>
    );
  }

  if (!user) {
    return (
      <AuthScreen
        onAuthenticated={(authenticatedUser) => {
          setUser(authenticatedUser);
          setActiveTab('dashboard');
        }}
      />
    );
  }

  if (user.mustChangePassword) {
    return (
      <ForcePasswordChangeScreen
        user={user}
        onSuccess={() => setUser({ ...user, mustChangePassword: false })}
        onLogout={handleLogout}
      />
    );
  }

  const isSuperAdmin = user.role === 'Super Admin';
  const navItems: Array<{ id: WorkspaceTab; label: string; icon: React.ComponentType<{ className?: string }> }> =
    isSuperAdmin
      ? [
          { id: 'dashboard', label: 'Platform Overview', icon: LayoutDashboard },
          { id: 'security', label: 'Security & Audit', icon: Bell },
        ]
      : [
          { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
          { id: 'attendance', label: 'Attendance & GPS', icon: Clock },
          { id: 'leaves', label: 'Leave & WFH', icon: CalendarCheck },
          { id: 'employees', label: 'Employees', icon: Users },
          { id: 'organization', label: 'Locations & Shifts', icon: Building2 },
          { id: 'reports', label: 'Payroll Reports', icon: BarChart3 },
          { id: 'security', label: 'Notifications & Audit', icon: Bell },
        ];

  const activeLabel = navItems.find((n) => n.id === activeTab)?.label || 'Dashboard';

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 bg-slate-900 text-slate-100 border-r border-slate-800">
        <div className="h-16 px-5 flex items-center gap-3 border-b border-slate-800 shrink-0">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center font-display font-bold text-white">
            S
          </div>
          <span className="font-display text-lg font-semibold tracking-tight text-white whitespace-nowrap">
            SmartAttend
          </span>
        </div>

        <div className="px-5 py-4 border-b border-slate-800">
          <div className="text-[11px] text-slate-400">Active Workspace</div>
          <div className="mt-0.5 text-sm font-medium text-white truncate">
            {user.companyName || 'Platform Administration'}
          </div>
          <div className="mt-0.5 text-xs font-mono text-slate-400">
            {user.companyId || 'GLOBAL'} · {user.role}
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                  active
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-800">
          <div className="text-xs font-medium text-white truncate">{user.fullName}</div>
          <div className="text-[11px] font-mono text-slate-400 truncate mt-0.5">
            {user.username}
            {user.employeeId ? ` · ${user.employeeId}` : ''}
          </div>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/50"
            onClick={() => setMobileNavOpen(false)}
          />
          <aside className="relative w-64 max-w-[80vw] bg-slate-900 text-slate-100 flex flex-col z-10">
            <div className="h-16 px-5 flex items-center justify-between border-b border-slate-800">
              <span className="font-display text-lg font-semibold text-white">SmartAttend</span>
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                className="p-1.5 text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <nav className="flex-1 px-3 py-4 space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setMobileNavOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg cursor-pointer ${
                      active ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 lg:pl-64 flex flex-col min-w-0">
        <header className="h-16 bg-white border-b border-slate-200 px-4 sm:px-8 flex items-center justify-between gap-8 sticky top-0 z-30">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation menu"
              className="lg:hidden p-2 text-slate-600 hover:text-slate-900 rounded-lg cursor-pointer"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="text-sm text-slate-500 flex items-center gap-2 truncate">
              <span className="font-medium text-slate-900 truncate">
                {user.companyName || 'Platform'}
              </span>
              <span aria-hidden="true">/</span>
              <span className="truncate">{activeLabel}</span>
            </div>
          </div>

          <div className="flex items-center gap-4 shrink-0">
            <div className="hidden sm:block text-right">
              <div className="text-xs font-medium text-slate-900 whitespace-nowrap">{user.fullName}</div>
              <div className="text-[11px] font-mono text-slate-500 whitespace-nowrap">
                {user.role} {user.employeeId ? `· ${user.employeeId}` : ''}
              </div>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign Out</span>
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-8 max-w-7xl w-full mx-auto">
          {activeTab === 'dashboard' && (
            <DashboardView
              currentUser={user}
              onNavigate={(tab) => setActiveTab(tab as WorkspaceTab)}
            />
          )}
          {activeTab === 'attendance' && <AttendanceModule currentUser={user} />}
          {activeTab === 'leaves' && <LeaveModule currentUser={user} />}
          {activeTab === 'employees' && <EmployeeManagement currentUser={user} />}
          {activeTab === 'organization' && <OrganizationSetupView currentUser={user} />}
          {activeTab === 'reports' && <ReportsView currentUser={user} />}
          {activeTab === 'security' && <SecurityNotificationsView currentUser={user} />}
        </main>
      </div>
    </div>
  );
}
