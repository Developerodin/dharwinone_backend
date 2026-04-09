import httpStatus from 'http-status';
import mongoose from 'mongoose';
import Candidate from '../models/candidate.model.js';
import Student from '../models/student.model.js';
import User from '../models/user.model.js';
import Token from '../models/token.model.js';
import { createUser, getUserByEmail, updateUserById, getUserById } from './user.service.js';
import { generateVerifyEmailToken } from './token.service.js';
import { sendVerificationEmail } from './email.service.js';
import { getShiftById } from './shift.service.js';
import { generatePresignedDownloadUrl } from '../config/s3.js';
import config from '../config/config.js';
import ApiError from '../utils/ApiError.js';
import logger from '../config/logger.js';

/** Max rows per bulk CSV export (same filter scope as list). */
const MAX_CANDIDATE_EXPORT = Number(process.env.MAX_CANDIDATE_EXPORT) || 10000;

/** User may have canManageCandidates set by controller (from candidates.manage permission). */
const isOwnerOrAdmin = (user, candidate) => {
  if (!candidate) return false;
  const hasManage = user?.canManageCandidates === true;
  return hasManage || String(candidate.owner) === String(user?.id || user?._id);
};

// Helper function to generate document API endpoint URL (never expires)
// Optionally accepts a token parameter to include in the URL for direct browser access
const getDocumentApiUrl = (candidateId, documentIndex, token = null) => {
  const backendUrl = config.backendPublicUrl || `http://localhost:${config.port}`;
  const baseUrl = `${backendUrl}/v1/candidates/documents/${candidateId}/${documentIndex}/download`;
  // Include token in query parameter if provided (for direct browser access)
  return token ? `${baseUrl}?token=${encodeURIComponent(token)}` : baseUrl;
};

const calculateProfileCompletion = (candidate) => {
  let completion = 30; // Base 30% when user registers (name, email, phone)
  
  // Additional Personal/Academic Information (10%)
  if (candidate.shortBio || candidate.sevisId || candidate.ead || candidate.visaType || candidate.countryCode ||
      candidate.degree || candidate.supervisorName || candidate.supervisorContact || candidate.supervisorCountryCode ||
      candidate.salaryRange || (candidate.address?.streetAddress && candidate.address?.city && 
      candidate.address?.state && candidate.address?.zipCode && candidate.address?.country)) {
    completion += 10;
  }
  
  // Dynamic Sections (10% each = 60% total)
  // Qualifications Section (10%)
  if (candidate.qualifications && candidate.qualifications.length > 0) {
    completion += 10;
  }
  
  // Experience Section (10%)
  if (candidate.experiences && candidate.experiences.length > 0) {
    completion += 10;
  }
  
  // Skills Section (10%)
  if (candidate.skills && candidate.skills.length > 0) {
    completion += 10;
  }
  
  // Documents Section (10%)
  if (candidate.documents && candidate.documents.length > 0) {
    completion += 10;
  }
  
  // Social Links Section (10%)
  if (candidate.socialLinks && candidate.socialLinks.length > 0) {
    completion += 10;
  }
  
  // Salary Slips Section (10%)
  if (candidate.salarySlips && candidate.salarySlips.length > 0) {
    completion += 10;
  }
  
  return completion;
};

const hasAllRequiredData = (candidateData) => {
  // Check if at least one qualification is provided
  const hasQualifications = candidateData.qualifications && 
    candidateData.qualifications.length > 0;
  
  // Check if at least one experience is provided
  const hasExperiences = candidateData.experiences && 
    candidateData.experiences.length > 0;
  
  // Auto-verify email if both qualifications and experiences are provided
  return hasQualifications && hasExperiences;
};

const createCandidate = async (ownerId, payload) => {
  // Check if payload is an array (multiple candidates) or single object
  const isMultiple = Array.isArray(payload);
  const candidatesData = isMultiple ? payload : [payload];
  
  const results = {
    successful: [],
    failed: [],
    summary: {
      total: candidatesData.length,
      successful: 0,
      failed: 0
    }
  };

  // Check for duplicate emails within the batch
  const emailsInBatch = new Set();
  for (let i = 0; i < candidatesData.length; i++) {
    const email = candidatesData[i].email;
    if (emailsInBatch.has(email)) {
      results.failed.push({
        index: i,
        candidateData: {
          fullName: candidatesData[i].fullName,
          email: candidatesData[i].email
        },
        error: `Duplicate email ${email} found in the same batch`,
        message: `Failed to create candidate: Duplicate email ${email} found in the same batch`
      });
      results.summary.failed++;
      continue;
    }
    emailsInBatch.add(email);
  }

  const { queueSopReminderCheckForCandidate } = await import('./sopReminder.service.js');

  // Process each candidate
  for (let i = 0; i < candidatesData.length; i++) {
    const candidateData = candidatesData[i];
    
    // Skip if this candidate already failed due to duplicate email in batch
    if (results.failed.some(f => f.index === i)) {
      continue;
    }
    
    try {
      // If admin provided password, create or reuse a user for candidate's email
      let resolvedOwnerId = ownerId;
      let shouldAutoVerifyEmail = false;
      
      if (candidateData.password && candidateData.email) {
        const existing = await getUserByEmail(candidateData.email);
        if (existing) {
          resolvedOwnerId = existing.id;
        } else {
          const user = await createUser({
            name: candidateData.fullName || candidateData.email,
            email: candidateData.email,
            password: candidateData.password,
            role: candidateData.role || 'user',
            adminId: candidateData.adminId,
          });
          resolvedOwnerId = user.id;
        }
      }
      
      // Check if candidate already exists with the same email
      const existingCandidate = await Candidate.findOne({ email: candidateData.email });
      if (existingCandidate) {
        throw new ApiError(httpStatus.CONFLICT, `Candidate with email ${candidateData.email} already exists`);
      }
      
      // Check if all required data is provided for auto email verification
      if (hasAllRequiredData(candidateData)) {
        shouldAutoVerifyEmail = true;
      }
      
      // eslint-disable-next-line no-unused-vars -- password intentionally discarded
      const { password, joiningDate: inputJoiningDate, ...rest } = candidateData; // never store password on candidate
      
      // Default joiningDate to today when account is created
      const joiningDate = inputJoiningDate ? new Date(inputJoiningDate) : new Date();
      const candidatePayload = {
        owner: resolvedOwnerId,
        adminId: candidateData.adminId || resolvedOwnerId,
        joiningDate,
        ...rest,
      };

      // Create candidate with calculated profile completion
      const candidate = await Candidate.create(candidatePayload);
      
      // Calculate and update profile completion percentage and completion status
      candidate.isProfileCompleted = calculateProfileCompletion(candidate);
      candidate.isCompleted = candidate.isProfileCompleted === 100;
      await candidate.save();
      
      // Auto-verify email if all required data is provided
      if (shouldAutoVerifyEmail) {
        await updateUserById(resolvedOwnerId, { isEmailVerified: true });
      }

      // Sync joiningDate and position to Student if user has a Student profile (attendance, training assignment)
      const student = await Student.findOne({ user: resolvedOwnerId });
      if (student) {
        student.joiningDate = candidate.joiningDate;
        student.position = candidate.position || null;
        await student.save();
      }

      queueSopReminderCheckForCandidate(String(candidate._id));

      results.successful.push({
        index: i,
        candidate: candidate,
        message: 'Candidate created successfully'
      });
      results.summary.successful++;
      
    } catch (error) {
      results.failed.push({
        index: i,
        candidateData: {
          fullName: candidateData.fullName,
          email: candidateData.email
        },
        error: error.message,
        message: `Failed to create candidate: ${error.message}`
      });
      results.summary.failed++;
    }
  }

  // Return format based on input type
  if (isMultiple) return results;
  if (results.summary.successful === 1) return results.successful[0].candidate;
  throw new ApiError(httpStatus.BAD_REQUEST, results.failed[0].message);
};

/**
 * Calculate total years of experience from experiences array
 * @internal reserved for future use
 */
// eslint-disable-next-line no-unused-vars
const calculateYearsOfExperience = (experiences) => {
  if (!experiences || experiences.length === 0) return 0;
  
  let totalMonths = 0;
  const now = new Date();
  
  experiences.forEach(exp => {
    const startDate = exp.startDate ? new Date(exp.startDate) : null;
    const endDate = exp.currentlyWorking 
      ? now 
      : (exp.endDate ? new Date(exp.endDate) : null);
    
    if (startDate && endDate) {
      const months = (endDate.getFullYear() - startDate.getFullYear()) * 12 
        + (endDate.getMonth() - startDate.getMonth());
      totalMonths += Math.max(0, months);
    }
  });
  
  return Math.round((totalMonths / 12) * 10) / 10; // Round to 1 decimal place
};

/**
 * Map years of experience to experience level
 * @internal reserved for future use
 */
// eslint-disable-next-line no-unused-vars
const mapExperienceLevel = (years) => {
  if (years < 2) return 'Entry Level';
  if (years < 5) return 'Mid Level';
  if (years < 10) return 'Senior Level';
  return 'Executive';
};

/**
 * Build MongoDB query for advanced filtering
 */
