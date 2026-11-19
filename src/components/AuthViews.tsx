import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Building2,
  CheckCircle2,
  Eye,
  EyeOff,
  HelpCircle,
  KeyRound,
  Lock,
  Mail,
  ShieldCheck,
  UserCheck,
  X,
} from 'lucide-react';
import { ApiError, apiFetch, setStoredToken } from '../api';
import type { AuthUser } from '../types';

const ARCH_BACKDROP = '/src/assets/images/smartattend_office_arch_1795081608452.jpg';

interface AuthScreenProps {
  onAuthenticated: (user: AuthUser) => void;
}

type AuthMode = 'login' | 'register' | 'forgot';

interface HelpInfo {
  loginGuidance: string[];
  passwordResetGuidance: string[];
  troubleshooting: string[];
  supportContact: { email: string; phone: string; hours: string };
}

interface OutboxItem {
  id: string;
  recipient_email: string;
  subject: string;
  reset_code: string;
  created_at: string;
}

export const AuthScreen: React.FC<AuthScreenProps> = ({ onAuthenticated }) => {
  const [mode, setMode] = useState<AuthMode>('login');
  const [imgFailed, setImgFailed] = useState(false);

  // Login state
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);

  // Company Registration state
  const [companyName, setCompanyName] = useState('');
  const [companyEmail, setCompanyEmail] = useState('');
  const [contactNumber, setContactNumber] = useState('');
  const [industry, setIndustry] = useState('Technology & Software');
  const [address, setAddress] = useState('');
  const [website, setWebsite] = useState('');
  const [adminFullName, setAdminFullName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminMobile, setAdminMobile] = useState('');
  const [regUsername, setRegUsername] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regConfirmPassword, setRegConfirmPassword] = useState('');
  const [usernameStatus, setUsernameStatus] = useState<{ checking: boolean; available?: boolean; reason?: string | null }>({
    checking: false,
  });
  const [regError, setRegError] = useState<string | null>(null);
  const [regLoading, setRegLoading] = useState(false);

  // Forgot Password state
  const [forgotIdentifier, setForgotIdentifier] = useState('');
  const [forgotStep, setForgotStep] = useState<'request' | 'verify'>('request');
  const [forgotNotice, setForgotNotice] = useState<string | null>(null);
  const [forgotError, setForgotError] = useState<string | null>(null);
  const [resetCode, setResetCode] = useState('');
  const [resetNewPass, setResetNewPass] = useState('');
  const [resetConfirmPass, setResetConfirmPass] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [showOutbox, setShowOutbox] = useState(false);
  const [outboxMessages, setOutboxMessages] = useState<OutboxItem[]>([]);

  // Need Help modal state
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpInfo, setHelpInfo] = useState<HelpInfo | null>(null);
  const [showQaAccounts, setShowQaAccounts] = useState(false);

  useEffect(() => {
    if (!regUsername.trim() || regUsername.trim().length < 3) {
      setUsernameStatus({ checking: false });
      return;
    }
    const timer = setTimeout(async () => {
      setUsernameStatus({ checking: true });
      try {
        const res = await apiFetch<{ available: boolean; reason: string | null }>(
          `/api/auth/check-username?username=${encodeURIComponent(regUsername.trim())}`
        );
        setUsernameStatus({ checking: false, available: res.available, reason: res.reason });
      } catch {
        setUsernameStatus({ checking: false });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [regUsername]);

  const openHelpModal = async () => {
    setHelpOpen(true);
    if (!helpInfo) {
      try {
        const info = await apiFetch<HelpInfo>('/api/auth/help-info');
        setHelpInfo(info);
      } catch {
        // fallback handled in UI
      }
    }
  };

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    setLoginLoading(true);
    try {
      const res = await apiFetch<{ token: string; user: AuthUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identifier: identifier.trim(), password }),
      });
      setStoredToken(res.token);
      onAuthenticated(res.user);
    } catch (err) {
      setLoginError(err instanceof ApiError ? err.message : 'Unable to sign in.');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegError(null);
    setRegLoading(true);
    try {
      const res = await apiFetch<{ token: string; user: AuthUser }>('/api/auth/register-company', {
        method: 'POST',
        body: JSON.stringify({
          companyName,
          companyEmail,
          contactNumber,
          industry,
          address,
          website,
          adminFullName,
          adminEmail,
          adminMobile,
          username: regUsername,
          password: regPassword,
          confirmPassword: regConfirmPassword,
        }),
      });
      setStoredToken(res.token);
      onAuthenticated(res.user);
    } catch (err) {
      setRegError(err instanceof ApiError ? err.message : 'Company registration failed.');
    } finally {
      setRegLoading(false);
    }
  };

  const loadOutbox = async () => {
    try {
      const res = await apiFetch<{ messages: OutboxItem[] }>('/api/auth/sandbox-outbox');
      setOutboxMessages(res.messages);
    } catch {
      // ignore
    }
  };

  const handleForgotRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setForgotError(null);
    setForgotNotice(null);
    setForgotLoading(true);
    try {
      const res = await apiFetch<{ message: string }>('/api/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ identifier: forgotIdentifier.trim() }),
      });
      setForgotNotice(res.message);
      setForgotStep('verify');
      await loadOutbox();
    } catch (err) {
      setForgotError(err instanceof ApiError ? err.message : 'Could not process reset request.');
    } finally {
      setForgotLoading(false);
    }
  };

  const handleResetConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setForgotError(null);
    setForgotLoading(true);
    try {
      const res = await apiFetch<{ message: string }>('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({
          token: resetCode.trim(),
          newPassword: resetNewPass,
          confirmPassword: resetConfirmPass,
        }),
      });
      setLoginError(null);
      setMode('login');
      setForgotStep('request');
      setResetCode('');
      setResetNewPass('');
      setResetConfirmPass('');
      setForgotNotice(res.message);
    } catch (err) {
      setForgotError(err instanceof ApiError ? err.message : 'Password reset failed.');
    } finally {
      setForgotLoading(false);
    }
  };

  const fillQaLogin = (ident: string, pass: string) => {
    setIdentifier(ident);
    setPassword(pass);
    setLoginError(null);
    setHelpOpen(false);
    setMode('login');
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col lg:flex-row">
      {/* Left Architectural Brand Column */}
      <aside className="relative lg:w-[44%] xl:w-[46%] min-h-[260px] lg:min-h-screen bg-slate-900 text-white overflow-hidden flex flex-col justify-between p-8 lg:p-12 shrink-0">
        {!imgFailed && (
          <img
            src={ARCH_BACKDROP}
            alt="Modern enterprise headquarters atrium"
            referrerPolicy="no-referrer"
            onError={() => setImgFailed(true)}
            className="absolute inset-0 w-full h-full object-cover opacity-55"
          />
        )}
        <div
          className="absolute inset-0 bg-gradient-to-t from-slate-950/95 via-slate-950/70 to-slate-900/60"
          aria-hidden="true"
        />

        <div className="relative z-10 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-600 flex items-center justify-center text-white font-display font-bold text-lg">
              S
            </div>
            <span className="font-display text-xl font-semibold tracking-tight text-white whitespace-nowrap">
              SmartAttend
            </span>
          </div>
          <span className="text-xs text-slate-300 font-medium tracking-wide">
            Workforce &amp; Attendance Platform
          </span>
        </div>

        <div className="relative z-10 max-w-lg my-8 lg:my-0">
          <h1 className="font-display text-3xl lg:text-4xl font-semibold tracking-tight text-white leading-tight [text-wrap:balance]">
            One global identity. Automatic workspace isolation.
          </h1>
          <p className="mt-4 text-sm lg:text-base text-slate-200 leading-relaxed">
            Sign in directly with your globally unique Username or system-generated Employee ID.
            SmartAttend resolves your organization, role permissions, geofenced office locations,
            and leave workflows automatically—without company codes.
          </p>

          <dl className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-6 pt-6 border-t border-white/15">
            <div>
              <dt className="text-xs text-slate-300">Authentication</dt>
              <dd className="mt-1 text-sm font-medium text-white">Username or Employee ID</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-300">Tenant Boundary</dt>
              <dd className="mt-1 text-sm font-medium text-white">Server-Enforced Isolation</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-300">Workforce Suite</dt>
              <dd className="mt-1 text-sm font-medium text-white">GPS, Shifts &amp; Payroll</dd>
            </div>
          </dl>
        </div>

        <div className="relative z-10 text-xs text-slate-300 flex items-center justify-between gap-4 border-t border-white/15 pt-5">
          <span>SmartAttend Workforce Operations</span>
          <span className="font-mono tabular-nums">Multi-Tenant Auth</span>
        </div>
      </aside>

      {/* Right Authentication / Registration / Recovery Column */}
      <main className="flex-1 flex items-center justify-center p-6 sm:p-10 lg:p-14 overflow-y-auto">
        {mode === 'login' && (
          <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-8">
            <div className="mb-7">
              <h2 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
                Sign in to SmartAttend
              </h2>
              <p className="mt-1.5 text-sm text-slate-600">
                Enter your Username or Employee ID and password to continue.
              </p>
            </div>

            {forgotNotice && (
              <div className="mb-5 p-3.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-900 text-sm flex items-start gap-2.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-700 mt-0.5 shrink-0" />
                <span>{forgotNotice}</span>
              </div>
            )}

            {loginError && (
              <div
                role="alert"
                className="mb-5 p-3.5 rounded-lg bg-red-50 border border-red-200 text-red-900 text-sm"
              >
                {loginError}
              </div>
            )}

            <form onSubmit={handleLoginSubmit} className="space-y-4">
              <div>
                <label htmlFor="login-identifier" className="block text-sm font-medium text-slate-700 mb-1.5">
                  Username / Employee ID
                </label>
                <div className="relative">
                  <UserCheck className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    id="login-identifier"
                    type="text"
                    required
                    autoComplete="username"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    placeholder="e.g. rahul or EMP0004"
                    className="w-full pl-10 pr-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label htmlFor="login-password" className="block text-sm font-medium text-slate-700">
                    Password
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setMode('forgot');
                      setForgotError(null);
                      setForgotNotice(null);
                    }}
                    className="text-xs font-medium text-blue-700 hover:text-blue-800 hover:underline whitespace-nowrap"
                  >
                    Forgot Password?
                  </button>
                </div>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    id="login-password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    className="w-full pl-10 pr-10 py-2.5 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                  />
                  <button
                    type="button"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    onClick={() => setShowPassword((prev) => !prev)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 p-1"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={loginLoading}
                className="w-full py-2.5 px-4 bg-blue-700 hover:bg-blue-800 disabled:bg-blue-400 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer whitespace-nowrap"
              >
                {loginLoading ? 'Signing in...' : 'Login'}
              </button>
            </form>

            <div className="mt-6 pt-5 border-t border-slate-200 flex items-center justify-between gap-3 text-sm">
              <button
                type="button"
                onClick={openHelpModal}
                className="inline-flex items-center gap-1.5 text-slate-600 hover:text-slate-900 font-medium whitespace-nowrap cursor-pointer"
              >
                <HelpCircle className="w-4 h-4" />
                <span>Need Help</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setMode('register');
                  setRegError(null);
                }}
                className="text-blue-700 hover:text-blue-800 font-medium hover:underline whitespace-nowrap cursor-pointer"
              >
                New Here? Register Company
              </button>
            </div>
          </div>
        )}

        {mode === 'register' && (
          <div className="w-full max-w-2xl bg-white border border-slate-200 rounded-xl p-6 sm:p-8">
            <div className="flex items-center justify-between gap-4 pb-5 border-b border-slate-200">
              <div>
                <h2 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
                  Register Your Company
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  Initialize your company workspace and create your primary Company Admin account.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setMode('login')}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back to Login</span>
              </button>
            </div>

            {regError && (
              <div role="alert" className="mt-5 p-3.5 rounded-lg bg-red-50 border border-red-200 text-red-900 text-sm">
                {regError}
              </div>
            )}

            <form onSubmit={handleRegisterSubmit} className="mt-6 space-y-6">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2 mb-3.5">
                  <Building2 className="w-4 h-4 text-blue-700" />
                  <span>01. Company Details</span>
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Company Name</label>
                    <input
                      type="text"
                      required
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      placeholder="Acme Logistics Inc."
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Company Email</label>
                    <input
                      type="email"
                      required
                      value={companyEmail}
                      onChange={(e) => setCompanyEmail(e.target.value)}
                      placeholder="ops@acmelogistics.com"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Contact Number</label>
                    <input
                      type="tel"
                      required
                      value={contactNumber}
                      onChange={(e) => setContactNumber(e.target.value)}
                      placeholder="+1 415-555-0140"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Industry</label>
                    <select
                      value={industry}
                      onChange={(e) => setIndustry(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                    >
                      <option>Technology &amp; Software</option>
                      <option>Manufacturing &amp; Engineering</option>
                      <option>Healthcare &amp; Life Sciences</option>
                      <option>Retail &amp; Logistics</option>
                      <option>Financial &amp; Advisory Services</option>
                      <option>Construction &amp; Field Operations</option>
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-slate-700 mb-1">Company Address</label>
                    <input
                      type="text"
                      required
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      placeholder="100 Market Street, Suite 400, San Francisco, CA"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-slate-700 mb-1">Website (Optional)</label>
                    <input
                      type="url"
                      value={website}
                      onChange={(e) => setWebsite(e.target.value)}
                      placeholder="https://acmelogistics.com"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                    />
                  </div>
                </div>
              </div>

              <div className="pt-5 border-t border-slate-200">
                <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2 mb-3.5">
                  <ShieldCheck className="w-4 h-4 text-blue-700" />
                  <span>02. Company Admin Account</span>
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Admin Full Name</label>
                    <input
                      type="text"
                      required
                      value={adminFullName}
                      onChange={(e) => setAdminFullName(e.target.value)}
                      placeholder="Siddharth Rao"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Admin Email</label>
                    <input
                      type="email"
                      required
                      value={adminEmail}
                      onChange={(e) => setAdminEmail(e.target.value)}
                      placeholder="siddharth@acmelogistics.com"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Admin Mobile Number</label>
                    <input
                      type="tel"
                      required
                      value={adminMobile}
                      onChange={(e) => setAdminMobile(e.target.value)}
                      placeholder="+1 415-555-0192"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Global Username
                    </label>
                    <input
                      type="text"
                      required
                      value={regUsername}
                      onChange={(e) => setRegUsername(e.target.value)}
                      placeholder="admin_acme"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                    />
                    {usernameStatus.checking && (
                      <p className="mt-1 text-xs text-slate-500">Checking global availability...</p>
                    )}
                    {!usernameStatus.checking && usernameStatus.available === true && (
                      <p className="mt-1 text-xs text-emerald-700">Username is globally available.</p>
                    )}
                    {!usernameStatus.checking && usernameStatus.available === false && (
                      <p className="mt-1 text-xs text-red-700">{usernameStatus.reason}</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Password</label>
                    <input
                      type="password"
                      required
                      value={regPassword}
                      onChange={(e) => setRegPassword(e.target.value)}
                      placeholder="Min 8 chars, Aa1"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Confirm Password</label>
                    <input
                      type="password"
                      required
                      value={regConfirmPassword}
                      onChange={(e) => setRegConfirmPassword(e.target.value)}
                      placeholder="Repeat password"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                    />
                  </div>
                </div>
              </div>

              <div className="pt-2 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setMode('login')}
                  className="px-4 py-2.5 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg whitespace-nowrap cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={regLoading || usernameStatus.available === false}
                  className="px-5 py-2.5 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:bg-blue-400 rounded-lg whitespace-nowrap cursor-pointer"
                >
                  {regLoading ? 'Creating Workspace...' : 'Register'}
                </button>
              </div>
            </form>
          </div>
        )}

        {mode === 'forgot' && (
          <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-8">
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-display text-xl font-semibold text-slate-900">Reset Password</h2>
              <button
                type="button"
                onClick={() => {
                  setMode('login');
                  setForgotStep('request');
                  setForgotError(null);
                }}
                className="text-xs font-medium text-slate-600 hover:text-slate-900 inline-flex items-center gap-1 cursor-pointer"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back to Login</span>
              </button>
            </div>

            {forgotNotice && (
              <div className="mb-4 p-3.5 rounded-lg bg-blue-50 border border-blue-200 text-blue-950 text-xs leading-relaxed">
                {forgotNotice}
              </div>
            )}
            {forgotError && (
              <div role="alert" className="mb-4 p-3.5 rounded-lg bg-red-50 border border-red-200 text-red-900 text-sm">
                {forgotError}
              </div>
            )}

            {forgotStep === 'request' ? (
              <form onSubmit={handleForgotRequest} className="space-y-4">
                <p className="text-sm text-slate-600">
                  Enter your registered email address or username. We will issue a single-use verification code without exposing company details.
                </p>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    Registered Email or Username
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="text"
                      required
                      value={forgotIdentifier}
                      onChange={(e) => setForgotIdentifier(e.target.value)}
                      placeholder="e.g. rahul or rahul@abctech.io"
                      className="w-full pl-10 pr-3.5 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={forgotLoading}
                  className="w-full py-2.5 px-4 bg-blue-700 hover:bg-blue-800 text-white text-sm font-medium rounded-lg cursor-pointer"
                >
                  {forgotLoading ? 'Issuing Verification Code...' : 'Send Verification Code'}
                </button>
              </form>
            ) : (
              <form onSubmit={handleResetConfirm} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Verification Code</label>
                  <input
                    type="text"
                    required
                    value={resetCode}
                    onChange={(e) => setResetCode(e.target.value)}
                    placeholder="8-character reset code"
                    className="w-full px-3 py-2 text-sm font-mono uppercase border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">New Password</label>
                  <input
                    type="password"
                    required
                    value={resetNewPass}
                    onChange={(e) => setResetNewPass(e.target.value)}
                    placeholder="Min 8 chars, Aa1"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Confirm New Password</label>
                  <input
                    type="password"
                    required
                    value={resetConfirmPass}
                    onChange={(e) => setResetConfirmPass(e.target.value)}
                    placeholder="Repeat new password"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                  />
                </div>
                <button
                  type="submit"
                  disabled={forgotLoading}
                  className="w-full py-2.5 px-4 bg-blue-700 hover:bg-blue-800 text-white text-sm font-medium rounded-lg cursor-pointer"
                >
                  {forgotLoading ? 'Updating Password...' : 'Update Password & Revoke Sessions'}
                </button>
              </form>
            )}

            <div className="mt-5 pt-4 border-t border-slate-200">
              <button
                type="button"
                onClick={() => {
                  setShowOutbox((p) => !p);
                  if (!showOutbox) loadOutbox();
                }}
                className="text-xs font-medium text-slate-600 hover:text-slate-900 underline cursor-pointer"
              >
                {showOutbox ? 'Hide Sandbox Mail Outbox' : 'Inspect Local Sandbox Mail Outbox'}
              </button>
              {showOutbox && (
                <div className="mt-3 space-y-2 max-h-40 overflow-y-auto">
                  {outboxMessages.length === 0 ? (
                    <p className="text-xs text-slate-500">No verification codes dispatched yet.</p>
                  ) : (
                    outboxMessages.map((m) => (
                      <div key={m.id} className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-slate-800 truncate">{m.recipient_email}</span>
                          <button
                            type="button"
                            onClick={() => {
                              setResetCode(m.reset_code);
                              setForgotStep('verify');
                            }}
                            className="font-mono font-semibold text-blue-700 hover:underline shrink-0 cursor-pointer"
                          >
                            {m.reset_code}
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Need Help Modal */}
      {helpOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-xl w-full max-h-[88vh] overflow-y-auto p-6 sm:p-7">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <h3 className="font-display text-lg font-semibold text-slate-900">Sign-In &amp; Account Help</h3>
              <button
                type="button"
                onClick={() => setHelpOpen(false)}
                aria-label="Close help modal"
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="mt-5 space-y-5 text-sm text-slate-700">
              <div>
                <h4 className="font-semibold text-slate-900 mb-2">Login Assistance</h4>
                <ul className="list-disc pl-5 space-y-1.5 text-slate-600">
                  {(helpInfo?.loginGuidance || [
                    'Sign in with your globally unique Username or system-generated Employee ID.',
                    'No company code is needed—SmartAttend identifies your company automatically.',
                  ]).map((item, idx) => (
                    <li key={idx}>{item}</li>
                  ))}
                </ul>
              </div>

              <div>
                <h4 className="font-semibold text-slate-900 mb-2">Password Reset &amp; Troubleshooting</h4>
                <ul className="list-disc pl-5 space-y-1.5 text-slate-600">
                  {(helpInfo?.troubleshooting || []).map((item, idx) => (
                    <li key={idx}>{item}</li>
                  ))}
                </ul>
              </div>

              <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
                <h4 className="font-semibold text-slate-900 text-xs mb-1.5">Configured Support Contact</h4>
                <div className="text-xs text-slate-600 space-y-1">
                  <div>
                    Email: <span className="font-medium text-slate-900">{helpInfo?.supportContact.email || 'support@smartattend.io'}</span>
                  </div>
                  <div>
                    Phone: <span className="font-mono text-slate-900">{helpInfo?.supportContact.phone || '+1 (800) 555-0194'}</span>
                  </div>
                  <div>Hours: {helpInfo?.supportContact.hours || 'Monday – Friday, 08:00 – 20:00 UTC'}</div>
                </div>
              </div>

              <div className="pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setShowQaAccounts((p) => !p)}
                  className="text-xs font-medium text-blue-700 hover:underline cursor-pointer"
                >
                  {showQaAccounts ? 'Hide Pre-Seeded Reference Accounts' : 'Show Pre-Seeded Reference Accounts (For Testing)'}
                </button>

                {showQaAccounts && (
                  <div className="mt-3 border border-slate-200 rounded-lg overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                        <tr>
                          <th className="py-2 px-3 font-medium">Company / Role</th>
                          <th className="py-2 px-3 font-medium">Identifier</th>
                          <th className="py-2 px-3 font-medium">Password</th>
                          <th className="py-2 px-3 font-medium text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {[
                          { label: 'ABC Tech · Company Admin', id: 'admin_abc', pass: 'Password@123' },
                          { label: 'ABC Tech · HOD', id: 'arjun_hod', pass: 'Password@123' },
                          { label: 'ABC Tech · Employee (Username)', id: 'rahul', pass: 'Password@123' },
                          { label: 'ABC Tech · Employee (Emp ID)', id: 'EMP0004', pass: 'Password@123' },
                          { label: 'ABC Tech · First-Login Force Change', id: 'neha_temp', pass: 'Temp@123' },
                          { label: 'ABC Tech · Deactivated Employee', id: 'rohit_inactive', pass: 'Password@123' },
                          { label: 'XYZ Solutions · Company Admin', id: 'admin_xyz', pass: 'Password@123' },
                          { label: 'XYZ Solutions · Employee', id: 'priya', pass: 'Password@123' },
                          { label: 'Vertex Retail · Suspended Company', id: 'admin_vertex', pass: 'Password@123' },
                          { label: 'Platform · Super Admin', id: 'superadmin', pass: 'Admin@123' },
                        ].map((acc) => (
                          <tr key={acc.id} className="hover:bg-slate-50">
                            <td className="py-2 px-3 text-slate-700">{acc.label}</td>
                            <td className="py-2 px-3 font-mono text-slate-900">{acc.id}</td>
                            <td className="py-2 px-3 font-mono text-slate-600">{acc.pass}</td>
                            <td className="py-2 px-3 text-right">
                              <button
                                type="button"
                                onClick={() => fillQaLogin(acc.id, acc.pass)}
                                className="text-blue-700 hover:underline font-medium cursor-pointer"
                              >
                                Fill
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

interface ForcePasswordChangeProps {
  user: AuthUser;
  onSuccess: () => void;
  onLogout: () => void;
}

export const ForcePasswordChangeScreen: React.FC<ForcePasswordChangeProps> = ({ user, onSuccess, onLogout }) => {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await apiFetch('/api/auth/change-first-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
      });
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to update password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-8">
        <div className="w-10 h-10 rounded-lg bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-700 mb-5">
          <KeyRound className="w-5 h-5" />
        </div>
        <h2 className="font-display text-xl font-semibold text-slate-900">
          Set Your Permanent Password
        </h2>
        <p className="mt-1.5 text-sm text-slate-600">
          Signed in as <span className="font-medium text-slate-900">{user.fullName}</span> ({user.employeeId || user.username})
          {user.companyName ? ` · ${user.companyName}` : ''}. Your administrator issued a temporary password. Update it before accessing SmartAttend modules.
        </p>

        {error && (
          <div role="alert" className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-900 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Temporary Password</label>
            <input
              type="password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">New Password</label>
            <input
              type="password"
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Min 8 chars, uppercase, lowercase, number"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Confirm New Password</label>
            <input
              type="password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
            />
          </div>

          <div className="pt-2 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={onLogout}
              className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
            >
              Sign Out
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-5 py-2.5 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer"
            >
              {loading ? 'Saving...' : 'Update Password & Continue'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
