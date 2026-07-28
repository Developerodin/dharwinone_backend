import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import numberPricingService from '../services/numberPricing.service.js';

/** GET /v1/number-pricing — list retail price configs (admin). */
const list = catchAsync(async (req, res) => {
  const includeInactive = String(req.query.includeInactive || '') === 'true';
  const rows = await numberPricingService.listPricingConfigs({ includeInactive });
  res.status(httpStatus.OK).send({ success: true, pricing: rows });
});

/** PUT /v1/number-pricing — upsert a country/type price row (admin). */
const upsert = catchAsync(async (req, res) => {
  const row = await numberPricingService.upsertPricingConfig(req.body);
  res.status(httpStatus.OK).send({ success: true, pricing: row });
});

/** DELETE /v1/number-pricing/:id — remove a non-default price row (admin). */
const remove = catchAsync(async (req, res) => {
  const result = await numberPricingService.deletePricingConfig(req.params.id);
  res.status(httpStatus.OK).send({ success: true, ...result });
});

export { list, upsert, remove };
