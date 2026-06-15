import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import * as studentService from '../services/student.service.js';
import * as studentExcelService from '../services/studentExcel.service.js';

/**
 * GET /v1/students/export — stream all students matching the current filters as
 * an .xlsx download. Reuses queryStudents (same status/position/search filters
 * as the list) with a high limit so the export respects the active view.
 */
export const exportExcel = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['status', 'position', 'search']);
  const result = await studentService.queryStudents(filter, { limit: 100000, page: 1 });
  const buf = studentExcelService.buildStudentsExportBuffer(result.results || []);
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="students-export-${date}.xlsx"`);
  res.send(buf);
});
