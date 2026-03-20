import XLSX from 'xlsx';
import User from '../models/user.model.js';
import { createUser } from './user.service.js';
import { getRoleByName } from './role.service.js';

/**
 * Export recruiters (users with Recruiter role via roleIds) to Excel
 */
const exportRecruitersToExcel = async () => {
  const recruiterRole = await getRoleByName('Recruiter');
  const query = recruiterRole
    ? { roleIds: recruiterRole._id, status: { $nin: ['deleted'] } }
    : { status: 'impossible-match' }; // no recruiter role = no results
  const users = await User.find(query)
    .select('name email phoneNumber countryCode education domain location profileSummary status createdAt')
    .sort({ createdAt: -1 });

  const exportData = users.map((u) => {
    const domains = Array.isArray(u.domain) ? u.domain : (u.domain ? [u.domain] : []);
    return {
      Name: u.name || '',
      Email: u.email || '',
      Password: '',
      'Country Code': u.countryCode || 'IN',
      Phone: u.phoneNumber || '',
      Education: u.education || '',
      Domain: domains.join('|'),
      Location: u.location || '',
      'Profile Summary': u.profileSummary || '',
      Status: u.status || '',
      'Created At': u.createdAt ? new Date(u.createdAt).toISOString() : '',
    };
  });

  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(exportData);
  worksheet['!cols'] = [{ wch: 25 }, { wch: 30 }, { wch: 20 }, { wch: 14 }, { wch: 20 }, { wch: 25 }, { wch: 30 }, { wch: 25 }, { wch: 40 }, { wch: 12 }, { wch: 25 }];
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Recruiters');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
};

/**
 * Get recruiter Excel template (headers only)
 */
const getRecruiterTemplateBuffer = () => {
  const headers = [{
    Name: 'John Doe',
    Email: 'john@example.com',
    Password: 'password1',
    'Country Code': 'IN',
    Phone: '9876543210',
    Education: 'B.Tech',
    Domain: 'IT|Healthcare',
    Location: 'Mumbai',
    'Profile Summary': 'Experienced recruiter',
  }];
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(headers);
  worksheet['!cols'] = [{ wch: 25 }, { wch: 30 }, { wch: 20 }, { wch: 14 }, { wch: 20 }, { wch: 25 }, { wch: 30 }, { wch: 25 }, { wch: 40 }];
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
    const password = row.Password || row.password || '';
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
      if (!name || !email || !password) {
        throw new Error('Name, Email, and Password are required');
      }
      if (password.length < 8 || !/\d/.test(password) || !/[a-zA-Z]/.test(password)) {
        throw new Error('Password must be at least 8 characters with 1 letter and 1 number');
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
        profileSummary: profileSummary ? profileSummary.toString().trim() : undefined,
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