const buildAdvancedFilter = (filter) => {
  const mongoFilter = {};
  const orConditions = [];

  // Basic filters
  if (filter.owner) mongoFilter.owner = filter.owner;
  if (filter.fullName) {
    mongoFilter.fullName = { $regex: filter.fullName, $options: 'i' };
  }
  if (filter.email) {
    mongoFilter.email = { $regex: filter.email, $options: 'i' };
  }
  if (filter.employeeId) {
    const trimmed = String(filter.employeeId).trim();
    const dbsMatch = trimmed.match(/^DBS(\d+)$/i);
    if (dbsMatch) {
      const numStr = dbsMatch[1];
      const num = parseInt(numStr, 10);
      if (num >= 1 && num <= 9 && numStr.length === 1) {
        mongoFilter.employeeId = { $regex: `^DBS0?${num}$`, $options: 'i' };
      } else {
        const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        mongoFilter.employeeId = { $regex: escaped, $options: 'i' };
      }
    } else {
      const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      mongoFilter.employeeId = { $regex: escaped, $options: 'i' };
    }
  }
  
  // Skills matching - use MongoDB text index for faster search
  if (filter.skills && filter.skills.length > 0) {
    const skillNames = (Array.isArray(filter.skills) ? filter.skills : [filter.skills])
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (skillNames.length > 0) {
      mongoFilter.$text = { $search: skillNames.join(' ') };
    }
  }
  
  // Skill level filtering
  if (filter.skillLevel) {
    mongoFilter['skills.level'] = filter.skillLevel;
  }
  
  // Location matching (can match city, state, or country)
  if (filter.location) {
    orConditions.push(
      { 'address.city': { $regex: filter.location, $options: 'i' } },
      { 'address.state': { $regex: filter.location, $options: 'i' } },
      { 'address.country': { $regex: filter.location, $options: 'i' } }
    );
  }
  
  // City matching
  if (filter.city) {
    mongoFilter['address.city'] = { $regex: filter.city, $options: 'i' };
  }
  
  // State matching
  if (filter.state) {
    mongoFilter['address.state'] = { $regex: filter.state, $options: 'i' };
  }
  
  // Country matching
  if (filter.country) {
    mongoFilter['address.country'] = { $regex: filter.country, $options: 'i' };
  }
  
  // Degree matching - frontend sends "Degree - Institute" (e.g. "Masters - Southern Arkansas University")
  // Backend stores degree and institute separately in qualifications[]
  if (filter.degree && filter.degree.trim()) {
    const parts = filter.degree.split(/\s*-\s*/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      // Match qualification where degree AND institute both match the selected "Degree - Institute"
      orConditions.push({
        qualifications: {
          $elemMatch: {
            degree: { $regex: parts[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' },
            institute: { $regex: parts[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
          }
        }
      });
    } else {
      // Single term - match degree or institute
      const term = filter.degree.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      orConditions.push(
        { degree: { $regex: term, $options: 'i' } },
        { 'qualifications.degree': { $regex: term, $options: 'i' } },
        { 'qualifications.institute': { $regex: term, $options: 'i' } }
      );
    }
  }
  
  // Visa type matching
  if (filter.visaType) {
    orConditions.push(
      { visaType: { $regex: filter.visaType, $options: 'i' } },
      { customVisaType: { $regex: filter.visaType, $options: 'i' } }
    );
  }

  // Employment status: current (no resign or resign in future), resigned (resign date on or in past), all (no filter)
  if (filter.employmentStatus === 'resigned') {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    mongoFilter.resignDate = { $exists: true, $ne: null, $lte: todayStart };
  } else if (filter.employmentStatus === 'current') {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    mongoFilter.$and = mongoFilter.$and || [];
    mongoFilter.$and.push({
      $or: [
        { resignDate: null },
        { resignDate: { $exists: false } },
        { resignDate: { $gt: todayStart } },
      ],
    });
  }
  // 'all' or undefined: no employmentStatus filter
  
  // Combine $or conditions if any exist
  if (orConditions.length > 0) {
    if (mongoFilter.$or) {
      mongoFilter.$and = [
        { $or: mongoFilter.$or },
        { $or: orConditions }
      ];
      delete mongoFilter.$or;
    } else {
      mongoFilter.$or = orConditions;
    }
  }
  
  return mongoFilter;
};

const queryCandidates = async (filter, options) => {
  const wantOpenSop =
    filter.includeOpenSopCount === true ||
    filter.includeOpenSopCount === 'true' ||
    filter.includeOpenSopCount === '1';

  // Build base MongoDB filter
  const mongoFilter = buildAdvancedFilter(filter);

  // Employment status drives isActive: current = active only, resigned = show resigned (isActive false), all = both
  if (filter.employmentStatus === 'resigned') {
    // Resigned: show candidates with resign date on or in past (do not filter by isActive)
  } else if (filter.employmentStatus === 'all') {
    // All: show current and resigned (do not filter by isActive)
  } else if (filter.isActive === undefined) {
    // current or undefined employment: only show active (current) candidates
    mongoFilter.isActive = { $ne: false };
  } else {
    mongoFilter.isActive = filter.isActive;
  }

  // Only show candidates whose owner (User) has the Candidate role – exclude Students, Recruiters, etc. who have a candidate record but not the role
  const { getRoleByName } = await import('./role.service.js');
  const candidateRole = await getRoleByName('Candidate');
  if (candidateRole) {
    const usersWithCandidateRole = await User.find(
      { roleIds: candidateRole._id, status: { $in: ['active', 'pending'] } },
      { _id: 1 }
    ).lean();
    const ownerIdsWithCandidateRole = usersWithCandidateRole.map((u) => u._id);
    if (filter.owner) {
      const ownerStr = String(filter.owner);
      const hasRole = ownerIdsWithCandidateRole.some((id) => String(id) === ownerStr);
      mongoFilter.owner = hasRole ? filter.owner : { $in: [] };
    } else {
      mongoFilter.owner = ownerIdsWithCandidateRole.length > 0 ? { $in: ownerIdsWithCandidateRole } : { $in: [] };
    }
  }

  // Filter by assigned training agent: explicit IDs (from checklist) or name/email substring `filter.agent`
  if (filter.agentIds?.trim()) {
    const raw = filter.agentIds.split(',').map((s) => s.trim()).filter(Boolean);
    const agentRole = await getRoleByName('Agent');
    if (!agentRole || raw.length === 0) {
      mongoFilter.assignedAgent = { $in: [] };
    } else {
      const oids = raw.filter((id) => mongoose.Types.ObjectId.isValid(id)).map((id) => new mongoose.Types.ObjectId(id));
      const valid = await User.find({
        _id: { $in: oids },
        roleIds: agentRole._id,
        status: { $in: ['active', 'pending'] },
      })
        .select('_id')
        .lean();
      mongoFilter.assignedAgent = { $in: valid.map((u) => u._id) };
    }
  } else if (filter.agent?.trim()) {
    const term = filter.agent.trim();
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'i');
    const agentRole = await getRoleByName('Agent');
    if (!agentRole) {
      mongoFilter.assignedAgent = { $in: [] };
    } else {
      const agentUsers = await User.find({
        roleIds: agentRole._id,
        status: { $in: ['active', 'pending'] },
        $or: [{ name: re }, { email: re }],
      })
        .select('_id')
        .lean();
      mongoFilter.assignedAgent = { $in: agentUsers.map((u) => u._id) };
    }
  }

  // Check if we need aggregation pipeline for experience-based filtering
  const needsAggregation = filter.experienceLevel || 
                          filter.minYearsOfExperience !== undefined || 
                          filter.maxYearsOfExperience !== undefined;
  
  if (needsAggregation) {
    // Use aggregation pipeline to calculate years of experience and filter
    const pipeline = [];
    
    // Match stage for basic filters
    if (Object.keys(mongoFilter).length > 0) {
      pipeline.push({ $match: mongoFilter });
    }
    
    // Add calculated field for years of experience
    const now = new Date();
    pipeline.push({
      $addFields: {
        yearsOfExperience: {
          $let: {
            vars: {
              totalDays: {
                $reduce: {
                  input: { $ifNull: ['$experiences', []] },
                  initialValue: 0,
                  in: {
                    $add: [
                      '$$value',
                      {
                        $cond: {
                          if: {
                            $and: [
                              { $ne: ['$$this.startDate', null] },
                              {
                                $or: [
                                  { $ifNull: ['$$this.currentlyWorking', false] },
                                  { $ne: ['$$this.endDate', null] }
                                ]
                              }
                            ]
                          },
                          then: {
                            $divide: [
                              {
                                $subtract: [
                                  {
                                    $cond: {
                                      if: { $ifNull: ['$$this.currentlyWorking', false] },
                                      then: now,
                                      else: '$$this.endDate'
                                    }
                                  },
                                  '$$this.startDate'
                                ]
                              },
                              1000 * 60 * 60 * 24 // Convert milliseconds to days
                            ]
                          },
                          else: 0
                        }
                      }
                    ]
                  }
                }
              }
            },
            in: {
              $divide: ['$$totalDays', 365.25] // Convert days to years
            }
          }
        }
      }
    });
    
    // Filter by experience level
    if (filter.experienceLevel) {
      const levelRanges = {
        'Entry Level': { min: 0, max: 2 },
        'Mid Level': { min: 2, max: 5 },
        'Senior Level': { min: 5, max: 10 },
        'Executive': { min: 10, max: 999 }
      };
      
      const range = levelRanges[filter.experienceLevel];
      const yearsFilter = { $gte: range.min };
      if (range.max !== 999) {
        yearsFilter.$lt = range.max;
      }
      pipeline.push({
        $match: {
          yearsOfExperience: yearsFilter
        }
      });
    }
    
    // Filter by years of experience range
    if (filter.minYearsOfExperience !== undefined || filter.maxYearsOfExperience !== undefined) {
      const yearsFilter = {};
      if (filter.minYearsOfExperience !== undefined) {
        yearsFilter.$gte = filter.minYearsOfExperience;
      }
      if (filter.maxYearsOfExperience !== undefined) {
        yearsFilter.$lte = filter.maxYearsOfExperience;
      }
      pipeline.push({
        $match: {
          yearsOfExperience: yearsFilter
        }
      });
    }
    
    // Add pagination and sorting
    const page = parseInt(options.page, 10) || 1;
    const limit = parseInt(options.limit, 10) || 10;
    const skip = (page - 1) * limit;
    
    // Count total documents (before pagination)
    const countPipeline = [...pipeline, { $count: 'total' }];
    const countResult = await Candidate.aggregate(countPipeline);
    const total = countResult.length > 0 ? countResult[0].total : 0;
    
    // Add sorting
    if (options.sortBy) {
      const sortParts = options.sortBy.split(':');
      const sortField = sortParts[0];
      const sortOrder = sortParts[1] === 'desc' ? -1 : 1;
      pipeline.push({ $sort: { [sortField]: sortOrder } });
    } else {
      pipeline.push({ $sort: { createdAt: -1 } });
    }
    
    // Add pagination
    pipeline.push({ $skip: skip });
    pipeline.push({ $limit: limit });
    
    // Execute aggregation
    const candidates = await Candidate.aggregate(pipeline);
    
    // Collect all unique owner IDs BEFORE population (owner is just an ID at this point)
    const ownerIds = [...new Set(candidates
      .map(c => c.owner)
      .filter(Boolean)
      .map(id => id.toString()))];
    
    // Fetch all users at once for better performance
    const users = ownerIds.length > 0 
      ? await User.find({ _id: { $in: ownerIds } }).select('_id isEmailVerified countryCode').lean()
      : [];
    const userMap = new Map(users.map(u => [String(u._id), { isEmailVerified: u.isEmailVerified || false, countryCode: u.countryCode || null }]));

    const studentsForOwners =
      ownerIds.length > 0
        ? await Student.find({ user: { $in: ownerIds } })
            .select('_id user')
            .lean()
        : [];
    const studentIdByOwnerId = new Map(studentsForOwners.map((s) => [String(s.user), String(s._id)]));
    
    // Populate owner and adminId
    const populatedCandidates = await Candidate.populate(candidates, [
      { path: 'owner', select: 'name email isEmailVerified countryCode' },
      { path: 'adminId', select: 'name email' }
    ]);
    
    // Add isEmailVerified and countryCode to each candidate from the owner user
    const candidatesWithEmailStatus = populatedCandidates.map(candidate => {
      const candidateObj = candidate.toObject ? candidate.toObject() : candidate;
      // Get owner ID - handle both populated object and ID string
      let ownerId = null;
      if (candidateObj.owner) {
        if (typeof candidateObj.owner === 'object' && candidateObj.owner._id) {
          ownerId = candidateObj.owner._id.toString();
        } else if (typeof candidateObj.owner === 'string') {
          ownerId = candidateObj.owner;
        } else if (candidateObj.owner.toString) {
          ownerId = candidateObj.owner.toString();
        }
      }
      
      if (ownerId) {
        const userData = userMap.get(ownerId) || { isEmailVerified: false, countryCode: null };
        candidateObj.isEmailVerified = userData.isEmailVerified;
        candidateObj.countryCode = userData.countryCode;
        candidateObj.studentId = studentIdByOwnerId.get(ownerId) || null;
        candidateObj.ownerId = ownerId;
      } else {
        candidateObj.isEmailVerified = false;
        candidateObj.countryCode = null;
        candidateObj.studentId = null;
        candidateObj.ownerId = null;
      }
      return candidateObj;
    });

    // Regenerate presigned URLs for profile pictures (stored URLs expire after 7 days)
    await Promise.all(candidatesWithEmailStatus.map(async (c) => {
      if (c.profilePicture?.key) {
        try {
          c.profilePicture.url = await generatePresignedDownloadUrl(c.profilePicture.key, 7 * 24 * 3600);
        } catch (e) {
          logger.warn('Failed to regenerate profile picture URL in list:', e?.message);
        }
      }
    }));

    if (wantOpenSop && candidatesWithEmailStatus.length > 0) {
      const { countOpenSopSteps } = await import('./sopChecklist.service.js');
      await Promise.all(
        candidatesWithEmailStatus.map(async (row) => {
          const id = row._id ?? row.id;
          if (id) row.openSopCount = await countOpenSopSteps(id);
        })
      );
    }

    return {
      results: candidatesWithEmailStatus,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      totalResults: total
    };
  }
  // Use simple pagination for non-experience-based filters (lean + select for faster load)
  const listFields = 'fullName email phoneNumber profilePicture skills qualifications experiences shortBio owner adminId isActive isProfileCompleted employeeId joiningDate resignDate';
  const paginateOptions = { ...options, lean: true, select: listFields };
  const result = await Candidate.paginate(mongoFilter, paginateOptions);
    
    // Manually populate with field selection including isEmailVerified
    if (result.results && result.results.length > 0) {
      // Collect all unique owner IDs BEFORE population (owner is just an ID at this point)
      const ownerIds = [...new Set(result.results
        .map(c => {
          const owner = c.owner;
          return owner ? owner.toString() : null;
        })
        .filter(Boolean))];
      
      // Fetch all users at once for better performance
      const users = ownerIds.length > 0 
        ? await User.find({ _id: { $in: ownerIds } }).select('_id isEmailVerified countryCode').lean()
        : [];
      const userMap = new Map(users.map(u => [String(u._id), { isEmailVerified: u.isEmailVerified || false, countryCode: u.countryCode || null }]));

      const studentsForOwners =
        ownerIds.length > 0
          ? await Student.find({ user: { $in: ownerIds } })
              .select('_id user')
              .lean()
          : [];
      const studentIdByOwnerId = new Map(studentsForOwners.map((s) => [String(s.user), String(s._id)]));
      
      await Candidate.populate(result.results, [
        { path: 'owner', select: 'name email isEmailVerified countryCode' },
        { path: 'adminId', select: 'name email' }
      ]);
      
      // Convert to plain objects and add isEmailVerified and countryCode
      result.results = result.results.map(candidate => {
        const candidateObj = candidate.toObject ? candidate.toObject() : candidate;
        // Get owner ID - handle both populated object and ID string
        let ownerId = null;
        if (candidateObj.owner) {
          if (typeof candidateObj.owner === 'object' && candidateObj.owner._id) {
            ownerId = candidateObj.owner._id.toString();
          } else if (typeof candidateObj.owner === 'string') {
            ownerId = candidateObj.owner;
          } else if (candidateObj.owner.toString) {
            ownerId = candidateObj.owner.toString();
          }
        }
        
        if (ownerId) {
          const userData = userMap.get(ownerId) || { isEmailVerified: false, countryCode: null };
          candidateObj.isEmailVerified = userData.isEmailVerified;
          candidateObj.countryCode = userData.countryCode;
          candidateObj.studentId = studentIdByOwnerId.get(ownerId) || null;
          candidateObj.ownerId = ownerId;
        } else {
          candidateObj.isEmailVerified = false;
          candidateObj.countryCode = null;
          candidateObj.studentId = null;
          candidateObj.ownerId = null;
        }
        return candidateObj;
      });

      // Regenerate presigned URLs for profile pictures (stored URLs expire after 7 days)
      await Promise.all(result.results.map(async (c) => {
        if (c.profilePicture?.key) {
          try {
            c.profilePicture.url = await generatePresignedDownloadUrl(c.profilePicture.key, 7 * 24 * 3600);
          } catch (e) {
            logger.warn('Failed to regenerate profile picture URL in list:', e?.message);
          }
        }
      }));

      if (wantOpenSop && result.results.length > 0) {
        const { countOpenSopSteps } = await import('./sopChecklist.service.js');
        await Promise.all(
          result.results.map(async (row) => {
            const id = row._id ?? row.id;
            if (id) row.openSopCount = await countOpenSopSteps(id);
          })
        );
      }
    }

    return result;
};

/**
 * Check if a candidate (by owner user id) is resigned (resignDate set and on or in the past).
 * Used by auth to block resigned candidates from portal access.
 * @param {mongoose.Types.ObjectId} ownerId - User id (candidate owner)
 * @returns {Promise<{ resigned: boolean }>}
 */
const getResignStatusByOwnerId = async (ownerId) => {
  const candidate = await Candidate.findOne({ owner: ownerId }).select('resignDate').lean();
  if (!candidate?.resignDate) return { resigned: false };
  const rd = new Date(candidate.resignDate);
  rd.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return { resigned: rd <= today };
};

/** Get full candidate by owner (for GET /auth/me/with-candidate). Includes documents & salarySlips with presigned URLs. */
const getCandidateByOwnerForMe = async (userId) => {
  const candidate = await Candidate.findOne({ owner: userId });
  if (!candidate) return null;
  await candidate.populate([{ path: 'owner', select: 'name email countryCode' }, { path: 'adminId', select: 'name email' }]);
  if (candidate.profilePicture?.key) {
    try {
      candidate.profilePicture.url = await generatePresignedDownloadUrl(candidate.profilePicture.key, 7 * 24 * 3600);
    } catch (_) {
      /* ignore presigned URL errors */
    }
  }
  if (candidate.documents?.length) {
    await Promise.all(
      candidate.documents.map(async (doc) => {
        if (doc.key) {
          try {
            doc.url = await generatePresignedDownloadUrl(doc.key, 7 * 24 * 3600);
          } catch (_) {
            /* ignore presigned URL errors */
          }
        }
      })
    );
  }
  if (candidate.salarySlips?.length) {
    await Promise.all(
      candidate.salarySlips.map(async (slip) => {
        if (slip.key) {
          try {
            slip.documentUrl = await generatePresignedDownloadUrl(slip.key, 7 * 24 * 3600);
          } catch (_) {
            /* ignore presigned URL errors */
          }
        }
      })
    );
  }
  return candidate;
};

const getCandidateById = async (id) => {
  const candidate = await Candidate.findById(id);
  if (candidate) {
    await candidate.populate([
      { path: 'owner', select: 'name email countryCode' },
      { path: 'adminId', select: 'name email' },
      { path: 'position', select: 'name' },
      { path: 'assignedRecruiter', select: 'name email role' },
      { path: 'assignedAgent', select: 'name email' },
      { path: 'recruiterNotes.addedBy', select: 'name email role' },
    ]);
    
    // Add countryCode from owner to candidate for consistency with list endpoint
    let ownerCountryCode = null;
    if (candidate.owner && typeof candidate.owner === 'object' && candidate.owner.countryCode) {
      ownerCountryCode = candidate.owner.countryCode;
    } else if (candidate.owner) {
      // If owner is just an ID, fetch the user to get countryCode
      const User = (await import('../models/user.model.js')).default;
      const owner = await User.findById(candidate.owner).select('countryCode').lean();
      if (owner && owner.countryCode) {
        ownerCountryCode = owner.countryCode;
      }
    }
    
    // Set countryCode on the document (field exists in schema, so it will be included in toJSON)
    if (ownerCountryCode !== null) {
      candidate.countryCode = ownerCountryCode;
    }
    
    // Regenerate presigned URLs for profile picture if it has a key
    if (candidate.profilePicture?.key) {
      try {
        const profilePictureUrl = await generatePresignedDownloadUrl(candidate.profilePicture.key, 7 * 24 * 3600);
        candidate.profilePicture.url = profilePictureUrl;
      } catch (error) {
        logger.error('Failed to regenerate profile picture URL:', error);
      }
    }
    
    // Regenerate document URLs to use direct S3 presigned URLs (like salary slips)
    if (candidate.documents && candidate.documents.length > 0) {
      await Promise.all(
        candidate.documents.map(async (doc) => {
          // If we have an S3 key, always prefer a fresh presigned URL
          if (doc.key) {
            try {
              const freshUrl = await generatePresignedDownloadUrl(doc.key, 7 * 24 * 3600);
              doc.url = freshUrl;
            } catch (error) {
              logger.error('Failed to regenerate URL for candidate document:', error);
              // Fallback: keep existing URL (could be old S3 URL or API URL)
            }
          }
          // If there's no key, we leave whatever URL is already stored
        })
      );
    }
    
    // Regenerate presigned URLs for salary slips
    if (candidate.salarySlips && candidate.salarySlips.length > 0) {
      await Promise.all(
        candidate.salarySlips.map(async (slip) => {
          if (slip.key) {
            try {
              const freshUrl = await generatePresignedDownloadUrl(slip.key, 7 * 24 * 3600);
              slip.documentUrl = freshUrl;
            } catch (error) {
              logger.error('Failed to regenerate URL for salary slip:', error);
            }
          }
        })
      );
    }
  }
  return candidate;
};

const updateCandidateById = async (id, updateBody, currentUser) => {
  const candidate = await getCandidateById(id);
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }
  if (!isOwnerOrAdmin(currentUser, candidate)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  
  // Update the candidate with new data
  Object.assign(candidate, updateBody);
  
  // Automatically recalculate profile completion percentage and completion status
  candidate.isProfileCompleted = calculateProfileCompletion(candidate);
  candidate.isCompleted = candidate.isProfileCompleted === 100;
  
  await candidate.save();

  const { queueSopReminderCheckForCandidate } = await import('./sopReminder.service.js');
  queueSopReminderCheckForCandidate(String(candidate._id));

  // Sync critical fields to the linked User model
  if (candidate.owner) {
    try {
      const userUpdateData = {};
      
      // Sync name if fullName changed
      if (updateBody.fullName) {
        userUpdateData.name = updateBody.fullName;
      }
      
      // Sync email if changed
      if (updateBody.email) {
        userUpdateData.email = updateBody.email;
      }
      
      // Sync phone / country if changed (keep User and Candidate identical)
      if (updateBody.phoneNumber !== undefined) {
        userUpdateData.phoneNumber = candidate.phoneNumber;
      }
      if (updateBody.countryCode !== undefined) {
        userUpdateData.countryCode = candidate.countryCode;
      }

      // Sync profile picture if changed (single image for both User and Candidate)
      if (updateBody.profilePicture !== undefined) {
        userUpdateData.profilePicture = updateBody.profilePicture;
      }

      // Only update if there are fields to sync
      if (Object.keys(userUpdateData).length > 0) {
        logger.debug('Syncing candidate data to user:', candidate.owner, userUpdateData);
        await updateUserById(candidate.owner, userUpdateData);
        logger.debug('User synced successfully');
      }
    } catch (error) {
      // Log error but don't fail the candidate update
      logger.error('Failed to sync candidate data to user:', error.message);
      logger.error('Error stack:', error.stack);
    }

    // Sync position to Student if user has a Student profile (for training module assignment)
    if ('position' in updateBody) {
      const student = await Student.findOne({ user: candidate.owner });
      if (student) {
        student.position = updateBody.position ?? null;
        await student.save();
      }
    }
  }

  return candidate;
};

/**
 * Export must use the same filter pipeline as GET /candidates; never Candidate.find with a partial query only.
 * @param {object} listFilter - Same shape as list endpoint filter (after controller pick / agent scoping).
 * @param {string} [sortBy] - Same as list sortBy (default createdAt:desc).
 * @returns {Promise<mongoose.Types.ObjectId[]>} Ordered ids.
 */
const getCandidateIdsMatchingListFilters = async (listFilter, sortBy = 'createdAt:desc') => {
  const filter = { ...listFilter };
  filter.includeOpenSopCount = false;

  const peek = await queryCandidates(filter, { page: 1, limit: 1, sortBy });
  const total = peek.totalResults ?? 0;
  if (total > MAX_CANDIDATE_EXPORT) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Export is limited to ${MAX_CANDIDATE_EXPORT} candidates; your filters match ${total}. Narrow filters and try again.`
    );
  }
  if (total === 0) {
    return [];
  }
  const full = await queryCandidates(filter, { page: 1, limit: total, sortBy });
  const results = full.results || [];
  return results.map((r) => r._id ?? r.id).filter(Boolean);
};

/**
 * Org-wide agent workload: counts per Agent user + unassigned, same candidate-owner scope as list (Candidate role owners).
 * Ignores agent / agentIds query filters so the report is always full-picture for the employment scope.
 * @param {{ employmentStatus?: string }} [scope]
 */
const getAgentAssignmentSummary = async (scope = {}) => {
  const filter = {
    employmentStatus: scope.employmentStatus,
    includeOpenSopCount: false,
  };
  const mongoFilter = buildAdvancedFilter(filter);

  if (filter.employmentStatus === 'resigned') {
    // Resigned: do not filter by isActive (matches queryCandidates)
  } else if (filter.employmentStatus === 'all') {
    // All: do not filter by isActive
  } else if (filter.isActive === undefined) {
    mongoFilter.isActive = { $ne: false };
  } else {
    mongoFilter.isActive = filter.isActive;
  }

  const { getRoleByName } = await import('./role.service.js');
  const candidateRole = await getRoleByName('Candidate');
  if (candidateRole) {
    const usersWithCandidateRole = await User.find(
      { roleIds: candidateRole._id, status: { $in: ['active', 'pending'] } },
      { _id: 1 }
    ).lean();
    const ownerIdsWithCandidateRole = usersWithCandidateRole.map((u) => u._id);
    mongoFilter.owner =
      ownerIdsWithCandidateRole.length > 0 ? { $in: ownerIdsWithCandidateRole } : { $in: [] };
  }

  const groups = await Candidate.aggregate([
    { $match: mongoFilter },
    { $group: { _id: '$assignedAgent', assignedCount: { $sum: 1 } } },
  ]);

  const countByAgentKey = new Map();
  let unassignedCount = 0;
  for (const g of groups) {
    if (g._id == null) {
      unassignedCount += g.assignedCount;
    } else {
      countByAgentKey.set(String(g._id), g.assignedCount);
    }
  }

  const agentRole = await getRoleByName('Agent');
  let agents = [];
  if (agentRole) {
    agents = await User.find({
      roleIds: agentRole._id,
      status: { $in: ['active', 'pending'] },
    })
      .select('name email')
      .sort({ name: 1 })
      .lean();
  }

  const agentsPayload = agents.map((a) => ({
    agentId: a._id,
    name: a.name || '',
    email: a.email || '',
    assignedCount: countByAgentKey.get(String(a._id)) || 0,
  }));

  return {
    employmentStatus: filter.employmentStatus || 'current',
    agents: agentsPayload,
    unassignedCount,
  };
};

const deleteCandidateById = async (id) => {
  const candidate = await getCandidateById(id);
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }

  candidate.isActive = false;
  await candidate.save();

  const ownerUser = await User.findById(candidate.owner);
  if (ownerUser) {
    const { getRoleByName } = await import('./role.service.js');
    const candidateRole = await getRoleByName('Candidate');

    if (candidateRole) {
      ownerUser.roleIds = (ownerUser.roleIds || []).filter(
        (rid) => rid.toString() !== candidateRole._id.toString()
      );
    }

    ownerUser.status = 'disabled';
    await ownerUser.save();

    await Token.deleteMany({ user: ownerUser._id });
  }

  return candidate;
};

const mapCandidateDocToExportRow = (candidate) => {
  const owner = candidate.owner;
  const adminId = candidate.adminId;
  const ag = candidate.assignedAgent;
  const pos = candidate.position;
  return {
    id: candidate._id?.toString?.() ?? candidate.id,
    employeeId: candidate.employeeId || '',
    fullName: candidate.fullName,
    email: candidate.email,
    phoneNumber: candidate.phoneNumber,
    countryCode: candidate.countryCode || '',
    shortBio: candidate.shortBio || '',
    sevisId: candidate.sevisId || '',
    ead: candidate.ead || '',
    visaType: candidate.visaType || '',
    customVisaType: candidate.customVisaType || '',
    degree: candidate.degree || '',
    supervisorName: candidate.supervisorName || '',
    supervisorContact: candidate.supervisorContact || '',
    supervisorCountryCode: candidate.supervisorCountryCode || '',
    salaryRange: candidate.salaryRange || '',
    address: candidate.address || {},
    owner: owner && typeof owner === 'object' ? owner.name || '' : '',
    ownerEmail: owner && typeof owner === 'object' ? owner.email || '' : '',
    adminId: adminId && typeof adminId === 'object' ? adminId.name || '' : '',
    adminEmail: adminId && typeof adminId === 'object' ? adminId.email || '' : '',
    assignedAgentName: ag && typeof ag === 'object' ? ag.name || '' : '',
    assignedAgentEmail: ag && typeof ag === 'object' ? ag.email || '' : '',
    designation: candidate.designation || '',
    positionTitle: pos && typeof pos === 'object' ? pos.name || '' : '',
    isProfileCompleted: candidate.isProfileCompleted,
    isCompleted: candidate.isCompleted,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    qualifications: (candidate.qualifications || []).map((q) => ({
      degree: q.degree,
      institute: q.institute,
      location: q.location || '',
      startYear: q.startYear || '',
      endYear: q.endYear || '',
      description: q.description || '',
    })),
    experiences: (candidate.experiences || []).map((e) => ({
      company: e.company,
      role: e.role,
      startDate: e.startDate ? new Date(e.startDate).toISOString().split('T')[0] : '',
      endDate: e.endDate ? new Date(e.endDate).toISOString().split('T')[0] : '',
      description: e.description || '',
      currentlyWorking: !!e.currentlyWorking,
    })),
    skills: (candidate.skills || []).map((s) => ({
      name: s.name,
      level: s.level,
      category: s.category || '',
    })),
    socialLinks: (candidate.socialLinks || []).map((sl) => ({
      platform: sl.platform,
      url: sl.url,
    })),
    documents: (candidate.documents || []).map((d) => ({
      label: d.label || '',
      url: d.url || '',
      originalName: d.originalName || '',
      size: d.size || '',
      mimeType: d.mimeType || '',
    })),
    salarySlips: (candidate.salarySlips || []).map((ss) => ({
      month: ss.month || '',
      year: ss.year || '',
      documentUrl: ss.documentUrl || '',
      originalName: ss.originalName || '',
      size: ss.size || '',
      mimeType: ss.mimeType || '',
    })),
  };
};

const exportAllCandidates = async (listFilter = {}, queryOptions = {}) => {
  const sortBy = queryOptions.sortBy || 'createdAt:desc';
  const ids = await getCandidateIdsMatchingListFilters(listFilter, sortBy);
  if (ids.length === 0) {
    return {
      totalCandidates: 0,
      exportedAt: new Date().toISOString(),
      data: [],
    };
  }

  const oidList = ids.map((id) => new mongoose.Types.ObjectId(String(id)));
  const orderIdx = new Map(ids.map((id, i) => [String(id), i]));

  const candidates = await Candidate.find({ _id: { $in: oidList } })
    .populate('owner', 'name email')
    .populate('adminId', 'name email')
    .populate('assignedAgent', 'name email')
    .populate('position', 'name')
    .lean();

  candidates.sort((a, b) => (orderIdx.get(String(a._id)) ?? 0) - (orderIdx.get(String(b._id)) ?? 0));

  const exportData = candidates.map((c) => mapCandidateDocToExportRow(c));

  return {
    totalCandidates: exportData.length,
    exportedAt: new Date().toISOString(),
    data: exportData,
  };
};

// Salary slip management methods
const addSalarySlipToCandidate = async (candidateId, salarySlipData, currentUser) => {
  const candidate = await getCandidateById(candidateId);
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }
  if (!isOwnerOrAdmin(currentUser, candidate)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }

  candidate.salarySlips.push(salarySlipData);
  
  // Recalculate profile completion
  candidate.isProfileCompleted = calculateProfileCompletion(candidate);
  candidate.isCompleted = candidate.isProfileCompleted === 100;
  
  await candidate.save();
  return candidate;
};

const updateSalarySlipInCandidate = async (candidateId, salarySlipIndex, updateData, currentUser) => {
  const candidate = await getCandidateById(candidateId);
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }
  if (!isOwnerOrAdmin(currentUser, candidate)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  if (salarySlipIndex < 0 || salarySlipIndex >= candidate.salarySlips.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid salary slip index');
  }

  // Update the salary slip
  Object.assign(candidate.salarySlips[salarySlipIndex], updateData);
  
  // Recalculate profile completion
  candidate.isProfileCompleted = calculateProfileCompletion(candidate);
  candidate.isCompleted = candidate.isProfileCompleted === 100;
  
  await candidate.save();
  return candidate;
};

const deleteSalarySlipFromCandidate = async (candidateId, salarySlipIndex, currentUser) => {
  const candidate = await getCandidateById(candidateId);
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }
  if (!isOwnerOrAdmin(currentUser, candidate)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  if (salarySlipIndex < 0 || salarySlipIndex >= candidate.salarySlips.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid salary slip index');
  }

  // Remove the salary slip
  candidate.salarySlips.splice(salarySlipIndex, 1);
  
  // Recalculate profile completion
  candidate.isProfileCompleted = calculateProfileCompletion(candidate);
  candidate.isCompleted = candidate.isProfileCompleted === 100;
  
  await candidate.save();
  return candidate;
};

// Document verification services
const verifyDocument = async (candidateId, documentIndex, verificationData, user) => {
  if (!user?.canManageCandidates) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only users with candidate manage permission can verify documents');
  }

  const candidate = await Candidate.findById(candidateId);
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }

  // Check if document index is valid
  if (documentIndex >= candidate.documents.length || documentIndex < 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid document index');
  }

  // Update the document status
  candidate.documents[documentIndex].status = verificationData.status;
  if (verificationData.adminNotes) {
    candidate.documents[documentIndex].adminNotes = verificationData.adminNotes;
  }
  candidate.documents[documentIndex].verifiedAt = new Date();
  candidate.documents[documentIndex].verifiedBy = user._id || user.id;

  await candidate.save();
  return candidate;
};

const getDocumentStatus = async (candidateId, user) => {
  const candidate = await Candidate.findById(candidateId);
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }

  // Check if user has permission to view document status
  if (!isOwnerOrAdmin(user, candidate)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Access denied');
  }

  // Return documents with direct S3 presigned URLs (like salary slips)
  const documentsWithStatus = await Promise.all(
    candidate.documents.map(async (doc, index) => {
      let url = doc.url;

      if (doc.key) {
        try {
          url = await generatePresignedDownloadUrl(doc.key, 7 * 24 * 3600);
        } catch (error) {
          logger.error('Failed to regenerate URL for candidate document (status):', error);
        }
      }
      
      return {
        index,
        label: doc.label,
        originalName: doc.originalName,
        status: doc.status,
        adminNotes: doc.adminNotes,
        verifiedAt: doc.verifiedAt,
        verifiedBy: doc.verifiedBy,
        url,
        size: doc.size,
        mimeType: doc.mimeType
      };
    })
  );

  return {
    candidateId: candidate._id,
    fullName: candidate.fullName,
    email: candidate.email,
    documents: documentsWithStatus
  };
};

const getDocuments = async (candidateId, user) => {
  const candidate = await Candidate.findById(candidateId);
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }

  // Check if user has permission to view documents
  if (!isOwnerOrAdmin(user, candidate)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Access denied');
  }

  // Return documents with direct S3 presigned URLs (like salary slips)
  const documents = await Promise.all(
    candidate.documents.map(async (doc, index) => {
      let url = doc.url;

      if (doc.key) {
        try {
          url = await generatePresignedDownloadUrl(doc.key, 7 * 24 * 3600);
        } catch (error) {
          logger.error('Failed to regenerate URL for candidate document (list):', error);
        }
      }
      
      return {
        index,
        label: doc.label,
        originalName: doc.originalName,
        url,
        key: doc.key,
        size: doc.size,
        mimeType: doc.mimeType,
        status: doc.status,
        adminNotes: doc.adminNotes,
        verifiedAt: doc.verifiedAt,
        verifiedBy: doc.verifiedBy
      };
    })
  );

  return {
    candidateId: candidate._id,
    fullName: candidate.fullName,
    email: candidate.email,
    documents: documents
  };
};

// Get document download URL (generates fresh presigned URL on-demand)
const getDocumentDownloadUrl = async (candidateId, documentIndex, user) => {
  const candidate = await Candidate.findById(candidateId);
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }

  // Check if user has permission to view documents
  if (!isOwnerOrAdmin(user, candidate)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Access denied');
  }

  // Check if document index is valid
  if (documentIndex < 0 || documentIndex >= candidate.documents.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid document index');
  }

  const document = candidate.documents[documentIndex];
  
  // If document has a key, generate fresh presigned URL
  if (document.key) {
    const presignedUrl = await generatePresignedDownloadUrl(document.key, 7 * 24 * 3600);
    
    return {
      url: presignedUrl,
      fileName: document.originalName || document.label || 'document',
      mimeType: document.mimeType,
      size: document.size
    };
  }
  
  // Fallback: If no key but URL exists, try to extract key from URL
  if (document.url) {
    // Try to extract S3 key from the stored URL
    // Format examples:
    // - https://bucket.s3.region.amazonaws.com/documents/user/file.pdf?params
    // - https://s3.region.amazonaws.com/bucket/documents/user/file.pdf?params
    // - https://vsc-files-storage.s3.ap-south-1.amazonaws.com/documents/.../file.pdf?params
    
    let extractedKey = null;
    
    // Pattern 1: bucket.s3.region.amazonaws.com/key
    const pattern1 = /https?:\/\/[^/]+\.s3[.-][^/]+\.amazonaws\.com\/([^?]+)/;
    const match1 = document.url.match(pattern1);
    if (match1) {
      extractedKey = decodeURIComponent(match1[1]);
    } else {
      // Pattern 2: s3.region.amazonaws.com/bucket/key
      const pattern2 = /https?:\/\/s3[.-][^/]+\.amazonaws\.com\/[^/]+\/([^?]+)/;
      const match2 = document.url.match(pattern2);
      if (match2) {
        extractedKey = decodeURIComponent(match2[1]);
      }
    }
    
    // If we extracted a key, try to generate a fresh presigned URL
    if (extractedKey) {
      try {
        const presignedUrl = await generatePresignedDownloadUrl(extractedKey, 7 * 24 * 3600);
        
        // Update the document in database to store the extracted key for future use
        document.key = extractedKey;
        await candidate.save();
        
        return {
          url: presignedUrl,
          fileName: document.originalName || document.label || 'document',
          mimeType: document.mimeType,
          size: document.size
        };
      } catch (error) {
        // If key extraction fails, fall back to stored URL
        logger.warn(`Failed to generate presigned URL from extracted key "${extractedKey}": ${error.message}`);
      }
    }
    
    // Return stored URL as fallback (may be expired, but better than nothing)
    // This handles old documents that don't have keys stored
    return {
      url: document.url,
      fileName: document.originalName || document.label || 'document',
      mimeType: document.mimeType,
      size: document.size
    };
  }
  
  // No key and no URL - document is invalid
  throw new ApiError(httpStatus.BAD_REQUEST, 'Document key and URL not found. Document may be corrupted.');
};

/** Get salary slip download URL (generates fresh presigned URL on-demand). */
const getSalarySlipDownloadUrl = async (candidateId, salarySlipIndex, user) => {
  const candidate = await Candidate.findById(candidateId);
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }
  if (!isOwnerOrAdmin(user, candidate)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Access denied');
  }
  if (salarySlipIndex < 0 || salarySlipIndex >= (candidate.salarySlips?.length ?? 0)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid salary slip index');
  }
  const slip = candidate.salarySlips[salarySlipIndex];
  if (slip.key) {
    const url = await generatePresignedDownloadUrl(slip.key, 7 * 24 * 3600);
    return {
      url,
      fileName: slip.originalName || `Salary-Slip-${slip.month || 'Unknown'}-${slip.year || 'Unknown'}`,
      mimeType: slip.mimeType,
      size: slip.size
    };
  }
  if (slip.documentUrl) {
    let extractedKey = null;
    const pattern1 = /https?:\/\/[^/]+\.s3[.-][^/]+\.amazonaws\.com\/([^?]+)/;
    const match1 = slip.documentUrl.match(pattern1);
    if (match1) {
      extractedKey = decodeURIComponent(match1[1]);
    } else {
      const pattern2 = /https?:\/\/s3[.-][^/]+\.amazonaws\.com\/[^/]+\/([^?]+)/;
      const match2 = slip.documentUrl.match(pattern2);
      if (match2) extractedKey = decodeURIComponent(match2[1]);
    }
    if (extractedKey) {
      try {
        const url = await generatePresignedDownloadUrl(extractedKey, 7 * 24 * 3600);
        slip.key = extractedKey;
        await candidate.save();
        return {
          url,
          fileName: slip.originalName || `Salary-Slip-${slip.month || 'Unknown'}-${slip.year || 'Unknown'}`,
          mimeType: slip.mimeType,
          size: slip.size
        };
      } catch (e) {
        logger.warn(`Failed to generate presigned URL for salary slip: ${e?.message}`);
      }
    }
    return {
      url: slip.documentUrl,
      fileName: slip.originalName || `Salary-Slip-${slip.month || 'Unknown'}-${slip.year || 'Unknown'}`,
      mimeType: slip.mimeType,
      size: slip.size
    };
  }
  throw new ApiError(httpStatus.BAD_REQUEST, 'Salary slip has no file.');
};

const shareCandidateProfile = async (candidateId, shareData, currentUser) => {
  const { email, withDoc = false } = shareData;
  
  // Get the candidate with populated owner and admin data
  const candidate = await Candidate.findById(candidateId)
    .populate('owner', 'name email')
    .populate('adminId', 'name email');
    
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }
  
  if (!currentUser?.canManageCandidates && String(candidate.owner._id) !== String(currentUser?.id || currentUser?._id)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'You can only share your own profile');
  }
  
  // Generate a unique token for the public page
  const crypto = await import('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  
  // Store the sharing data temporarily (in a real app, you might want to store this in Redis or DB)
  // For now, we'll encode the data in the URL
  const shareDataEncoded = Buffer.from(JSON.stringify({
    candidateId: candidate._id.toString(),
    withDoc,
    sharedBy: currentUser.name,
    sharedAt: new Date().toISOString()
  })).toString('base64');
  
  // Generate the public page URL (same backend that has the candidate data)
  const baseUrl = config.backendPublicUrl || `http://localhost:${config.port}`;
  const publicUrl = `${baseUrl.replace(/\/$/, '')}/v1/candidates/public/candidate/${candidate._id}?token=${token}&data=${shareDataEncoded}`;
  
  return {
    candidateId: candidate._id,
    candidateName: candidate.fullName,
    recipientEmail: email,
    withDoc,
    publicUrl,
    sharedBy: currentUser.name,
    sharedAt: new Date()
  };
};

const getPublicCandidateProfile = async (candidateId, token, data) => {
  // Verify the token and decode the data
  let shareData;
  try {
    const decodedData = Buffer.from(data, 'base64').toString('utf-8');
    shareData = JSON.parse(decodedData);
  } catch (error) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid share data');
  }
  
  // Verify the candidate ID matches
  if (shareData.candidateId !== candidateId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid candidate ID');
  }
  
  // Get the candidate data
  const candidate = await Candidate.findById(candidateId)
    .populate('owner', 'name email')
    .populate('adminId', 'name email');
    
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }
  
  // Regenerate presigned URL for profile picture if it has a key
  let profilePicture = candidate.profilePicture;
  if (profilePicture?.key) {
    try {
      const profilePictureUrl = await generatePresignedDownloadUrl(profilePicture.key, 7 * 24 * 3600);
      profilePicture = { ...profilePicture.toObject(), url: profilePictureUrl };
    } catch (error) {
      logger.error('Failed to regenerate profile picture URL:', error);
    }
  }
  
  // Return documents with direct S3 presigned URLs (never expire within short window)
  let documents = [];
  if (shareData.withDoc && candidate.documents) {
    documents = await Promise.all(
      candidate.documents.map(async (doc, _index) => {
        let url = doc.url;

        if (doc.key) {
          try {
            url = await generatePresignedDownloadUrl(doc.key, 7 * 24 * 3600);
          } catch (error) {
            logger.error('Failed to regenerate URL for public candidate document:', error);
          }
        }

        return { ...doc.toObject(), url };
      })
    );
  }
  
  // Regenerate presigned URLs for salary slips if withDoc is true
  let salarySlips = [];
  if (shareData.withDoc && candidate.salarySlips) {
    salarySlips = await Promise.all(
      candidate.salarySlips.map(async (slip) => {
        let documentUrl = slip.documentUrl;
        if (slip.key) {
          try {
            documentUrl = await generatePresignedDownloadUrl(slip.key, 7 * 24 * 3600);
          } catch (error) {
            logger.error('Failed to regenerate URL for salary slip:', error);
          }
        }
        return { ...slip.toObject(), documentUrl };
      })
    );
  }
  
  // Prepare candidate data for public display with complete information
  const candidateData = {
    // Basic Information
    fullName: candidate.fullName,
    email: candidate.email,
    phoneNumber: candidate.phoneNumber,
    countryCode: candidate.countryCode,
    
    // Profile Picture
    profilePicture,
    
    // Personal Information
    shortBio: candidate.shortBio,
    sevisId: candidate.sevisId,
    ead: candidate.ead,
    visaType: candidate.visaType,
    customVisaType: candidate.customVisaType,
    degree: candidate.degree,
    supervisorName: candidate.supervisorName,
    supervisorContact: candidate.supervisorContact,
    supervisorCountryCode: candidate.supervisorCountryCode,
    
    // Professional Information
    salaryRange: candidate.salaryRange,
    
    // Address Information
    address: candidate.address,
    
    // Profile Completion Status
    isProfileCompleted: candidate.isProfileCompleted,
    isCompleted: candidate.isCompleted,
    
    // Dynamic Sections
    qualifications: candidate.qualifications,
    experiences: candidate.experiences,
    skills: candidate.skills,
    socialLinks: candidate.socialLinks,
    
    // Documents and Salary Slips (conditional based on withDoc flag)
    documents,
    salarySlips,
    
    // Sharing Information
    withDoc: shareData.withDoc,
    sharedBy: shareData.sharedBy,
    sharedAt: shareData.sharedAt,
    
    // Timestamps
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt
  };
  
  return candidateData;
};

/**
 * Resend email verification link for a candidate
 * Only admins can resend verification emails
 * Only works if the candidate's user account exists and email is not verified
 * @param {string} candidateId
 * @returns {Promise<Object>}
 */
const resendCandidateVerificationEmail = async (candidateId, options = {}) => {
  // Get the candidate
  const candidate = await Candidate.findById(candidateId);
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }

  // Resolve the User account that owns this candidate (token + verification apply to this user).
  // Prefer owner — avoids mismatches when candidate.email was edited but User.email is canonical.
  let user = null;
  if (candidate.owner) {
    user = await getUserById(candidate.owner);
  }
  if (!user) {
    user = await getUserByEmail(candidate.email);
  }

  if (!user) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No user account found for this candidate. Cannot send verification email.');
  }

  if (user.isEmailVerified) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Email is already verified for this candidate.');
  }

  const verifyEmailToken = await generateVerifyEmailToken(user);
  // Always send to the login email for `user`; the JWT verifies this same account.
  await sendVerificationEmail(user.email, verifyEmailToken, options);

  return {
    success: true,
    message: 'Verification email sent successfully',
    candidateId: candidate._id,
    /** Profile / list email on the candidate record (may differ from login email). */
    candidateEmail: candidate.email,
    /** Inbox the message was sent to — always the User account email (JWT + login). */
    sentToEmail: user.email,
    candidateName: candidate.fullName,
  };
};

