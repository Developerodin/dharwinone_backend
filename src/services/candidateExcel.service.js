import XLSX from 'xlsx';
import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import { createCandidate } from './candidate.service.js';

// Country-specific phone validation rules
const PHONE_RULES = {
  IN: { regex: /^[6-9]\d{9}$/, length: 10, example: '9876543210' },
  US: { regex: /^\d{10}$/, length: 10, example: '2025551234' },
  CA: { regex: /^\d{10}$/, length: 10, example: '4165551234' },
  GB: { regex: /^[1-9]\d{9,10}$/, length: [10, 11], example: '7700900123' },
  AU: { regex: /^[2-4789]\d{8}$/, length: 9, example: '412345678' },
  PK: { regex: /^3\d{9}$/, length: 10, example: '3001234567' },
  BD: { regex: /^1[3-9]\d{8}$/, length: 10, example: '1712345678' },
  PH: { regex: /^9\d{9}$/, length: 10, example: '9171234567' },
  SG: { regex: /^[689]\d{7}$/, length: 8, example: '91234567' },
  AE: { regex: /^[2-9]\d{8}$/, length: 9, example: '501234567' },
  SA: { regex: /^5\d{8}$/, length: 9, example: '501234567' },
  ZA: { regex: /^[6-9]\d{8}$/, length: 9, example: '712345678' },
  NG: { regex: /^[7-9]\d{9}$/, length: 10, example: '8012345678' },
  KE: { regex: /^7\d{8}$/, length: 9, example: '712345678' },
  DE: { regex: /^[1-9]\d{9,11}$/, length: [10, 11, 12], example: '15112345678' },
  FR: { regex: /^[1-9]\d{8}$/, length: 9, example: '612345678' },
  ES: { regex: /^[6-9]\d{8}$/, length: 9, example: '612345678' },
  IT: { regex: /^3\d{8,9}$/, length: [9, 10], example: '3123456789' },
  BR: { regex: /^[1-9]\d{9,10}$/, length: [10, 11], example: '11987654321' },
  MX: { regex: /^1\d{9}$/, length: 10, example: '1234567890' },
  AR: { regex: /^[2-9]\d{9}$/, length: 10, example: '1123456789' },
  CN: { regex: /^1[3-9]\d{9}$/, length: 11, example: '13812345678' },
  JP: { regex: /^[1-9]\d{8,9}$/, length: [9, 10], example: '9012345678' },
  KR: { regex: /^[1-9]\d{8,9}$/, length: [9, 10], example: '1012345678' },
  TH: { regex: /^[6-9]\d{8}$/, length: 9, example: '812345678' },
  VN: { regex: /^9\d{8}$/, length: 9, example: '912345678' },
  ID: { regex: /^8\d{9,10}$/, length: [10, 11], example: '81234567890' },
  MY: { regex: /^1[0-9]\d{7,8}$/, length: [9, 10], example: '123456789' },
  NZ: { regex: /^[2-9]\d{7}$/, length: 8, example: '21234567' },
};

/**
 * Validate phone number for a specific country
 */
function validatePhoneForCountry(phoneNumber, countryCode) {
  if (!phoneNumber) return { valid: false, error: 'Phone number is required' };
  
  // Remove all non-digit characters
  const digits = phoneNumber.replace(/\D/g, '');
  
  const rule = PHONE_RULES[countryCode];
  if (!rule) {
    // For countries without specific rules, accept 6-15 digits
    if (digits.length >= 6 && digits.length <= 15) {
      return { valid: true, digits };
    }
    return { valid: false, error: `Phone must be 6-15 digits (country ${countryCode})` };
  }
  
  if (!rule.regex.test(digits)) {
    const lengthMsg = Array.isArray(rule.length) 
      ? `${rule.length[0]}-${rule.length[rule.length - 1]} digits`
      : `${rule.length} digits`;
    return { 
      valid: false, 
      error: `Invalid ${countryCode} phone number. Expected ${lengthMsg} (e.g., ${rule.example})` 
    };
  }
  
  return { valid: true, digits };
}

/**
 * Parse multi-sheet candidate Excel file
 */
