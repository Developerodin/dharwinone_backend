import httpStatus from 'http-status';
import mongoose from 'mongoose';
import ApiError from '../utils/ApiError.js';
import Position from '../models/position.model.js';
import Employee from '../models/employee.model.js';
import TrainingModule from '../models/trainingModule.model.js';

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
 * All positions with active HR employee assignments (Employee.position, designation, or referralJobTitle).
 * @returns {Promise<Array>}
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
 * @returns {Promise<Map<string, Array<{ id: string, name: string }>>>}
 */
const buildModulesByPositionId = async (positionIds) => {
  const map = new Map();
  if (!positionIds.length) return map;

  for (const posId of positionIds) {
    map.set(String(posId), []);
  }

  const modules = await TrainingModule.find({ positions: { $in: positionIds } })
    .select('moduleName positions')
    .lean();

  for (const mod of modules) {
    const modEntry = { id: String(mod._id), name: mod.moduleName };
    for (const posRef of mod.positions ?? []) {
      const posKey = String(posRef);
      if (map.has(posKey)) {
        map.get(posKey).push(modEntry);
      }
    }
  }

  for (const [, list] of map) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }

  return map;
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

const getPositionRoster = async () => {
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
  const modulesByPosition = await buildModulesByPositionId(positionIds);

  const linkedRows = positions.map((pos) => {
    const meta = metaByPosition.get(String(pos._id)) ?? { employeeCount: 0, assignedEmployees: [] };
    return {
      ...pos,
      id: String(pos._id),
      employeeCount: meta.employeeCount,
      assignedEmployees: meta.assignedEmployees,
      assignedModules: modulesByPosition.get(String(pos._id)) ?? [],
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
      };
    })
    .filter((row) => row.employeeCount > 0);

  return [...linkedRows, ...unlinkedRows].sort((a, b) => a.name.localeCompare(b.name));
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
