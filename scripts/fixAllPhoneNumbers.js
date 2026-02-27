import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read the input Excel file
const inputPath = 'C:\\Users\\INTEL\\Downloads\\candidates_filled.xlsx';
const outputPath = 'C:\\Users\\INTEL\\Downloads\\candidates_filled_corrected.xlsx';

console.log('Reading Excel file from:', inputPath);
const workbook = XLSX.readFile(inputPath);

// Get the "Personal Info" sheet
const personalInfoSheet = workbook.Sheets['Personal Info'];
const personalInfoData = XLSX.utils.sheet_to_json(personalInfoSheet, { header: 1 });

console.log(`Found ${personalInfoData.length - 1} candidates in Personal Info sheet`);
console.log('Headers:', personalInfoData[0]);

// Get column indices
const headers = personalInfoData[0];
const countryCodeIndex = headers.findIndex(h => String(h).trim().toLowerCase() === 'countrycode');
const phoneNumberIndex = headers.findIndex(h => String(h).trim().toLowerCase() === 'phonenumber');
const supervisorCountryCodeIndex = headers.findIndex(h => String(h).trim().toLowerCase() === 'supervisorcountrycode');
const supervisorContactIndex = headers.findIndex(h => String(h).trim().toLowerCase() === 'supervisorcontact');

console.log(`\nColumn indices:`);
console.log(`  PhoneNumber: ${phoneNumberIndex}, CountryCode: ${countryCodeIndex}`);
console.log(`  SupervisorContact: ${supervisorContactIndex}, SupervisorCountryCode: ${supervisorCountryCodeIndex}`);

// Phone validation rules
const PHONE_RULES = {
  IN: { regex: /^[6-9]\d{9}$/, length: 10 },
  US: { regex: /^\d{10}$/, length: 10 },
  AU: { regex: /^[2-4789]\d{8}$/, length: 9 },
  GB: { regex: /^[1-9]\d{9,10}$/, length: [10, 11] },
  CA: { regex: /^\d{10}$/, length: 10 },
};

// Fix country codes based on phone number format
let fixedCount = 0;
console.log('\nAnalyzing and fixing phone numbers:\n');

for (let i = 1; i < personalInfoData.length; i++) {
  const row = personalInfoData[i];
  if (!row || !row[phoneNumberIndex]) continue;
  
  const phoneNumber = String(row[phoneNumberIndex]).trim().replace(/\D/g, '');
  let countryCode = String(row[countryCodeIndex] || 'US').trim();
  
  // Check if current country code is valid for this phone number
  const rule = PHONE_RULES[countryCode];
  let isValid = false;
  
  if (rule) {
    isValid = rule.regex.test(phoneNumber);
  }
  
  if (!isValid) {
    // Try to find a matching country code
    let newCountryCode = 'US'; // default
    
    for (const [code, rule] of Object.entries(PHONE_RULES)) {
      if (rule.regex.test(phoneNumber)) {
        newCountryCode = code;
        break;
      }
    }
    
    console.log(`Row ${i + 1}: ${row[0] || 'Unknown'} - Phone: ${phoneNumber} (${phoneNumber.length} digits)`);
    console.log(`  Changed: ${countryCode} -> ${newCountryCode}`);
    
    row[countryCodeIndex] = newCountryCode;
    fixedCount++;
  }
  
  // Fix supervisor phone if present
  if (row[supervisorContactIndex]) {
    const supervisorPhone = String(row[supervisorContactIndex]).trim().replace(/\D/g, '');
    let supervisorCountryCode = row[supervisorCountryCodeIndex] || row[countryCodeIndex];
    
    const supervisorRule = PHONE_RULES[supervisorCountryCode];
    let supervisorValid = false;
    
    if (supervisorRule) {
      supervisorValid = supervisorRule.regex.test(supervisorPhone);
    }
    
    if (!supervisorValid) {
      // Try to find a matching country code
      let newSupervisorCode = 'US'; // default
      
      for (const [code, rule] of Object.entries(PHONE_RULES)) {
        if (rule.regex.test(supervisorPhone)) {
          newSupervisorCode = code;
          break;
        }
      }
      
      console.log(`  Supervisor phone: ${supervisorPhone} (${supervisorPhone.length} digits) - Changed: ${supervisorCountryCode} -> ${newSupervisorCode}`);
      
      row[supervisorCountryCodeIndex] = newSupervisorCode;
      fixedCount++;
    }
  }
}

console.log(`\n\nFixed ${fixedCount} phone/country code issues`);

// Write back to the sheet
const newPersonalInfoSheet = XLSX.utils.aoa_to_sheet(personalInfoData);
workbook.Sheets['Personal Info'] = newPersonalInfoSheet;

// Write the corrected workbook
XLSX.writeFile(workbook, outputPath);
console.log(`\nCorrected Excel file saved to: ${outputPath}`);
