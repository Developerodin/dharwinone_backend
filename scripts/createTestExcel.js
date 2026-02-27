import XLSX from 'xlsx';

// Create a simple test Excel file with just Personal Info
const personalInfoData = [
  [
    'FullName', 'Email', 'CountryCode', 'PhoneNumber', 'Password', 'ShortBio',
    'SevisId', 'Ead', 'Degree', 'VisaType', 'SupervisorName', 'SupervisorContact',
    'SupervisorCountryCode', 'SalaryRange', 'StreetAddress', 'StreetAddress2',
    'City', 'State', 'ZipCode', 'Country'
  ],
  [
    'Test User 1', 'testuser1@example.com', 'US', '2025551234', 'Test@123', 'Software developer with 5 years experience',
    '', '', 'Computer Science', 'H1B', 'John Manager', '2025555678',
    'US', '$80k-$100k', '123 Main St', 'Apt 4B',
    'New York', 'NY', '10001', 'United States'
  ],
  [
    'Test User 2', 'testuser2@example.com', 'IN', '9876543210', 'Test@123', 'Data scientist',
    '', '', 'Data Science', 'F1', 'Jane Supervisor', '9876543211',
    'IN', '$70k-$90k', '456 Tech Park', '',
    'Bangalore', 'Karnataka', '560001', 'India'
  ]
];

// Create Skills sheet
const skillsData = [
  ['FullName', 'Name', 'Level', 'Category'],
  ['Test User 1', 'JavaScript', 'Advanced', 'Programming'],
  ['Test User 1', 'React', 'Advanced', 'Frontend'],
  ['Test User 1', 'Node.js', 'Intermediate', 'Backend'],
  ['Test User 2', 'Python', 'Advanced', 'Programming'],
  ['Test User 2', 'Machine Learning', 'Intermediate', 'AI/ML'],
];

// Create Qualifications sheet
const qualificationsData = [
  ['FullName', 'Degree', 'Institute', 'Location', 'StartYear', 'EndYear', 'Description'],
  ['Test User 1', 'Bachelor of Science', 'MIT', 'Cambridge, MA', 2015, 2019, 'Computer Science major'],
  ['Test User 2', 'Master of Science', 'Stanford University', 'Stanford, CA', 2019, 2021, 'Data Science specialization'],
];

// Create Work Experience sheet
const experienceData = [
  ['FullName', 'Company', 'Role', 'StartDate', 'EndDate', 'Description', 'CurrentlyWorking'],
  ['Test User 1', 'Tech Corp', 'Senior Developer', '2019-06-01', '2024-12-31', 'Full stack development', 'true'],
  ['Test User 2', 'Data Inc', 'Data Scientist', '2021-08-01', '2024-12-31', 'ML model development', 'true'],
];

// Create Social Links sheet
const socialLinksData = [
  ['FullName', 'Platform', 'URL'],
  ['Test User 1', 'LinkedIn', 'https://linkedin.com/in/testuser1'],
  ['Test User 1', 'GitHub', 'https://github.com/testuser1'],
  ['Test User 2', 'LinkedIn', 'https://linkedin.com/in/testuser2'],
  ['Test User 2', 'GitHub', 'https://github.com/testuser2'],
];

// Create workbook
const workbook = XLSX.utils.book_new();

// Add sheets
const personalInfoSheet = XLSX.utils.aoa_to_sheet(personalInfoData);
const skillsSheet = XLSX.utils.aoa_to_sheet(skillsData);
const qualificationsSheet = XLSX.utils.aoa_to_sheet(qualificationsData);
const experienceSheet = XLSX.utils.aoa_to_sheet(experienceData);
const socialLinksSheet = XLSX.utils.aoa_to_sheet(socialLinksData);

XLSX.utils.book_append_sheet(workbook, personalInfoSheet, 'Personal Info');
XLSX.utils.book_append_sheet(workbook, skillsSheet, 'Skills');
XLSX.utils.book_append_sheet(workbook, qualificationsSheet, 'Qualification');
XLSX.utils.book_append_sheet(workbook, experienceSheet, 'Work Experience');
XLSX.utils.book_append_sheet(workbook, socialLinksSheet, 'Social Links');

// Write file
const outputPath = 'C:\\Users\\INTEL\\Downloads\\test_candidates.xlsx';
XLSX.writeFile(workbook, outputPath);

console.log(`Test file created: ${outputPath}`);
console.log('\nThis file contains:');
console.log('- 2 test candidates with unique emails');
console.log('- All required and optional sheets');
console.log('- Properly formatted data');
console.log('\nUse this file to test the import functionality!');