function parseMultiSheetExcel(fileBuffer) {
  const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
  
  // Only Personal Info is required
  if (!workbook.SheetNames.includes('Personal Info')) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Missing required sheet: Personal Info');
  }
  
  const candidates = [];
  
  // Parse Personal Info
  const personalInfoSheet = workbook.Sheets['Personal Info'];
  const personalInfoData = XLSX.utils.sheet_to_json(personalInfoSheet, { header: 1 });
  
  if (personalInfoData.length < 2) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Personal Info sheet must have at least a header row and one data row');
  }
  
  const headers = personalInfoData[0].map(h => String(h || '').trim());
  
  // Process each candidate from Personal Info
  for (let i = 1; i < personalInfoData.length; i++) {
    const row = personalInfoData[i];
    if (row && row.some(cell => cell !== undefined && cell !== null && cell !== '')) {
      const candidate = {
        qualifications: [],
        experiences: [],
        skills: [],
        socialLinks: [],
      };
      
      headers.forEach((header, index) => {
        const value = row[index] != null ? String(row[index]).trim() : '';
        const normalized = header.toLowerCase().replace(/\s+/g, '');
        
        switch (normalized) {
          case 'fullname': candidate.fullName = value; break;
          case 'email': candidate.email = value; break;
          case 'phonenumber': candidate.phoneNumber = value; break;
          case 'countrycode': candidate.countryCode = value || 'US'; break;
          case 'password': candidate.password = value; break;
          case 'shortbio': candidate.shortBio = value; break;
          case 'sevisid': candidate.sevisId = value; break;
          case 'ead': candidate.ead = value; break;
          case 'degree': candidate.degree = value; break;
          case 'visatype': candidate.visaType = value; break;
          case 'customvisatype': candidate.customVisaType = value; break;
          case 'supervisorname': candidate.supervisorName = value; break;
          case 'supervisorcontact': candidate.supervisorContact = value; break;
          case 'supervisorcountrycode': candidate.supervisorCountryCode = value; break;
          case 'salaryrange': candidate.salaryRange = value; break;
          case 'streetaddress': candidate.streetAddress = value; break;
          case 'streetaddress2': candidate.streetAddress2 = value; break;
          case 'city': candidate.city = value; break;
          case 'state': candidate.state = value; break;
          case 'zipcode': candidate.zipCode = value; break;
          case 'country': candidate.country = value; break;
        }
      });
      
      candidates.push(candidate);
    }
  }
  
  // Parse optional Social Links sheet
  if (workbook.SheetNames.includes('Social Links')) {
    const socialLinksSheet = workbook.Sheets['Social Links'];
    const socialLinksData = XLSX.utils.sheet_to_json(socialLinksSheet, { header: 1 });
    
    for (let i = 1; i < socialLinksData.length; i++) {
      const row = socialLinksData[i];
      if (row && row.length >= 3) {
        const fullName = String(row[0] || '').trim();
        const platform = String(row[1] || '').trim();
        const url = String(row[2] || '').trim();
        
        if (fullName && platform && url) {
          const candidate = candidates.find(c => c.fullName === fullName);
          if (candidate) {
            candidate.socialLinks.push({ platform, url });
          }
        }
      }
    }
  }
  
  // Parse optional Skills sheet
  if (workbook.SheetNames.includes('Skills')) {
    const skillsSheet = workbook.Sheets['Skills'];
    const skillsData = XLSX.utils.sheet_to_json(skillsSheet, { header: 1 });
    
    for (let i = 1; i < skillsData.length; i++) {
      const row = skillsData[i];
      if (row && row.length >= 2) {
        const fullName = String(row[0] || '').trim();
        const name = String(row[1] || '').trim();
        const level = String(row[2] || 'Beginner').trim();
        const category = String(row[3] || '').trim();
        
        if (fullName && name) {
          const candidate = candidates.find(c => c.fullName === fullName);
          if (candidate) {
            candidate.skills.push({ name, level, category });
          }
        }
      }
    }
  }
  
  // Parse optional Qualification sheet
  if (workbook.SheetNames.includes('Qualification')) {
    const qualificationSheet = workbook.Sheets['Qualification'];
    const qualificationData = XLSX.utils.sheet_to_json(qualificationSheet, { header: 1 });
    
    for (let i = 1; i < qualificationData.length; i++) {
      const row = qualificationData[i];
      if (row && row.length >= 3) {
        const fullName = String(row[0] || '').trim();
        const degree = String(row[1] || '').trim();
        const institute = String(row[2] || '').trim();
        const location = String(row[3] || '').trim();
        const startYear = row[4];
        const endYear = row[5];
        const description = String(row[6] || '').trim();
        
        if (fullName && degree && institute) {
          const candidate = candidates.find(c => c.fullName === fullName);
          if (candidate) {
            candidate.qualifications.push({
              degree,
              institute,
              location,
              startYear: startYear ? parseInt(String(startYear), 10) : null,
              endYear: endYear ? parseInt(String(endYear), 10) : null,
              description,
            });
          }
        }
      }
    }
  }
  
  // Parse optional Work Experience sheet
  if (workbook.SheetNames.includes('Work Experience')) {
    const workExpSheet = workbook.Sheets['Work Experience'];
    const workExpData = XLSX.utils.sheet_to_json(workExpSheet, { header: 1 });
    
    for (let i = 1; i < workExpData.length; i++) {
      const row = workExpData[i];
      if (row && row.length >= 3) {
        const fullName = String(row[0] || '').trim();
        const company = String(row[1] || '').trim();
        const role = String(row[2] || '').trim();
        const startDate = row[3];
        const endDate = row[4];
        const description = String(row[5] || '').trim();
        const currentlyWorking = String(row[6] || '').toLowerCase() === 'true';
        
        if (fullName && company && role) {
          const candidate = candidates.find(c => c.fullName === fullName);
          if (candidate) {
            candidate.experiences.push({
              company,
              role,
              startDate: startDate ? new Date(startDate) : null,
              endDate: endDate && !currentlyWorking ? new Date(endDate) : null,
              currentlyWorking,
              description,
            });
          }
        }
      }
    }
  }
  
  return candidates;
}

