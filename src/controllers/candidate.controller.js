import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import { 
  createCandidate, 
  queryCandidates, 
  getCandidateById, 
  updateCandidateById, 
  deleteCandidateById, 
  exportAllCandidates,
  addSalarySlipToCandidate,
  updateSalarySlipInCandidate,
  deleteSalarySlipFromCandidate,
  verifyDocument,
  getDocumentStatus,
  getDocuments,
  getDocumentDownloadUrl,
  shareCandidateProfile,
  getPublicCandidateProfile,
  resendCandidateVerificationEmail,
  addRecruiterNote,
  addRecruiterFeedback,
  assignRecruiterToCandidate,
  updateJoiningDate,
  updateResignDate,
  updateWeekOffForCandidates,
  getCandidateWeekOff,
  assignShiftToCandidates
} from '../services/candidate.service.js';
import { importCandidatesFromExcel } from '../services/candidateExcel.service.js';
import { sendCandidateProfileShareEmail, sendEmail } from '../services/email.service.js';
import { logActivity } from '../services/recruiterActivity.service.js';
import { userHasRecruiterRole } from '../utils/roleHelpers.js';
import { getUserPermissionContext } from '../services/permission.service.js';

const canManageCandidates = (req) => req.authContext?.permissions?.has('candidates.manage') ?? false;

const create = catchAsync(async (req, res) => {
  req.user.canManageCandidates = canManageCandidates(req);
  const ownerId = req.user.canManageCandidates && req.body.owner ? req.body.owner : req.user._id;
  const isMultiple = Array.isArray(req.body);

  if (isMultiple && !req.user.canManageCandidates) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only users with candidate manage permission can create multiple candidates');
  }

  const result = await createCandidate(ownerId, req.body);
  
  if (isMultiple) {
    // Handle multiple candidates response
    if (result.summary.failed === 0) {
      // All candidates created successfully
      res.status(httpStatus.CREATED).send({
        message: 'All candidates created successfully',
        ...result
      });
    } else if (result.summary.successful === 0) {
      // All candidates failed
      res.status(httpStatus.BAD_REQUEST).send({
        message: 'Failed to create any candidates',
        ...result
      });
    } else {
      // Partial success
      res.status(httpStatus.MULTI_STATUS).send({
        message: 'Some candidates created successfully, some failed',
        ...result
      });
    }
  } else {
    // Handle single candidate response (existing behavior)
    res.status(httpStatus.CREATED).send(result);
  }
});

const list = catchAsync(async (req, res) => {
  req.user.canManageCandidates = canManageCandidates(req);
  const filter = pick(req.query, [
    'owner',
    'fullName',
    'email',
    'employeeId',
    'skills',
    'skillLevel',
    'experienceLevel',
    'minYearsOfExperience',
    'maxYearsOfExperience',
    'salaryRangeMin',
    'salaryRangeMax',
    'location',
    'city',
    'state',
    'country',
    'degree',
    'visaType',
    'skillMatchMode',
  ]);
  if (!req.user.canManageCandidates) {
    filter.owner = req.user._id;
  }
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await queryCandidates(filter, options);
  res.send(result);
});

const get = catchAsync(async (req, res) => {
  req.user.canManageCandidates = canManageCandidates(req);
  const candidate = await getCandidateById(req.params.candidateId);
  if (!candidate) throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  if (!req.user.canManageCandidates && String(candidate.owner) !== String(req.user._id)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  res.send(candidate);
});

const update = catchAsync(async (req, res) => {
  req.user.canManageCandidates = canManageCandidates(req);
  const candidate = await updateCandidateById(req.params.candidateId, req.body, req.user);
  res.send(candidate);
});

const remove = catchAsync(async (req, res) => {
  req.user.canManageCandidates = canManageCandidates(req);
  if (!req.user.canManageCandidates) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only users with candidate manage permission can delete a candidate');
  }
  await deleteCandidateById(req.params.candidateId);
  res.status(httpStatus.NO_CONTENT).send();
});

/** Get current user's own candidate (auth only, no candidates.read). Used by my-profile for role 'user'. */
const getMyCandidate = catchAsync(async (req, res) => {
  const result = await queryCandidates({ owner: req.user._id }, { limit: 1, page: 1 });
  const candidate = result.results?.[0] || null;
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'No candidate profile found for your account');
  }
  res.send(candidate);
});

/** Update current user's own candidate (auth only, no candidates.read). */
const updateMyCandidate = catchAsync(async (req, res) => {
  const result = await queryCandidates({ owner: req.user._id }, { limit: 1, page: 1 });
  const candidate = result.results?.[0] || null;
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'No candidate profile found for your account');
  }
  const updated = await updateCandidateById(candidate._id || candidate.id, req.body, req.user);
  res.send(updated);
});

export { create, list, get, getMyCandidate, updateMyCandidate, update, remove };

