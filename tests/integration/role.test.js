import request from 'supertest';
import httpStatus from 'http-status';
import app from '../../src/app.js';
import setupTestDB from '../utils/setupTestDB.js';
import { insertUsers, userOne } from '../fixtures/user.fixture.js';
import { userOneAccessToken } from '../fixtures/token.fixture.js';

setupTestDB();

describe('Role routes', () => {
  describe('GET /v1/roles', () => {
    test('should return 401 when access token is missing', async () => {
      await request(app).get('/v1/roles').expect(httpStatus.UNAUTHORIZED);
    });

    test('should return 401 when access token is invalid', async () => {
      await request(app).get('/v1/roles').set('Authorization', 'Bearer invalid-token').expect(httpStatus.UNAUTHORIZED);
    });

    test('should return 403 when user has no roles.read permission', async () => {
      await insertUsers([userOne]);
      await request(app).get('/v1/roles').set('Authorization', `Bearer ${userOneAccessToken}`).expect(httpStatus.FORBIDDEN);
    });
  });

  describe('GET /v1/roles/:roleId', () => {
    test('should return 401 when access token is missing', async () => {
      await request(app).get('/v1/roles/507f1f77bcf86cd799439011').expect(httpStatus.UNAUTHORIZED);
    });
  });

  describe('POST /v1/roles', () => {
    test('should return 401 when access token is missing', async () => {
      await request(app).post('/v1/roles').send({ name: 'TestRole', permissions: [] }).expect(httpStatus.UNAUTHORIZED);
    });
  });
});