/**
 * Add recruiter note to candidate
 */
const addRecruiterNote = async (candidateId, note, recruiterId) => {
  const candidate = await Candidate.findById(candidateId);
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }
  
  candidate.recruiterNotes.push({
    note,
    addedBy: recruiterId,
    addedAt: new Date(),
  });
  
  await candidate.save();
  
  // Populate recruiter information
  await candidate.populate([
    { path: 'owner', select: 'name email' },
    { path: 'adminId', select: 'name email' },
    { path: 'assignedRecruiter', select: 'name email role' },
    { path: 'recruiterNotes.addedBy', select: 'name email role' },
  ]);
  
  return candidate;
};

/**
 * Add recruiter feedback to candidate
 */
const addRecruiterFeedback = async (candidateId, feedback, rating, _recruiterId) => {
  const candidate = await Candidate.findById(candidateId);
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }
  
  candidate.recruiterFeedback = feedback;
  if (rating) {
    candidate.recruiterRating = rating;
  }
  
  await candidate.save();
  
  // Populate recruiter information
  await candidate.populate([
    { path: 'owner', select: 'name email' },
    { path: 'adminId', select: 'name email' },
    { path: 'assignedRecruiter', select: 'name email role' },
    { path: 'recruiterNotes.addedBy', select: 'name email role' },
  ]);
  
  return candidate;
};

