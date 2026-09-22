import httpStatus from 'http-status';
import mongoose from 'mongoose';
import ApiError from '../utils/ApiError.js';
import Position from '../models/position.model.js';
import Employee from '../models/employee.model.js';
import TrainingModule from '../models/trainingModule.model.js';
import { countStudentsByPosition } from './positionEnrollment.service.js';

const escapeRegex = (value) => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const toAssignedEmployee = (employee) => ({
  id: String(employee._id ?? employee.id),
  name:
    String(employee.fullName ?? '').trim() ||
    String(employee.email ?? '').trim() ||
    'Employee',
});

/** Same title fallbacks as frontend resolveEmployeeJobTitle (minus populated position.name). */
const getJobTitleCandidates = (employee) => {
  const titles = [];
  for (const value of [employee.designation, employee.referralJobTitle]) {
    const trimmed = String(value ?? '').trim();
    if (trimmed) titles.push(trimmed);
  }
  return titles;
};

const activeEmployeeTitleFilter = {
  isActive: { $ne: false },
  $or: [
    { position: { $ne: null } },
    { designation: { $exists: true, $nin: [null, ''] } },
    { referralJobTitle: { $exists: true, $nin: [null, ''] } },
  ],
};

const UNLINKED_POSITION_PREFIX = 'unlinked:';

/**
 * Match job title text to an existing Position (read-only; never creates).
 * @param {string} name
 * @returns {Promise<{ _id: import('mongoose').Types.ObjectId, name: string }|null>}
 */
const findPositionByName = async (name) => {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  const nameRegex = new RegExp(`^${escapeRegex(trimmed)}$`, 'i');
  return Position.findOne({ name: { $regex: nameRegex } }).select('_id name').lean();
};

/** @returns {Promise<string|null>} Position ObjectId string, or `unlinked:<titleKey>` when no catalog match. */
const resolvePositionKeyFromTitle = async (title, positionNameToId, designationCache) => {
  const trimmed = String(title || '').trim();
  if (!trimmed) return null;

  const titleKey = trimmed.toLowerCase();
  if (designationCache.has(titleKey)) return designationCache.get(titleKey);
  if (positionNameToId.has(titleKey)) {
    const positionKey = positionNameToId.get(titleKey);
    designationCache.set(titleKey, positionKey);
    return positionKey;
  }

  const resolved = await findPositionByName(trimmed);
  if (resolved?._id) {
    const positionKey = String(resolved._id);
    positionNameToId.set(titleKey, positionKey);
    designationCache.set(titleKey, positionKey);
    return positionKey;
  }

  const unlinkedKey = `${UNLINKED_POSITION_PREFIX}${titleKey}`;
  designationCache.set(titleKey, unlinkedKey);
  return unlinkedKey;
};

const buildActiveEmployeePositionFilter = (position) => {
  const titleRegex = new RegExp(`^${escapeRegex(position.name)}$`, 'i');
  return {
    isActive: { $ne: false },
    $or: [
      { position: position._id },
      { designation: titleRegex },
      { referralJobTitle: titleRegex },
    ],
  };
};

/**
 * Create a position
 * @param {Object} positionBody
 * @returns {Promise<Position>}
 */
const createPosition = async (positionBody) => {
  if (await Position.isNameTaken(positionBody.name)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Position name already taken');
  }
  return Position.create(positionBody);
};

/**
 * Query for positions
 * @param {Object} filter - Mongo filter (name, search)
 * @param {Object} options - Query options
 * @returns {Promise<QueryResult>}
 */
const queryPositions = async (filter, options) => {
  const { search, ...restFilter } = filter;
  const mongoFilter = { ...restFilter };
  if (search && search.trim()) {
    const trimmed = search.trim();
    const searchRegex = new RegExp(escapeRegex(trimmed), 'i');
    mongoFilter.$or = [{ name: { $regex: searchRegex } }];
  }
  const positions = await Position.paginate(mongoFilter, options);
  return positions;
};

/**
 * Get all positions (no pagination) - for dropdowns
 * @returns {Promise<Position[]>}
 */
const getAllPositions = async () => {
  return Position.find().sort({ name: 1 }).lean();
};

/**
 * Get position by id
 * @param {ObjectId} id
 * @returns {Promise<Position|null>}
 */
const getPositionById = async (id) => {
  return Position.findById(id);
};

/**
 * Update position by id
 * @param {ObjectId} positionId
 * @param {Object} updateBody
 * @returns {Promise<Position>}
 */
