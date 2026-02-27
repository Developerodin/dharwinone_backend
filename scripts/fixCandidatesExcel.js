import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read the input Excel file
const inputPath = 'C:\\Users\\INTEL\\Downloads\\candidates_filled.xlsx';
const outputPath = path.join(__dirname, '..', 'candidates_filled_fixed.xlsx');

console.log('Reading Excel file from:', inputPath);
const workbook = XLSX.readFile(inputPath);

// Get the "Personal Info" sheet
const personalInfoSheet = workbook.Sheets['Personal Info'];
const personalInfoData = XLSX.utils.sheet_to_json(personalInfoSheet, { header: 1 });

console.log(`Found ${personalInfoData.length - 1} candidates in Personal Info sheet`);

// Get the CountryCode column index
const headers = personalInfoData[0];
const countryCodeIndex = headers.findIndex(h => String(h).trim().toLowerCase() === 'countrycode');
const phoneNumberIndex = headers.findIndex(h => String(h).trim().toLowerCase() === 'phonenumber');

if (countryCodeIndex === -1 || phoneNumberIndex === -1) {
  console.error('Could not find CountryCode or PhoneNumber columns');
  process.exit(1);
}

console.log(`CountryCode column index: ${countryCodeIndex}, PhoneNumber column index: ${phoneNumberIndex}`);

// Fix country codes: if phone number is 10 digits starting with any digit, set country code to US
let fixedCount = 0;
for (let i = 1; i < personalInfoData.length; i++) {
  const row = personalInfoData[i];
  if (row && row[phoneNumberIndex]) {
    const phoneNumber = String(row[phoneNumberIndex]).trim().replace(/\D/g, '');
    const countryCode = row[countryCodeIndex];
    
    // If phone is 10 digits (typical US format), set country code to US
    if (phoneNumber.length === 10) {
      row[countryCodeIndex] = 'US';
      fixedCount++;
      console.log(`Row ${i + 1}: Fixed country code to US for phone ${phoneNumber}`);
    }
  }
}

console.log(`Fixed ${fixedCount} country codes`);

// Write back to the sheet
const newPersonalInfoSheet = XLSX.utils.aoa_to_sheet(personalInfoData);
workbook.Sheets['Personal Info'] = newPersonalInfoSheet;

// Write the corrected workbook
XLSX.writeFile(workbook, outputPath);
console.log(`Corrected Excel file saved to: ${outputPath}`);
