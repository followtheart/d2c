import jwt from 'jsonwebtoken';
import { JWTService, JWTPayload } from '../types';

export class JWTServiceImpl implements JWTService {
  private readonly secret: string;
  private readonly expiresIn: string;

  constructor(secret?: string, expiresIn: string = '24h') {
    this.secret = secret || process.env.JWT_SECRET || 'your-256-bit-secret-key-here';
    this.expiresIn = expiresIn;
  }

  /**
   * 生成JWT令牌
   * @param userId 用户ID
   * @param email 用户邮箱
   * @returns JWT令牌字符串
   */
  generateToken(userId: string, email: string): string {
    const payload: Omit<JWTPayload, 'iat' | 'exp'> = {
      userId,
      email
    };

    return jwt.sign(payload, this.secret, {
      expiresIn: this.expiresIn,
      algorithm: 'HS256'
    });
  }

  /**
   * 验证JWT令牌
   * @param token JWT令牌
   * @returns 解析后的payload，验证失败返回null
   */
  verifyToken(token: string): JWTPayload | null {
    try {
      const decoded = jwt.verify(token, this.secret, {
        algorithms: ['HS256']
      }) as JWTPayload;

      return decoded;
    } catch (error) {
      // 令牌过期、篡改或无效时返回null
      return null;
    }
  }

  /**
   * 刷新JWT令牌
   * @param oldToken 旧令牌
   * @returns 新令牌
   * @throws Error 如果旧令牌无效或过期
   */
  refreshToken(oldToken: string): string {
    const payload = this.verifyToken(oldToken);

    if (!payload) {
      throw new Error('令牌无效或已过期');
    }

    // 生成新令牌
    return this.generateToken(payload.userId, payload.email);
  }
}