const updatePositionById = async (positionId, updateBody) => {
  const position = await getPositionById(positionId);
  if (!position) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Position not found');
  }
  if (updateBody.name && (await Position.isNameTaken(updateBody.name, positionId))) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Position name already taken');
  }
  Object.assign(position, updateBody);
  await position.save();
  return position;
};

/**
 * Delete position by id
 * @param {ObjectId} positionId
 * @returns {Promise<Position>}
 */
const deletePositionById = async (positionId) => {
  const position = await getPositionById(positionId);
  if (!position) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Position not found');
  }
  await position.deleteOne();
  return position;
};

/**
 * Normalize module id list for position ↔ module assignment writes.
 */
const normalizeModuleIds = (moduleIds) => {
  if (!Array.isArray(moduleIds)) return [];
  return moduleIds
    .map((id) => String(id).trim())
    .filter((id) => mongoose.Types.ObjectId.isValid(id));
};

const assertModulesExist = async (moduleIds) => {
  if (!moduleIds.length) return;
  const found = await TrainingModule.countDocuments({ _id: { $in: moduleIds } });
  if (found !== moduleIds.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'One or more training modules are invalid');
  }
};

/**
 * @param {import('mongoose').Types.ObjectId[]} positionIds
 * @returns {Promise<{
 *   modulesByPosition: Map<string, Array<{ id: string, name: string }>>,
 *   foldersByModuleId: Map<string, string[]>,
 * }>}
 */
const buildModulesByPositionId = async (positionIds) => {
  const modulesByPosition = new Map();
  const foldersByModuleId = new Map();
  if (!positionIds.length) return { modulesByPosition, foldersByModuleId };

  for (const posId of positionIds) {
    modulesByPosition.set(String(posId), []);
  }

  const modules = await TrainingModule.find({ positions: { $in: positionIds } })
    .select('moduleName positions categories')
    .lean();

  for (const mod of modules) {
    const modId = String(mod._id);
    const modEntry = { id: modId, name: mod.moduleName };
    foldersByModuleId.set(
      modId,
      (mod.categories ?? []).map((c) => String(c)).filter(Boolean)
    );
    for (const posRef of mod.positions ?? []) {
      const posKey = String(posRef);
      if (modulesByPosition.has(posKey)) {
        modulesByPosition.get(posKey).push(modEntry);
      }
    }
  }

  for (const [, list] of modulesByPosition) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }

  return { modulesByPosition, foldersByModuleId };
};

/** Match frontend normalizeSearchKey / normalizedSearchIncludes for roster search. */
const normalizeSearchKey = (value) =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');

const normalizedSearchIncludes = (haystack, query) => {
  const q = normalizeSearchKey(query);
  if (!q) return true;
  return normalizeSearchKey(haystack).includes(q);
};

/**
 * Filter roster rows by text + folder chips (OR folders, AND with search).
 * Mirrors frontend filterPositions.
 */
const filterRosterRows = (rows, search, folderIds, foldersByModuleId) => {
  const q = String(search ?? '').trim();
  const folders = new Set((folderIds ?? []).map(String).filter(Boolean));

  return rows.filter((row) => {
    if (folders.size > 0) {
      const inFolder = (row.assignedModules ?? []).some((m) =>
        (foldersByModuleId.get(m.id) ?? []).some((f) => folders.has(f))
      );
      if (!inFolder) return false;
    }
    if (!q) return true;
    return (
      normalizedSearchIncludes(row.name, q) ||
      normalizedSearchIncludes(row.department ?? '', q) ||
      (row.assignedModules ?? []).some((m) => normalizedSearchIncludes(m.name, q)) ||
      (row.assignedEmployees ?? []).some((e) => normalizedSearchIncludes(e.name, q))
    );
  });
};

const ALLOWED_ROSTER_SORT_FIELDS = new Set(['name', 'employees']);

/**
 * Parse `sortBy=name:asc,_id:asc` (or employees). Unknown fields ignored.
 * Neutral / empty → keep incoming order with stable id tie-break only when sorting.
 */
const parseRosterSort = (sortBy) => {
  const raw = String(sortBy ?? '').trim();
  if (!raw) return null;
  for (const part of raw.split(',')) {
    const [fieldRaw, dirRaw] = part.split(':');
    const field = String(fieldRaw ?? '').trim();
    if (!ALLOWED_ROSTER_SORT_FIELDS.has(field)) continue;
    const dir = String(dirRaw ?? 'asc').trim().toLowerCase() === 'desc' ? 'desc' : 'asc';
    return { field, dir };
  }
  return null;
};

