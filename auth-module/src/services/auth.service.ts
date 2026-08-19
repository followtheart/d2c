import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import {
  User,
  UserRepository,
  JWTService,
  EmailService,
  LoginResponse,
  ValidationError,
  AuthenticationError,
  NotFoundError
} from '../types';
import { Validator } from '../utils/validator';

export class AuthService {
  private readonly BCRYPT_ROUNDS = 12;
  private readonly VERIFICATION_CODE_EXPIRY = 60 * 60 * 1000; // 1小时
  private readonly RESET_TOKEN_EXPIRY = 60 * 60 * 1000; // 1小时
  private readonly MAX_LOGIN_ATTEMPTS = 5;
  private readonly LOCK_DURATION = 15 * 60 * 1000; // 15分钟

  constructor(
    private userRepository: UserRepository,
    private jwtService: JWTService,
    private emailService: EmailService
  ) {}

  /**
   * 用户注册
   * @param email 邮箱
   * @param password 密码
   * @returns 创建的用户对象
   */
  async register(email: string, password: string): Promise<User> {
    // 1. 验证输入
    Validator.validateEmail(email);
    Validator.validatePassword(password);

    // 2. 检查邮箱是否已注册
    const existingUser = await this.userRepository.findByEmail(email);
    if (existingUser) {
      throw new ValidationError('该邮箱已被注册');
    }

    // 3. 加密密码
    const hashedPassword = await bcrypt.hash(password, this.BCRYPT_ROUNDS);

    // 4. 生成验证码
    const verificationCode = this.generateVerificationCode();
    const verificationExpiry = new Date(Date.now() + this.VERIFICATION_CODE_EXPIRY);

    // 5. 创建用户
    const user = await this.userRepository.create({
      email,
      password: hashedPassword,
      emailVerified: false,
      verificationCode,
      verificationExpiry,
      loginAttempts: 0
    });

    // 6. 发送验证邮件
    const emailSent = await this.emailService.sendVerificationCode(email, verificationCode);
    
    if (!emailSent) {
      // 邮件发送失败，回滚用户创建
      // 注意：实际生产环境需要实现事务回滚
      throw new Error('验证邮件发送失败，请稍后重试');
    }

    return user;
  }

  /**
   * 验证邮箱
   * @param email 邮箱
   * @param code 验证码
   * @returns 验证是否成功
   */
  async verifyEmail(email: string, code: string): Promise<boolean> {
    // 1. 验证输入
    Validator.validateEmail(email);
    Validator.validateVerificationCode(code);

    // 2. 查找用户
    const user = await this.userRepository.findByEmail(email);
    if (!user) {
      throw new NotFoundError('用户不存在');
    }

    // 3. 检查验证码是否匹配
    if (user.verificationCode !== code) {
      throw new ValidationError('验证码错误');
    }

    // 4. 检查验证码是否过期
    if (!user.verificationExpiry || user.verificationExpiry < new Date()) {
      throw new ValidationError('验证码已过期');
    }

    // 5. 更新用户状态
    await this.userRepository.update(user.id, {
      emailVerified: true,
      verificationCode: undefined,
      verificationExpiry: undefined
    });

    return true;
  }

