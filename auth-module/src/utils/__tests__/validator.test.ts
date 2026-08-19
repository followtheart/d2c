import { Validator } from '../validator';
import { ValidationError } from '../../types';

describe('Validator', () => {
  describe('validateEmail', () => {
    // TC-REG-001: 有效邮箱
    test('TC-REG-001: 应该接受有效邮箱', () => {
      expect(() => Validator.validateEmail('test@example.com')).not.toThrow();
      expect(() => Validator.validateEmail('user.name@domain.co.uk')).not.toThrow();
    });

    // TC-REG-002: 无效邮箱格式
    test('TC-REG-002: 应该拒绝无效邮箱格式', () => {
      expect(() => Validator.validateEmail('invalid-email')).toThrow(ValidationError);
      expect(() => Validator.validateEmail('test@')).toThrow(ValidationError);
      expect(() => Validator.validateEmail('@example.com')).toThrow(ValidationError);
    });

    // TC-REG-006: 空邮箱
    test('TC-REG-006: 应该拒绝空邮箱', () => {
      expect(() => Validator.validateEmail('')).toThrow(ValidationError);
      expect(() => Validator.validateEmail(undefined as any)).toThrow(ValidationError);
    });
  });

  describe('validatePassword', () => {
    // TC-REG-001: 强密码
    test('TC-REG-001: 应该接受强密码', () => {
      expect(() => Validator.validatePassword('Password123!')).not.toThrow();
      expect(() => Validator.validatePassword('Str0ng@Pass')).not.toThrow();
    });

    // TC-REG-003: 密码长度不足
    test('TC-REG-003: 应该拒绝长度<8的密码', () => {
      expect(() => Validator.validatePassword('Pass1!')).toThrow(ValidationError);
      expect(() => Validator.validatePassword('Abc123!')).toThrow(ValidationError);
    });

    // TC-REG-004: 密码缺少特殊字符
    test('TC-REG-004: 应该拒绝缺少特殊字符的密码', () => {
      expect(() => Validator.validatePassword('Password123')).toThrow(ValidationError);
    });

    // 密码缺少大写字母
    test('应该拒绝缺少大写字母的密码', () => {
      expect(() => Validator.validatePassword('password123!')).toThrow(ValidationError);
    });

    // 密码缺少数字
    test('应该拒绝缺少数字的密码', () => {
      expect(() => Validator.validatePassword('Password!')).toThrow(ValidationError);
    });

    // TC-REG-006: 空密码
    test('TC-REG-006: 应该拒绝空密码', () => {
      expect(() => Validator.validatePassword('')).toThrow(ValidationError);
      expect(() => Validator.validatePassword(undefined as any)).toThrow(ValidationError);
    });
  });

  describe('validateVerificationCode', () => {
    // TC-VERIFY-001: 正确的验证码格式
    test('应该接受6位数字验证码', () => {
      expect(() => Validator.validateVerificationCode('123456')).not.toThrow();
      expect(() => Validator.validateVerificationCode('000000')).not.toThrow();
      expect(() => Validator.validateVerificationCode('999999')).not.toThrow();
    });

    // TC-VERIFY-004: 错误的验证码格式
    test('应该拒绝非6位数字的验证码', () => {
      expect(() => Validator.validateVerificationCode('12345')).toThrow(ValidationError);
      expect(() => Validator.validateVerificationCode('1234567')).toThrow(ValidationError);
      expect(() => Validator.validateVerificationCode('abcdef')).toThrow(ValidationError);
      expect(() => Validator.validateVerificationCode('12345a')).toThrow(ValidationError);
    });

    // 空验证码
    test('应该拒绝空验证码', () => {
      expect(() => Validator.validateVerificationCode('')).toThrow(ValidationError);
      expect(() => Validator.validateVerificationCode(undefined as any)).toThrow(ValidationError);
    });
  });
});
