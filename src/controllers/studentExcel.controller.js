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
  const filter = pick(req.query, [
    'status',
    'position',
    'search',
    'names',
    'skills',
    'education',
    'email',
    'experienceMin',
    'experienceMax',
  ]);
  const options = pick(req.query, ['sortBy']);
  const { results, capped, totalResults, exportMax } = await studentService.queryStudentsForExport(filter, options);
  const buf = studentExcelService.buildStudentsExportBuffer(results || []);
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="students-export-${date}.xlsx"`);
  if (capped) {
    res.setHeader('X-Export-Capped', 'true');
    res.setHeader('X-Export-Total-Results', String(totalResults));
    res.setHeader('X-Export-Max-Rows', String(exportMax));
  }
  res.send(buf);
});
