import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import * as communicationService from '../services/communication.service.js';

const listUnifiedCalls = catchAsync(async (req, res) => {
  const user = req.user;
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 25;
  const source = req.query.source || 'all';
  const search = req.query.search;
  const status = req.query.status;
  const purpose = req.query.purpose;
  const language = req.query.language;
  const sortBy = req.query.sortBy || 'createdAt';
  const order = req.query.order || 'desc';

  const result = await communicationService.listUnifiedCalls({
    user,
    page,
    limit,
    source,
    search,
    status,
    purpose,
    language,
    sortBy,
    order,
  });

  res.status(httpStatus.OK).send(result);
});

export { listUnifiedCalls };