/**
 * Validate a single candidate
 */
function validateCandidate(candidate, index) {
  const errors = [];
  
  if (!candidate.fullName) errors.push('Full Name is required');
  if (!candidate.email) errors.push('Email is required');
  if (!candidate.email?.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) errors.push('Invalid email format');
  if (!candidate.phoneNumber) errors.push('Phone Number is required');
  
  // Validate phone number with country code
  const phoneValidation = validatePhoneForCountry(candidate.phoneNumber, candidate.countryCode || 'US');
  if (!phoneValidation.valid) {
    errors.push(phoneValidation.error);
  } else {
    candidate.phoneNumber = phoneValidation.digits;
  }
  
  // Validate supervisor phone if provided
  if (candidate.supervisorContact) {
    const supervisorPhoneValidation = validatePhoneForCountry(
      candidate.supervisorContact, 
      candidate.supervisorCountryCode || candidate.countryCode || 'US'
    );
    if (!supervisorPhoneValidation.valid) {
      errors.push(`Supervisor ${supervisorPhoneValidation.error}`);
    } else {
      candidate.supervisorContact = supervisorPhoneValidation.digits;
    }
  }
  
  // Add default values for required array fields if missing
  if (!candidate.qualifications || candidate.qualifications.length === 0) {
    candidate.qualifications = [{ degree: 'N/A', institute: 'N/A', location: 'N/A', startYear: 2020, endYear: 2024 }];
  }
  if (!candidate.experiences || candidate.experiences.length === 0) {
    candidate.experiences = [{ company: 'N/A', role: 'N/A', startDate: new Date('2020-01-01'), currentlyWorking: false }];
  }
  if (!candidate.skills || candidate.skills.length === 0) {
    candidate.skills = [{ name: 'General', level: 'Beginner' }];
  }
  if (!candidate.socialLinks || candidate.socialLinks.length === 0) {
    candidate.socialLinks = [{ platform: 'LinkedIn', url: 'https://linkedin.com' }];
  }
  
  return {
    isValid: errors.length === 0,
    errors: errors.length > 0 ? `${errors.join(', ')}` : null,
  };
}

/**
 * Import candidates from Excel file
 */
const importCandidatesFromExcel = async (fileBuffer, createdBy) => {
  try {
    const parsedCandidates = parseMultiSheetExcel(fileBuffer);
    
    if (parsedCandidates.length === 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'No candidates found in Excel file');
    }
    
    const results = {
      successful: [],
      failed: [],
      summary: {
        total: parsedCandidates.length,
        successful: 0,
        failed: 0,
      },
    };
    
    // Validate and import each candidate
    for (let i = 0; i < parsedCandidates.length; i++) {
      const candidate = parsedCandidates[i];
      
      try {
        // Validate
        const validation = validateCandidate(candidate, i);
        if (!validation.isValid) {
          throw new Error(validation.errors);
        }
        
        // Format for createCandidate service
        const candidateData = {
          role: 'user',
          fullName: candidate.fullName,
          email: candidate.email,
          phoneNumber: candidate.phoneNumber,
          countryCode: candidate.countryCode || 'US',
          password: candidate.password || 'Welcome@123',
          shortBio: candidate.shortBio,
          sevisId: candidate.sevisId,
          ead: candidate.ead,
          degree: candidate.degree,
          visaType: candidate.visaType || 'H1B',
          ...(candidate.customVisaType && { customVisaType: candidate.customVisaType }),
          supervisorName: candidate.supervisorName,
          supervisorContact: candidate.supervisorContact,
          ...(candidate.supervisorCountryCode && { supervisorCountryCode: candidate.supervisorCountryCode }),
          salaryRange: candidate.salaryRange,
          address: {
            streetAddress: candidate.streetAddress || '',
            streetAddress2: candidate.streetAddress2 || '',
            city: candidate.city || '',
            state: candidate.state || '',
            zipCode: candidate.zipCode || '',
            country: candidate.country || '',
          },
          qualifications: candidate.qualifications,
          experiences: candidate.experiences,
          skills: candidate.skills,
          socialLinks: candidate.socialLinks,
        };
        
        // Create candidate
        const created = await createCandidate(createdBy, candidateData);
        
        results.successful.push({
          row: i + 2,
          candidateId: created.id,
          fullName: created.fullName,
          email: created.email,
        });
        results.summary.successful += 1;
      } catch (error) {
        results.failed.push({
          row: i + 2,
          fullName: candidate.fullName || 'Unknown',
          email: candidate.email || 'Unknown',
          error: error.message || 'Unknown error',
        });
        results.summary.failed += 1;
      }
    }
    
    return results;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(httpStatus.BAD_REQUEST, `Failed to import candidates: ${error.message}`);
  }
};

export { importCandidatesFromExcel, validatePhoneForCountry };
