import catchAsync from '../utils/catchAsync.js';
import * as weekOffExportService from '../services/weekOffExport.service.js';

/**
 * GET /v1/training/students/week-off/export?days=Saturday,Sunday
 */
export const exportWeekOffExcel = catchAsync(async (req, res) => {
  const days = Array.isArray(req.query.days) ? req.query.days : String(req.query.days || '').split(',');
  const selectedDays = [...new Set(days.map((day) => String(day).trim()).filter(Boolean))];

  const { buffer, rowCount } = await weekOffExportService.buildWeekOffExportForDays(selectedDays);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="week-off-export.xlsx"');
  res.setHeader('X-Export-Row-Count', String(rowCount));
  res.send(buffer);
});
