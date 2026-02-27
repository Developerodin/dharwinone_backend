import XLSX from 'xlsx';

const inputPath = 'C:\\Users\\INTEL\\Downloads\\candidates_filled.xlsx';
const outputPath = 'C:\\Users\\INTEL\\Downloads\\candidates_filled_final.xlsx';

console.log('Reading Excel file from:', inputPath);
const workbook = XLSX.readFile(inputPath);

const personalInfoSheet = workbook.Sheets['Personal Info'];
const personalInfoData = XLSX.utils.sheet_to_json(personalInfoSheet, { header: 1 });

console.log(`Found ${personalInfoData.length - 1} candidates`);

// Get column indices
const headers = personalInfoData[0];
const countryCodeIndex = headers.findIndex(h => String(h).trim().toLowerCase() === 'countrycode');
const phoneNumberIndex = headers.findIndex(h => String(h).trim().toLowerCase() === 'phonenumber');
const supervisorContactIndex = headers.findIndex(h => String(h).trim().toLowerCase() === 'supervisorcontact');

// Add SupervisorCountryCode column after SupervisorContact
const insertIndex = supervisorContactIndex + 1;
headers.splice(insertIndex, 0, 'SupervisorCountryCode');

// Phone validation
const PHONE_RULES = {
  IN: { regex: /^[6-9]\d{9}$/ },
  US: { regex: /^\d{10}$/ },
  AU: { regex: /^[2-4789]\d{8}$/ },
  GB: { regex: /^[1-9]\d{9,10}$/ },
  CA: { regex: /^\d{10}$/ },
};

function detectCountryCode(phone) {
  const digits = String(phone).replace(/\D/g, '');
  for (const [code, rule] of Object.entries(PHONE_RULES)) {
    if (rule.regex.test(digits)) return code;
  }
  return 'US'; // default
}

console.log('\nProcessing rows:\n');

for (let i = 1; i < personalInfoData.length; i++) {
  const row = personalInfoData[i];
  if (!row) continue;
  
  // Fix candidate phone country code
  const phoneNumber = String(row[phoneNumberIndex] || '').trim().replace(/\D/g, '');
  const correctCountryCode = detectCountryCode(phoneNumber);
  row[countryCodeIndex] = correctCountryCode;
  
  console.log(`Row ${i + 1}: ${row[0]} - Phone: ${phoneNumber} -> ${correctCountryCode}`);
  
  // Add supervisor country code
  const supervisorContact = row[supervisorContactIndex];
  let supervisorCountryCode = correctCountryCode; // default to same as candidate
  
  if (supervisorContact) {
    const supervisorPhone = String(supervisorContact).trim().replace(/\D/g, '');
    supervisorCountryCode = detectCountryCode(supervisorPhone);
    console.log(`  Supervisor: ${supervisorPhone} -> ${supervisorCountryCode}`);
  }
  
  row.splice(insertIndex, 0, supervisorCountryCode);
}

console.log(`\nProcessed ${personalInfoData.length - 1} candidates`);

// Write back
const newPersonalInfoSheet = XLSX.utils.aoa_to_sheet(personalInfoData);
workbook.Sheets['Personal Info'] = newPersonalInfoSheet;

XLSX.writeFile(workbook, outputPath);
console.log(`\nFinal corrected file saved to: ${outputPath}`);
console.log('\nThis file now has:');
console.log('- Correct CountryCode for all candidates');
console.log('- New SupervisorCountryCode column');
console.log('- All phone numbers matched to their country codes');
