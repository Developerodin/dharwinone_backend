/**
 * Test email routing for companyAssignedEmail fallback.
 *
 * Sends a test email to two known Prakhar accounts and reports the resolved
 * delivery address (EmailLog.to) so we can confirm routing matches expectation:
 *   - if Employee.companyAssignedEmail is set → mail goes to that address
 *   - otherwise → mail goes to the personal/login email
 *
 * Read-only against application state (only writes EmailLog rows + an SMTP send).
 *
 * Usage:
 *   node scripts/test-email-routing.js
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const TARGETS = ['prakhar@theodin.in', 'sharmaprakhar720@gmail.com'];

const main = async () => {
  const uri = process.env.MONGODB_URL || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URL not set in env');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log('Connected to Mongo');

  const { default: Employee } = await import('../src/models/employee.model.js');
  const { default: EmailLog } = await import('../src/models/emailLog.model.js');
  const emailMod = await import('../src/services/email.service.js');

  for (const personal of TARGETS) {
    const emp = await Employee.findOne({ email: personal.toLowerCase() })
      .select('fullName email companyAssignedEmail')
      .lean();

    const subject = `[Routing Test] Delivery check for ${personal}`;
    const body = [
      `Hello ${emp?.fullName || personal},`,
      ``,
      `Personal/login email: ${personal}`,
      `companyAssignedEmail:  ${emp?.companyAssignedEmail || '(not set)'}`,
      ``,
      `If you received this at your professional mailbox, routing works.`,
      `If you received this at your personal mailbox, no professional was set.`,
    ].join('\n');

    console.log(`\n--- Sending to caller-address: ${personal} ---`);
    console.log(`  Employee found:        ${Boolean(emp)}`);
    console.log(`  companyAssignedEmail:  ${emp?.companyAssignedEmail || '(empty)'}`);

    try {
      await emailMod.sendEmail(personal, subject, body, undefined, 'routing_test');
      const log = await EmailLog.findOne({ templateName: 'routing_test' })
        .sort({ createdAt: -1 })
        .select('to status sentAt error')
        .lean();
      console.log(`  Resolved EmailLog.to:  ${log?.to}`);
      console.log(`  Status:                ${log?.status}`);
      if (log?.error) console.log(`  Error:                 ${log.error}`);
    } catch (e) {
      console.error(`  Send failed: ${e?.message || e}`);
    }
  }

  await mongoose.disconnect();
  console.log('\nDone.');
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
