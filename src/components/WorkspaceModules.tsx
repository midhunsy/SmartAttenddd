import React, { useEffect, useState } from 'react';
import {
  Bell,
  Building2,
  CalendarDays,
  CheckCheck,
  Clock,
  Download,
  MapPin,
  ShieldAlert,
} from 'lucide-react';
import { ApiError, apiFetch } from '../api';
import type {
  AttendanceRecord,
  AuditLogItem,
  AuthUser,
  CompanySettings,
  CompanySummary,
  Department,
  Holiday,
  LeaveBalance,
  NotificationItem,
  OfficeLocation,
  PayrollRow,
  Shift,
} from '../types';

// -----------------------------------------------------------------------------
// 1. ROLE-BASED DASHBOARD VIEW
// -----------------------------------------------------------------------------
interface DashboardData {
  mode: 'super_admin' | 'company';
  totals?: { total_companies: number; active_companies: number; total_users: number; total_employees: number };
  companies?: CompanySummary[];
  headcount?: { total_employees: number; active_employees: number };
  todayAttendance?: { checked_in_count: number; late_count: number; wfh_count: number };
  pendingApprovals?: { pending_leaves: number; pending_regs: number; pending_wfh: number };
  deptBreakdown?: Array<{ department: string; count: number }>;
  upcomingHolidays?: Holiday[];
  myToday?: AttendanceRecord | null;
  myBalances?: LeaveBalance[];
  recentAttendance?: AttendanceRecord[];
}