/**
 * Assign recruiter to candidate
 */
const assignRecruiterToCandidate = async (candidateId, recruiterId) => {
  const candidate = await Candidate.findById(candidateId);
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }
  
  const recruiter = await User.findById(recruiterId);
  if (!recruiter) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Recruiter not found');
  }
  candidate.assignedRecruiter = recruiterId;
  await candidate.save();

  const { queueSopReminderCheckForCandidate } = await import('./sopReminder.service.js');
  queueSopReminderCheckForCandidate(String(candidate._id));

  const { notify, plainTextEmailBody } = await import('./notification.service.js');
  const candidateName = candidate.fullName || candidate.email || 'a candidate';
  const candLink = `/candidates/${candidateId}`;
  const recMsg = `You have been assigned as recruiter to ${candidateName}.`;
  notify(recruiterId, {
    type: 'recruiter',
    title: 'Candidate assigned',
    message: recMsg,
    link: candLink,
    email: {
      subject: 'Candidate assigned to you',
      text: plainTextEmailBody(recMsg, candLink),
    },
  }).catch(() => {});

  // Populate recruiter information
  await candidate.populate([
    { path: 'owner', select: 'name email' },
    { path: 'adminId', select: 'name email' },
    { path: 'assignedRecruiter', select: 'name email role' },
    { path: 'recruiterNotes.addedBy', select: 'name email role' },
  ]);

  return candidate;
};

