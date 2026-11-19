import React, { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Edit3,
  Plus,
  RefreshCw,
  Search,
  UserCheck,
  UserX,
  X,
} from 'lucide-react';
import { ApiError, apiFetch } from '../api';
import type {
  AuthUser,
  Department,
  EmployeeRow,
  OfficeLocation,
  Shift,
  UserRole,
} from '../types';

interface EmployeeManagementProps {
  currentUser: AuthUser;
}

interface OrgOptions {
  departments: Department[];
  locations: OfficeLocation[];
  shifts: Shift[];
  managers: Array<{ employee_record_id: string; employee_id: string; employee_name: string; role_name: string }>;
}

export const EmployeeManagement: React.FC<EmployeeManagementProps> = ({ currentUser }) => {
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [orgOptions, setOrgOptions] = useState<OrgOptions>({
    departments: [],
    locations: [],
    shifts: [],
    managers: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');

  const [createdBanner, setCreatedBanner] = useState<{
    employeeId: string;
    username: string;
    employeeName: string;
  } | null>(null);

  const [modalMode, setModalMode] = useState<'create' | 'edit' | null>(null);
  const [editingRow, setEditingRow] = useState<EmployeeRow | null>(null);

  // Form state
  const [employeeName, setEmployeeName] = useState('');
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [designation, setDesignation] = useState('');
  const [reportingManagerId, setReportingManagerId] = useState('');
  const [hodId, setHodId] = useState('');
  const [joiningDate, setJoiningDate] = useState(new Date().toISOString().slice(0, 10));
  const [employmentType, setEmploymentType] = useState('Full-Time');
  const [officeLocationId, setOfficeLocationId] = useState('');
  const [assignedShiftId, setAssignedShiftId] = useState('');
  const [employmentStatus, setEmploymentStatus] = useState('active');
  const [profilePicture, setProfilePicture] = useState('');
  const [roleName, setRoleName] = useState<UserRole>('Employee');

  // Credentials (only on create)
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [forcePasswordChange, setForcePasswordChange] = useState(true);
  const [usernameCheck, setUsernameCheck] = useState<{ checking: boolean; available?: boolean; reason?: string | null }>({
    checking: false,
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const canManage = currentUser.role === 'Company Admin' || currentUser.role === 'HR';

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [empRes, orgRes] = await Promise.all([
        apiFetch<{ employees: EmployeeRow[] }>('/api/employees'),
        apiFetch<OrgOptions>('/api/org-options'),
      ]);
      setEmployees(empRes.employees);
      setOrgOptions(orgRes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load employees.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (modalMode !== 'create' || !username.trim() || username.trim().length < 3) {
      setUsernameCheck({ checking: false });
      return;
    }
    const timer = setTimeout(async () => {
      setUsernameCheck({ checking: true });
      try {
        const res = await apiFetch<{ available: boolean; reason: string | null }>(
          `/api/auth/check-username?username=${encodeURIComponent(username.trim())}`
        );
        setUsernameCheck({ checking: false, available: res.available, reason: res.reason });
      } catch {
        setUsernameCheck({ checking: false });
      }
    }, 280);
    return () => clearTimeout(timer);
  }, [username, modalMode]);

  const openCreateModal = () => {
    setModalMode('create');
    setEditingRow(null);
    setEmployeeName('');
    setEmail('');
    setMobile('');
    setDepartmentId(orgOptions.departments[0]?.department_id || '');
    setDesignation('');
    setReportingManagerId(orgOptions.managers[0]?.employee_record_id || '');
    setHodId(orgOptions.managers[0]?.employee_record_id || '');
    setJoiningDate(new Date().toISOString().slice(0, 10));
    setEmploymentType('Full-Time');
    setOfficeLocationId(orgOptions.locations[0]?.location_id || '');
    setAssignedShiftId(orgOptions.shifts[0]?.shift_id || '');
    setEmploymentStatus('active');
    setProfilePicture('');
    setRoleName('Employee');
    setUsername('');
    setPassword('');
    setConfirmPassword('');
    setForcePasswordChange(true);
    setFormError(null);
  };

  const openEditModal = (row: EmployeeRow) => {
    setModalMode('edit');
    setEditingRow(row);
    setEmployeeName(row.employee_name);
    setEmail(row.email);
    setMobile(row.mobile);
    setDepartmentId(row.department_id || '');
    setDesignation(row.designation);
    setReportingManagerId(row.reporting_manager_id || '');
    setHodId(row.hod_id || '');
    setJoiningDate(row.joining_date);
    setEmploymentType(row.employment_type);
    setOfficeLocationId(row.office_location_id || '');
    setAssignedShiftId(row.assigned_shift_id || '');
    setEmploymentStatus(row.employment_status);
    setProfilePicture(row.profile_picture || '');
    setRoleName(row.role_name);
    setFormError(null);
  };

  const handleGeneratePassword = async () => {
    try {
      const res = await apiFetch<{ password: string }>('/api/employees/generate-password', { method: 'POST' });
      setPassword(res.password);
      setConfirmPassword(res.password);
    } catch {
      // ignore
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSaving(true);
    try {
      if (modalMode === 'create') {
        const res = await apiFetch<{
          employee: { employeeId: string; username: string; employeeName: string };
        }>('/api/employees', {
          method: 'POST',
          body: JSON.stringify({
            employeeName,
            email,
            mobile,
            departmentId: departmentId || null,
            designation,
            reportingManagerId: reportingManagerId || null,
            hodId: hodId || null,
            joiningDate,
            employmentType,
            officeLocationId: officeLocationId || null,
            assignedShiftId: assignedShiftId || null,
            employmentStatus,
            profilePicture: profilePicture || null,
            roleName,
            username,
            password,
            confirmPassword,
            forcePasswordChange,
          }),
        });
        setCreatedBanner(res.employee);
      } else if (modalMode === 'edit' && editingRow) {
        await apiFetch(`/api/employees/${editingRow.employee_record_id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            employeeName,
            email,
            mobile,
            departmentId: departmentId || null,
            designation,
            reportingManagerId: reportingManagerId || null,
            hodId: hodId || null,
            employmentType,
            officeLocationId: officeLocationId || null,
            assignedShiftId: assignedShiftId || null,
            employmentStatus,
            roleName,
          }),
        });
      }
      setModalMode(null);
      await loadData();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Unable to save employee record.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleStatus = async (row: EmployeeRow) => {
    const nextStatus = row.account_status === 'active' ? 'inactive' : 'active';
    try {
      await apiFetch(`/api/employees/${row.employee_record_id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: nextStatus }),
      });
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Status update failed.');
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return employees.filter((e) => {
      if (statusFilter === 'active' && e.account_status !== 'active') return false;
      if (statusFilter === 'inactive' && e.account_status !== 'inactive') return false;
      if (!q) return true;
      return (
        e.employee_name.toLowerCase().includes(q) ||
        e.employee_id.toLowerCase().includes(q) ||
        e.username.toLowerCase().includes(q) ||
        (e.department_name || '').toLowerCase().includes(q) ||
        e.designation.toLowerCase().includes(q)
      );
    });
  }, [employees, search, statusFilter]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl font-semibold text-slate-900">Employee Directory &amp; Accounts</h2>
          <p className="mt-1 text-sm text-slate-600">
            Manage employee profiles, globally unique usernames, and system-generated Employee IDs for{' '}
            <span className="font-medium text-slate-900">{currentUser.companyName}</span>.
          </p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={openCreateModal}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-700 hover:bg-blue-800 text-white text-sm font-medium rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Add Employee</span>
          </button>
        )}
      </div>

      {createdBanner && (
        <div className="p-4 rounded-lg bg-emerald-50 border border-emerald-200 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-700 mt-0.5 shrink-0" />
            <div className="text-sm text-emerald-950">
              <div className="font-semibold">Employee Account Created</div>
              <p className="mt-0.5 text-emerald-900">
                <span className="font-medium">{createdBanner.employeeName}</span> can now log in using Username{' '}
                <span className="font-mono font-semibold">{createdBanner.username}</span> or system-generated Employee ID{' '}
                <span className="font-mono font-semibold">{createdBanner.employeeId}</span>.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setCreatedBanner(null)}
            className="text-emerald-700 hover:text-emerald-900 p-1 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {error && (
        <div role="alert" className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-red-900 text-sm">
          {error}
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, Employee ID, username, department..."
              className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
            />
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start sm:self-auto">
            {(['all', 'active', 'inactive'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setStatusFilter(tab)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md capitalize whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                  statusFilter === tab
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-600">
              <tr>
                <th className="py-3 px-4 font-medium">Employee ID</th>
                <th className="py-3 px-4 font-medium">Employee</th>
                <th className="py-3 px-4 font-medium">Username</th>
                <th className="py-3 px-4 font-medium">Department &amp; Role</th>
                <th className="py-3 px-4 font-medium">Location &amp; Shift</th>
                <th className="py-3 px-4 font-medium">Account Status</th>
                {canManage && <th className="py-3 px-4 font-medium text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-10 px-4 text-center text-slate-500">
                    Loading company directory...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 px-4 text-center text-slate-500">
                    No matching employees found in this company.
                  </td>
                </tr>
              ) : (
                filtered.map((emp) => (
                  <tr key={emp.employee_record_id} className="hover:bg-slate-50/70">
                    <td className="py-3 px-4 font-mono text-xs font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                      {emp.employee_id}
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-medium text-slate-900">{emp.employee_name}</div>
                      <div className="text-xs text-slate-500">
                        {emp.designation} · {emp.email}
                      </div>
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-700 whitespace-nowrap">
                      {emp.username}
                      {emp.must_change_password === 1 && (
                        <div className="text-[11px] font-sans text-amber-700 mt-0.5">
                          Temp password pending change
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-700">
                      <div className="font-medium text-slate-900">{emp.department_name || 'Unassigned'}</div>
                      <div className="text-slate-500">
                        {emp.role_name} · {emp.employment_type}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-600">
                      <div>{emp.location_name || 'Any Location'}</div>
                      <div className="text-slate-500">{emp.shift_name || 'Default Shift'}</div>
                    </td>
                    <td className="py-3 px-4 text-xs whitespace-nowrap">
                      <span
                        className={`font-medium ${
                          emp.account_status === 'active' ? 'text-emerald-700' : 'text-red-700'
                        }`}
                      >
                        {emp.account_status === 'active' ? 'Active' : 'Deactivated'}
                      </span>
                    </td>
                    {canManage && (
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => openEditModal(emp)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 border border-slate-200 rounded-md cursor-pointer"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                            <span>Edit</span>
                          </button>
                          {emp.user_id !== currentUser.userId && (
                            <button
                              type="button"
                              onClick={() => handleToggleStatus(emp)}
                              className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md border cursor-pointer ${
                                emp.account_status === 'active'
                                  ? 'text-red-700 border-red-200 hover:bg-red-50'
                                  : 'text-emerald-700 border-emerald-200 hover:bg-emerald-50'
                              }`}
                            >
                              {emp.account_status === 'active' ? (
                                <>
                                  <UserX className="w-3.5 h-3.5" />
                                  <span>Deactivate</span>
                                </>
                              ) : (
                                <>
                                  <UserCheck className="w-3.5 h-3.5" />
                                  <span>Reactivate</span>
                                </>
                              )}
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create / Edit Employee Modal */}
      {modalMode && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto p-6 sm:p-7">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <div>
                <h3 className="font-display text-lg font-semibold text-slate-900">
                  {modalMode === 'create' ? 'Add New Employee Account' : `Edit Employee · ${editingRow?.employee_id}`}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {modalMode === 'create'
                    ? 'Employee ID is generated automatically and globally unique across SmartAttend.'
                    : 'Update employee details and assignments. Existing passwords are never visible.'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setModalMode(null)}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {formError && (
              <div role="alert" className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-900 text-sm">
                {formError}
              </div>
            )}

            <form onSubmit={handleSubmit} className="mt-5 space-y-6">
              <div>
                <h4 className="text-xs font-semibold text-slate-900 mb-3">01. Employee Details</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Employee Name</label>
                    <input
                      type="text"
                      required
                      value={employeeName}
                      onChange={(e) => setEmployeeName(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Email</label>
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Mobile Number</label>
                    <input
                      type="tel"
                      required
                      value={mobile}
                      onChange={(e) => setMobile(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Department</label>
                    <select
                      value={departmentId}
                      onChange={(e) => setDepartmentId(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="">Select department</option>
                      {orgOptions.departments.map((d) => (
                        <option key={d.department_id} value={d.department_id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Designation</label>
                    <input
                      type="text"
                      required
                      value={designation}
                      onChange={(e) => setDesignation(e.target.value)}
                      placeholder="Software Engineer"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Role</label>
                    <select
                      value={roleName}
                      onChange={(e) => setRoleName(e.target.value as UserRole)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="Employee">Employee</option>
                      <option value="Responsible Person">Responsible Person</option>
                      <option value="Manager">Manager</option>
                      <option value="HOD">HOD</option>
                      <option value="HR">HR</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Reporting Manager</label>
                    <select
                      value={reportingManagerId}
                      onChange={(e) => setReportingManagerId(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="">None</option>
                      {orgOptions.managers.map((m) => (
                        <option key={m.employee_record_id} value={m.employee_record_id}>
                          {m.employee_name} ({m.employee_id})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">HOD</label>
                    <select
                      value={hodId}
                      onChange={(e) => setHodId(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="">None</option>
                      {orgOptions.managers.map((m) => (
                        <option key={m.employee_record_id} value={m.employee_record_id}>
                          {m.employee_name} ({m.employee_id})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Joining Date</label>
                    <input
                      type="date"
                      required
                      value={joiningDate}
                      disabled={modalMode === 'edit'}
                      onChange={(e) => setJoiningDate(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg disabled:bg-slate-50"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Employment Type</label>
                    <select
                      value={employmentType}
                      onChange={(e) => setEmploymentType(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                    >
                      <option>Full-Time</option>
                      <option>Part-Time</option>
                      <option>Contract</option>
                      <option>Intern</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Office Location</label>
                    <select
                      value={officeLocationId}
                      onChange={(e) => setOfficeLocationId(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="">Any company office</option>
                      {orgOptions.locations.map((l) => (
                        <option key={l.location_id} value={l.location_id}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Assigned Shift</label>
                    <select
                      value={assignedShiftId}
                      onChange={(e) => setAssignedShiftId(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="">Default Shift</option>
                      {orgOptions.shifts.map((s) => (
                        <option key={s.shift_id} value={s.shift_id}>
                          {s.name} ({s.start_time}–{s.end_time})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Employment Status</label>
                    <select
                      value={employmentStatus}
                      onChange={(e) => setEmploymentStatus(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="active">Active</option>
                      <option value="on_leave">On Leave</option>
                      <option value="inactive">Inactive</option>
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-slate-700 mb-1">Profile Picture URL (Optional)</label>
                    <input
                      type="url"
                      value={profilePicture}
                      onChange={(e) => setProfilePicture(e.target.value)}
                      placeholder="https://..."
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>
              </div>

              {modalMode === 'create' && (
                <div className="pt-5 border-t border-slate-200">
                  <div className="flex items-center justify-between gap-4 mb-3">
                    <h4 className="text-xs font-semibold text-slate-900">02. Employee Login Credentials</h4>
                    <button
                      type="button"
                      onClick={handleGeneratePassword}
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 hover:underline cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Generate Secure Temporary Password</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Global Username (Admin creates)
                      </label>
                      <input
                        type="text"
                        required
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="e.g. ananya_k"
                        className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                      />
                      {usernameCheck.checking && (
                        <p className="mt-1 text-xs text-slate-500">Checking global uniqueness...</p>
                      )}
                      {!usernameCheck.checking && usernameCheck.available === true && (
                        <p className="mt-1 text-xs text-emerald-700">Globally available across all companies.</p>
                      )}
                      {!usernameCheck.checking && usernameCheck.available === false && (
                        <p className="mt-1 text-xs text-red-700">{usernameCheck.reason}</p>
                      )}
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Employee ID (System Generated)
                      </label>
                      <input
                        type="text"
                        readOnly
                        value="Auto-generated on save (EMPxxxx)"
                        className="w-full px-3 py-2 text-sm font-mono bg-slate-50 text-slate-500 border border-slate-200 rounded-lg"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Temporary Password</label>
                      <input
                        type="text"
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Min 8 chars, Aa1"
                        className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Confirm Password</label>
                      <input
                        type="text"
                        required
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="Repeat password"
                        className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                      />
                    </div>
                  </div>

                  <label className="mt-3.5 inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={forcePasswordChange}
                      onChange={(e) => setForcePasswordChange(e.target.checked)}
                      className="rounded border-slate-300 text-blue-700"
                    />
                    <span>Require employee to change temporary password on first login</span>
                  </label>
                </div>
              )}

              <div className="pt-3 border-t border-slate-200 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setModalMode(null)}
                  className="px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || (modalMode === 'create' && usernameCheck.available === false)}
                  className="px-5 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:bg-blue-400 rounded-lg cursor-pointer"
                >
                  {saving ? 'Saving...' : modalMode === 'create' ? 'Save Employee Account' : 'Update Employee'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
