import { ValidationError } from '../types';

/**
 * 用户输入验证工具
 */
export class Validator {
  /**
   * 验证邮箱格式
   * @param email 邮箱地址
   * @throws ValidationError 如果邮箱格式无效
   */
  static validateEmail(email: string): void {
    if (!email || typeof email !== 'string') {
      throw new ValidationError('邮箱不能为空');
    }

    // RFC 5322 标准的邮箱正则表达式
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    
    if (!emailRegex.test(email)) {
      throw new ValidationError('邮箱格式无效');
    }
  }

  /**
   * 验证密码强度
   * @param password 密码
   * @throws ValidationError 如果密码不符合要求
   */
  static validatePassword(password: string): void {
    if (!password || typeof password !== 'string') {
      throw new ValidationError('密码不能为空');
    }

    if (password.length < 8) {
      throw new ValidationError('密码长度至少为8位');
    }

    // 必须包含大写字母
    if (!/[A-Z]/.test(password)) {
      throw new ValidationError('密码必须包含大写字母');
    }

    // 必须包含小写字母
    if (!/[a-z]/.test(password)) {
      throw new ValidationError('密码必须包含小写字母');
    }

    // 必须包含数字
    if (!/[0-9]/.test(password)) {
      throw new ValidationError('密码必须包含数字');
    }

    // 必须包含特殊字符
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
      throw new ValidationError('密码必须包含特殊字符');
    }
  }

  /**
   * 验证验证码格式
   * @param code 验证码
   * @throws ValidationError 如果验证码格式无效
   */
  static validateVerificationCode(code: string): void {
    if (!code || typeof code !== 'string') {
      throw new ValidationError('验证码不能为空');
    }

    if (!/^\d{6}$/.test(code)) {
      throw new ValidationError('验证码必须为6位数字');
    }
  }
}