/**
 * Users with Agent role (for student assignment UI).
 */
const listAgentUsersForAssignment = async () => {
  const { getRoleByName } = await import('./role.service.js');
  const agentRole = await getRoleByName('Agent');
  if (!agentRole) {
    return [];
  }
  return User.find({ roleIds: agentRole._id, status: { $in: ['active', 'pending'] } })
    .select('name email')
    .sort({ name: 1 })
    .lean();
};

/**
 * Assignable people: Candidate records whose owner has Student and/or Candidate role.
 * Each candidate has at most one assignedAgent; many candidates may share the same agent.
 */
const listStudentAgentAssignments = async () => {
  const { getRoleByName } = await import('./role.service.js');
  const Role = (await import('../models/role.model.js')).default;
  const studentRole = await getRoleByName('Student');
  const candidateRole = await getRoleByName('Candidate');
  if (!studentRole && !candidateRole) {
    const agents = await listAgentUsersForAssignment();
    return {
      students: [],
      agents: agents.map((u) => ({ id: String(u._id), name: u.name, email: u.email })),
    };
  }

  const ownerIdSet = new Set();
  const addOwnersWithRole = async (roleDoc) => {
    if (!roleDoc) return;
    const rows = await User.find(
      { roleIds: roleDoc._id, status: { $in: ['active', 'pending'] } },
      { _id: 1 }
    ).lean();
    rows.forEach((u) => ownerIdSet.add(u._id));
  };
  await addOwnersWithRole(studentRole);
  await addOwnersWithRole(candidateRole);

  const ownerIds = [...ownerIdSet];
  if (ownerIds.length === 0) {
    const agents = await listAgentUsersForAssignment();
    return {
      students: [],
      agents: agents.map((u) => ({ id: String(u._id), name: u.name, email: u.email })),
    };
  }

  const candidates = await Candidate.find({ owner: { $in: ownerIds } })
    .select('fullName email employeeId owner assignedAgent')
    .populate({ path: 'assignedAgent', select: 'name email' })
    .sort({ fullName: 1 })
    .lean();

  const studentsForOwners =
    ownerIds.length > 0
      ? await Student.find({ user: { $in: ownerIds } })
          .select('_id user')
          .lean()
      : [];
  const studentIdByOwnerId = new Map(studentsForOwners.map((s) => [String(s.user), String(s._id)]));

  const ownerUsers =
    ownerIds.length > 0
      ? await User.find({ _id: { $in: ownerIds } })
          .select('roleIds')
          .lean()
      : [];
  const allRoleIds = [...new Set(ownerUsers.flatMap((u) => u.roleIds || []).map((id) => String(id)))];
  const roleDocs =
    allRoleIds.length > 0 ? await Role.find({ _id: { $in: allRoleIds } }).select('name').lean() : [];
  const roleNameById = new Map(roleDocs.map((r) => [String(r._id), r.name]));

  const ownerRoleLabelByOwnerId = new Map();
  ownerUsers.forEach((u) => {
    const names = (u.roleIds || []).map((rid) => roleNameById.get(String(rid))).filter(Boolean);
    const tags = [];
    if (names.includes('Student')) tags.push('Student');
    if (names.includes('Candidate')) tags.push('Candidate');
    ownerRoleLabelByOwnerId.set(String(u._id), tags.length ? tags.join(' · ') : '—');
  });

  const students = candidates.map((c) => {
    const ownerId = c.owner ? String(c.owner) : '';
    const ag = c.assignedAgent;
    return {
      id: String(c._id),
      fullName: c.fullName,
      email: c.email,
      employeeId: c.employeeId ?? null,
      ownerId,
      ownerRoleLabel: ownerRoleLabelByOwnerId.get(ownerId) ?? '—',
      studentId: studentIdByOwnerId.get(ownerId) ?? null,
      assignedAgent: ag
        ? {
            id: String(ag._id),
            name: ag.name,
            email: ag.email,
          }
        : null,
    };
  });

  const agents = await listAgentUsersForAssignment();
  return {
    students,
    agents: agents.map((u) => ({ id: String(u._id), name: u.name, email: u.email })),
  };
};

