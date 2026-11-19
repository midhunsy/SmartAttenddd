import React, { useEffect, useState } from 'react';
import {
  Calendar,
  Clock,
  Coffee,
  LogIn,
  LogOut,
  MapPin,
  Navigation,
} from 'lucide-react';
import { ApiError, apiFetch } from '../api';
import type {
  AttendanceRecord,
  AuthUser,
  OfficeLocation,
  RegularizationRequest,
  Shift,
} from '../types';

interface AttendanceModuleProps {
  currentUser: AuthUser;
}

export const AttendanceModule: React.FC<AttendanceModuleProps> = ({ currentUser }) => {
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [assignedLocation, setAssignedLocation] = useState<OfficeLocation | null>(null);
  const [assignedShift, setAssignedShift] = useState<Shift | null>(null);
  const [regRequests, setRegRequests] = useState<RegularizationRequest[]>([]);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [scope, setScope] = useState<'all' | 'mine'>(
    ['Company Admin', 'HR', 'HOD', 'Manager', 'Responsible Person'].includes(currentUser.role) ? 'all' : 'mine'
  );
  const [viewMode, setViewMode] = useState<'table' | 'calendar' | 'regularization'>('table');
  const [loading, setLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // GPS Coordinates (default to assigned office when loaded)
  const [lat, setLat] = useState<string>('37.7897');
  const [lng, setLng] = useState<string>('-122.3972');
  const [gpsSource, setGpsSource] = useState<'office' | 'outside' | 'device'>('office');

  // Regularization form
  const [regDate, setRegDate] = useState(new Date().toISOString().slice(0, 10));
  const [regIn, setRegIn] = useState('09:00');
  const [regOut, setRegOut] = useState('18:00');
  const [regReason, setRegReason] = useState('');

  const isApprover = ['Company Admin', 'HR', 'HOD', 'Manager', 'Responsible Person'].includes(currentUser.role);

  const loadAttendance = async () => {
    setLoading(true);
    try {
      const [attRes, regRes] = await Promise.all([
        apiFetch<{
          records: AttendanceRecord[];
          assignedLocation: OfficeLocation | null;
          assignedShift: Shift | null;
        }>(`/api/attendance?month=${month}&scope=${scope}`),
        apiFetch<{ requests: RegularizationRequest[] }>('/api/regularizations'),
      ]);
      setRecords(attRes.records);
      setAssignedLocation(attRes.assignedLocation);
      setAssignedShift(attRes.assignedShift);
      setRegRequests(regRes.requests);
      if (attRes.assignedLocation && gpsSource === 'office') {
        setLat(String(attRes.assignedLocation.latitude));
        setLng(String(attRes.assignedLocation.longitude));
      }
    } catch (err) {
      setActionMsg({ type: 'err', text: err instanceof ApiError ? err.message : 'Unable to load attendance.' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAttendance();
  }, [month, scope]);

  const todayStr = new Date().toISOString().slice(0, 10);
  const myTodayRecord = records.find(
    (r) => r.employee_record_id === currentUser.employeeRecordId && r.attendance_date === todayStr
  );

  const selectCoordPreset = (preset: 'office' | 'outside' | 'device') => {
    setGpsSource(preset);
    if (preset === 'office' && assignedLocation) {
      setLat(String(assignedLocation.latitude));
      setLng(String(assignedLocation.longitude));
    } else if (preset === 'outside' && assignedLocation) {
      setLat((assignedLocation.latitude + 0.025).toFixed(4));
      setLng((assignedLocation.longitude + 0.025).toFixed(4));
    } else if (preset === 'device' && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setLat(pos.coords.latitude.toFixed(6));
          setLng(pos.coords.longitude.toFixed(6));
        },
        () => {
          setActionMsg({ type: 'err', text: 'Browser geolocation unavailable. Using manual coordinates.' });
        }
      );
    }
  };

  const handleCheckIn = async () => {
    setActionMsg(null);
    try {
      const res = await apiFetch<{ geofenceStatus: string; isLate: boolean; lateMinutes: number }>(
        '/api/attendance/check-in',
        {
          method: 'POST',
          body: JSON.stringify({ latitude: Number(lat), longitude: Number(lng) }),
        }
      );
      setActionMsg({
        type: 'ok',
        text: `Checked in (${res.geofenceStatus})${res.isLate ? ` · Late by ${res.lateMinutes} min` : ' · On time'}.`,
      });
      await loadAttendance();
    } catch (err) {
      setActionMsg({ type: 'err', text: err instanceof ApiError ? err.message : 'Check-in failed.' });
    }
  };

  const handleBreakToggle = async () => {
    setActionMsg(null);
    try {
      const res = await apiFetch<{ onBreak: boolean; breakMinutes: number }>('/api/attendance/break', {
        method: 'POST',
      });
      setActionMsg({
        type: 'ok',
        text: res.onBreak ? 'Break timer started.' : `Break ended. Total break time: ${res.breakMinutes} mins.`,
      });
      await loadAttendance();
    } catch (err) {
      setActionMsg({ type: 'err', text: err instanceof ApiError ? err.message : 'Unable to update break.' });
    }
  };

  const handleCheckOut = async () => {
    setActionMsg(null);
    try {
      const res = await apiFetch<{ workingHours: number; status: string }>('/api/attendance/check-out', {
        method: 'POST',
        body: JSON.stringify({ latitude: Number(lat), longitude: Number(lng) }),
      });
      setActionMsg({
        type: 'ok',
        text: `Checked out · Working hours: ${res.workingHours}h · Status: ${res.status}.`,
      });
      await loadAttendance();
    } catch (err) {
      setActionMsg({ type: 'err', text: err instanceof ApiError ? err.message : 'Check-out failed.' });
    }
  };

  const handleRegularizationSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionMsg(null);
    try {
      await apiFetch('/api/regularizations', {
        method: 'POST',
        body: JSON.stringify({
          attendanceDate: regDate,
          requestedCheckIn: regIn,
          requestedCheckOut: regOut,
          reason: regReason,
        }),
      });
      setRegReason('');
      setActionMsg({ type: 'ok', text: 'Attendance regularization request submitted.' });
      await loadAttendance();
    } catch (err) {
      setActionMsg({ type: 'err', text: err instanceof ApiError ? err.message : 'Submission failed.' });
    }
  };

  const handleRegAction = async (regId: string, decision: 'approve' | 'reject') => {
    try {
      await apiFetch(`/api/regularizations/${regId}/action`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      await loadAttendance();
    } catch (err) {
      setActionMsg({ type: 'err', text: err instanceof ApiError ? err.message : 'Action failed.' });
    }
  };

  // Calendar grid helper
  const calendarDays = (() => {
    const [yr, mo] = month.split('-').map(Number);
    const daysInMonth = new Date(yr, mo, 0).getDate();
    return Array.from({ length: daysInMonth }, (_, i) => {
      const d = `${month}-${String(i + 1).padStart(2, '0')}`;
      const rec = records.find(
        (r) =>
          r.attendance_date === d &&
          (scope === 'mine' || r.employee_record_id === currentUser.employeeRecordId)
      );
      return { date: d, dayNum: i + 1, rec };
    });
  })();

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl font-semibold text-slate-900">
            Attendance, GPS &amp; Geofencing
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Verify geofenced check-in/out, track shift breaks, and manage attendance regularizations.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white font-mono"
          />
          {isApprover && (
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              <button
                type="button"
                onClick={() => setScope('all')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
                  scope === 'all' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                Company
              </button>
              <button
                type="button"
                onClick={() => setScope('mine')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
                  scope === 'mine' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                My Logs
              </button>
            </div>
          )}
        </div>
      </div>

      {actionMsg && (
        <div
          role={actionMsg.type === 'err' ? 'alert' : 'status'}
          className={`p-3.5 rounded-lg border text-sm ${
            actionMsg.type === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-red-50 border-red-200 text-red-900'
          }`}
        >
          {actionMsg.text}
        </div>
      )}

      {/* GPS Check-In / Check-Out Console */}
      {currentUser.employeeRecordId && (
        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <MapPin className="w-4 h-4 text-blue-700" />
                <span>Today&apos;s Shift &amp; Geofence Check-In</span>
              </div>
              <p className="text-xs text-slate-600">
                Assigned Office:{' '}
                <span className="font-medium text-slate-900">
                  {assignedLocation ? `${assignedLocation.name} (${assignedLocation.radius_meters}m radius)` : 'Default Geofence'}
                </span>
                {' · '}
                Shift:{' '}
                <span className="font-medium text-slate-900 font-mono">
                  {assignedShift ? `${assignedShift.name} (${assignedShift.start_time}–${assignedShift.end_time})` : '09:00–18:00'}
                </span>
              </p>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-xs text-slate-500">Coordinates:</span>
                <button
                  type="button"
                  onClick={() => selectCoordPreset('office')}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md border cursor-pointer ${
                    gpsSource === 'office'
                      ? 'bg-blue-50 border-blue-200 text-blue-800'
                      : 'bg-white border-slate-200 text-slate-700'
                  }`}
                >
                  Inside Office Geofence
                </button>
                <button
                  type="button"
                  onClick={() => selectCoordPreset('outside')}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md border cursor-pointer ${
                    gpsSource === 'outside'
                      ? 'bg-amber-50 border-amber-200 text-amber-800'
                      : 'bg-white border-slate-200 text-slate-700'
                  }`}
                >
                  Test Outside Geofence
                </button>
                <button
                  type="button"
                  onClick={() => selectCoordPreset('device')}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md border cursor-pointer ${
                    gpsSource === 'device'
                      ? 'bg-blue-50 border-blue-200 text-blue-800'
                      : 'bg-white border-slate-200 text-slate-700'
                  }`}
                >
                  <Navigation className="w-3 h-3" />
                  <span>Use Device GPS</span>
                </button>
                <span className="text-xs font-mono text-slate-500 tabular-nums">
                  {lat}, {lng}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 shrink-0">
              {!myTodayRecord && (
                <button
                  type="button"
                  onClick={handleCheckIn}
                  className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-700 hover:bg-blue-800 text-white text-sm font-medium rounded-lg cursor-pointer whitespace-nowrap"
                >
                  <LogIn className="w-4 h-4" />
                  <span>GPS Check In</span>
                </button>
              )}

              {myTodayRecord && !myTodayRecord.check_out_time && (
                <>
                  <div className="text-xs text-slate-600 pr-2">
                    <div>
                      Checked in:{' '}
                      <span className="font-mono font-semibold text-slate-900">
                        {myTodayRecord.check_in_time?.slice(11, 16)} UTC
                      </span>
                    </div>
                    <div>
                      Breaks: <span className="font-mono">{myTodayRecord.break_minutes}m</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleBreakToggle}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2.5 border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-sm font-medium rounded-lg cursor-pointer whitespace-nowrap"
                  >
                    <Coffee className="w-4 h-4" />
                    <span>{myTodayRecord.active_break_start ? 'End Break' : 'Start Break'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleCheckOut}
                    className="inline-flex items-center gap-2 px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium rounded-lg cursor-pointer whitespace-nowrap"
                  >
                    <LogOut className="w-4 h-4" />
                    <span>GPS Check Out</span>
                  </button>
                </>
              )}

              {myTodayRecord && myTodayRecord.check_out_time && (
                <div className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700">
                  Shift Completed ·{' '}
                  <span className="font-mono font-semibold text-slate-900">
                    {myTodayRecord.working_hours}h
                  </span>{' '}
                  · {myTodayRecord.status}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Sub-navigation Tabs */}
      <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg w-fit">
        <button
          type="button"
          onClick={() => setViewMode('table')}
          className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
            viewMode === 'table' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
          }`}
        >
          <Clock className="w-3.5 h-3.5" />
          <span>Attendance Log</span>
        </button>
        <button
          type="button"
          onClick={() => setViewMode('calendar')}
          className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
            viewMode === 'calendar' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
          }`}
        >
          <Calendar className="w-3.5 h-3.5" />
          <span>Monthly Calendar</span>
        </button>
        <button
          type="button"
          onClick={() => setViewMode('regularization')}
          className={`px-3.5 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
            viewMode === 'regularization' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
          }`}
        >
          Regularization ({regRequests.length})
        </button>
      </div>

      {viewMode === 'table' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-600">
              <tr>
                <th className="py-3 px-4 font-medium">Date</th>
                <th className="py-3 px-4 font-medium">Employee</th>
                <th className="py-3 px-4 font-medium">Check In</th>
                <th className="py-3 px-4 font-medium">Check Out</th>
                <th className="py-3 px-4 font-medium">Geofence</th>
                <th className="py-3 px-4 font-medium text-right">Hours</th>
                <th className="py-3 px-4 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-8 px-4 text-center text-slate-500">
                    Loading attendance logs...
                  </td>
                </tr>
              ) : records.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 px-4 text-center text-slate-500">
                    No attendance records for {month}.
                  </td>
                </tr>
              ) : (
                records.map((r) => (
                  <tr key={r.attendance_id} className="hover:bg-slate-50/70">
                    <td className="py-3 px-4 font-mono text-xs text-slate-900 tabular-nums whitespace-nowrap">
                      {r.attendance_date}
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-medium text-slate-900">{r.employee_name}</div>
                      <div className="text-xs font-mono text-slate-500">{r.employee_id}</div>
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-700 tabular-nums">
                      {r.check_in_time ? r.check_in_time.slice(11, 16) : '—'}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-700 tabular-nums">
                      {r.check_out_time ? r.check_out_time.slice(11, 16) : '—'}
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-600">
                      {r.geofence_status || '—'}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-900 text-right tabular-nums">
                      {r.working_hours ? `${r.working_hours}h` : '—'}
                    </td>
                    <td className="py-3 px-4 text-xs font-medium whitespace-nowrap">
                      <span
                        className={
                          r.status.includes('Late') || r.status === 'Half-Day'
                            ? 'text-amber-700'
                            : 'text-emerald-700'
                        }
                      >
                        {r.status}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {viewMode === 'calendar' && (
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-2.5">
            {calendarDays.map((d) => (
              <div
                key={d.date}
                className="p-3 border border-slate-200 rounded-lg bg-slate-50/40 min-h-[82px] flex flex-col justify-between"
              >
                <div className="flex items-center justify-between text-xs">
                  <span className="font-mono font-semibold text-slate-800">{d.dayNum}</span>
                  <span className="text-[11px] text-slate-400">{d.date.slice(5)}</span>
                </div>
                <div className="mt-2 text-xs">
                  {d.rec ? (
                    <>
                      <div
                        className={`font-medium ${
                          d.rec.is_late || d.rec.is_half_day ? 'text-amber-700' : 'text-emerald-700'
                        }`}
                      >
                        {d.rec.status}
                      </div>
                      <div className="text-[11px] font-mono text-slate-500 mt-0.5">
                        {d.rec.working_hours ? `${d.rec.working_hours}h` : 'Active'}
                      </div>
                    </>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {viewMode === 'regularization' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <form
            onSubmit={handleRegularizationSubmit}
            className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 h-fit"
          >
            <h3 className="font-display text-base font-semibold text-slate-900">
              Submit Regularization
            </h3>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Attendance Date</label>
              <input
                type="date"
                required
                value={regDate}
                onChange={(e) => setRegDate(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Check In</label>
                <input
                  type="time"
                  required
                  value={regIn}
                  onChange={(e) => setRegIn(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Check Out</label>
                <input
                  type="time"
                  required
                  value={regOut}
                  onChange={(e) => setRegOut(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Reason</label>
              <textarea
                rows={3}
                required
                value={regReason}
                onChange={(e) => setRegReason(e.target.value)}
                placeholder="Explain missed punch or GPS variance..."
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <button
              type="submit"
              className="w-full py-2.5 px-4 bg-blue-700 hover:bg-blue-800 text-white text-sm font-medium rounded-lg cursor-pointer"
            >
              Request Regularization
            </button>
          </form>

          <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-600">
                <tr>
                  <th className="py-3 px-4 font-medium">Employee</th>
                  <th className="py-3 px-4 font-medium">Date &amp; Requested Time</th>
                  <th className="py-3 px-4 font-medium">Reason</th>
                  <th className="py-3 px-4 font-medium">Status</th>
                  {isApprover && <th className="py-3 px-4 font-medium text-right">Action</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {regRequests.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 px-4 text-center text-slate-500">
                      No regularization requests found.
                    </td>
                  </tr>
                ) : (
                  regRequests.map((req) => (
                    <tr key={req.reg_id}>
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-900">{req.employee_name}</div>
                        <div className="text-xs font-mono text-slate-500">{req.employee_id}</div>
                      </td>
                      <td className="py-3 px-4 font-mono text-xs text-slate-700">
                        <div>{req.attendance_date}</div>
                        <div className="text-slate-500">
                          {req.requested_check_in} – {req.requested_check_out}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600 max-w-xs">{req.reason}</td>
                      <td className="py-3 px-4 text-xs font-medium">
                        <span
                          className={
                            req.status === 'Approved'
                              ? 'text-emerald-700'
                              : req.status === 'Rejected'
                                ? 'text-red-700'
                                : 'text-amber-700'
                          }
                        >
                          {req.status}
                        </span>
                      </td>
                      {isApprover && (
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          {req.status === 'Pending' ? (
                            <div className="inline-flex gap-2">
                              <button
                                type="button"
                                onClick={() => handleRegAction(req.reg_id, 'approve')}
                                className="px-2.5 py-1 text-xs font-medium text-emerald-700 border border-emerald-200 hover:bg-emerald-50 rounded cursor-pointer"
                              >
                                Approve
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRegAction(req.reg_id, 'reject')}
                                className="px-2.5 py-1 text-xs font-medium text-red-700 border border-red-200 hover:bg-red-50 rounded cursor-pointer"
                              >
                                Reject
                              </button>
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400">Reviewed</span>
                          )}
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