const compareRosterRows = (a, b, sort) => {
  if (sort) {
    const cmp =
      sort.field === 'employees'
        ? (a.employeeCount ?? 0) - (b.employeeCount ?? 0)
        : String(a.name ?? '').localeCompare(String(b.name ?? ''), undefined, { sensitivity: 'base' });
    if (cmp !== 0) return sort.dir === 'desc' ? -cmp : cmp;
  }
  return String(a.id ?? '').localeCompare(String(b.id ?? ''));
};

const sortRosterRows = (rows, sortBy) => {
  const sort = parseRosterSort(sortBy);
  if (!sort) return rows;
  return [...rows].sort((a, b) => compareRosterRows(a, b, sort));
};

const parseFolderIdsParam = (raw) => {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((id) => id.trim())
    .filter((id) => mongoose.Types.ObjectId.isValid(id));
};

const paginateRosterRows = (rows, page, limit) => {
  const totalResults = rows.length;
  if (limit == null) {
    return {
      results: rows,
      page: 1,
      limit: totalResults || 1,
      totalPages: totalResults > 0 ? 1 : 0,
      totalResults,
    };
  }
  const safeLimit = Math.min(Math.max(1, limit), 2000);
  const safePage = Math.max(1, page || 1);
  const totalPages = totalResults === 0 ? 0 : Math.ceil(totalResults / safeLimit);
  const start = (safePage - 1) * safeLimit;
  return {
    results: rows.slice(start, start + safeLimit),
    page: safePage,
    limit: safeLimit,
    totalPages,
    totalResults,
  };
};