/**
 * Assign or unassign an Agent to a candidate profile whose owner has Student and/or Candidate role.
 * @param {string} candidateId
 * @param {string|null|undefined} agentId - null clears assignment
 */
const assignAgentToCandidate = async (candidateId, agentId) => {
  const { getRoleByName } = await import('./role.service.js');
  const candidate = await Candidate.findById(candidateId);
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }

  const studentRole = await getRoleByName('Student');
  const candidateRole = await getRoleByName('Candidate');
  if (!studentRole && !candidateRole) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Student or Candidate role must be configured');
  }
  const ownerOr = [];
  if (studentRole) ownerOr.push({ roleIds: studentRole._id });
  if (candidateRole) ownerOr.push({ roleIds: candidateRole._id });
  const ownerEligible =
    ownerOr.length > 0
      ? await User.exists({
          _id: candidate.owner,
          status: { $in: ['active', 'pending'] },
          $or: ownerOr,
        })
      : false;
  if (!ownerEligible) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Agent assignment applies only to users with the Student or Candidate role'
    );
  }

  if (agentId === null || agentId === undefined || agentId === '') {
    candidate.set('assignedAgent', null);
    await candidate.save();
    const { queueSopReminderCheckForCandidate } = await import('./sopReminder.service.js');
    queueSopReminderCheckForCandidate(String(candidate._id));
    await candidate.populate([
      { path: 'owner', select: 'name email' },
      { path: 'assignedAgent', select: 'name email' },
    ]);
    return candidate;
  }

  const agentRole = await getRoleByName('Agent');
  if (!agentRole) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Agent role is not configured');
  }
  const agentUser = await User.findOne({
    _id: agentId,
    roleIds: agentRole._id,
    status: { $in: ['active', 'pending'] },
  });
  if (!agentUser) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Agent user not found or does not have the Agent role');
  }

  candidate.assignedAgent = agentId;
  await candidate.save();

  const { queueSopReminderCheckForCandidate } = await import('./sopReminder.service.js');
  queueSopReminderCheckForCandidate(String(candidate._id));

  const { notify } = await import('./notification.service.js');
  const studentLabel = candidate.fullName || candidate.email || 'a person';
  notify(agentId, {
    type: 'assignment',
    title: 'Assignee added',
    message: `You are now the assigned agent for ${studentLabel}.`,
    link: '/settings/agents/',
  }).catch(() => {});

  await candidate.populate([
    { path: 'owner', select: 'name email' },
    { path: 'assignedAgent', select: 'name email' },
  ]);
  return candidate;
};

