/**
 * Integration tests for Attendance API.
 * Covers GET /training/attendance/me (identity) for different user types.
 * Run with: npm test -- tests/integration/attendance.test.js
 */
import request from 'supertest';
import httpStatus from 'http-status';
import app from '../../src/app';
import setupTestDB from '../utils/setupTestDB';
import { insertUsers, userOne, admin } from '../fixtures/user.fixture';
import { userOneAccessToken, adminAccessToken } from '../fixtures/token.fixture';

setupTestDB();

describe('Attendance API', () => {
  beforeEach(async () => {
    await insertUsers([userOne, admin]);
  });

  describe('GET /v1/training/attendance/me', () => {
    test('should return 401 when access token is missing', async () => {
      await request(app)
        .get('/v1/training/attendance/me')
        .expect(httpStatus.UNAUTHORIZED);
    });

    test('should return 200 and user identity when user has no Student and is not admin by roleIds', async () => {
      const res = await request(app)
        .get('/v1/training/attendance/me')
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .expect(httpStatus.OK);

      expect(res.body).toMatchObject({
        type: 'user',
        id: userOne._id.toString(),
        user: {
          id: userOne._id.toString(),
          name: userOne.name,
          email: userOne.email,
        },
      });
    });

    test('should return 200 for admin fixture when admin has no Administrator in roleIds', async () => {
      // Current implementation uses only roleIds for admin; fixture admin has role 'admin' but no roleIds,
      // so backend returns user identity (no Student).
      const res = await request(app)
        .get('/v1/training/attendance/me')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(httpStatus.OK);

      expect(res.body).toHaveProperty('id', admin._id.toString());
      expect(res.body).toHaveProperty('user');
      expect(res.body.user).toMatchObject({
        id: admin._id.toString(),
        name: admin.name,
        email: admin.email,
      });
    });
  });
});
