// 用户数据模型
export interface User {
  id: string;
  email: string;
  password: string;
  emailVerified: boolean;
  verificationCode?: string;
  verificationExpiry?: Date;
  resetToken?: string;
  resetTokenExpiry?: Date;
  loginAttempts?: number;
  lockUntil?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// JWT相关类型
export interface JWTPayload {
  userId: string;
  email: string;
  iat: number;
  exp: number;
}

export interface LoginResponse {
  token: string;
  user: {
    id: string;
    email: string;
  };
}

// 服务接口
export interface JWTService {
  generateToken(userId: string, email: string): string;
  verifyToken(token: string): JWTPayload | null;
  refreshToken(oldToken: string): string;
}

export interface EmailService {
  sendVerificationCode(email: string, code: string): Promise<boolean>;
  sendPasswordResetLink(email: string, resetToken: string): Promise<boolean>;
}

export interface UserRepository {
  create(user: Omit<User, 'id' | 'createdAt' | 'updatedAt'>): Promise<User>;
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  update(id: string, updates: Partial<User>): Promise<User>;
}

// 错误类型
export class AuthError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export class ValidationError extends AuthError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 400);
    this.name = 'ValidationError';
  }
}

export class AuthenticationError extends AuthError {
  constructor(message: string = '认证失败') {
    super(message, 'AUTHENTICATION_ERROR', 401);
    this.name = 'AuthenticationError';
  }
}

export class NotFoundError extends AuthError {
  constructor(message: string = '资源不存在') {
    super(message, 'NOT_FOUND', 404);
    this.name = 'NotFoundError';
  }
}