const dedupeAndSortAssignedEmployees = (metaByPosition) => {
  for (const [, meta] of metaByPosition) {
    const seen = new Set();
    meta.assignedEmployees = meta.assignedEmployees
      .filter((employee) => {
        if (seen.has(employee.id)) return false;
        seen.add(employee.id);
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    meta.employeeCount = meta.assignedEmployees.length;
  }
};

/**
 * All positions with active HR employee assignments (Employee.position, designation, or referralJobTitle).
 * Supports optional search / folderIds / sortBy / page / limit. When limit is omitted, returns every
 * matching row (FolderPositionsPopover / bulk-assign callers).
 *
 * @param {Object} [filter]
 * @param {string} [filter.search]
 * @param {string} [filter.folderIds] - comma-separated category ids
 * @param {Object} [options]
 * @param {string} [options.sortBy] - e.g. `name:asc,_id:asc` or `employees:desc,_id:asc`
 * @param {number} [options.limit]
 * @param {number} [options.page]
 * @returns {Promise<{ results: Array, page: number, limit: number, totalPages: number, totalResults: number }>}
 */
const getPositionRoster = async (filter = {}, options = {}) => {
  const positions = await Position.find().sort({ name: 1 }).lean();
  const positionNameToId = new Map(
    positions.map((pos) => [String(pos.name).trim().toLowerCase(), String(pos._id)])
  );

  const activeEmployees = await Employee.find(activeEmployeeTitleFilter)
    .select('fullName email position designation referralJobTitle')
    .lean();

  const metaByPosition = new Map();
  const titleCache = new Map();
  const unlinkedDisplayNames = new Map();

  const addEmployeeToPosition = (positionKey, employee) => {
    if (!positionKey) return;
    const entry = metaByPosition.get(positionKey) ?? { employeeCount: 0, assignedEmployees: [] };
    entry.assignedEmployees.push(toAssignedEmployee(employee));
    metaByPosition.set(positionKey, entry);
  };

  for (const employee of activeEmployees) {
    let positionKey = employee.position ? String(employee.position) : null;

    if (!positionKey) {
      for (const title of getJobTitleCandidates(employee)) {
        positionKey = await resolvePositionKeyFromTitle(title, positionNameToId, titleCache);
        if (positionKey) {
          if (positionKey.startsWith(UNLINKED_POSITION_PREFIX)) {
            const titleKey = positionKey.slice(UNLINKED_POSITION_PREFIX.length);
            if (!unlinkedDisplayNames.has(titleKey)) {
              unlinkedDisplayNames.set(titleKey, title);
            }
          }
          break;
        }
      }
    }

    addEmployeeToPosition(positionKey, employee);
  }

  dedupeAndSortAssignedEmployees(metaByPosition);

  const positionIds = positions.map((pos) => pos._id);
  const { modulesByPosition, foldersByModuleId } = await buildModulesByPositionId(positionIds);
  const studentCounts = await countStudentsByPosition(positionIds.map(String));

  const linkedRows = positions.map((pos) => {
    const meta = metaByPosition.get(String(pos._id)) ?? { employeeCount: 0, assignedEmployees: [] };
    return {
      ...pos,
      id: String(pos._id),
      employeeCount: meta.employeeCount,
      assignedEmployees: meta.assignedEmployees,
      assignedModules: modulesByPosition.get(String(pos._id)) ?? [],
      studentCount: studentCounts[String(pos._id)] ?? 0,
      autoEnrollNewHires: pos.autoEnrollNewHires ?? false,
    };
  });

  const unlinkedRows = [...unlinkedDisplayNames.entries()]
    .map(([titleKey, displayName]) => {
      const key = `${UNLINKED_POSITION_PREFIX}${titleKey}`;
      const meta = metaByPosition.get(key) ?? { employeeCount: 0, assignedEmployees: [] };
      return {
        id: key,
        name: displayName,
        unlinked: true,
        employeeCount: meta.employeeCount,
        assignedEmployees: meta.assignedEmployees,
        assignedModules: [],
        studentCount: 0,
        autoEnrollNewHires: false,
      };
    })
    .filter((row) => row.employeeCount > 0);

  // Default catalog order (name) before optional explicit sortBy.
  const assembled = [...linkedRows, ...unlinkedRows].sort((a, b) => a.name.localeCompare(b.name));
  const folderIds = parseFolderIdsParam(filter.folderIds);
  const filtered = filterRosterRows(assembled, filter.search, folderIds, foldersByModuleId);
  const sorted = sortRosterRows(filtered, options.sortBy);

  const hasLimit = options.limit != null && options.limit !== '';
  const limit = hasLimit ? Number(options.limit) : null;
  const page = options.page != null && options.page !== '' ? Number(options.page) : 1;
  return paginateRosterRows(sorted, page, limit);
};

/**
 * Active HR employees assigned to a position (position ref, designation, or referralJobTitle).
 * @param {ObjectId} positionId
 * @param {Object} filter
 * @param {Object} options
 * @returns {Promise<QueryResult>}
 */
const queryEmployeesForPosition = async (positionId, filter, options) => {
  const position = await getPositionById(positionId);
  if (!position) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Position not found');
  }

  const mongoFilter = buildActiveEmployeePositionFilter(position);

  if (filter.search?.trim()) {
    const searchRegex = new RegExp(escapeRegex(filter.search.trim()), 'i');
    mongoFilter.$and = [
      ...(mongoFilter.$and || []),
      { $or: [{ fullName: searchRegex }, { email: searchRegex }, { employeeId: searchRegex }] },
    ];
  }

  const result = await Employee.paginate(mongoFilter, {
    ...options,
    sortBy: options.sortBy || 'fullName:asc',
    select: 'fullName email employeeId',
  });

  return {
    ...result,
    results: result.results.map((employee) => toAssignedEmployee(employee)),
  };
};

/**
 * Set which training modules include this position (stored on TrainingModule.positions).
 * @param {import('mongoose').Types.ObjectId|string} positionId
 * @param {string[]} moduleIds
 */
const setPositionModules = async (positionId, moduleIds) => {
  const position = await getPositionById(positionId);
  if (!position) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Position not found');
  }

  const normalizedIds = normalizeModuleIds(moduleIds);
  await assertModulesExist(normalizedIds);

  const posOid = position._id;
  const desiredObjectIds = normalizedIds.map((id) => new mongoose.Types.ObjectId(id));

  if (desiredObjectIds.length) {
    await TrainingModule.updateMany({ _id: { $in: desiredObjectIds } }, { $addToSet: { positions: posOid } });
  }

  await TrainingModule.updateMany(
    {
      positions: posOid,
      ...(desiredObjectIds.length ? { _id: { $nin: desiredObjectIds } } : {}),
    },
    { $pull: { positions: posOid } }
  );

  const updatedModules = await TrainingModule.find({ positions: posOid })
    .select('moduleName')
    .sort({ moduleName: 1 })
    .lean();

  return {
    positionId: String(posOid),
    assignedModules: updatedModules.map((mod) => ({ id: String(mod._id), name: mod.moduleName })),
  };
};

export {
  createPosition,
  queryPositions,
  getAllPositions,
  getPositionById,
  getPositionRoster,
  queryEmployeesForPosition,
  setPositionModules,
  updatePositionById,
  deletePositionById,
};
