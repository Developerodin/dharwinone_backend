import httpStatus from 'http-status';
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

/** User may have canManageCandidates set by controller (from candidates.manage permission). */
const isOwnerOrAdmin = (user, candidate) => {
  if (!candidate) return false;
  const hasManage = user?.canManageCandidates === true;
  return hasManage || String(candidate.owner) === String(user?.id || user?._id);
};

// Helper function to generate document API endpoint URL (never expires)
// Optionally accepts a token parameter to include in the URL for direct browser access
const getDocumentApiUrl = (candidateId, documentIndex, token = null) => {
  // Use backend API URL - construct from environment or use default
  const backendUrl = process.env.BACKEND_URL || config.frontendBaseUrl || `http://localhost:${config.port}`;
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

      // Sync joiningDate to Student if user has a Student profile (for attendance)
      const student = await Student.findOne({ user: resolvedOwnerId });
      if (student) {
        student.joiningDate = candidate.joiningDate;
        await student.save();
      }
      
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
    mongoFilter.employeeId = { $regex: filter.employeeId, $options: 'i' };
  }
  
  // Skills matching
  if (filter.skills) {
    const skillsArray = Array.isArray(filter.skills) ? filter.skills : [filter.skills];
    const skillNames = skillsArray.map(s => s.trim());
    
    if (filter.skillMatchMode === 'all') {
      // All skills must match - use $all with regex
      mongoFilter['skills.name'] = {
        $all: skillNames.map(name => new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
      };
    } else {
      // At least one skill must match (default)
      mongoFilter['skills.name'] = {
        $in: skillNames.map(name => new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
      };
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
  
  // Degree matching (can match top-level degree or qualifications)
  if (filter.degree) {
    orConditions.push(
      { degree: { $regex: filter.degree, $options: 'i' } },
      { 'qualifications.degree': { $regex: filter.degree, $options: 'i' } }
    );
  }
  
  // Visa type matching
  if (filter.visaType) {
    orConditions.push(
      { visaType: { $regex: filter.visaType, $options: 'i' } },
      { customVisaType: { $regex: filter.visaType, $options: 'i' } }
    );
  }
  
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
  // Build base MongoDB filter
  const mongoFilter = buildAdvancedFilter(filter);
  
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
      } else {
        candidateObj.isEmailVerified = false;
        candidateObj.countryCode = null;
      }
      return candidateObj;
    });
    
    return {
      results: candidatesWithEmailStatus,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      totalResults: total
    };
  }
  // Use simple pagination for non-experience-based filters
  const result = await Candidate.paginate(mongoFilter, options);
    
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
      
      for (const candidate of result.results) {
        await candidate.populate([
          { path: 'owner', select: 'name email isEmailVerified countryCode' },
          { path: 'adminId', select: 'name email' }
        ]);
      }
      
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
        } else {
          candidateObj.isEmailVerified = false;
          candidateObj.countryCode = null;
        }
        return candidateObj;
      });
    }
    
    return result;
};

const getCandidateById = async (id) => {
  const candidate = await Candidate.findById(id);
  if (candidate) {
    await candidate.populate([
      { path: 'owner', select: 'name email countryCode' },
      { path: 'adminId', select: 'name email' },
      { path: 'assignedRecruiter', select: 'name email role' },
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
      
      // Sync phone if changed
      if (updateBody.phoneNumber) {
        userUpdateData.phoneNumber = updateBody.phoneNumber;
      }
      
      // Only update if there are fields to sync
      if (Object.keys(userUpdateData).length > 0) {
        console.log('Syncing candidate data to user:', candidate.owner, userUpdateData);
        await updateUserById(candidate.owner, userUpdateData);
        console.log('User synced successfully');
      }
    } catch (error) {
      // Log error but don't fail the candidate update
      console.error('Failed to sync candidate data to user:', error.message);
      console.error('Error stack:', error.stack);
    }
  }
  
  return candidate;
};

const deleteCandidateById = async (id) => {
  const candidate = await getCandidateById(id);
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }
  
  // Get the owner user account
  const ownerUser = await User.findById(candidate.owner);
  
  // Check if this user has any other candidates before deleting the candidate
  // This check must happen before deleting the candidate
  let hasOtherCandidates = false;
  if (ownerUser && ownerUser.email === candidate.email) {
    const otherCandidates = await Candidate.findOne({ 
      owner: ownerUser._id,
      _id: { $ne: id } // Exclude the current candidate
    });
    hasOtherCandidates = !!otherCandidates;
  }
  
  // Delete the candidate
  await candidate.deleteOne();
  
  // If owner user exists, email matches candidate email, and no other candidates exist,
  // delete the user account and all associated tokens to prevent login
  if (ownerUser && ownerUser.email === candidate.email && !hasOtherCandidates) {
    // Delete all tokens associated with this user to invalidate all sessions
    await Token.deleteMany({ user: ownerUser._id });
    // Delete the user account
    await ownerUser.deleteOne();
  }
  
  return candidate;
};