/**
 * Update candidate joining date
 * @param {string} candidateId - Candidate ID
 * @param {Date} joiningDate - Joining date (can be null to clear)
 * @param {Object} user - Current user
 * @returns {Promise<Candidate>}
 */
const updateJoiningDate = async (candidateId, joiningDate, user) => {
  const candidate = await Candidate.findById(candidateId);
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }

  if (!user?.canUpdateJoiningDate) {
    throw new ApiError(httpStatus.FORBIDDEN, 'You do not have permission to update joining date');
  }

  // Validate that joining date is before resign date if both exist
  if (candidate.resignDate && joiningDate && new Date(joiningDate) > new Date(candidate.resignDate)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Joining date cannot be after resign date');
  }

  // Allow clearing joining date (setting to null)
  candidate.joiningDate = joiningDate ? new Date(joiningDate) : null;
  await candidate.save();

  // Sync joiningDate to Student if user has a Student profile (for attendance)
  const student = await Student.findOne({ user: candidate.owner });
  if (student) {
    student.joiningDate = candidate.joiningDate;
    await student.save();
  }

  // Populate fields
  await candidate.populate([
    { path: 'owner', select: 'name email' },
    { path: 'adminId', select: 'name email' },
  ]);

  return candidate;
};

/**
 * Update candidate resign date (makes candidate inactive)
 * @param {string} candidateId - Candidate ID
 * @param {Date} resignDate - Resign date (can be null to clear/reactivate)
 * @param {Object} user - Current user
 * @returns {Promise<Candidate>}
 */
const updateResignDate = async (candidateId, resignDate, user) => {
  const candidate = await Candidate.findById(candidateId);
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }

  if (!user?.canUpdateResignDate) {
    throw new ApiError(httpStatus.FORBIDDEN, 'You do not have permission to update resign date');
  }

  // Validate that resign date is after joining date if both exist
  if (candidate.joiningDate && resignDate && new Date(resignDate) < new Date(candidate.joiningDate)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Resign date cannot be before joining date');
  }

  // Allow clearing resign date (setting to null) to reactivate candidate.
  // Employee ID is never changed here; resigned candidates keep their ID for records.
  candidate.resignDate = resignDate ? new Date(resignDate) : null;
  // isActive will be automatically set by pre-save hook based on resignDate
  await candidate.save();

  // Populate fields
  await candidate.populate([
    { path: 'owner', select: 'name email' },
    { path: 'adminId', select: 'name email' },
  ]);

  return candidate;
};

/**
 * Update week-off days for multiple candidates
 * @param {Array<string>} candidateIds - Array of candidate IDs
 * @param {Array<string>} weekOff - Array of week-off days (e.g., ['Saturday', 'Sunday'])
 * @param {Object} user - Current user
 * @returns {Promise<Object>} Object with updated candidates and summary
 */
const updateWeekOffForCandidates = async (candidateIds, weekOff, user) => {
  if (!user?.canManageCandidates) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only users with candidate manage permission can update week-off calendar');
  }

  // Validate candidate IDs
  const candidates = await Candidate.find({ _id: { $in: candidateIds } });
  if (candidates.length !== candidateIds.length) {
    const foundIds = candidates.map((c) => String(c._id));
    const missingIds = candidateIds.filter((id) => !foundIds.includes(String(id)));
    throw new ApiError(httpStatus.NOT_FOUND, `Some candidates not found: ${missingIds.join(', ')}`);
  }

  // Update week-off for all candidates
  const updateResult = await Candidate.updateMany(
    { _id: { $in: candidateIds } },
    { $set: { weekOff } }
  );

  const { queueSopReminderCheckForCandidate } = await import('./sopReminder.service.js');
  candidateIds.forEach((cid) => queueSopReminderCheckForCandidate(String(cid)));

  // Fetch updated candidates
  const updatedCandidates = await Candidate.find({ _id: { $in: candidateIds } })
    .populate('owner', 'name email')
    .populate('adminId', 'name email');

  return {
    success: true,
    message: `Week-off calendar updated for ${updateResult.modifiedCount} candidate(s)`,
    data: {
      updatedCount: updateResult.modifiedCount,
      candidates: updatedCandidates,
    },
  };
};

/**
 * Get week-off days for a candidate
 * @param {string} candidateId - Candidate ID
 * @returns {Promise<Object>} Candidate week-off information
 */
const getCandidateWeekOff = async (candidateId) => {
  const candidate = await Candidate.findById(candidateId)
    .select('weekOff fullName email')
    .populate('owner', 'name email');

  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }

  return {
    candidateId: candidate._id,
    candidateName: candidate.fullName,
    candidateEmail: candidate.email,
    weekOff: candidate.weekOff || [],
  };
};

/**
 * Assign shift to multiple candidates
 * @param {Array<string>} candidateIds - Array of candidate IDs
 * @param {string} shiftId - Shift ID to assign
 * @param {Object} user - Current user
 * @returns {Promise<Object>} Object with updated candidates and summary
 */
const assignShiftToCandidates = async (candidateIds, shiftId, user) => {
  if (!user?.canManageCandidates) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only users with candidate manage permission can assign shifts to candidates');
  }

  // Validate and fetch shift
  const shift = await getShiftById(shiftId);
  if (!shift) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Shift not found');
  }

  // Validate candidate IDs
  const candidates = await Candidate.find({ _id: { $in: candidateIds } });
  if (candidates.length !== candidateIds.length) {
    const foundIds = candidates.map((c) => String(c._id));
    const missingIds = candidateIds.filter((id) => !foundIds.includes(String(id)));
    throw new ApiError(httpStatus.NOT_FOUND, `Some candidates not found: ${missingIds.join(', ')}`);
  }

  // Update shift reference for all candidates
  const updateResult = await Candidate.updateMany(
    { _id: { $in: candidateIds } },
    { $set: { shift: shiftId } }
  );

  const { queueSopReminderCheckForCandidate } = await import('./sopReminder.service.js');
  candidateIds.forEach((cid) => queueSopReminderCheckForCandidate(String(cid)));

  // Fetch updated candidates with populated shift
  const updatedCandidates = await Candidate.find({ _id: { $in: candidateIds } })
    .populate('owner', 'name email')
    .populate('adminId', 'name email')
    .populate('shift', 'name description timezone startTime endTime isActive')
    .select('fullName email shift owner adminId');

  return {
    success: true,
    message: `Shift assigned to ${updateResult.modifiedCount} candidate(s)`,
    data: {
      updatedCount: updateResult.modifiedCount,
      shift: {
        id: shift.id,
        name: shift.name,
        description: shift.description,
        timezone: shift.timezone,
        startTime: shift.startTime,
        endTime: shift.endTime,
        isActive: shift.isActive,
      },
      candidates: updatedCandidates,
    },
  };
};

