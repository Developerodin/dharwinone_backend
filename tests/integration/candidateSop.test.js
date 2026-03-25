/**
 * Candidate SOP templates + sop-status authz (BOLA 404, BFLA 403).
 * Run: npm test -- tests/integration/candidateSop.test.js
 */
import request from 'supertest';
import mongoose from 'mongoose';
import faker from 'faker';
import httpStatus from 'http-status';
import app from '../../src/app.js';
import setupTestDB from '../utils/setupTestDB.js';
import { insertUsers, userOne, userTwo, admin } from '../fixtures/user.fixture.js';
import tokenService from '../../src/services/token.service.js';
import config from '../../src/config/config.js';
import { tokenTypes } from '../../src/config/tokens.js';
import moment from 'moment';
import Candidate from '../../src/models/candidate.model.js';
import CandidateSopTemplate from '../../src/models/candidateSopTemplate.model.js';
import User from '../../src/models/user.model.js';

setupTestDB();

const accessTokenFor = (user) => {
  const exp = moment().add(config.jwt.accessExpirationMinutes, 'minutes');
  return tokenService.generateToken(user._id, exp, tokenTypes.ACCESS);
};

describe('Candidate SOP API', () => {
  test('GET /v1/candidate-sop-templates/active returns 403 for user without candidates.manage', async () => {
    await insertUsers([userOne]);
    const token = accessTokenFor(userOne);
    await request(app)
      .get('/v1/candidate-sop-templates/active')
      .set('Authorization', `Bearer ${token}`)
      .expect(httpStatus.FORBIDDEN);
  });

  test('GET /v1/candidates/:id/sop-status returns 404 for unrelated user (BOLA)', async () => {
    await insertUsers([userOne, userTwo, admin]);

    const cand = await Candidate.create({
      fullName: 'SOP Test',
      email: 'soptest@example.com',
      phoneNumber: '1234567890',
      owner: userOne._id,
      adminId: admin._id,
      assignedAgent: userTwo._id,
    });

    const ownerToken = accessTokenFor(userOne);
    await request(app)
      .get(`/v1/candidates/${cand._id}/sop-status`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(httpStatus.OK);

    const agentToken = accessTokenFor(userTwo);
    await request(app)
      .get(`/v1/candidates/${cand._id}/sop-status`)
      .set('Authorization', `Bearer ${agentToken}`)
      .expect(httpStatus.OK);

    const stranger = {
      _id: mongoose.Types.ObjectId(),
      name: 'Stranger',
      email: faker.internet.email().toLowerCase(),
      password: 'password1',
      role: 'user',
      isEmailVerified: false,
    };
    await insertUsers([stranger]);
    const stToken = accessTokenFor(stranger);
    await request(app)
      .get(`/v1/candidates/${cand._id}/sop-status`)
      .set('Authorization', `Bearer ${stToken}`)
      .expect(httpStatus.NOT_FOUND);
  });

  test('GET /v1/candidates/:id/sop-status returns checklist for platform super user', async () => {
    await insertUsers([admin]);
    await User.updateOne({ _id: admin._id }, { $set: { platformSuperUser: true } });

    const token = accessTokenFor(admin);

    const cand = await Candidate.create({
      fullName: 'SOP Admin',
      email: 'sopadmin@example.com',
      phoneNumber: '1234567890',
      owner: admin._id,
      adminId: admin._id,
    });

    await CandidateSopTemplate.deleteMany({});
    await CandidateSopTemplate.create({
      name: 'T',
      version: 1,
      isActive: true,
      steps: [
        {
          checkerKey: 'profile_complete',
          label: 'Profile',
          description: '',
          sortOrder: 0,
          enabled: true,
          linkTemplate: '/ats/candidates/edit?id={{candidateId}}',
        },
      ],
    });

    const res = await request(app)
      .get(`/v1/candidates/${cand._id}/sop-status`)
      .set('Authorization', `Bearer ${token}`)
      .expect(httpStatus.OK);

    expect(res.body).toMatchObject({
      skipped: false,
      totalCount: 1,
      steps: expect.arrayContaining([expect.objectContaining({ checkerKey: 'profile_complete' })]),
    });
  });
});
