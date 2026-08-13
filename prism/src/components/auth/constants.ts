export const AUTH_TOKEN_STORAGE_KEY = 'auth-token';

export const AUTH_ERROR_MESSAGES = {
  authStatusCheckFailed: 'Failed to check authentication status',
  loginFailed: 'Login failed',
  registrationFailed: 'Registration failed',
  networkError: 'Network error. Please try again.',
  pendingApproval: '注册申请已提交,等待管理员审批通过后即可登录。',
} as const;