const exportProfile = catchAsync(async (req, res) => {
  req.user.canManageCandidates = canManageCandidates(req);
  const candidate = await getCandidateById(req.params.candidateId);
  if (!candidate) throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  if (!req.user.canManageCandidates && String(candidate.owner) !== String(req.user._id)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  const { email } = req.body;
  const subject = `Candidate Profile: ${candidate.fullName}`;
  const lines = [
    `Name: ${candidate.fullName}`,
    `Email: ${candidate.email}`,
    `Phone: ${candidate.phoneNumber}`,
    candidate.profilePicture?.url ? `Profile Picture: ${candidate.profilePicture.url}` : null,
    candidate.shortBio ? `Bio: ${candidate.shortBio}` : null,
    candidate.sevisId ? `SEVIS ID: ${candidate.sevisId}` : null,
    candidate.ead ? `EAD: ${candidate.ead}` : null,
    candidate.visaType ? `Visa Type: ${candidate.visaType}` : null,
    candidate.customVisaType ? `Custom Visa Type: ${candidate.customVisaType}` : null,
    candidate.countryCode ? `Country Code: ${candidate.countryCode}` : null,
    candidate.degree ? `Degree: ${candidate.degree}` : null,
    candidate.supervisorName ? `Supervisor: ${candidate.supervisorName}` : null,
    candidate.supervisorContact ? `Supervisor Contact: ${candidate.supervisorContact}` : null,
    candidate.supervisorCountryCode ? `Supervisor Country Code: ${candidate.supervisorCountryCode}` : null,
    candidate.salaryRange ? `Salary Range: ${candidate.salaryRange}` : null,
    candidate.address?.streetAddress ? `Street Address: ${candidate.address.streetAddress}` : null,
    candidate.address?.streetAddress2 ? `Street Address 2: ${candidate.address.streetAddress2}` : null,
    candidate.address?.city ? `City: ${candidate.address.city}` : null,
    candidate.address?.state ? `State: ${candidate.address.state}` : null,
    candidate.address?.zipCode ? `Zip Code: ${candidate.address.zipCode}` : null,
    candidate.address?.country ? `Country: ${candidate.address.country}` : null,
    '',
    'Qualifications:',
    ...candidate.qualifications.map((q, i) => `  ${i + 1}. ${q.degree} - ${q.institute} (${q.startYear || ''}-${q.endYear || ''})`),
    '',
    'Experiences:',
    ...candidate.experiences.map((e, i) => `  ${i + 1}. ${e.role} @ ${e.company} (${e.startDate ? new Date(e.startDate).getFullYear() : ''}-${e.currentlyWorking ? 'Present' : (e.endDate ? new Date(e.endDate).getFullYear() : '')})`),
    '',
    'Social Links:',
    ...candidate.socialLinks.map((s, i) => `  ${i + 1}. ${s.platform}: ${s.url}`),
  ].filter(Boolean);
  await sendEmail(email, subject, lines.join('\n'));
  res.status(httpStatus.NO_CONTENT).send();
});

const exportAll = catchAsync(async (req, res) => {
  req.user.canManageCandidates = canManageCandidates(req);
  if (!req.user.canManageCandidates) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only users with candidate manage permission can export all candidates');
  }

  const { email } = req.body;
  
  // Get filters from query parameters
  const filters = pick(req.query, ['owner', 'fullName', 'email']);
  
  // Export all candidates
  const exportData = await exportAllCandidates(filters);
  
  if (email) {
    // Send via email
    const subject = `All Candidates Export - ${exportData.totalCandidates} candidates`;
    const csvContent = generateCSVFormat(exportData);
    
    await sendEmail(email, subject, csvContent);
    
    res.status(httpStatus.OK).send({
      message: `CSV export sent successfully to ${email}`,
      totalCandidates: exportData.totalCandidates,
      exportedAt: exportData.exportedAt
    });
  } else {
    // Return CSV data directly
    const csvContent = generateCSVFormat(exportData);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="candidates-export-${new Date().toISOString().split('T')[0]}.csv"`);
    res.status(httpStatus.OK).send(csvContent);
  }
});


// Helper function to generate CSV format
const generateCSVFormat = (exportData) => {
  const headers = [
    'ID',
    'Full Name',
    'Email',
    'Phone Number',
    'Profile Picture',
    'Short Bio',
    'SEVIS ID',
    'EAD',
    'Visa Type',
    'Custom Visa Type',
    'Country Code',
    'Degree',
    'Supervisor Name',
    'Supervisor Contact',
    'Supervisor Country Code',
    'Salary Range',
    'Street Address',
    'Street Address 2',
    'City',
    'State',
    'Zip Code',
    'Country',
    'Owner',
    'Owner Email',
    'Admin',
    'Admin Email',
    'Profile Completion %',
    'Status',
    'Created At',
    'Updated At',
    'Qualifications',
    'Experiences',
    'Skills',
    'Social Links',
    'Documents',
    'Salary Slips'
  ];

  const rows = exportData.data.map(candidate => [
    candidate.id,
    `"${candidate.fullName || ''}"`,
    candidate.email || '',
    candidate.phoneNumber || '',
    candidate.profilePicture?.url || '',
    `"${(candidate.shortBio || '').replace(/"/g, '""')}"`,
    candidate.sevisId || '',
    candidate.ead || '',
    candidate.visaType || '',
    candidate.customVisaType || '',
    candidate.countryCode || '',
    `"${candidate.degree || ''}"`,
    `"${candidate.supervisorName || ''}"`,
    candidate.supervisorContact || '',
    candidate.supervisorCountryCode || '',
    candidate.salaryRange || '',
    candidate.address?.streetAddress || '',
    candidate.address?.streetAddress2 || '',
    candidate.address?.city || '',
    candidate.address?.state || '',
    candidate.address?.zipCode || '',
    candidate.address?.country || '',
    `"${candidate.owner || ''}"`,
    candidate.ownerEmail || '',
    `"${candidate.adminId || ''}"`,
    candidate.adminEmail || '',
    candidate.isProfileCompleted || 0,
    candidate.isCompleted ? 'Completed' : 'Incomplete',
    new Date(candidate.createdAt).toLocaleDateString(),
    new Date(candidate.updatedAt).toLocaleDateString(),
    `"${candidate.qualifications.map(q => `${q.degree} - ${q.institute}`).join('; ')}"`,
    `"${candidate.experiences.map(e => `${e.role} @ ${e.company}${e.currentlyWorking ? ' (Currently Working)' : ''}`).join('; ')}"`,
    `"${candidate.skills.map(s => `${s.name} (${s.level})`).join('; ')}"`,
    `"${candidate.socialLinks.map(sl => `${sl.platform}: ${sl.url}`).join('; ')}"`,
    `"${candidate.documents.map(d => d.label || d.originalName).join('; ')}"`,
    `"${candidate.salarySlips.map(ss => `${ss.month} ${ss.year}`).join('; ')}"`
  ]);

  const csvContent = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
  return csvContent;
};