  /**
   * 用户登录
   * @param email 邮箱
   * @param password 密码
   * @returns 登录响应（包含JWT令牌）
   */
  async login(email: string, password: string): Promise<LoginResponse> {
    // 1. 验证输入
    if (!email || !password) {
      throw new ValidationError('邮箱和密码不能为空');
    }

    // 2. 查找用户
    const user = await this.userRepository.findByEmail(email);
    if (!user) {
      // 安全考虑：不暴露具体错误原因
      throw new AuthenticationError('邮箱或密码错误');
    }

    // 3. 检查账户是否被锁定
    if (user.lockUntil && user.lockUntil > new Date()) {
      throw new AuthenticationError('账户已被锁定，请15分钟后再试');
    }

    // 4. 检查邮箱是否已验证
    if (!user.emailVerified) {
      throw new AuthenticationError('请先验证邮箱');
    }

    // 5. 验证密码
    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      // 增加登录失败次数
      const loginAttempts = (user.loginAttempts || 0) + 1;
      
      if (loginAttempts >= this.MAX_LOGIN_ATTEMPTS) {
        // 锁定账户
        await this.userRepository.update(user.id, {
          loginAttempts,
          lockUntil: new Date(Date.now() + this.LOCK_DURATION)
        });
        throw new AuthenticationError('登录失败次数过多，账户已锁定15分钟');
      }

      await this.userRepository.update(user.id, { loginAttempts });
      throw new AuthenticationError('邮箱或密码错误');
    }

    // 6. 重置登录失败次数
    if (user.loginAttempts && user.loginAttempts > 0) {
      await this.userRepository.update(user.id, {
        loginAttempts: 0,
        lockUntil: undefined
      });
    }

    // 7. 生成JWT令牌
    const token = this.jwtService.generateToken(user.id, user.email);

    return {
      token,
      user: {
        id: user.id,
        email: user.email
      }
    };
  }

  /**
   * 请求密码重置
   * @param email 邮箱
   * @returns 是否成功（无论邮箱是否存在都返回true）
   */
  async requestPasswordReset(email: string): Promise<boolean> {
    // 1. 验证邮箱格式
    Validator.validateEmail(email);

    // 2. 查找用户
    const user = await this.userRepository.findByEmail(email);
    
    // 安全考虑：即使邮箱不存在也返回成功，防止邮箱枚举攻击
    if (!user) {
      return true;
    }

    // 3. 生成重置令牌
    const resetToken = uuidv4();
    const resetTokenExpiry = new Date(Date.now() + this.RESET_TOKEN_EXPIRY);

    // 4. 保存重置令牌
    await this.userRepository.update(user.id, {
      resetToken,
      resetTokenExpiry
    });

    // 5. 发送重置邮件
    await this.emailService.sendPasswordResetLink(email, resetToken);

    return true;
  }

  /**
   * 重置密码
   * @param resetToken 重置令牌
   * @param newPassword 新密码
   * @returns 是否成功
   */
  async resetPassword(resetToken: string, newPassword: string): Promise<boolean> {
    // 1. 验证新密码
    Validator.validatePassword(newPassword);

    if (!resetToken || typeof resetToken !== 'string') {
      throw new ValidationError('重置令牌不能为空');
    }

    // 2. 查找匹配的用户
    // 注意：需要在repository中添加findByResetToken方法
    // 这里简化处理，实际应该通过repository查找
    const user = await this.findUserByResetToken(resetToken);
    
    if (!user) {
      throw new ValidationError('重置令牌无效');
    }

    // 3. 检查令牌是否过期
    if (!user.resetTokenExpiry || user.resetTokenExpiry < new Date()) {
      throw new ValidationError('重置令牌已过期');
    }

    // 4. 加密新密码
    const hashedPassword = await bcrypt.hash(newPassword, this.BCRYPT_ROUNDS);

    // 5. 更新密码并清除重置令牌
    await this.userRepository.update(user.id, {
      password: hashedPassword,
      resetToken: undefined,
      resetTokenExpiry: undefined
    });

    return true;
  }

  /**
   * 刷新JWT令牌
   * @param token 旧令牌
   * @returns 新令牌
   */
  refreshToken(token: string): string {
    return this.jwtService.refreshToken(token);
  }

  /**
   * 生成6位数字验证码
   */
  private generateVerificationCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  /**
   * 根据重置令牌查找用户（辅助方法）
   */
  private async findUserByResetToken(token: string): Promise<User | null> {
    // 注意：实际实现需要在repository中添加findByResetToken方法
    // 这里返回null作为占位
    return null;
  }
}