/**
 * Ensure a Candidate profile exists for a user who has the Candidate role.
 * Creates one if missing. No-op if user lacks Candidate role or already has a profile.
 * @param {ObjectId} userId
 * @returns {Promise<Candidate|null>}
 */
const ensureCandidateProfileForUser = async (userId) => {
  const { getRoleByName } = await import('./role.service.js');
  const candidateRole = await getRoleByName('Candidate');
  if (!candidateRole) return null;

  const user = await User.findById(userId);
  if (!user) return null;

  const hasCandidateRole = (user.roleIds || []).some(
    (id) => id && id.toString() === candidateRole._id.toString()
  );
  if (!hasCandidateRole) return null;

  const existing = await Candidate.findOne({ owner: userId });
  if (existing) {
    if (existing.isActive === false) {
      existing.isActive = true;
      await existing.save();
    }
    return existing;
  }

  // Find an admin user by looking for users with the Administrator role in their roleIds
  const Role = (await import('../models/role.model.js')).default;
  const adminRole = await Role.findOne({ name: 'Administrator', status: 'active' }).select('_id').lean();
  const adminUser = adminRole
    ? await User.findOne({ roleIds: adminRole._id }).select('_id').lean()
    : null;

  const candidate = await Candidate.create({
    owner: userId,
    adminId: adminUser?._id || userId,
    fullName: user.name || user.email,
    email: user.email,
    phoneNumber: user.phoneNumber || '0000000000',
    isProfileCompleted: 10,
  });
  return candidate;
};

/**
 * After admin creates a user with the Candidate role, apply optional ATS fields.
 * Runs after ensureCandidateProfileForUser (auto employee ID may be replaced if provided).
 * @param {import('mongoose').Types.ObjectId} userId
 * @param {{ employeeId?: string, shortBio?: string, joiningDate?: Date|string|null, department?: string, designation?: string, degree?: string, salaryRange?: string }} fields
 * @returns {Promise<import('mongoose').Document|null>}
 */
const applyInitialCandidateProfileFromAdmin = async (userId, fields) => {
  const { employeeId, shortBio, joiningDate, department, designation, degree, salaryRange } = fields || {};
  const hasEmployee = employeeId !== undefined && employeeId !== null && String(employeeId).trim() !== '';
  const hasBio = shortBio !== undefined && shortBio !== null && String(shortBio).trim() !== '';
  const hasJoin =
    joiningDate !== undefined && joiningDate !== null && joiningDate !== '';
  const hasDept = department !== undefined && department !== null && String(department).trim() !== '';
  const hasDesig = designation !== undefined && designation !== null && String(designation).trim() !== '';
  const hasDegree = degree !== undefined && degree !== null && String(degree).trim() !== '';
  const hasSalary = salaryRange !== undefined && salaryRange !== null && String(salaryRange).trim() !== '';
  if (!hasEmployee && !hasBio && !hasJoin && !hasDept && !hasDesig && !hasDegree && !hasSalary) return null;

  const candidate = await Candidate.findOne({ owner: userId });
  if (!candidate) return null;

  if (hasEmployee) {
    candidate.employeeId = String(employeeId).trim();
  }
  if (hasBio) {
    candidate.shortBio = String(shortBio).trim();
  }
  if (hasJoin) {
    const d = new Date(joiningDate);
    if (!Number.isNaN(d.getTime())) {
      candidate.joiningDate = d;
    }
  }
  if (hasDept) candidate.department = String(department).trim();
  if (hasDesig) candidate.designation = String(designation).trim();
  if (hasDegree) candidate.degree = String(degree).trim();
  if (hasSalary) candidate.salaryRange = String(salaryRange).trim();
  await candidate.save();
  return candidate;
};

/**
 * Mirror User phone fields onto the linked Candidate (owner).
 * Called after User is updated (admin or PATCH /auth/me) so ATS and User stay aligned.
 * Does not call updateUserById (avoids loops). Candidate.phoneNumber is required — if User clears phone, candidate keeps existing digits.
 * @param {import('mongoose').Types.ObjectId} ownerUserId
 * @param {{ phoneNumber?: string | null, countryCode?: string | null }} fields - omit key to skip that field
 */
const syncPhoneFromUserToCandidate = async (ownerUserId, fields) => {
  const { phoneNumber, countryCode } = fields;
  if (phoneNumber === undefined && countryCode === undefined) return;

  const candidate = await Candidate.findOne({ owner: ownerUserId });
  if (!candidate) return;

  if (phoneNumber !== undefined) {
    const v = phoneNumber === null || phoneNumber === '' ? '' : String(phoneNumber).trim();
    if (v === '') {
      logger.debug('syncPhoneFromUserToCandidate: preserving candidate phone; user phone cleared');
    } else {
      candidate.phoneNumber = v;
    }
  }
  if (countryCode !== undefined) {
    const cc = countryCode === null || countryCode === '' ? undefined : String(countryCode).trim();
    candidate.countryCode = cc;
  }
  await candidate.save();
};

/** User fields allowed for self-update via PATCH /auth/me/with-candidate */
const USER_ME_FIELDS = ['name', 'notificationPreferences', 'profilePicture'];

/** Candidate fields (excludes User fields). Sync name→fullName and profilePicture to candidate. */
const CANDIDATE_ME_FIELDS = [
  'fullName',
  'email',
  'phoneNumber',
  'shortBio',
  'sevisId',
  'ead',
  'visaType',
  'customVisaType',
  'countryCode',
  'degree',
  'supervisorName',
  'supervisorContact',
  'supervisorCountryCode',
  'salaryRange',
  'address',
  'qualifications',
  'experiences',
  'documents',
  'skills',
  'socialLinks',
  'salarySlips',
];

/**
 * Atomically update User and Candidate for PATCH /auth/me/with-candidate.
 * Syncs name→fullName and profilePicture to candidate. Returns { user, candidate }.
 */
const updateUserAndCandidateForMe = async (userId, body) => {
  const result = await queryCandidates({ owner: userId }, { limit: 1, page: 1 });
  const candidateDoc = result.results?.[0];
  if (!candidateDoc) {
    throw new ApiError(httpStatus.NOT_FOUND, 'No candidate profile found for your account');
  }

  const userPayload = {};
  for (const key of USER_ME_FIELDS) {
    if (body[key] !== undefined) userPayload[key] = body[key];
  }

  const candidatePayload = {};
  for (const key of CANDIDATE_ME_FIELDS) {
    if (body[key] !== undefined) candidatePayload[key] = body[key];
  }
  if (body.name !== undefined) candidatePayload.fullName = body.name;
  if (body.profilePicture !== undefined) candidatePayload.profilePicture = body.profilePicture;

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const user = await User.findById(userId).session(session);
    if (!user) {
      throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
    }
    if (userPayload.email !== undefined && (await User.isEmailTaken(userPayload.email, userId))) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Email already taken');
    }
    if (candidatePayload.email !== undefined && (await User.isEmailTaken(candidatePayload.email, userId))) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Email already taken');
    }
    if (Object.keys(userPayload).length > 0) {
      Object.assign(user, userPayload);
      await user.save({ session });
    }

    const candidate = await Candidate.findById(candidateDoc.id || candidateDoc._id).session(session);
    if (!candidate) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
    }
    if (Object.keys(candidatePayload).length > 0) {
      Object.assign(candidate, candidatePayload);
      if (candidatePayload.documents !== undefined) candidate.markModified('documents');
      if (candidatePayload.salarySlips !== undefined) candidate.markModified('salarySlips');
      candidate.isProfileCompleted = calculateProfileCompletion(candidate);
      candidate.isCompleted = candidate.isProfileCompleted === 100;
      await candidate.save({ session });
      if (candidatePayload.fullName !== undefined) user.name = candidatePayload.fullName;
      if (candidatePayload.email !== undefined) user.email = candidatePayload.email;
      if (candidatePayload.phoneNumber !== undefined) user.phoneNumber = candidatePayload.phoneNumber;
      if (candidatePayload.countryCode !== undefined) user.countryCode = candidatePayload.countryCode;
      if (
        Object.keys(candidatePayload).some((k) =>
          ['fullName', 'email', 'phoneNumber', 'countryCode'].includes(k)
        )
      ) {
        await user.save({ session });
      }
    }

    await session.commitTransaction();
    return { user: await User.findById(userId), candidate: await Candidate.findById(candidate._id) };
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

export {
  createCandidate,
  queryCandidates,
  getCandidateById,
  updateCandidateById,
  deleteCandidateById,
  exportAllCandidates,
  getAgentAssignmentSummary,
  isOwnerOrAdmin,
  calculateProfileCompletion,
  hasAllRequiredData,
  // Salary slip management
  addSalarySlipToCandidate,
  updateSalarySlipInCandidate,
  deleteSalarySlipFromCandidate,
  // Document verification
  verifyDocument,
  getDocumentStatus,
  getDocuments,
  getDocumentDownloadUrl,
  getSalarySlipDownloadUrl,
  getDocumentApiUrl,
  // Profile sharing
  shareCandidateProfile,
  getPublicCandidateProfile,
  // Email verification
  resendCandidateVerificationEmail,
  // Recruiter notes and feedback
  addRecruiterNote,
  addRecruiterFeedback,
  assignRecruiterToCandidate,
  listStudentAgentAssignments,
  listAgentUsersForAssignment,
  assignAgentToCandidate,
  // Joining and resign dates
  updateJoiningDate,
  updateResignDate,
  // Week-off calendar
  updateWeekOffForCandidates,
  getCandidateWeekOff,
  // Shift assignment
  assignShiftToCandidates,
  ensureCandidateProfileForUser,
  applyInitialCandidateProfileFromAdmin,
  updateUserAndCandidateForMe,
  syncPhoneFromUserToCandidate,
  getCandidateByOwnerForMe,
  getResignStatusByOwnerId,
};


