import React, { useEffect, useState } from 'react';
import { ApiError, apiFetch } from '../api';
import type { AuthUser, LeaveApplication, LeaveBalance, WfhRequest } from '../types';

interface LeaveModuleProps {
  currentUser: AuthUser;
}

export const LeaveModule: React.FC<LeaveModuleProps> = ({ currentUser }) => {
  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  const [applications, setApplications] = useState<LeaveApplication[]>([]);
  const [wfhRequests, setWfhRequests] = useState<WfhRequest[]>([]);
  const [tab, setTab] = useState<'leaves' | 'wfh'>('leaves');
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Leave form
  const [leaveType, setLeaveType] = useState('Annual Leave');
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10));
  const [dayMode, setDayMode] = useState('Full Day');
  const [reason, setReason] = useState('');

  // WFH form
  const [wfhDate, setWfhDate] = useState(new Date().toISOString().slice(0, 10));
  const [wfhReason, setWfhReason] = useState('');

  const isApprover = ['Company Admin', 'HR', 'HOD', 'Manager', 'Responsible Person'].includes(currentUser.role);

  const loadData = async () => {
    setLoading(true);
    try {
      const [lvRes, wfhRes] = await Promise.all([
        apiFetch<{ balances: LeaveBalance[]; applications: LeaveApplication[] }>('/api/leaves'),
        apiFetch<{ requests: WfhRequest[] }>('/api/wfh'),
      ]);
      setBalances(lvRes.balances);
      setApplications(lvRes.applications);
      setWfhRequests(wfhRes.requests);
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof ApiError ? err.message : 'Unable to load leave records.' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleLeaveSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      const res = await apiFetch<{ isPaid: boolean; daysCount: number; status: string }>('/api/leaves', {
        method: 'POST',
        body: JSON.stringify({ leaveType, startDate, endDate, dayMode, reason }),
      });
      setReason('');
      setMsg({
        type: 'ok',
        text: `Leave submitted (${res.daysCount} day(s) · ${res.isPaid ? 'Paid' : 'Unpaid / LOP'} · ${res.status}).`,
      });
      await loadData();
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof ApiError ? err.message : 'Leave submission failed.' });
    }
  };

  const handleLeaveAction = async (leaveId: string, decision: 'approve' | 'reject') => {
    setMsg(null);
    try {
      const res = await apiFetch<{ status: string }>(`/api/leaves/${leaveId}/action`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      setMsg({ type: 'ok', text: `Leave application updated to ${res.status}.` });
      await loadData();
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof ApiError ? err.message : 'Action failed.' });
    }
  };

  const handleWfhSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      await apiFetch('/api/wfh', {
        method: 'POST',
        body: JSON.stringify({ wfhDate, reason: wfhReason }),
      });
      setWfhReason('');
      setMsg({ type: 'ok', text: 'Work From Home request submitted.' });
      await loadData();
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof ApiError ? err.message : 'WFH request failed.' });
    }
  };

  const handleWfhAction = async (wfhId: string, decision: 'approve' | 'reject') => {
    try {
      await apiFetch(`/api/wfh/${wfhId}/action`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      await loadData();
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof ApiError ? err.message : 'Action failed.' });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl font-semibold text-slate-900">
            Leave &amp; Work-From-Home Management
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Track paid/unpaid leave balances, advance &amp; half-day applications, and multi-level approvals.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start sm:self-auto">
          <button
            type="button"
            onClick={() => setTab('leaves')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
              tab === 'leaves' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
            }`}
          >
            Leave Requests ({applications.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('wfh')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
              tab === 'wfh' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
            }`}
          >
            Work From Home ({wfhRequests.length})
          </button>
        </div>
      </div>

      {msg && (
        <div
          role={msg.type === 'err' ? 'alert' : 'status'}
          className={`p-3.5 rounded-lg border text-sm ${
            msg.type === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-red-50 border-red-200 text-red-900'
          }`}
        >
          {msg.text}
        </div>
      )}

      {/* Leave Balances Strip */}
      {balances.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {balances.map((b) => {
            const avail = Number((b.total_days - b.used_days).toFixed(1));
            return (
              <div key={b.balance_id} className="bg-white border border-slate-200 rounded-xl p-5">
                <div className="text-xs font-medium text-slate-500">{b.leave_type} · {b.year}</div>
                <div className="mt-2 flex items-baseline justify-between">
                  <span className="font-display text-2xl font-semibold text-slate-900 tabular-nums">
                    {avail} <span className="text-sm font-normal text-slate-500">days available</span>
                  </span>
                  <span className="text-xs font-mono text-slate-500 tabular-nums">
                    {b.used_days} / {b.total_days} used
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab === 'leaves' ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <form
            onSubmit={handleLeaveSubmit}
            className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 h-fit"
          >
            <h3 className="font-display text-base font-semibold text-slate-900">Apply for Leave</h3>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Leave Type</label>
              <select
                value={leaveType}
                onChange={(e) => setLeaveType(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option>Annual Leave</option>
                <option>Sick Leave</option>
                <option>Casual Leave</option>
                <option>Unpaid Leave (LOP)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Duration Mode</label>
              <select
                value={dayMode}
                onChange={(e) => setDayMode(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option>Full Day</option>
                <option>Half Day</option>
                <option>Early Leave</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Start Date</label>
                <input
                  type="date"
                  required
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">End Date</label>
                <input
                  type="date"
                  required
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Reason</label>
              <textarea
                rows={3}
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Provide details for L1/L2 approval..."
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <button
              type="submit"
              className="w-full py-2.5 px-4 bg-blue-700 hover:bg-blue-800 text-white text-sm font-medium rounded-lg cursor-pointer"
            >
              Submit Leave Application
            </button>
          </form>

          <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-600">
                <tr>
                  <th className="py-3 px-4 font-medium">Employee</th>
                  <th className="py-3 px-4 font-medium">Leave Details</th>
                  <th className="py-3 px-4 font-medium">Dates &amp; Days</th>
                  <th className="py-3 px-4 font-medium">Approval Stage</th>
                  {isApprover && <th className="py-3 px-4 font-medium text-right">Action</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {loading ? (
                  <tr>
                    <td colSpan={5} className="py-8 px-4 text-center text-slate-500">
                      Loading leave queue...
                    </td>
                  </tr>
                ) : applications.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 px-4 text-center text-slate-500">
                      No leave applications recorded.
                    </td>
                  </tr>
                ) : (
                  applications.map((lv) => (
                    <tr key={lv.leave_id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-900">{lv.employee_name}</div>
                        <div className="text-xs font-mono text-slate-500">{lv.employee_id}</div>
                      </td>
                      <td className="py-3 px-4 text-xs">
                        <div className="font-medium text-slate-900">
                          {lv.leave_type} · {lv.is_paid ? 'Paid' : 'Unpaid (LOP)'}
                        </div>
                        <div className="text-slate-500 max-w-xs truncate">{lv.reason}</div>
                      </td>
                      <td className="py-3 px-4 font-mono text-xs text-slate-700 tabular-nums">
                        <div>
                          {lv.start_date} → {lv.end_date}
                        </div>
                        <div className="text-slate-500">
                          {lv.days_count}d · {lv.day_mode}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-xs font-medium">
                        <span
                          className={
                            lv.status === 'Approved'
                              ? 'text-emerald-700'
                              : lv.status === 'Rejected'
                                ? 'text-red-700'
                                : 'text-amber-700'
                          }
                        >
                          {lv.status}
                        </span>
                      </td>
                      {isApprover && (
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          {lv.status.startsWith('Pending') ? (
                            <div className="inline-flex gap-2">
                              <button
                                type="button"
                                onClick={() => handleLeaveAction(lv.leave_id, 'approve')}
                                className="px-2.5 py-1 text-xs font-medium text-emerald-700 border border-emerald-200 hover:bg-emerald-50 rounded cursor-pointer"
                              >
                                Approve
                              </button>
                              <button
                                type="button"
                                onClick={() => handleLeaveAction(lv.leave_id, 'reject')}
                                className="px-2.5 py-1 text-xs font-medium text-red-700 border border-red-200 hover:bg-red-50 rounded cursor-pointer"
                              >
                                Reject
                              </button>
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400">Finalized</span>
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
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <form
            onSubmit={handleWfhSubmit}
            className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 h-fit"
          >
            <h3 className="font-display text-base font-semibold text-slate-900">Request Work From Home</h3>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">WFH Date</label>
              <input
                type="date"
                required
                value={wfhDate}
                onChange={(e) => setWfhDate(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Deliverables / Reason</label>
              <textarea
                rows={3}
                required
                value={wfhReason}
                onChange={(e) => setWfhReason(e.target.value)}
                placeholder="Outline remote work plan..."
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <button
              type="submit"
              className="w-full py-2.5 px-4 bg-blue-700 hover:bg-blue-800 text-white text-sm font-medium rounded-lg cursor-pointer"
            >
              Submit WFH Request
            </button>
          </form>

          <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-600">
                <tr>
                  <th className="py-3 px-4 font-medium">Employee</th>
                  <th className="py-3 px-4 font-medium">Date</th>
                  <th className="py-3 px-4 font-medium">Reason</th>
                  <th className="py-3 px-4 font-medium">Status</th>
                  {isApprover && <th className="py-3 px-4 font-medium text-right">Action</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {wfhRequests.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 px-4 text-center text-slate-500">
                      No Work-From-Home requests found.
                    </td>
                  </tr>
                ) : (
                  wfhRequests.map((w) => (
                    <tr key={w.wfh_id}>
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-900">{w.employee_name}</div>
                        <div className="text-xs font-mono text-slate-500">{w.employee_id}</div>
                      </td>
                      <td className="py-3 px-4 font-mono text-xs text-slate-700">{w.wfh_date}</td>
                      <td className="py-3 px-4 text-xs text-slate-600 max-w-xs">{w.reason}</td>
                      <td className="py-3 px-4 text-xs font-medium">
                        <span
                          className={
                            w.status === 'Approved'
                              ? 'text-emerald-700'
                              : w.status === 'Rejected'
                                ? 'text-red-700'
                                : 'text-amber-700'
                          }
                        >
                          {w.status}
                        </span>
                      </td>
                      {isApprover && (
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          {w.status === 'Pending' ? (
                            <div className="inline-flex gap-2">
                              <button
                                type="button"
                                onClick={() => handleWfhAction(w.wfh_id, 'approve')}
                                className="px-2.5 py-1 text-xs font-medium text-emerald-700 border border-emerald-200 hover:bg-emerald-50 rounded cursor-pointer"
                              >
                                Approve
                              </button>
                              <button
                                type="button"
                                onClick={() => handleWfhAction(w.wfh_id, 'reject')}
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
