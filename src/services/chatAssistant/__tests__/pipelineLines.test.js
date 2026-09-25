import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatOfferLine, formatPlacementLine } from '../pipelineLines.js';

const fmtDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

describe('formatOfferLine', () => {
  it('prints lifecycle dates, creator and letter link', () => {
    const line = formatOfferLine({
      offerCode: 'OF-1', status: 'Accepted',
      candidate: { owner: { name: 'Rahul', email: 'r@x.io' }, employeeId: 'DBS1' },
      job: { title: 'Data Analyst' }, positionTitle: 'Sr Data Analyst',
      joiningDate: '2026-10-01', ctcBreakdown: { gross: 500000, currency: 'INR' },
      createdAt: '2026-09-01', createdBy: { name: 'Asha' },
      sentAt: '2026-09-02', acceptedAt: '2026-09-04', offerLetterUrl: 'https://s3/x.pdf',
    }, { fmtDate });
    assert.match(line, /POSITION: Sr Data Analyst/);
    assert.match(line, /PREPARED: 2026-09-01 by Asha/);
    assert.match(line, /SENT: 2026-09-02/);
    assert.match(line, /ACCEPTED: 2026-09-04/);
    assert.match(line, /LETTER: https:\/\/s3\/x\.pdf/);
  });

  it('says NOT_RECORDED for a missing sent date and omits absent lifecycle fields', () => {
    const line = formatOfferLine({ offerCode: 'OF-2', status: 'Draft' }, { fmtDate });
    assert.match(line, /SENT: NOT_RECORDED/);
    assert.doesNotMatch(line, /ACCEPTED:/);
  });

  it('shows days pending for Sent offers', () => {
    const sent = new Date(Date.now() - 4 * 86400000).toISOString();
    assert.match(formatOfferLine({ status: 'Sent', sentAt: sent }, { fmtDate }), /PENDING_DAYS: 4/);
  });
});

describe('formatPlacementLine', () => {
  it('prints BGV and onboarding dates', () => {
    const line = formatPlacementLine({
      offer: { offerCode: 'OF-1' }, candidate: { fullName: 'Rahul' }, job: { title: 'DA' },
      status: 'Pending', preBoardingStatus: 'In Progress', joiningDate: '2026-10-01',
      backgroundVerification: { status: 'Completed', requestedAt: '2026-09-10', completedAt: '2026-09-15' },
      enteredOnboardingAt: '2026-09-20',
    }, { fmtDate });
    assert.match(line, /BGV: Completed \(requested 2026-09-10, completed 2026-09-15\)/);
    assert.match(line, /ENTERED_ONBOARDING: 2026-09-20/);
  });
});
