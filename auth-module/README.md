# 用户认证模块

完整的用户认证模块，支持注册、登录、密码重置功能，包含邮箱验证和JWT令牌认证。

## 功能特性

- ✅ 用户注册（包含邮箱验证）
- ✅ 用户登录（JWT令牌认证）
- ✅ 密码重置（邮箱确认）
- ✅ JWT令牌生成、验证和刷新
- ✅ 密码加密存储（bcrypt）
- ✅ 登录失败锁定机制
- ✅ 完整的单元测试

## 技术栈

- TypeScript
- Jest（测试框架）
- bcrypt（密码加密）
- jsonwebtoken（JWT令牌）
- uuid（唯一标识生成）

## 安装依赖

```bash
npm install
```

## 运行测试

```bash
# 运行所有测试
npm test

# 运行测试并查看覆盖率
npm test -- --coverage

# 监听模式运行测试
npm run test:watch
```

## 构建项目

```bash
npm run build
```

## 项目结构

```
auth-module/
├── src/
│   ├── types/              # 类型定义
│   │   └── index.ts        # 接口和错误类型
│   ├── services/           # 服务实现
│   │   ├── jwt.service.ts  # JWT服务
│   │   ├── email.service.ts # 邮件服务
│   │   ├── auth.service.ts # 认证服务
│   │   └── __tests__/      # 服务测试
│   ├── repository/         # 数据仓储
│   │   └── user.repository.ts
│   ├── utils/              # 工具类
│   │   ├── validator.ts    # 验证器
│   │   └── __tests__/      # 工具测试
│   └── index.ts            # 主入口
├── package.json
├── tsconfig.json
├── jest.config.js
└── README.md
```

## 测试覆盖率要求

- 分支覆盖率：≥ 75%
- 函数覆盖率：≥ 80%
- 行覆盖率：≥ 80%
- 语句覆盖率：≥ 80%

## API文档

### 用户注册

```typescript
const authService = new AuthService(userRepository, jwtService, emailService);
const user = await authService.register('test@example.com', 'Password123!');
```

### 邮箱验证

```typescript
await authService.verifyEmail('test@example.com', '123456');
```

### 用户登录

```typescript
const response = await authService.login('test@example.com', 'Password123!');
console.log(response.token); // JWT令牌
```

### 密码重置请求

```typescript
await authService.requestPasswordReset('test@example.com');
```

### 重置密码

```typescript
await authService.resetPassword('reset-token-here', 'NewPassword123!');
```

### 刷新令牌

```typescript
const newToken = authService.refreshToken(oldToken);
```

## 安全特性

- 🔒 密码使用bcrypt加密（cost factor = 12）
- 🔒 JWT使用HS256算法签名
- 🔒 JWT令牌有效期24小时
- 🔒 验证码和重置令牌有效期1小时
- 🔒 登录失败5次后锁定账户15分钟
- 🔒 防止邮箱枚举攻击
- 🔒 重置令牌一次性使用

## 开发流程

本模块按照TDD（测试驱动开发）流程开发：

1. **Red阶段**：编写失败的测试用例
2. **Green阶段**：编写最少代码使测试通过
3. **Refactor阶段**：重构优化代码

所有测试用例基于OpenSpec规范编写，确保100%覆盖需求场景。
