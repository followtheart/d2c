import { v4 as uuidv4 } from 'uuid';
import { User, UserRepository } from '../types';

/**
 * 内存数据库实现
 * 用于测试环境，生产环境应替换为真实数据库
 */
export class InMemoryUserRepository implements UserRepository {
  private users: Map<string, User> = new Map();

  /**
   * 创建新用户
   */
  async create(userData: Omit<User, 'id' | 'createdAt' | 'updatedAt'>): Promise<User> {
    // 检查邮箱唯一性
    const existingUser = await this.findByEmail(userData.email);
    if (existingUser) {
      throw new Error('邮箱已被注册');
    }

    const user: User = {
      ...userData,
      id: uuidv4(),
      createdAt: new Date(),
      updatedAt: new Date()
    };

    this.users.set(user.id, user);
    return user;
  }

  /**
   * 根据邮箱查找用户
   */
  async findByEmail(email: string): Promise<User | null> {
    for (const user of this.users.values()) {
      if (user.email === email) {
        return { ...user }; // 返回副本
      }
    }
    return null;
  }

  /**
   * 根据ID查找用户
   */
  async findById(id: string): Promise<User | null> {
    const user = this.users.get(id);
    return user ? { ...user } : null; // 返回副本
  }

  /**
   * 更新用户信息
   */
  async update(id: string, updates: Partial<User>): Promise<User> {
    const user = this.users.get(id);
    if (!user) {
      throw new Error('用户不存在');
    }

    const updatedUser: User = {
      ...user,
      ...updates,
      id: user.id, // 不允许修改ID
      updatedAt: new Date()
    };

    this.users.set(id, updatedUser);
    return { ...updatedUser }; // 返回副本
  }

  /**
   * 清空所有用户（仅用于测试）
   */
  clear() {
    this.users.clear();
  }

  /**
   * 获取用户数量（仅用于测试）
   */
  count(): number {
    return this.users.size;
  }
}