export const DashboardView: React.FC<{
  currentUser: AuthUser;
  onNavigate: (tab: string) => void;
}> = ({ currentUser, onNavigate }) => {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDashboard = async () => {
    setLoading(true);
    try {
      const res = await apiFetch<DashboardData>('/api/dashboard');
      setData(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load dashboard.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDashboard();
  }, []);

  const toggleCompanyStatus = async (companyId: string, currentStatus: 'active' | 'suspended') => {
    const next = currentStatus === 'active' ? 'suspended' : 'active';
    try {
      await apiFetch(`/api/platform/companies/${companyId}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: next }),
      });
      await loadDashboard();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to update company status.');
    }
  };

  if (loading) {
    return <div className="py-12 text-center text-sm text-slate-500">Loading workspace metrics...</div>;
  }
  if (error || !data) {
    return (
      <div role="alert" className="p-4 rounded-lg bg-red-50 border border-red-200 text-red-900 text-sm">
        {error || 'Dashboard unavailable.'}
      </div>
    );
  }

  if (data.mode === 'super_admin') {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="font-display text-2xl font-semibold text-slate-900">
            Platform Super Admin Console
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Monitor multi-tenant company workspaces, active headcounts, and tenant access status across SmartAttend.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="text-xs text-slate-500">Registered Companies</div>
            <div className="mt-2 font-display text-2xl font-semibold text-slate-900 tabular-nums">
              {data.totals?.total_companies ?? 0}
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="text-xs text-slate-500">Active Workspaces</div>
            <div className="mt-2 font-display text-2xl font-semibold text-emerald-700 tabular-nums">
              {data.totals?.active_companies ?? 0}
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="text-xs text-slate-500">Global User Accounts</div>
            <div className="mt-2 font-display text-2xl font-semibold text-slate-900 tabular-nums">
              {data.totals?.total_users ?? 0}
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="text-xs text-slate-500">Total Employees</div>
            <div className="mt-2 font-display text-2xl font-semibold text-slate-900 tabular-nums">
              {data.totals?.total_employees ?? 0}
            </div>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
          <div className="p-4 border-b border-slate-200 flex items-center justify-between">
            <h3 className="font-display text-base font-semibold text-slate-900">Tenant Directory</h3>
            <span className="text-xs text-slate-500">Suspending a company immediately blocks sign-ins and revokes active sessions</span>
          </div>
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-600">
              <tr>
                <th className="py-3 px-4 font-medium">Company ID</th>
                <th className="py-3 px-4 font-medium">Organization</th>
                <th className="py-3 px-4 font-medium">Industry</th>
                <th className="py-3 px-4 font-medium text-right">Employees</th>
                <th className="py-3 px-4 font-medium">Status</th>
                <th className="py-3 px-4 font-medium text-right">Control</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {(data.companies || []).map((c) => (
                <tr key={c.company_id} className="hover:bg-slate-50/70">
                  <td className="py-3 px-4 font-mono text-xs font-semibold text-slate-900">{c.company_id}</td>
                  <td className="py-3 px-4">
                    <div className="font-medium text-slate-900">{c.company_name}</div>
                    <div className="text-xs text-slate-500">{c.company_email}</div>
                  </td>
                  <td className="py-3 px-4 text-xs text-slate-600">{c.industry}</td>
                  <td className="py-3 px-4 text-right font-mono text-xs tabular-nums">{c.employee_count}</td>
                  <td className="py-3 px-4 text-xs font-medium">
                    <span className={c.status === 'active' ? 'text-emerald-700' : 'text-red-700'}>
                      {c.status === 'active' ? 'Active' : 'Suspended'}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right">
                    <button
                      type="button"
                      onClick={() => toggleCompanyStatus(c.company_id, c.status)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md border cursor-pointer ${
                        c.status === 'active'
                          ? 'text-red-700 border-red-200 hover:bg-red-50'
                          : 'text-emerald-700 border-emerald-200 hover:bg-emerald-50'
                      }`}
                    >
                      {c.status === 'active' ? 'Suspend Company' : 'Activate Company'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  const totalPending =
    (data.pendingApprovals?.pending_leaves ?? 0) +
    (data.pendingApprovals?.pending_regs ?? 0) +
    (data.pendingApprovals?.pending_wfh ?? 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl font-semibold text-slate-900">
            {currentUser.role} Dashboard
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            {currentUser.companyName} · Automatically isolated workspace ({currentUser.companyId})
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => onNavigate('attendance')}
            className="px-4 py-2 bg-blue-700 hover:bg-blue-800 text-white text-xs font-medium rounded-lg whitespace-nowrap cursor-pointer"
          >
            GPS Check-In / Attendance
          </button>
          {['Company Admin', 'HR'].includes(currentUser.role) && (
            <button
              type="button"
              onClick={() => onNavigate('employees')}
              className="px-4 py-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-800 text-xs font-medium rounded-lg whitespace-nowrap cursor-pointer"
            >
              Manage Employees
            </button>
          )}
        </div>
      </div>

      {/* 4-column KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs text-slate-500">Active Workforce</div>
          <div className="mt-2 font-display text-2xl font-semibold text-slate-900 tabular-nums">
            {data.headcount?.active_employees ?? 0}{' '}
            <span className="text-xs font-normal text-slate-500">
              / {data.headcount?.total_employees ?? 0} total
            </span>
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs text-slate-500">Checked In Today</div>
          <div className="mt-2 font-display text-2xl font-semibold text-emerald-700 tabular-nums">
            {data.todayAttendance?.checked_in_count ?? 0}
          </div>
          <div className="mt-1 text-xs text-slate-500 tabular-nums">
            {data.todayAttendance?.late_count ?? 0} late · {data.todayAttendance?.wfh_count ?? 0} WFH
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs text-slate-500">Pending Approvals</div>
          <div className="mt-2 font-display text-2xl font-semibold text-amber-700 tabular-nums">
            {totalPending}
          </div>
          <div className="mt-1 text-xs text-slate-500 tabular-nums">
            {data.pendingApprovals?.pending_leaves ?? 0} leave · {data.pendingApprovals?.pending_regs ?? 0} reg ·{' '}
            {data.pendingApprovals?.pending_wfh ?? 0} WFH
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs text-slate-500">My Shift Status Today</div>
          <div className="mt-2 font-display text-lg font-semibold text-slate-900">
            {data.myToday ? data.myToday.status : 'Not Checked In'}
          </div>
          <div className="mt-1 text-xs font-mono text-slate-500 tabular-nums">
            {data.myToday?.check_in_time
              ? `In ${data.myToday.check_in_time.slice(11, 16)} UTC`
              : `ID: ${currentUser.employeeId || currentUser.username}`}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex items-center justify-between">
            <h3 className="font-display text-base font-semibold text-slate-900">
              Recent Company Attendance Activity
            </h3>
            <button
              type="button"
              onClick={() => onNavigate('attendance')}
              className="text-xs font-medium text-blue-700 hover:underline cursor-pointer"
            >
              View All
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-600">
                <tr>
                  <th className="py-2.5 px-4 font-medium">Employee</th>
                  <th className="py-2.5 px-4 font-medium">Date</th>
                  <th className="py-2.5 px-4 font-medium">Punch Window</th>
                  <th className="py-2.5 px-4 font-medium text-right">Hours</th>
                  <th className="py-2.5 px-4 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {(data.recentAttendance || []).length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 px-4 text-center text-slate-500 text-xs">
                      No attendance logs recorded yet in this workspace.
                    </td>
                  </tr>
                ) : (
                  (data.recentAttendance || []).map((r) => (
                    <tr key={r.attendance_id}>
                      <td className="py-2.5 px-4">
                        <div className="font-medium text-slate-900 text-xs">{r.employee_name}</div>
                        <div className="text-[11px] font-mono text-slate-500">{r.employee_id}</div>
                      </td>
                      <td className="py-2.5 px-4 font-mono text-xs text-slate-600">{r.attendance_date}</td>
                      <td className="py-2.5 px-4 font-mono text-xs text-slate-600">
                        {r.check_in_time ? r.check_in_time.slice(11, 16) : '—'} –{' '}
                        {r.check_out_time ? r.check_out_time.slice(11, 16) : 'Active'}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-xs text-right tabular-nums">
                        {r.working_hours ? `${r.working_hours}h` : '—'}
                      </td>
                      <td className="py-2.5 px-4 text-xs font-medium">
                        <span className={r.is_late || r.is_half_day ? 'text-amber-700' : 'text-emerald-700'}>
                          {r.status}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <h3 className="font-display text-base font-semibold text-slate-900 mb-3">
              Departments
            </h3>
            <div className="space-y-2.5">
              {(data.deptBreakdown || []).map((d) => (
                <div key={d.department} className="flex items-center justify-between text-sm">
                  <span className="text-slate-700">{d.department}</span>
                  <span className="font-mono text-xs font-semibold text-slate-900 tabular-nums">
                    {d.count}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <h3 className="font-display text-base font-semibold text-slate-900 mb-3">
              Upcoming Holidays
            </h3>
            {(data.upcomingHolidays || []).length === 0 ? (
              <p className="text-xs text-slate-500">No upcoming holidays configured.</p>
            ) : (
              <div className="space-y-2.5">
                {(data.upcomingHolidays || []).map((h) => (
                  <div key={h.holiday_id} className="flex items-center justify-between text-xs">
                    <div>
                      <div className="font-medium text-slate-900">{h.name}</div>
                      <div className="text-slate-500">{h.holiday_type}</div>
                    </div>
                    <span className="font-mono text-slate-700">{h.holiday_date}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// -----------------------------------------------------------------------------
// 2. ORGANIZATION SETUP (Locations/Geofencing, Shifts, Departments, Holidays)
// -----------------------------------------------------------------------------
export const OrganizationSetupView: React.FC<{ currentUser: AuthUser }> = ({ currentUser }) => {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [locations, setLocations] = useState<OfficeLocation[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [settings, setSettings] = useState<CompanySettings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Forms
  const [locName, setLocName] = useState('');
  const [locAddr, setLocAddr] = useState('');
  const [locLat, setLocLat] = useState('37.7897');
  const [locLng, setLocLng] = useState('-122.3972');
  const [locRad, setLocRad] = useState('250');

  const [shiftName, setShiftName] = useState('');
  const [shiftStart, setShiftStart] = useState('09:00');
  const [shiftEnd, setShiftEnd] = useState('18:00');

  const [holName, setHolName] = useState('');
  const [holDate, setHolDate] = useState('2026-12-31');

  const [deptName, setDeptName] = useState('');
  const [deptCode, setDeptCode] = useState('');

  const isAdmin = ['Company Admin', 'HR'].includes(currentUser.role);

  const loadOrg = async () => {
    const res = await apiFetch<{
      departments: Department[];
      locations: OfficeLocation[];
      shifts: Shift[];
      holidays: Holiday[];
      settings: CompanySettings;
    }>('/api/org-options');
    setDepartments(res.departments);
    setLocations(res.locations);
    setShifts(res.shifts);
    setHolidays(res.holidays);
    setSettings(res.settings);
  };

  useEffect(() => {
    loadOrg();
  }, []);

  const addLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/api/locations', {
      method: 'POST',
      body: JSON.stringify({
        name: locName,
        address: locAddr,
        latitude: Number(locLat),
        longitude: Number(locLng),
        radiusMeters: Number(locRad),
      }),
    });
    setLocName('');
    setLocAddr('');
    setMsg('Office geofence location added.');
    await loadOrg();
  };

  const addShift = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/api/shifts', {
      method: 'POST',
      body: JSON.stringify({ name: shiftName, startTime: shiftStart, endTime: shiftEnd }),
    });
    setShiftName('');
    setMsg('Shift schedule added.');
    await loadOrg();
  };

  const addHoliday = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/api/holidays', {
      method: 'POST',
      body: JSON.stringify({ name: holName, holidayDate: holDate }),
    });
    setHolName('');
    setMsg('Holiday added to company calendar.');
    await loadOrg();
  };

  const addDept = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/api/departments', {
      method: 'POST',
      body: JSON.stringify({ name: deptName, code: deptCode }),
    });
    setDeptName('');
    setDeptCode('');
    setMsg('Department added.');
    await loadOrg();
  };

  const savePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    await apiFetch('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        gracePeriodMinutes: settings.grace_period_minutes,
        halfDayHours: settings.half_day_hours,
        fullDayHours: settings.full_day_hours,
        requireGeofence: Boolean(settings.require_geofence),
      }),
    });
    setMsg('Attendance policy settings updated.');
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-2xl font-semibold text-slate-900">
          Office Locations, Shifts &amp; Policies
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Configure geofence boundaries, shift timings, company holidays, and attendance rules for{' '}
          <span className="font-medium text-slate-900">{currentUser.companyName}</span>.
        </p>
      </div>

      {msg && (
        <div className="p-3.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-900 text-sm">
          {msg}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Geofenced Office Locations */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2 font-display font-semibold text-slate-900">
            <MapPin className="w-4 h-4 text-blue-700" />
            <span>Geofenced Office Locations</span>
          </div>
          <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg">
            {locations.map((l) => (
              <div key={l.location_id} className="p-3 text-xs flex items-center justify-between gap-4">
                <div>
                  <div className="font-medium text-slate-900">{l.name}</div>
                  <div className="text-slate-500">{l.address}</div>
                </div>
                <div className="text-right font-mono text-slate-700 shrink-0">
                  <div>
                    {l.latitude}, {l.longitude}
                  </div>
                  <div className="text-slate-500">Radius {l.radius_meters}m</div>
                </div>
              </div>
            ))}
          </div>
          {isAdmin && (
            <form onSubmit={addLocation} className="pt-2 space-y-2.5 border-t border-slate-200">
              <div className="grid grid-cols-2 gap-2.5">
                <input
                  type="text"
                  required
                  value={locName}
                  onChange={(e) => setLocName(e.target.value)}
                  placeholder="Office Name"
                  className="px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
                <input
                  type="text"
                  required
                  value={locAddr}
                  onChange={(e) => setLocAddr(e.target.value)}
                  placeholder="Street Address"
                  className="px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
                <input
                  type="number"
                  step="any"
                  required
                  value={locLat}
                  onChange={(e) => setLocLat(e.target.value)}
                  placeholder="Latitude"
                  className="px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                />
                <input
                  type="number"
                  step="any"
                  required
                  value={locLng}
                  onChange={(e) => setLocLng(e.target.value)}
                  placeholder="Longitude"
                  className="px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div className="flex items-center gap-2.5">
                <input
                  type="number"
                  required
                  value={locRad}
                  onChange={(e) => setLocRad(e.target.value)}
                  placeholder="Radius (m)"
                  className="w-32 px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                />
                <button
                  type="submit"
                  className="px-4 py-2 bg-slate-900 text-white text-xs font-medium rounded-lg cursor-pointer"
                >
                  Add Location
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Shifts */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2 font-display font-semibold text-slate-900">
            <Clock className="w-4 h-4 text-blue-700" />
            <span>Work Shifts</span>
          </div>
          <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg">
            {shifts.map((s) => (
              <div key={s.shift_id} className="p-3 text-xs flex items-center justify-between">
                <div className="font-medium text-slate-900">{s.name}</div>
                <div className="font-mono text-slate-700">
                  {s.start_time} – {s.end_time} · Grace {s.grace_minutes}m
                </div>
              </div>
            ))}
          </div>
          {isAdmin && (
            <form onSubmit={addShift} className="pt-2 flex flex-wrap items-center gap-2.5 border-t border-slate-200">
              <input
                type="text"
                required
                value={shiftName}
                onChange={(e) => setShiftName(e.target.value)}
                placeholder="Shift Name"
                className="flex-1 min-w-[140px] px-3 py-2 text-xs border border-slate-300 rounded-lg"
              />
              <input
                type="time"
                required
                value={shiftStart}
                onChange={(e) => setShiftStart(e.target.value)}
                className="px-2.5 py-2 text-xs font-mono border border-slate-300 rounded-lg"
              />
              <input
                type="time"
                required
                value={shiftEnd}
                onChange={(e) => setShiftEnd(e.target.value)}
                className="px-2.5 py-2 text-xs font-mono border border-slate-300 rounded-lg"
              />
              <button
                type="submit"
                className="px-4 py-2 bg-slate-900 text-white text-xs font-medium rounded-lg cursor-pointer"
              >
                Add Shift
              </button>
            </form>
          )}
        </div>

        {/* Holidays & Departments */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2 font-display font-semibold text-slate-900">
            <CalendarDays className="w-4 h-4 text-blue-700" />
            <span>Company Holiday Calendar</span>
          </div>
          <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg">
            {holidays.map((h) => (
              <div key={h.holiday_id} className="p-3 text-xs flex items-center justify-between">
                <span className="font-medium text-slate-900">{h.name}</span>
                <span className="font-mono text-slate-600">{h.holiday_date}</span>
              </div>
            ))}
          </div>
          {isAdmin && (
            <form onSubmit={addHoliday} className="pt-2 flex items-center gap-2.5 border-t border-slate-200">
              <input
                type="text"
                required
                value={holName}
                onChange={(e) => setHolName(e.target.value)}
                placeholder="Holiday Name"
                className="flex-1 px-3 py-2 text-xs border border-slate-300 rounded-lg"
              />
              <input
                type="date"
                required
                value={holDate}
                onChange={(e) => setHolDate(e.target.value)}
                className="px-2.5 py-2 text-xs font-mono border border-slate-300 rounded-lg"
              />
              <button
                type="submit"
                className="px-4 py-2 bg-slate-900 text-white text-xs font-medium rounded-lg cursor-pointer"
              >
                Add
              </button>
            </form>
          )}
        </div>

        {/* Departments & Attendance Policy */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-5">
          <div>
            <div className="flex items-center gap-2 font-display font-semibold text-slate-900 mb-3">
              <Building2 className="w-4 h-4 text-blue-700" />
              <span>Departments &amp; Attendance Rules</span>
            </div>
            <div className="flex flex-wrap gap-2 mb-3">
              {departments.map((d) => (
                <span key={d.department_id} className="text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-md px-2.5 py-1">
                  {d.name} ({d.code})
                </span>
              ))}
            </div>
            {isAdmin && (
              <form onSubmit={addDept} className="flex items-center gap-2">
                <input
                  type="text"
                  required
                  value={deptName}
                  onChange={(e) => setDeptName(e.target.value)}
                  placeholder="New Department"
                  className="flex-1 px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
                <input
                  type="text"
                  required
                  value={deptCode}
                  onChange={(e) => setDeptCode(e.target.value)}
                  placeholder="Code"
                  className="w-20 px-3 py-2 text-xs font-mono uppercase border border-slate-300 rounded-lg"
                />
                <button
                  type="submit"
                  className="px-3.5 py-2 bg-slate-900 text-white text-xs font-medium rounded-lg cursor-pointer"
                >
                  Add
                </button>
              </form>
            )}
          </div>

          {settings && isAdmin && (
            <form onSubmit={savePolicy} className="pt-4 border-t border-slate-200 space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">Grace (mins)</label>
                  <input
                    type="number"
                    value={settings.grace_period_minutes}
                    onChange={(e) =>
                      setSettings({ ...settings, grace_period_minutes: Number(e.target.value) })
                    }
                    className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">Half-Day (hrs)</label>
                  <input
                    type="number"
                    step="0.5"
                    value={settings.half_day_hours}
                    onChange={(e) =>
                      setSettings({ ...settings, half_day_hours: Number(e.target.value) })
                    }
                    className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">Full-Day (hrs)</label>
                  <input
                    type="number"
                    step="0.5"
                    value={settings.full_day_hours}
                    onChange={(e) =>
                      setSettings({ ...settings, full_day_hours: Number(e.target.value) })
                    }
                    className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-lg"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between pt-1">
                <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(settings.require_geofence)}
                    onChange={(e) =>
                      setSettings({ ...settings, require_geofence: e.target.checked ? 1 : 0 })
                    }
                  />
                  <span>Enforce office geofence radius on check-in</span>
                </label>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-blue-700 text-white text-xs font-medium rounded-lg cursor-pointer"
                >
                  Save Rules
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

// -----------------------------------------------------------------------------
// 3. PAYROLL ATTENDANCE SUMMARY & REPORTS
// -----------------------------------------------------------------------------
export const ReportsView: React.FC<{ currentUser: AuthUser }> = ({ currentUser }) => {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [rows, setRows] = useState<PayrollRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    apiFetch<{ summary: PayrollRow[] }>(`/api/reports/payroll?month=${month}`)
      .then((res) => setRows(res.summary))
      .finally(() => setLoading(false));
  }, [month]);

  const exportCsv = () => {
    const header = [
      'Employee ID',
      'Employee Name',
      'Department',
      'Present',
      'Late',
      'Half-Days',
      'WFH',
      'Paid Leave',
      'Unpaid Leave (LOP)',
      'Payable Days',
      'Total Hours',
    ];
    const lines = rows.map((r) => {
      const payable = r.present_days + r.wfh_days + r.paid_leave_days + r.half_days * 0.5;
      return [
        r.employee_id,
        `"${r.employee_name}"`,
        `"${r.department_name || ''}"`,
        r.present_days,
        r.late_days,
        r.half_days,
        r.wfh_days,
        r.paid_leave_days,
        r.unpaid_leave_days,
        payable,
        r.total_hours,
      ].join(',');
    });
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `smartattend-payroll-${currentUser.companyId}-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl font-semibold text-slate-900">
            Payroll Attendance Summary &amp; Reports
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Tenant-isolated monthly attendance, paid/unpaid leave calculations, and payable days for{' '}
            <span className="font-medium text-slate-900">{currentUser.companyName}</span>.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white font-mono"
          />
          <button
            type="button"
            onClick={exportCsv}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium rounded-lg cursor-pointer whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-600">
            <tr>
              <th className="py-3 px-4 font-medium">Employee ID</th>
              <th className="py-3 px-4 font-medium">Employee</th>
              <th className="py-3 px-4 font-medium text-right">Present</th>
              <th className="py-3 px-4 font-medium text-right">Late</th>
              <th className="py-3 px-4 font-medium text-right">Half-Day</th>
              <th className="py-3 px-4 font-medium text-right">WFH</th>
              <th className="py-3 px-4 font-medium text-right">Paid Leave</th>
              <th className="py-3 px-4 font-medium text-right">LOP</th>
              <th className="py-3 px-4 font-medium text-right">Payable Days</th>
              <th className="py-3 px-4 font-medium text-right">Total Hours</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {loading ? (
              <tr>
                <td colSpan={10} className="py-8 px-4 text-center text-slate-500">
                  Calculating payroll summary...
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const payable = r.present_days + r.wfh_days + r.paid_leave_days + r.half_days * 0.5;
                return (
                  <tr key={r.employee_record_id} className="hover:bg-slate-50/70">
                    <td className="py-3 px-4 font-mono text-xs font-semibold text-slate-900">
                      {r.employee_id}
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-medium text-slate-900">{r.employee_name}</div>
                      <div className="text-xs text-slate-500">{r.department_name || r.designation}</div>
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-xs tabular-nums">{r.present_days}</td>
                    <td className="py-3 px-4 text-right font-mono text-xs tabular-nums text-amber-700">{r.late_days}</td>
                    <td className="py-3 px-4 text-right font-mono text-xs tabular-nums">{r.half_days}</td>
                    <td className="py-3 px-4 text-right font-mono text-xs tabular-nums">{r.wfh_days}</td>
                    <td className="py-3 px-4 text-right font-mono text-xs tabular-nums text-emerald-700">
                      {r.paid_leave_days}
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-xs tabular-nums text-red-700">
                      {r.unpaid_leave_days}
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-xs font-semibold text-slate-900 tabular-nums">
                      {payable}
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-xs text-slate-700 tabular-nums">
                      {r.total_hours}h
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// -----------------------------------------------------------------------------
// 4. NOTIFICATIONS & SECURITY AUDIT LOGS
// -----------------------------------------------------------------------------
export const SecurityNotificationsView: React.FC<{ currentUser: AuthUser }> = ({ currentUser }) => {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);
  const canViewAudit = ['Super Admin', 'Company Admin', 'HR'].includes(currentUser.role);

  const loadAll = async () => {
    const ntf = await apiFetch<{ notifications: NotificationItem[] }>('/api/notifications');
    setNotifications(ntf.notifications);
    if (canViewAudit) {
      const aud = await apiFetch<{ logs: AuditLogItem[] }>('/api/audit-logs');
      setAuditLogs(aud.logs);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const markAllRead = async () => {
    await apiFetch('/api/notifications/read-all', { method: 'POST' });
    await loadAll();
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-2xl font-semibold text-slate-900">
          Notifications &amp; Security Audit Trail
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Workspace reminders, account lifecycle events, and tenant-isolation security logs.
        </p>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-display font-semibold text-slate-900">
            <Bell className="w-4 h-4 text-blue-700" />
            <span>Notifications</span>
          </div>
          {notifications.some((n) => n.is_read === 0) && (
            <button
              type="button"
              onClick={markAllRead}
              className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline cursor-pointer"
            >
              <CheckCheck className="w-3.5 h-3.5" />
              <span>Mark All Read</span>
            </button>
          )}
        </div>
        {notifications.length === 0 ? (
          <p className="text-xs text-slate-500">No notifications in your inbox.</p>
        ) : (
          <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg">
            {notifications.map((n) => (
              <div key={n.notification_id} className="p-3.5 flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-slate-900">
                    {n.title}
                    {n.is_read === 0 && <span className="ml-2 text-xs font-semibold text-blue-700">New</span>}
                  </div>
                  <p className="text-xs text-slate-600 mt-0.5">{n.message}</p>
                </div>
                <span className="text-[11px] font-mono text-slate-400 shrink-0">{n.created_at.slice(0, 10)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {canViewAudit && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex items-center gap-2 font-display font-semibold text-slate-900">
            <ShieldAlert className="w-4 h-4 text-blue-700" />
            <span>Authentication &amp; Multi-Tenant Audit Log</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <tr>
                  <th className="py-2.5 px-4 font-medium">Timestamp</th>
                  <th className="py-2.5 px-4 font-medium">Actor</th>
                  <th className="py-2.5 px-4 font-medium">Event</th>
                  <th className="py-2.5 px-4 font-medium">Outcome</th>
                  <th className="py-2.5 px-4 font-medium">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {auditLogs.map((l) => (
                  <tr key={l.log_id}>
                    <td className="py-2.5 px-4 font-mono text-slate-500 whitespace-nowrap">
                      {l.created_at.slice(0, 19).replace('T', ' ')}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-slate-900">{l.actor_username || 'system'}</td>
                    <td className="py-2.5 px-4 font-mono font-medium text-slate-800">{l.action}</td>
                    <td className="py-2.5 px-4 font-medium">
                      <span
                        className={
                          l.outcome === 'success'
                            ? 'text-emerald-700'
                            : l.outcome === 'denied'
                              ? 'text-red-700'
                              : 'text-amber-700'
                        }
                      >
                        {l.outcome}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-slate-600">{l.details || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