export { exportProfile, exportAll };

// Salary slip management controllers
const addSalarySlip = catchAsync(async (req, res) => {
  req.user.canManageCandidates = canManageCandidates(req);
  const candidate = await addSalarySlipToCandidate(req.params.candidateId, req.body, req.user);
  res.status(httpStatus.OK).send(candidate);
});

const updateSalarySlip = catchAsync(async (req, res) => {
  req.user.canManageCandidates = canManageCandidates(req);
  const candidate = await updateSalarySlipInCandidate(
    req.params.candidateId,
    req.params.salarySlipIndex,
    req.body,
    req.user
  );
  res.status(httpStatus.OK).send(candidate);
});

const deleteSalarySlip = catchAsync(async (req, res) => {
  req.user.canManageCandidates = canManageCandidates(req);
  const candidate = await deleteSalarySlipFromCandidate(
    req.params.candidateId,
    req.params.salarySlipIndex,
    req.user
  );
  res.status(httpStatus.OK).send(candidate);
});

export { addSalarySlip, updateSalarySlip, deleteSalarySlip };

// Document verification controllers
const verifyDocumentStatus = catchAsync(async (req, res) => {
  req.user.canManageCandidates = canManageCandidates(req);
  const candidate = await verifyDocument(
    req.params.candidateId,
    req.params.documentIndex,
    req.body,
    req.user
  );
  res.status(httpStatus.OK).send({
    success: true,
    message: 'Document status updated successfully',
    data: candidate
  });
});

const getCandidateDocumentStatus = catchAsync(async (req, res) => {
  req.user.canManageCandidates = canManageCandidates(req);
  const candidate = await getDocumentStatus(req.params.candidateId, req.user);
  res.status(httpStatus.OK).send({
    success: true,
    data: candidate
  });
});

const getCandidateDocuments = catchAsync(async (req, res) => {
  req.user.canManageCandidates = canManageCandidates(req);
  const documents = await getDocuments(req.params.candidateId, req.user);
  res.status(httpStatus.OK).send({
    success: true,
    data: documents
  });
});

const downloadDocument = catchAsync(async (req, res) => {
  const { candidateId, documentIndex } = req.params;

  // documentAuth sets req.user but not req.authContext; compute canManageCandidates for isOwnerOrAdmin check
  const authContext = await getUserPermissionContext(req.user);
  req.user.canManageCandidates = authContext?.permissions?.has('candidates.manage') ?? false;

  const documentData = await getDocumentDownloadUrl(candidateId, parseInt(documentIndex, 10), req.user);
  
  // Check if client wants JSON response (for programmatic access)
  const acceptsJson = req.headers.accept && req.headers.accept.includes('application/json');
  
  if (acceptsJson) {
    // Return JSON with the presigned URL for programmatic access
    res.status(httpStatus.OK).json({
      success: true,
      data: {
        url: documentData.url,
        fileName: documentData.fileName,
        mimeType: documentData.mimeType,
        size: documentData.size
      }
    });
  } else {
    // Redirect to the presigned URL for direct browser access
    res.redirect(documentData.url);
  }
});

export { verifyDocumentStatus, getCandidateDocumentStatus, getCandidateDocuments, downloadDocument };

