import crypto from 'crypto';
import XLSX from 'xlsx';
import { createUser, queryRecruitersForExport } from './user.service.js';
import { getRoleByName } from './role.service.js';

/** Import rows without a Password column still need a valid User.password. */
const generateImportPassword = () => {
  const base = crypto.randomBytes(8).toString('hex');
  return `Rx${base}1`;
};

/**
 * Export recruiters (users with Recruiter role via roleIds) to Excel
 */
const exportRecruitersToExcel = async (filter = {}, options = {}, requester = null) => {
  const { results, totalResults, capped, exportMax } = await queryRecruitersForExport(
    filter,
    options,
    requester
  );

  const exportData = results.map((u) => {
    const obj = typeof u.toJSON === 'function' ? u.toJSON() : u;
    const domains = Array.isArray(obj.domain) ? obj.domain : obj.domain ? [obj.domain] : [];
    return {
      Name: obj.name || '',
      Email: obj.email || '',
      'Country Code': obj.countryCode || 'IN',
      Phone: obj.phoneNumber || '',
      Education: obj.education || '',
      Domain: domains.join('|'),
      Location: obj.location || '',
      'Profile Summary': obj.profileSummary || '',
      Status: obj.status || '',
      'Created At': obj.createdAt ? new Date(obj.createdAt).toISOString() : '',
    };
  });

  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(exportData);
  worksheet['!cols'] = [{ wch: 25 }, { wch: 30 }, { wch: 14 }, { wch: 20 }, { wch: 25 }, { wch: 30 }, { wch: 25 }, { wch: 40 }, { wch: 12 }, { wch: 25 }];
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Recruiters');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  return { buffer, totalResults, capped, exportMax };
};

/**
 * Get recruiter Excel template (headers only)
 */
const getRecruiterTemplateBuffer = () => {
  const headers = [{
    Name: 'John Doe',
    Email: 'john@example.com',
    'Country Code': 'IN',
    Phone: '9876543210',
    Education: 'B.Tech',
    Domain: 'IT|Healthcare',
    Location: 'Mumbai',
    'Profile Summary': 'Experienced recruiter',
  }];
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(headers);
  worksheet['!cols'] = [{ wch: 25 }, { wch: 30 }, { wch: 14 }, { wch: 20 }, { wch: 25 }, { wch: 30 }, { wch: 25 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Recruiters');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
};

/**
 * Import recruiters from Excel file
 */
const importRecruitersFromExcel = async (fileBuffer) => {
  const recruiterRole = await getRoleByName('Recruiter');
  const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(worksheet);

  const results = {
    successful: [],
    failed: [],
    summary: { total: data.length, successful: 0, failed: 0 },
  };

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const name = row.Name || row.name || '';
    const email = (row.Email || row.email || '').toString().trim().toLowerCase();
    const passwordRaw = row.Password ?? row.password ?? '';
    const passwordProvided = Boolean(String(passwordRaw).trim());
    const password = passwordProvided ? String(passwordRaw).trim() : generateImportPassword();
    const countryCodeRaw = row['Country Code'] || row.countryCode || row.CountryCode || 'IN';
    const countryCode = typeof countryCodeRaw === 'string' ? countryCodeRaw.trim().toUpperCase() || 'IN' : 'IN';
    const phone = row.Phone || row.phone || row.phoneNumber || '';
    const education = row.Education || row.education || '';
    const domainRaw = row.Domain || row.domain || '';
    const domainArr = typeof domainRaw === 'string'
      ? domainRaw.split(/[|,;]/).map((d) => d.trim()).filter(Boolean)
      : Array.isArray(domainRaw) ? domainRaw.filter(Boolean) : [];
    const location = row.Location || row.location || '';
    const profileSummary = row['Profile Summary'] || row.profileSummary || row.ProfileSummary || '';

    try {
      if (!name || !email) {
        throw new Error('Name and Email are required');
      }
      if (
        passwordProvided &&
        (password.length < 8 || !/\d/.test(password) || !/[a-zA-Z]/.test(password))
      ) {
        throw new Error('Password must be at least 8 characters with 1 letter and 1 number');
      }
      const summaryTrimmed = profileSummary ? profileSummary.toString().trim() : '';
      if (summaryTrimmed.length > 4000) {
        throw new Error('Profile Summary must be at most 4000 characters');
      }

      const user = await createUser({
        name: name.toString().trim(),
        email,
        password,
        isEmailVerified: true,
        status: 'active',
        roleIds: recruiterRole ? [recruiterRole._id] : [],
        phoneNumber: phone ? phone.toString().replace(/\D/g, '').trim() || undefined : undefined,
        countryCode: countryCode || undefined,
        education: education ? education.toString().trim() : undefined,
        domain: domainArr.length > 0 ? domainArr : undefined,
        location: location ? location.toString().trim() : undefined,
        profileSummary: summaryTrimmed || undefined,
      });

      results.successful.push({ row: i + 2, email, id: user._id.toString() });
      results.summary.successful += 1;
    } catch (err) {
      results.failed.push({
        row: i + 2,
        email: email || '(empty)',
        error: err.message || 'Unknown error',
      });
      results.summary.failed += 1;
    }
  }

  return results;
};

export { exportRecruitersToExcel, getRecruiterTemplateBuffer, importRecruitersFromExcel };
