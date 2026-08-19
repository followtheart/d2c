import { EmailService } from '../types';

/**
 * 邮件服务Mock实现
 * 用于测试环境，实际生产环境应替换为真实的邮件服务
 */
export class EmailServiceMock implements EmailService {
  private sentEmails: Array<{ to: string; type: string; content: string }> = [];

  /**
   * 发送邮箱验证码
   * @param email 目标邮箱
   * @param code 验证码
   * @returns 是否发送成功
   */
  async sendVerificationCode(email: string, code: string): Promise<boolean> {
    try {
      // 模拟邮件发送
      console.log(`[邮件服务] 发送验证码到 ${email}: ${code}`);
      
      this.sentEmails.push({
        to: email,
        type: 'verification',
        content: `您的验证码是: ${code}，有效期1小时`
      });

      // 模拟异步操作
      await new Promise(resolve => setTimeout(resolve, 100));

      return true;
    } catch (error) {
      console.error('邮件发送失败:', error);
      return false;
    }
  }

  /**
   * 发送密码重置链接
   * @param email 目标邮箱
   * @param resetToken 重置令牌
   * @returns 是否发送成功
   */
  async sendPasswordResetLink(email: string, resetToken: string): Promise<boolean> {
    try {
      // 模拟邮件发送
      const resetLink = `https://example.com/reset?token=${resetToken}`;
      console.log(`[邮件服务] 发送密码重置链接到 ${email}: ${resetLink}`);
      
      this.sentEmails.push({
        to: email,
        type: 'password-reset',
        content: `点击以下链接重置密码: ${resetLink}，有效期1小时`
      });

      // 模拟异步操作
      await new Promise(resolve => setTimeout(resolve, 100));

      return true;
    } catch (error) {
      console.error('邮件发送失败:', error);
      return false;
    }
  }

  /**
   * 获取已发送的邮件（仅用于测试）
   */
  getSentEmails() {
    return this.sentEmails;
  }

  /**
   * 清空已发送邮件记录（仅用于测试）
   */
  clearSentEmails() {
    this.sentEmails = [];
  }
}