// Share candidate profile controller (per SHARE_CANDIDATE_FORM.md)
const shareProfile = catchAsync(async (req, res) => {
  req.user.canManageCandidates = canManageCandidates(req);
  const { candidateId } = req.params;
  const { email, withDoc } = req.body;

  const shareResult = await shareCandidateProfile(candidateId, { email, withDoc }, req.user);

  const candidate = await getCandidateById(candidateId);
  if (!candidate) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }

  const candidateData = {
    candidateName: candidate.fullName,
    candidateEmail: candidate.email
  };
  const emailShareData = {
    publicUrl: shareResult.publicUrl,
    withDoc,
    sharedBy: req.user.name
  };
  await sendCandidateProfileShareEmail(email, candidateData, emailShareData);
  const { notifyByEmail } = await import('../services/notification.service.js');
  notifyByEmail(email, {
    type: 'general',
    title: 'Candidate profile shared with you',
    message: `${candidateData.candidateName} was shared by ${req.user.name}.`,
    link: shareResult.publicUrl,
  }).catch(() => {});

  res.status(httpStatus.OK).send({
    success: true,
    message: 'Candidate profile shared successfully',
    data: shareResult
  });
});

// Public candidate profile controller
const getPublicProfile = catchAsync(async (req, res) => {
  const { candidateId } = req.params;
  const { token, data } = req.query;
  
  if (!token || !data) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Missing required parameters');
  }
  
  // Get the public candidate profile data
  const candidateData = await getPublicCandidateProfile(candidateId, token, data);
  
  // Generate HTML page
  const html = generatePublicProfileHTML(candidateData);
  
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});


// Helper function to get preview button
const getPreviewButton = (document) => {
  const mimeType = document.mimeType || '';
  const fileName = document.originalName || document.label || '';
  const extension = fileName.split('.').pop()?.toLowerCase() || '';
  
  // Check if document can be previewed in browser
  const canPreview = 
    mimeType.startsWith('image/') ||
    mimeType === 'application/pdf' ||
    mimeType.startsWith('text/') ||
    ['txt', 'rtf', 'html', 'htm', 'xml', 'json', 'csv'].includes(extension) ||
    mimeType === 'application/json' ||
    mimeType === 'text/csv' ||
    mimeType === 'text/xml';
  
  if (canPreview) {
    return `<a href="${document.url}" class="document-preview" target="_blank" rel="noopener noreferrer">Preview</a>`;
  }
  
  // For non-previewable files, show a "View" button instead
  return `<a href="${document.url}" class="document-preview" target="_blank" rel="noopener noreferrer">Preview</a>`;
};