const exportAllCandidates = async (filters = {}) => {
  // Get all candidates with optional filters
  const candidates = await Candidate.find(filters)
    .populate('owner', 'name email')
    .populate('adminId', 'name email')
    .sort({ createdAt: -1 });

  // Format candidates data for export
  const exportData = candidates.map(candidate => ({
    id: candidate.id,
    employeeId: candidate.employeeId || '',
    fullName: candidate.fullName,
    email: candidate.email,
    phoneNumber: candidate.phoneNumber,
    shortBio: candidate.shortBio || '',
    sevisId: candidate.sevisId || '',
    ead: candidate.ead || '',
    visaType: candidate.visaType || '',
    customVisaType: candidate.customVisaType || '',
    degree: candidate.degree || '',
    supervisorName: candidate.supervisorName || '',
    supervisorContact: candidate.supervisorContact || '',
    owner: candidate.owner ? candidate.owner.name : '',
    ownerEmail: candidate.owner ? candidate.owner.email : '',
    adminId: candidate.adminId ? candidate.adminId.name : '',
    adminEmail: candidate.adminId ? candidate.adminId.email : '',
    isProfileCompleted: candidate.isProfileCompleted,
    isCompleted: candidate.isCompleted,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    qualifications: candidate.qualifications.map(q => ({
      degree: q.degree,
      institute: q.institute,
      location: q.location || '',
      startYear: q.startYear || '',
      endYear: q.endYear || '',
      description: q.description || ''
    })),
    experiences: candidate.experiences.map(e => ({
      company: e.company,
      role: e.role,
      startDate: e.startDate ? new Date(e.startDate).toISOString().split('T')[0] : '',
      endDate: e.endDate ? new Date(e.endDate).toISOString().split('T')[0] : '',
      description: e.description || ''
    })),
    skills: candidate.skills.map(s => ({
      name: s.name,
      level: s.level,
      category: s.category || ''
    })),
    socialLinks: candidate.socialLinks.map(sl => ({
      platform: sl.platform,
      url: sl.url
    })),
    documents: candidate.documents.map(d => ({
      label: d.label || '',
      url: d.url || '',
      originalName: d.originalName || '',
      size: d.size || '',
      mimeType: d.mimeType || ''
    })),
    salarySlips: candidate.salarySlips.map(ss => ({
      month: ss.month || '',
      year: ss.year || '',
      documentUrl: ss.documentUrl || '',
      originalName: ss.originalName || '',
      size: ss.size || '',
      mimeType: ss.mimeType || ''
    }))
  }));

  return {
    totalCandidates: exportData.length,
    exportedAt: new Date().toISOString(),
    data: exportData
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
const resendCandidateVerificationEmail = async (candidateId) => {
  // Get the candidate
  const candidate = await Candidate.findById(candidateId);
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }

  // Find the user associated with this candidate
  // First try to find by email (most common case)
  let user = await getUserByEmail(candidate.email);
  
  // If not found by email, try to find by owner ID
  if (!user && candidate.owner) {
    user = await getUserById(candidate.owner);
  }

  // If user doesn't exist, throw error
  if (!user) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No user account found for this candidate. Cannot send verification email.');
  }

  // Check if email is already verified
  if (user.isEmailVerified) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Email is already verified for this candidate.');
  }

  // Generate verification token and send email
  const verifyEmailToken = await generateVerifyEmailToken(user);
  await sendVerificationEmail(candidate.email, verifyEmailToken);

  return {
    success: true,
    message: 'Verification email sent successfully',
    candidateId: candidate._id,
    candidateEmail: candidate.email,
    candidateName: candidate.fullName
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

  const { notify } = await import('./notification.service.js');
  const candidateName = candidate.fullName || candidate.email || 'a candidate';
  notify(recruiterId, {
    type: 'recruiter',
    title: 'Candidate assigned',
    message: `You have been assigned as recruiter to ${candidateName}.`,
    link: `/candidates/${candidateId}`,
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

  if (!user?.canManageCandidates) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only users with candidate manage permission can update joining date');
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

  if (!user?.canManageCandidates) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only users with candidate manage permission can update resign date');
  }

  // Validate that resign date is after joining date if both exist
  if (candidate.joiningDate && resignDate && new Date(resignDate) < new Date(candidate.joiningDate)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Resign date cannot be before joining date');
  }

  // Allow clearing resign date (setting to null) to reactivate candidate
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

export {
  createCandidate,
  queryCandidates,
  getCandidateById,
  updateCandidateById,
  deleteCandidateById,
  exportAllCandidates,
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
  // Joining and resign dates
  updateJoiningDate,
  updateResignDate,
  // Week-off calendar
  updateWeekOffForCandidates,
  getCandidateWeekOff,
  // Shift assignment
  assignShiftToCandidates,
};


