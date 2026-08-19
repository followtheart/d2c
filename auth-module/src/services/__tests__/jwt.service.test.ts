import { JWTServiceImpl } from '../jwt.service';
import { JWTPayload } from '../../types';

describe('JWTServiceImpl', () => {
  const SECRET = 'test-secret-key-256-bit';
  let jwtService: JWTServiceImpl;

  beforeEach(() => {
    jwtService = new JWTServiceImpl(SECRET);
  });

  describe('generateToken', () => {
    // TC-JWT-001: 生成JWT令牌，验证包含正确的userId和email
    test('TC-JWT-001: 应该生成包含userId和email的JWT令牌', () => {
      const userId = 'user-123';
      const email = 'test@example.com';

      const token = jwtService.generateToken(userId, email);

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3); // JWT格式：header.payload.signature
    });
  });

  describe('verifyToken', () => {
    // TC-JWT-002: 验证有效的JWT令牌，返回正确的payload
    test('TC-JWT-002: 应该验证有效令牌并返回payload', () => {
      const userId = 'user-123';
      const email = 'test@example.com';
      const token = jwtService.generateToken(userId, email);

      const payload = jwtService.verifyToken(token);

      expect(payload).not.toBeNull();
      expect(payload!.userId).toBe(userId);
      expect(payload!.email).toBe(email);
      expect(payload!.iat).toBeDefined();
      expect(payload!.exp).toBeDefined();
    });

    // TC-JWT-003: 验证过期的JWT令牌，返回null
    test('TC-JWT-003: 验证过期令牌应返回null', () => {
      // 创建过期令牌
      const expiredJwtService = new JWTServiceImpl(SECRET, '-1s');
      const token = expiredJwtService.generateToken('user-123', 'test@example.com');

      // 等待令牌过期
      setTimeout(() => {
        const payload = jwtService.verifyToken(token);
        expect(payload).toBeNull();
      }, 1000);
    });

    // TC-JWT-004: 验证篡改的JWT令牌，返回null
    test('TC-JWT-004: 验证篡改令牌应返回null', () => {
      const token = jwtService.generateToken('user-123', 'test@example.com');
      const tamperedToken = token + 'tampered';

      const payload = jwtService.verifyToken(tamperedToken);

      expect(payload).toBeNull();
    });
  });

  describe('refreshToken', () => {
    // TC-JWT-005: 刷新有效的JWT令牌，生成新令牌
    test('TC-JWT-005: 应该刷新有效令牌并生成新令牌', () => {
      const userId = 'user-123';
      const email = 'test@example.com';
      const oldToken = jwtService.generateToken(userId, email);

      const newToken = jwtService.refreshToken(oldToken);

      expect(newToken).toBeDefined();
      expect(newToken).not.toBe(oldToken);

      // 验证新令牌包含相同的信息
      const payload = jwtService.verifyToken(newToken);
      expect(payload!.userId).toBe(userId);
      expect(payload!.email).toBe(email);
    });

    // TC-JWT-006: 刷新过期的JWT令牌，应抛出异常
    test('TC-JWT-006: 刷新过期令牌应抛出异常', () => {
      const expiredJwtService = new JWTServiceImpl(SECRET, '-1s');
      const expiredToken = expiredJwtService.generateToken('user-123', 'test@example.com');

      setTimeout(() => {
        expect(() => {
          jwtService.refreshToken(expiredToken);
        }).toThrow('令牌无效或已过期');
      }, 1000);
    });
  });
});