// Helper function to generate public profile HTML
const generatePublicProfileHTML = (candidateData) => {
  const { withDoc } = candidateData;
  
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${candidateData.fullName} - Candidate Profile</title>
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }
            
            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                line-height: 1.5;
                color: #2c3e50;
                background: #f8f9fa;
                margin: 0;
                padding: 0;
            }
            
            .container {
                max-width: 1000px;
                margin: 20px auto;
                padding: 20px;
                background: white;
                box-shadow: 0 4px 20px rgba(0,0,0,0.1);
                border-radius: 8px;
            }
            
            .header {
                background: linear-gradient(135deg, #1a365d 0%, #2c5282 100%);
                color: white;
                padding: 25px;
                margin-bottom: 25px;
                text-align: center;
                border-radius: 8px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            
            
            .profile-header {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 15px;
            }
            
            .profile-picture {
                width: 90px;
                height: 90px;
                border-radius: 8px;
                overflow: hidden;
                border: 3px solid #ffffff;
                box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            }
            
            .profile-picture img {
                width: 100%;
                height: 100%;
                object-fit: cover;
            }
            
            .profile-info {
                text-align: left;
            }
            
            .logo {
                position: relative;
                z-index: 1;
                margin-bottom: 20px;
            }
            
            .logo img {
                max-height: 60px;
                max-width: 200px;
                width: auto;
                height: auto;
            }
            
            .profile-title {
                font-size: 28px;
                font-weight: 700;
                margin-bottom: 8px;
                text-shadow: 0 1px 2px rgba(0,0,0,0.1);
            }
            
            .profile-subtitle {
                font-size: 16px;
                opacity: 0.95;
                font-weight: 300;
                text-align: center;
            }
            
            .main-content {
                display: flex;
                flex-direction: column;
                gap: 20px;
                margin-bottom: 25px;
            }
            
            .info-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
                gap: 15px;
            }
            
            .social-links-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
                gap: 15px;
            }
            
            .skills-container {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
            }
            
            .section {
                margin-bottom: 20px;
                border: 1px solid #e1e8ed;
                padding: 20px;
                background: #ffffff;
                border-radius: 6px;
                box-shadow: 0 1px 3px rgba(0,0,0,0.05);
            }
            
            .section-title {
                color: #1a365d;
                font-size: 18px;
                font-weight: 700;
                margin-bottom: 15px;
                padding-bottom: 8px;
                border-bottom: 2px solid #1a365d;
                text-transform: uppercase;
                letter-spacing: 0.8px;
            }
            
            .info-item {
                margin-bottom: 12px;
                padding: 12px;
                background: #f8f9fa;
                border: 1px solid #e1e8ed;
                border-left: 4px solid #1a365d;
                border-radius: 4px;
                transition: all 0.2s ease;
            }
            
            .info-item:hover {
                background: #f1f3f4;
                box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            }
            
            .info-label {
                font-weight: 600;
                color: #1a365d;
                margin-bottom: 5px;
                font-size: 13px;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            
            .info-value {
                color: #2c3e50;
                font-size: 15px;
                line-height: 1.4;
            }
            
            .list-item {
                background: #ffffff;
                border: 1px solid #e1e8ed;
                padding: 15px;
                margin-bottom: 12px;
                border-left: 4px solid #1a365d;
                border-radius: 4px;
                box-shadow: 0 1px 3px rgba(0,0,0,0.05);
                transition: all 0.2s ease;
            }
            
            .list-item:hover {
                box-shadow: 0 2px 6px rgba(0,0,0,0.1);
            }
            
            .list-item-title {
                font-weight: 700;
                color: #1a365d;
                margin-bottom: 8px;
                font-size: 16px;
            }
            
            .list-item-subtitle {
                color: #4a5568;
                margin-bottom: 8px;
                font-size: 14px;
                font-weight: 500;
            }
            
            .list-item-description {
                color: #64748b;
                font-size: 13px;
                font-style: italic;
                line-height: 1.4;
            }
            
            .skill-tag {
                display: inline-block;
                background: #e3f2fd;
                color: #1a365d;
                padding: 6px 12px;
                border: 1px solid #bbdefb;
                border-radius: 20px;
                font-size: 12px;
                font-weight: 500;
                margin: 3px;
                transition: all 0.2s ease;
            }
            
            .skill-tag:hover {
                background: #bbdefb;
                transform: translateY(-1px);
            }
            
            .document-item {
                background: #ffffff;
                border: 1px solid #e1e8ed;
                padding: 12px 16px;
                margin-bottom: 10px;
                border-left: 4px solid #1a365d;
                border-radius: 4px;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 15px;
                box-shadow: 0 1px 3px rgba(0,0,0,0.05);
                transition: all 0.2s ease;
            }
            
            .document-item:hover {
                box-shadow: 0 2px 6px rgba(0,0,0,0.1);
            }
            
            
            
            .document-name {
                font-weight: 600;
                color: #1a365d;
                word-break: break-word;
                flex: 1;
                min-width: 0;
                font-size: 14px;
            }
            
            .document-size {
                color: #64748b;
                font-size: 11px;
                margin-bottom: 3px;
            }
            
            .document-actions {
                display: flex;
                gap: 5px;
                flex-shrink: 0;
            }
            
            .document-preview {
                background: #1a365d;
                color: white;
                padding: 6px 12px;
                border-radius: 4px;
                text-decoration: none;
                font-weight: 500;
                font-size: 12px;
                border: none;
                cursor: pointer;
                transition: all 0.2s ease;
            }
            
            .document-preview:hover {
                background: #2c5282;
                transform: translateY(-1px);
                box-shadow: 0 2px 4px rgba(0,0,0,0.2);
            }
            
            
            
            .shared-info {
                background: #f8f9fa;
                border: 1px solid #e1e8ed;
                border-radius: 6px;
                padding: 15px;
                margin-top: 20px;
                text-align: center;
                box-shadow: 0 1px 3px rgba(0,0,0,0.05);
            }
            
            .shared-info-title {
                color: #1a365d;
                font-weight: 700;
                margin-bottom: 8px;
                font-size: 14px;
            }
            
            .shared-info-text {
                color: #4a5568;
                font-size: 13px;
            }
            
            .footer {
                background: linear-gradient(135deg, #1a365d 0%, #2c5282 100%);
                color: white;
                padding: 20px;
                text-align: center;
                border-radius: 6px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            
            .footer p {
                margin-bottom: 5px;
                opacity: 0.95;
                font-size: 13px;
            }
            
            .footer a {
                color: #ffffff;
                text-decoration: none;
                font-weight: 500;
            }
            
            .footer a:hover {
                text-decoration: underline;
            }
            
            @media (max-width: 768px) {
                .main-content {
                    gap: 15px;
                }
                
                .container {
                    padding: 15px;
                    margin: 10px;
                }
                
                .header {
                    padding: 20px;
                }
                
                .profile-header {
                    flex-direction: column;
                    text-align: center;
                    gap: 12px;
                }
                
                .profile-picture {
                    width: 70px;
                    height: 70px;
                }
                
                .profile-info {
                    text-align: center;
                }
                
                .profile-title {
                    font-size: 22px;
                }
                
                .section {
                    padding: 15px;
                }
                
                .info-grid {
                    grid-template-columns: 1fr;
                }
                
                .social-links-grid {
                    grid-template-columns: 1fr;
                }
                
                .skills-container {
                    justify-content: center;
                }
                
                .document-item {
                    flex-direction: column;
                    align-items: flex-start;
                    padding: 12px;
                }
                
                .document-actions {
                    flex-direction: row;
                    gap: 8px;
                    margin-top: 8px;
                }
                
                .document-preview {
                    width: auto;
                    text-align: center;
                }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <div class="logo">
                    <img src="https://dharwinone.com/assets/images/company-logos/logo.jpeg" alt="Dharwin" />
                </div>
                <div class="profile-header">
                    ${candidateData.profilePicture?.url ? `
                    <div class="profile-picture">
                        <img src="${candidateData.profilePicture.url}" alt="Profile Picture" />
                    </div>
                    ` : ''}
                    <div class="profile-info">
                        <h1 class="profile-title">${candidateData.fullName}</h1>
                        <p class="profile-subtitle">Candidate Profile</p>
                    </div>
                </div>
            </div>
            
            <div class="main-content">
                <!-- Personal Info Section -->
                <div class="section">
                    <h2 class="section-title">👤 Personal Information</h2>
                    <div class="info-grid">
                        <div class="info-item">
                            <div class="info-label">Full Name</div>
                            <div class="info-value">${candidateData.fullName}</div>
                        </div>
                        
                        <div class="info-item">
                            <div class="info-label">Email</div>
                            <div class="info-value">${candidateData.email}</div>
                        </div>
                        
                        <div class="info-item">
                            <div class="info-label">Phone</div>
                            <div class="info-value">${candidateData?.countryCode === "IN" ? "+91 " : "+1 "} ${candidateData.phoneNumber}</div>
                        </div>
                        
                        ${candidateData.shortBio ? `
                        <div class="info-item">
                            <div class="info-label">Bio</div>
                            <div class="info-value">${candidateData.shortBio}</div>
                        </div>
                        ` : ''}
                        
                        ${candidateData.sevisId ? `
                        <div class="info-item">
                            <div class="info-label">SEVIS ID</div>
                            <div class="info-value">${candidateData.sevisId}</div>
                        </div>
                        ` : ''}
                        
                        ${candidateData.ead ? `
                        <div class="info-item">
                            <div class="info-label">EAD</div>
                            <div class="info-value">${candidateData.ead}</div>
                        </div>
                        ` : ''}
                        
                        ${candidateData.visaType ? `
                        <div class="info-item">
                            <div class="info-label">Visa Type</div>
                            <div class="info-value">${candidateData.visaType}</div>
                        </div>
                        ` : ''}
                        
                        ${candidateData.customVisaType ? `
                        <div class="info-item">
                            <div class="info-label">Custom Visa Type</div>
                            <div class="info-value">${candidateData.customVisaType}</div>
                        </div>
                        ` : ''}
                        
                        ${candidateData.degree ? `
                        <div class="info-item">
                            <div class="info-label">Degree</div>
                            <div class="info-value">${candidateData.degree}</div>
                        </div>
                        ` : ''}
                        
                        ${candidateData.supervisorName ? `
                        <div class="info-item">
                            <div class="info-label">Supervisor</div>
                            <div class="info-value">${candidateData.supervisorName}</div>
                            <div class="info-value">${candidateData?.supervisorCountryCode === "IN" ? "+91 " : "+1 "} ${candidateData.supervisorContact}</div>
                        </div>
                        ` : ''}
                        
                        ${candidateData.address?.streetAddress ? `
                        <div class="info-item">
                            <div class="info-label">Address</div>
                            <div class="info-value">
                                ${candidateData.address.streetAddress}
                                ${candidateData.address.streetAddress2 ? `<br/>${candidateData.address.streetAddress2}` : ''}
                                ${candidateData.address.city ? `<br/>${candidateData.address.city}` : ''}
                                ${candidateData.address.state ? `, ${candidateData.address.state}` : ''}
                                ${candidateData.address.zipCode ? ` ${candidateData.address.zipCode}` : ''}
                                ${candidateData.address.country ? `<br/>${candidateData.address.country}` : ''}
                            </div>
                        </div>
                        ` : ''}
                    </div>
                </div>
                
                <!-- Social Links Section -->
                ${candidateData.socialLinks && candidateData.socialLinks.length > 0 ? `
                <div class="section">
                    <h2 class="section-title">🔗 Social Links</h2>
                    <div class="social-links-grid">
                        ${candidateData.socialLinks.map(sl => `
                        <div class="info-item">
                            <div class="info-label">${sl.platform}</div>
                            <div class="info-value"><a href="${sl.url}" target="_blank" style="color: #36af4c; text-decoration: none;">${sl.url}</a></div>
                        </div>
                        `).join('')}
                    </div>
                </div>
                ` : ''}
                
                <!-- Skills Section -->
                ${candidateData.skills && candidateData.skills.length > 0 ? `
                <div class="section">
                    <h2 class="section-title">🛠️ Skills</h2>
                    <div class="skills-container">
                        ${candidateData.skills.map(s => `
                        <span class="skill-tag">${s.name} (${s.level})</span>
                        `).join('')}
                    </div>
                </div>
                ` : ''}
                
                <!-- Work Experience Section -->
                ${candidateData.experiences && candidateData.experiences.length > 0 ? `
                <div class="section">
                    <h2 class="section-title">💼 Work Experience</h2>
                    ${candidateData.experiences.map(e => `
                    <div class="list-item">
                        <div class="list-item-title">${e.role}</div>
                        <div class="list-item-subtitle">${e.company}</div>
                        ${e.startDate || e.endDate || e.currentlyWorking ? `<div class="list-item-subtitle">${e.startDate ? new Date(e.startDate).toLocaleDateString() : ''} - ${e.currentlyWorking ? 'Present' : (e.endDate ? new Date(e.endDate).toLocaleDateString() : '')}</div>` : ''}
                        ${e.description ? `<div class="list-item-description">${e.description}</div>` : ''}
                    </div>
                    `).join('')}
                </div>
                ` : ''}
                
                <!-- Qualifications Section -->
                ${candidateData.qualifications && candidateData.qualifications.length > 0 ? `
                <div class="section">
                    <h2 class="section-title">🎓 Qualifications</h2>
                    ${candidateData.qualifications.map(q => `
                    <div class="list-item">
                        <div class="list-item-title">${q.degree}</div>
                        <div class="list-item-subtitle">${q.institute}${q.location ? ` - ${q.location}` : ''}</div>
                        ${q.startYear || q.endYear ? `<div class="list-item-subtitle">${q.startYear || ''} - ${q.endYear || ''}</div>` : ''}
                        ${q.description ? `<div class="list-item-description">${q.description}</div>` : ''}
                    </div>
                    `).join('')}
                </div>
                ` : ''}
                
                <!-- Documents Section -->
                ${withDoc ? `
                <div class="section">
                    <h2 class="section-title">📄 Documents</h2>
                    ${candidateData.documents && candidateData.documents.length > 0 ? `
                    ${candidateData.documents.map(d => `
                    <div class="document-item">
                        <div class="document-name">${d.label || d.originalName}</div>
                        <div class="document-actions">
                            ${getPreviewButton(d)}
                        </div>
                    </div>
                    `).join('')}
                    ` : `
                    <div class="list-item">
                        <div class="list-item-title">No documents available</div>
                        <div class="list-item-description">This candidate has not uploaded any documents yet.</div>
                    </div>
                    `}
                </div>
                ` : ''}
                
                <!-- Salary Slip Section -->
                ${withDoc ? `
                <div class="section">
                    <h2 class="section-title">💰 Salary Slips</h2>
                    ${candidateData.salarySlips && candidateData.salarySlips.length > 0 ? `
                    ${candidateData.salarySlips.map(ss => `
                    <div class="document-item">
                        <div class="document-name">${ss.month} ${ss.year}</div>
                        <div class="document-actions">
                            ${ss.documentUrl ? `<a href="${ss.documentUrl}" class="document-preview" target="_blank" rel="noopener noreferrer">Preview</a>` : ''}
                        </div>
                    </div>
                    `).join('')}
                    ` : `
                    <div class="list-item">
                        <div class="list-item-title">No salary slips available</div>
                        <div class="list-item-description">This candidate has not uploaded any salary slips yet.</div>
                    </div>
                    `}
                </div>
                ` : ''}
            </div>
            
            <div class="shared-info">
                <div class="shared-info-title">Profile Shared</div>
                <div class="shared-info-text">This profile was shared by ${candidateData.sharedBy} on ${new Date(candidateData.sharedAt).toLocaleDateString()}</div>
            </div>
            
            <div class="footer">
                <p>This candidate profile was shared through Dharwin Business Solutions</p>
                <p>© 2024 Dharwin. All rights reserved.</p>
                <!-- <p><a href="#">Visit our website</a></p> -->
            </div>
        </div>
        
    </body>
    </html>
  `;
};

export { shareProfile, getPublicProfile };

// Resend email verification controller
const resendVerificationEmail = catchAsync(async (req, res) => {
  req.user.canManageCandidates = canManageCandidates(req);
  if (!req.user.canManageCandidates) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only users with candidate manage permission can resend verification emails');
  }
  const { candidateId } = req.params;
  const result = await resendCandidateVerificationEmail(candidateId);
  res.status(httpStatus.OK).send(result);
});

export { resendVerificationEmail };

// Recruiter notes and feedback controllers
const addNote = catchAsync(async (req, res) => {
  req.user.canManageCandidates = canManageCandidates(req);
  const { candidateId } = req.params;
  const { note } = req.body;
  const recruiterId = req.user._id || req.user.id;
  const candidate = await addRecruiterNote(candidateId, note, recruiterId);
  if (await userHasRecruiterRole(req.user)) {
    await logActivity(recruiterId, 'note_added', {
      candidateId,
      description: 'Added note to candidate',
      metadata: { noteLength: note?.length },
    });
  }
  res.status(httpStatus.OK).send(candidate);
});

const addFeedback = catchAsync(async (req, res) => {
  req.user.canManageCandidates = canManageCandidates(req);
  const { candidateId } = req.params;
  const { feedback, rating } = req.body;
  const recruiterId = req.user._id || req.user.id;
  const candidate = await addRecruiterFeedback(candidateId, feedback, rating, recruiterId);
  if (await userHasRecruiterRole(req.user)) {
    await logActivity(recruiterId, 'feedback_added', {
      candidateId,
      description: 'Added feedback to candidate',
      metadata: { rating },
    });
  }
  res.status(httpStatus.OK).send(candidate);
});

const assignRecruiter = catchAsync(async (req, res) => {
  req.user.canManageCandidates = canManageCandidates(req);
  if (!req.user.canManageCandidates) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only users with candidate manage permission can assign recruiters');
  }
  const { candidateId } = req.params;
  const { recruiterId } = req.body;
  const assignedBy = req.user._id || req.user.id;
  const candidate = await assignRecruiterToCandidate(candidateId, recruiterId);
  if (await userHasRecruiterRole(req.user)) {
    await logActivity(assignedBy, 'candidate_screened', {
      candidateId,
      description: `Assigned recruiter to candidate`,
      metadata: { assignedRecruiterId: recruiterId },
    });
  }
  res.status(httpStatus.OK).send(candidate);
});

export { addNote, addFeedback, assignRecruiter };

/**
 * Update candidate joining date
 */
const updateJoining = catchAsync(async (req, res) => {
  req.user.canManageCandidates = canManageCandidates(req);
  const { candidateId } = req.params;
  const { joiningDate } = req.body;

  const candidate = await updateJoiningDate(candidateId, joiningDate, req.user);
  
  res.status(httpStatus.OK).send({
    success: true,
    message: 'Joining date updated successfully',
    data: candidate,
  });
});

/**
 * Update candidate resign date (makes candidate inactive)
 */
const updateResign = catchAsync(async (req, res) => {
  req.user.canManageCandidates = canManageCandidates(req);
  const { candidateId } = req.params;
  const { resignDate } = req.body;

  const candidate = await updateResignDate(candidateId, resignDate, req.user);
  
  // Determine message based on whether resign date was cleared or set
  let message = 'Resign date updated successfully.';
  if (!resignDate) {
    message = 'Resign date cleared successfully. Candidate is now active.';
  } else {
    const resignDateObj = new Date(resignDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    resignDateObj.setHours(0, 0, 0, 0);
    
    if (resignDateObj <= today) {
      message = 'Resign date updated successfully. Candidate is now inactive.';
    } else {
      message = `Resign date updated successfully. Candidate will be deactivated on ${resignDateObj.toLocaleDateString()}.`;
    }
  }
  
  res.status(httpStatus.OK).send({
    success: true,
    message,
    data: candidate,
  });
});

/**
 * Update week-off calendar for multiple candidates
 */
const updateWeekOff = catchAsync(async (req, res) => {
  req.user.canManageCandidates = canManageCandidates(req);
  const { candidateIds, weekOff } = req.body;

  const result = await updateWeekOffForCandidates(candidateIds, weekOff, req.user);
  
  res.status(httpStatus.OK).send(result);
});

/**
 * Get week-off calendar for a candidate
 */
const getWeekOff = catchAsync(async (req, res) => {
  const { candidateId } = req.params;
  
  const result = await getCandidateWeekOff(candidateId);
  
  res.status(httpStatus.OK).send({
    success: true,
    data: result,
  });
});

/**
 * Assign shift to multiple candidates
 */
const assignShift = catchAsync(async (req, res) => {
  req.user.canManageCandidates = canManageCandidates(req);
  const { candidateIds, shiftId } = req.body;

  const result = await assignShiftToCandidates(candidateIds, shiftId, req.user);
  
  res.status(httpStatus.OK).send(result);
});

export { updateJoining, updateResign, updateWeekOff, getWeekOff, assignShift };

// Excel Import controller
const importExcel = catchAsync(async (req, res) => {
  console.log('Import Excel Request received');
  console.log('Has file:', !!req.file);
  console.log('File details:', req.file ? { name: req.file.originalname, size: req.file.size, mimetype: req.file.mimetype } : 'No file');
  
  req.user.canManageCandidates = canManageCandidates(req);
  if (!req.user.canManageCandidates) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only users with candidate manage permission can import candidates from Excel');
  }
  
  if (!req.file) {
    console.error('No file in request');
    throw new ApiError(httpStatus.BAD_REQUEST, 'Excel file is required. Please upload an Excel file.');
  }
  
  const createdBy = req.user.id || req.user._id;
  console.log('Created by:', createdBy);
  
  try {
    console.log('Starting import...');
    const result = await importCandidatesFromExcel(req.file.buffer, createdBy);
    console.log('Import result:', result.summary);
    
    if (result.summary.failed === 0) {
      res.status(httpStatus.CREATED).send({
        message: 'All candidates imported successfully',
        ...result,
      });
    } else if (result.summary.successful === 0) {
      res.status(httpStatus.BAD_REQUEST).send({
        message: 'Failed to import any candidates',
        ...result,
      });
    } else {
      res.status(httpStatus.MULTI_STATUS).send({
        message: 'Some candidates imported successfully, some failed',
        ...result,
      });
    }
  } catch (error) {
    console.error('Excel import error:', error);
    console.error('Error stack:', error.stack);
    throw new ApiError(httpStatus.BAD_REQUEST, error.message || 'Failed to import candidates from Excel');
  }
});

export { importExcel };

