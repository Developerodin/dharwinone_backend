/**
 * Suggested "Roles & responsibilities" / training bullets by job title keyword (case-insensitive).
 * Used when pre-filling the offer letter form; users can edit before PDF generation.
 */
const ENTRIES = [
  {
    test: /data\s*analyst/i,
    roleResponsibilities: [
      'Assist in collecting, cleaning, and organizing data from various sources for analysis.',
      'Perform data analysis using tools such as Excel, SQL, or Python to identify trends and insights.',
      'Support the development of dashboards, reports, and visualizations for business decision-making.',
      'Work on real-time datasets to understand business performance and operational efficiency.',
      'Collaborate with internal teams to understand data requirements and provide analytical support.',
      'Participate in training sessions focused on data analytics concepts, tools, and industry practices.',
    ],
    trainingOutcomes: [
      'Data cleaning and preprocessing techniques',
      'Data visualization and reporting',
      'Basic statistical analysis and business insights generation',
      'Real-world project exposure in data analytics',
    ],
  },
  {
    test: /business\s*analyst/i,
    roleResponsibilities: [
      'Collecting, cleaning, and analyzing business and operational datasets using SQL, Python, and Excel',
      'Developing dashboards and reports using Power BI/Tableau to support decision-making',
      'Conducting KPI analysis, trend identification, and performance evaluation',
      'Supporting business stakeholders with data-driven insights and documentation',
      'Assisting in process optimization and business reporting initiatives',
      'Collaborating with technical and management teams to improve operational efficiency',
    ],
    trainingOutcomes: [],
  },
];

const DEFAULT_ROLES = [
  'Contribute to assigned projects under supervision and in line with business priorities.',
  'Collaborate with team members to deliver quality work within agreed timelines.',
  'Adhere to company policies, security, and professional communication standards.',
];

const DEFAULT_TRAINING = [
  'Practical tools and processes used in the role',
  'Communication and collaboration in a distributed team',
];

/**
 * @param {string} positionTitle
 * @returns {{ roleResponsibilities: string[], trainingOutcomes: string[] }}
 */
function getLetterDefaultsForPositionTitle(positionTitle) {
  const t = (positionTitle || '').trim();
  for (const e of ENTRIES) {
    if (e.test.test(t)) {
      return {
        roleResponsibilities: [...e.roleResponsibilities],
        trainingOutcomes: e.trainingOutcomes.length ? [...e.trainingOutcomes] : [...DEFAULT_TRAINING],
      };
    }
  }
  return {
    roleResponsibilities: [...DEFAULT_ROLES],
    trainingOutcomes: [...DEFAULT_TRAINING],
  };
}

export { getLetterDefaultsForPositionTitle, ENTRIES };
