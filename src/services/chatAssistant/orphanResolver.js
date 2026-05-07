/**
 * Merge an Employee profile with its owner User (which may be missing or
 * deleted) into a single identity object. Never returns the literal 'N/A' —
 * falls back to Employee fields, then to a synthesised label.
 *
 * @param {object|null} employee  Lean Employee doc (fullName, email, phoneNumber, employeeId, owner, ...)
 * @param {object|null} ownerUser Lean User doc (name, email, phoneNumber, roleNames, _id)
 * @returns {object|null} { _id, name, email, phone, role[], _orphan } or null if both inputs absent
 */
export function resolveIdentity(employee, ownerUser) {
  if (!employee && !ownerUser) return null;

  const name =
    ownerUser?.name ||
    employee?.fullName ||
    (employee?.employeeId ? `Employee ${employee.employeeId}` : 'Unknown');

  return {
    _id:    ownerUser?._id    || employee?.owner    || null,
    name,
    email:  ownerUser?.email       || employee?.email       || null,
    phone:  ownerUser?.phoneNumber || employee?.phoneNumber || null,
    role:   ownerUser?.roleNames || ['Employee'],
    _orphan: !ownerUser,
  };
}
