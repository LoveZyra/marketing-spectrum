// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution.
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import crypto from 'crypto';

import spawn from 'cross-spawn';
import express from 'express';
import { Octokit } from '@octokit/rest';

import { userDb, apiKeysDb, githubTokensDb, projectsDb, sessionsDb, sessionMessagesDb, canViewerSeeSession } from '../modules/database/index.js';
import { chatRunRegistry } from '../modules/websocket/index.js';
import { queryClaudeSDK, abortClaudeSDKSession } from '../claude-sdk.js';
import { IS_PLATFORM } from '../constants/config.js';
import { readRequestViewer } from '../shared/project-visibility.js';
import { normalizeProjectPath, WORKSPACES_ROOT, generateMessageId } from '../shared/utils.js';

const router = express.Router();

/**
 * 要求路径落在工作区根之下,否则抛错。
 *
 * 先解析 realpath 再比,否则工作区里放一个指向 / 的符号链接就绕过去了。
 * 路径尚不存在时(克隆目标目录)向上找到最近的已存在祖先来解析,与
 * files 模块的 `realpathAllowingMissingLeaf` 同一思路。
 */
async function assertInsideWorkspaceRoot(candidatePath) {
  const root = path.resolve(WORKSPACES_ROOT);

  const realOf = async (target) => {
    let current = path.resolve(target);
    const suffix = [];
    for (;;) {
      try {
        const real = await fs.realpath(current);
        return suffix.length > 0 ? path.join(real, ...suffix) : real;
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
        const parent = path.dirname(current);
        if (parent === current) return path.resolve(target);
        suffix.unshift(path.basename(current));
        current = parent;
      }
    }
  };

  const [realRoot, realTarget] = await Promise.all([realOf(root), realOf(candidatePath)]);
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new Error(
      `Project path must stay under the workspace root (${realRoot}); got ${realTarget}`,
    );
  }
}


/**
 * Middleware to authenticate agent API requests.
 *
 * Supports two authentication modes:
 * 1. Platform mode (IS_PLATFORM=true): For managed/hosted deployments where
 *    authentication is handled by an external proxy. Requests are trusted and
 *    the default user context is used.
 *
 * 2. API key mode (default): For self-hosted deployments where users authenticate
 *    via API keys created in the UI. Keys are validated against the local database.
 */
const validateExternalApiKey = (req, res, next) => {
  // Platform mode: Authentication is handled externally (e.g., by a proxy layer).
  // Trust the request and use the default user context.
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (!user) {
        return res.status(500).json({ error: 'Platform mode: No user found in database' });
      }
      req.user = user;
      return next();
    } catch (error) {
      console.error('Platform mode error:', error);
      return res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
    }
  }

  // Self-hosted mode: Validate API key from header or query parameter
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;

  if (!apiKey) {
    return res.status(401).json({ error: 'API key required' });
  }

  const user = apiKeysDb.validateApiKey(apiKey);

  if (!user) {
    return res.status(401).json({ error: 'Invalid or inactive API key' });
  }

  req.user = user;
  next();
};

/**
 * Get the remote URL of a git repository
 * @param {string} repoPath - Path to the git repository
 * @returns {Promise<string>} - Remote URL of the repository
 */
async function getGitRemoteUrl(repoPath) {
  return new Promise((resolve, reject) => {
    const gitProcess = spawn('git', ['config', '--get', 'remote.origin.url'], {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    gitProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    gitProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    gitProcess.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Failed to get git remote: ${stderr}`));
      }
    });

    gitProcess.on('error', (error) => {
      reject(new Error(`Failed to execute git: ${error.message}`));
    });
  });
}

/**
 * Normalize GitHub URLs for comparison
 * @param {string} url - GitHub URL
 * @returns {string} - Normalized URL
 */
function normalizeGitHubUrl(url) {
  // Remove .git suffix
  let normalized = url.replace(/\.git$/, '');
  // Convert SSH to HTTPS format for comparison
  normalized = normalized.replace(/^git@github\.com:/, 'https://github.com/');
  // Remove trailing slash
  normalized = normalized.replace(/\/$/, '');
  return normalized.toLowerCase();
}

/**
 * Parse GitHub URL to extract owner and repo
 * @param {string} url - GitHub URL (HTTPS or SSH)
 * @returns {{owner: string, repo: string}} - Parsed owner and repo
 */
function parseGitHubUrl(url) {
  // Handle HTTPS URLs: https://github.com/owner/repo or https://github.com/owner/repo.git
  // Handle SSH URLs: git@github.com:owner/repo or git@github.com:owner/repo.git
  const match = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) {
    throw new Error('Invalid GitHub URL format');
  }
  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/, '')
  };
}

/**
 * Auto-generate a branch name from a message
 * @param {string} message - The agent message
 * @returns {string} - Generated branch name
 */
function autogenerateBranchName(message) {
  // Convert to lowercase, replace spaces/special chars with hyphens
  let branchName = message
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single
    .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens

  // Ensure non-empty fallback
  if (!branchName) {
    branchName = 'task';
  }

  // Generate timestamp suffix (last 6 chars of base36 timestamp)
  const timestamp = Date.now().toString(36).slice(-6);
  const suffix = `-${timestamp}`;

  // Limit length to ensure total length including suffix fits within 50 characters
  const maxBaseLength = 50 - suffix.length;
  if (branchName.length > maxBaseLength) {
    branchName = branchName.substring(0, maxBaseLength);
  }

  // Remove any trailing hyphen after truncation and ensure no leading hyphen
  branchName = branchName.replace(/-$/, '').replace(/^-+/, '');

  // If still empty or starts with hyphen after cleanup, use fallback
  if (!branchName || branchName.startsWith('-')) {
    branchName = 'task';
  }

  // Combine base name with timestamp suffix
  branchName = `${branchName}${suffix}`;

  // Final validation: ensure it matches safe pattern
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branchName)) {
    // Fallback to deterministic safe name
    return `branch-${timestamp}`;
  }

  return branchName;
}

/**
 * Validate a Git branch name
 * @param {string} branchName - Branch name to validate
 * @returns {{valid: boolean, error?: string}} - Validation result
 */
function validateBranchName(branchName) {
  if (!branchName || branchName.trim() === '') {
    return { valid: false, error: 'Branch name cannot be empty' };
  }

  // Git branch name rules
  const invalidPatterns = [
    { pattern: /^\./, message: 'Branch name cannot start with a dot' },
    { pattern: /\.$/, message: 'Branch name cannot end with a dot' },
    { pattern: /\.\./, message: 'Branch name cannot contain consecutive dots (..)' },
    { pattern: /\s/, message: 'Branch name cannot contain spaces' },
    { pattern: /[~^:?*\[\\]/, message: 'Branch name cannot contain special characters: ~ ^ : ? * [ \\' },
    { pattern: /@{/, message: 'Branch name cannot contain @{' },
    { pattern: /\/$/, message: 'Branch name cannot end with a slash' },
    { pattern: /^\//, message: 'Branch name cannot start with a slash' },
    { pattern: /\/\//, message: 'Branch name cannot contain consecutive slashes' },
    { pattern: /\.lock$/, message: 'Branch name cannot end with .lock' }
  ];

  for (const { pattern, message } of invalidPatterns) {
    if (pattern.test(branchName)) {
      return { valid: false, error: message };
    }
  }

  // Check for ASCII control characters
  if (/[\x00-\x1F\x7F]/.test(branchName)) {
    return { valid: false, error: 'Branch name cannot contain control characters' };
  }

  return { valid: true };
}

/**
 * Get recent commit messages from a repository
 * @param {string} projectPath - Path to the git repository
 * @param {number} limit - Number of commits to retrieve (default: 5)
 * @returns {Promise<string[]>} - Array of commit messages
 */
async function getCommitMessages(projectPath, limit = 5) {
  return new Promise((resolve, reject) => {
    const gitProcess = spawn('git', ['log', `-${limit}`, '--pretty=format:%s'], {
      cwd: projectPath,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    gitProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    gitProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    gitProcess.on('close', (code) => {
      if (code === 0) {
        const messages = stdout.trim().split('\n').filter(msg => msg.length > 0);
        resolve(messages);
      } else {
        reject(new Error(`Failed to get commit messages: ${stderr}`));
      }
    });

    gitProcess.on('error', (error) => {
      reject(new Error(`Failed to execute git: ${error.message}`));
    });
  });
}

/**
 * Create a new branch on GitHub using the API
 * @param {Octokit} octokit - Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} branchName - Name of the new branch
 * @param {string} baseBranch - Base branch to branch from (default: 'main')
 * @returns {Promise<void>}
 */
async function createGitHubBranch(octokit, owner, repo, branchName, baseBranch = 'main') {
  try {
    // Get the SHA of the base branch
    const { data: ref } = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${baseBranch}`
    });

    const baseSha = ref.object.sha;

    // Create the new branch
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: baseSha
    });

    console.log(`✅ Created branch '${branchName}' on GitHub`);
  } catch (error) {
    if (error.status === 422 && error.message.includes('Reference already exists')) {
      console.log(`ℹ️ Branch '${branchName}' already exists on GitHub`);
    } else {
      throw error;
    }
  }
}

/**
 * Create a pull request on GitHub
 * @param {Octokit} octokit - Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} branchName - Head branch name
 * @param {string} title - PR title
 * @param {string} body - PR body/description
 * @param {string} baseBranch - Base branch (default: 'main')
 * @returns {Promise<{number: number, url: string}>} - PR number and URL
 */
async function createGitHubPR(octokit, owner, repo, branchName, title, body, baseBranch = 'main') {
  const { data: pr } = await octokit.pulls.create({
    owner,
    repo,
    title,
    head: branchName,
    base: baseBranch,
    body
  });

  console.log(`✅ Created pull request #${pr.number}: ${pr.html_url}`);

  return {
    number: pr.number,
    url: pr.html_url
  };
}

/**
 * Clone a GitHub repository to a directory
 * @param {string} githubUrl - GitHub repository URL
 * @param {string} githubToken - Optional GitHub token for private repos
 * @param {string} projectPath - Path for cloning the repository
 * @returns {Promise<string>} - Path to the cloned repository
 */
async function cloneGitHubRepo(githubUrl, githubToken = null, projectPath) {
  return new Promise(async (resolve, reject) => {
    try {
      // Validate GitHub URL —— 必须真的是 github.com 的 https 地址。
      // 老判定是 includes('github.com'),`https://evil.com/github.com` 也能过;
      // 现在凭据走 http.extraHeader 随请求发出,主机名不锁死等于把 token 交给
      // 任意主机。
      let parsedRepoUrl = null;
      try {
        parsedRepoUrl = new URL(String(githubUrl ?? ''));
      } catch {
        parsedRepoUrl = null;
      }
      const repoHost = parsedRepoUrl?.hostname ?? '';
      if (
        !parsedRepoUrl
        || parsedRepoUrl.protocol !== 'https:'
        || !(repoHost === 'github.com' || repoHost.endsWith('.github.com'))
      ) {
        throw new Error('Invalid GitHub URL');
      }

      const cloneDir = path.resolve(projectPath);

      // Check if directory already exists
      try {
        await fs.access(cloneDir);
        // Directory exists - check if it's a git repo with the same URL
        try {
          const existingUrl = await getGitRemoteUrl(cloneDir);
          const normalizedExisting = normalizeGitHubUrl(existingUrl);
          const normalizedRequested = normalizeGitHubUrl(githubUrl);

          if (normalizedExisting === normalizedRequested) {
            console.log('✅ Repository already exists at path with correct URL');
            return resolve(cloneDir);
          } else {
            throw new Error(`Directory ${cloneDir} already exists with a different repository (${existingUrl}). Expected: ${githubUrl}`);
          }
        } catch (gitError) {
          throw new Error(`Directory ${cloneDir} already exists but is not a valid git repository or git command failed`);
        }
      } catch (accessError) {
        // Directory doesn't exist - proceed with clone
      }

      // Ensure parent directory exists
      await fs.mkdir(path.dirname(cloneDir), { recursive: true });

      // 凭据不进 URL、不进 argv:老写法把 token 拼成 https://<token>@github.com,
      // 它会随 git 的报错原样出现在 stderr(下面还 console.log)、落进服务日志,
      // 还会被写进克隆产物的 .git/config(origin URL)。改走环境变量注入的
      // http.extraHeader(GIT_CONFIG_* 是 git 2.31+ 的正路),token 全程不落
      // URL / argv / 磁盘;远端 URL 保持干净的 githubUrl。
      const gitEnv = { ...process.env };
      if (githubToken) {
        gitEnv.GIT_CONFIG_COUNT = '1';
        gitEnv.GIT_CONFIG_KEY_0 = 'http.extraHeader';
        gitEnv.GIT_CONFIG_VALUE_0 =
          `Authorization: Basic ${Buffer.from(`x-access-token:${githubToken}`).toString('base64')}`;
        // 防呆:凭据只该从上面这条 header 进来,禁用交互式追问。
        gitEnv.GIT_TERMINAL_PROMPT = '0';
      }

      // 兜底脱敏:就算 URL 里被调用方塞了凭据(githubUrl 本身带 user:pass@),
      // 日志与报错也不放行。
      const scrubSecrets = (text) => String(text ?? '').replace(/(https?:\/\/)[^\s/@]+@/gi, '$1***@');

      console.log('🔄 Cloning repository:', scrubSecrets(githubUrl));
      console.log('📁 Destination:', cloneDir);

      // Execute git clone
      const gitProcess = spawn('git', ['clone', '--depth', '1', githubUrl, cloneDir], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: gitEnv,
      });

      let stdout = '';
      let stderr = '';

      gitProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      gitProcess.stderr.on('data', (data) => {
        stderr += data.toString();
        console.log('Git stderr:', scrubSecrets(data.toString()));
      });

      gitProcess.on('close', (code) => {
        if (code === 0) {
          console.log('✅ Repository cloned successfully');
          resolve(cloneDir);
        } else {
          const cleanStderr = scrubSecrets(stderr);
          console.error('❌ Git clone failed:', cleanStderr);
          reject(new Error(`Git clone failed: ${cleanStderr}`));
        }
      });

      gitProcess.on('error', (error) => {
        reject(new Error(`Failed to execute git: ${error.message}`));
      });
    } catch (error) {
      reject(error);
    }
  });
}

/** JSON.parse,坏了就返回 null —— 不让一条脏帧把整段收集带崩。 */
function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Clean up a temporary project directory and its Claude session
 * @param {string} projectPath - Path to the project directory
 * @param {string} sessionId - Session ID to clean up
 */
async function cleanupProject(projectPath, sessionId = null) {
  try {
    // Only clean up projects in the external-projects directory
    if (!projectPath.includes('.claude/external-projects')) {
      console.warn('⚠️ Refusing to clean up non-external project:', projectPath);
      return;
    }

    console.log('🧹 Cleaning up project:', projectPath);
    await fs.rm(projectPath, { recursive: true, force: true });
    console.log('✅ Project cleaned up');

    // Also clean up the Claude session directory if sessionId provided
    if (sessionId) {
      try {
        const sessionPath = path.join(os.homedir(), '.claude', 'sessions', sessionId);
        console.log('🧹 Cleaning up session directory:', sessionPath);
        await fs.rm(sessionPath, { recursive: true, force: true });
        console.log('✅ Session directory cleaned up');
      } catch (error) {
        console.error('⚠️ Failed to clean up session directory:', error.message);
      }
    }
  } catch (error) {
    console.error('❌ Failed to clean up project:', error);
  }
}

/**
 * SSE Stream Writer - Adapts SDK/CLI output to Server-Sent Events
 */
class SSEStreamWriter {
  constructor(res, userId = null) {
    this.res = res;
    this.sessionId = null;
    this.userId = userId;
    this.isSSEStreamWriter = true;  // Marker for transport detection
  }

  send(data) {
    if (this.res.writableEnded) {
      return;
    }

    // Format as SSE - providers send raw objects, we stringify
    this.res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  end() {
    if (!this.res.writableEnded) {
      this.res.write('data: {"type":"done"}\n\n');
      this.res.end();
    }
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId;
    this.send({ type: 'session-id', sessionId });
  }

  getSessionId() {
    return this.sessionId;
  }
}

/**
 * Non-streaming response collector
 */
class ResponseCollector {
  constructor(userId = null) {
    this.messages = [];
    this.sessionId = null;
    this.userId = userId;
  }

  send(data) {
    // Store ALL messages for now - we'll filter when returning
    this.messages.push(data);

    // Extract sessionId if present
    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data);
        if (parsed.sessionId) {
          this.sessionId = parsed.sessionId;
        }
      } catch (e) {
        // Not JSON, ignore
      }
    } else if (data && data.sessionId) {
      this.sessionId = data.sessionId;
    }
  }

  end() {
    // Do nothing - we'll collect all messages
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId;
  }

  getSessionId() {
    return this.sessionId;
  }

  getMessages() {
    return this.messages;
  }

  /**
   * Get filtered assistant messages only
   */
  getAssistantMessages() {
    /**
     * 这里原来只认 `type: 'claude-response'` 的**字符串**帧 —— 那是老 CLI 的
     * 线格式。走 SDK 之后运行时推过来的一律是规范化**对象**
     * (`{ kind: 'text' | 'tool_use' | … }`),两个条件一个都对不上,
     * 于是非流式响应的 `messages` **恒为空数组**,静默了很久。
     *
     * 现在按 kind 取:`text` 就是助手真正说出来的那几段。工具调用不在内 ——
     * 要看完整过程去页面上看,这个字段的语义是"回答"。
     */
    const assistantMessages = [];

    for (const msg of this.messages) {
      const data = typeof msg === 'string' ? safeParseJson(msg) : msg;
      if (!data || typeof data !== 'object') continue;

      if (data.kind === 'text' && typeof data.content === 'string' && data.content) {
        assistantMessages.push({
          id: data.id,
          role: data.role || 'assistant',
          content: data.content,
          model: data.model,
          timestamp: data.timestamp,
        });
        continue;
      }

      // 老 CLI 线格式,留着不动 —— 万一还有别的调用方走那条路。
      if (data.type === 'claude-response' && data.data && data.data.type === 'assistant') {
        assistantMessages.push(data.data);
      }
    }

    return assistantMessages;
  }

  /**
   * Calculate total tokens from all messages
   */
  getTotalTokens() {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheCreation = 0;

    for (const msg of this.messages) {
      let data = msg;

      // Parse if string
      if (typeof msg === 'string') {
        try {
          data = JSON.parse(msg);
        } catch (e) {
          continue;
        }
      }

      if (!data || typeof data !== 'object') continue;

      // SDK 路径:每条助手消息的用量以 `status / token_budget` 帧推过来。
      // 和下面那段老格式一样是**逐条累加**,不是取最后一条。
      if (data.kind === 'status' && data.text === 'token_budget' && data.tokenBudget) {
        const budget = data.tokenBudget;
        totalOutput += budget.outputTokens || 0;
        totalCacheRead += budget.cacheReadTokens || 0;
        totalCacheCreation += budget.cacheCreationTokens || 0;
        // budget.inputTokens 里已经含了两种缓存,减掉才是"直入"部分,
        // 否则下面再加一次会把缓存算两遍。
        totalInput += Math.max(
          0,
          (budget.inputTokens || 0) - (budget.cacheReadTokens || 0) - (budget.cacheCreationTokens || 0),
        );
        continue;
      }

      // Extract usage from claude-response messages
      if (data.type === 'claude-response' && data.data) {
        const msgData = data.data;
        if (msgData.message && msgData.message.usage) {
          const usage = msgData.message.usage;
          totalInput += usage.input_tokens || 0;
          totalOutput += usage.output_tokens || 0;
          totalCacheRead += usage.cache_read_input_tokens || 0;
          totalCacheCreation += usage.cache_creation_input_tokens || 0;
        }
      }
    }

    const inputTokens = totalInput + totalCacheRead + totalCacheCreation;

    return {
      inputTokens,
      outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead,
      cacheCreationTokens: totalCacheCreation,
      totalTokens: inputTokens + totalOutput
    };
  }
}

// ===============================
// External API Endpoint
// ===============================

/**
 * POST /api/agent/sessions —— **先领一个会话号**。
 *
 * 不跑任何回合,毫秒级返回。用途是把"拿 id"和"干活"拆成两步:
 *
 *   1. POST /api/agent/sessions  { projectPath }        → { sessionId, sessionPath }
 *   2. 立刻就能拼链接:  https://<host>/session/<sessionId>
 *   3. POST /api/agent           { projectPath, message, sessionId }
 *
 * 关键是这里**真的在库里占了一行**,不是发一个 UUID 就完事 —— 占了行,
 * 第 2 步那个链接当场就能打开(先是一段空对话),而不是"会话不存在"。
 *
 * 第 3 步传这个 id 时会被当成"**用这个 id 新建**"而不是续对话:判据是库里
 * 那行的 `provider_session_id` 还空着。老调用方传的是 provider 原生 id
 * (磁盘发现的会话两列同值,一定非空),所以走的还是原来的 resume,行为不变。
 *
 * Request:  { projectPath: "/path/to/project", provider?: "claude" }
 * Response: 201 { success, sessionId, sessionPath, projectPath }
 */
router.post('/sessions', validateExternalApiKey, async (req, res) => {
  const { projectPath, provider = 'claude' } = req.body || {};

  if (!projectPath || !String(projectPath).trim()) {
    return res.status(400).json({ error: 'projectPath is required' });
  }

  if (provider !== 'claude') {
    return res.status(400).json({ error: 'provider must be "claude"' });
  }

  try {
    // 和主路由同一道门:这个端点用 API key 鉴权,而任何登录用户都能自助建一把
    // key,少了这道校验就等于把工作区边界让出去了。
    const finalProjectPath = normalizeProjectPath(path.resolve(String(projectPath)));
    await assertInsideWorkspaceRoot(finalProjectPath);

    try {
      await fs.access(finalProjectPath);
    } catch {
      return res.status(400).json({ error: `Project path does not exist: ${finalProjectPath}` });
    }

    const sessionId = crypto.randomUUID();
    // owner 必须传:不传 = 项目无主(非公共目录仅 root 可见 / 公共目录下全员可见),
    // 调用者自己反而丢掉归属。
    sessionsDb.createAppSession(sessionId, provider, finalProjectPath, req.user.id);

    return res.status(201).json({
      success: true,
      sessionId,
      // 相对路径:服务端不猜自己的对外域名(反代之后 Host 未必对)。
      sessionPath: `/session/${sessionId}`,
      projectPath: finalProjectPath,
    });
  } catch (error) {
    console.error('[Agent API] 领会话号失败:', error);
    return res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/agent/sessions — 本 key 可见的会话列表(F5)。
 *
 * 可见性与网页端同一道闸(canViewerSeeSession):自己项目的会话 + 公共目录
 * 项目的会话。默认不含已归档,`?includeArchived=1` 才带。`running` 来自
 * 运行注册表,轮询它即可知道回合是否还在跑。
 */
router.get('/sessions', validateExternalApiKey, (req, res) => {
  try {
    const viewer = readRequestViewer(req);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const includeArchived = req.query.includeArchived === '1' || req.query.includeArchived === 'true';

    const rows = [
      ...sessionsDb.getAllSessions(),
      ...(includeArchived ? sessionsDb.getArchivedSessions() : []),
    ]
      .filter((row) => canViewerSeeSession(row.session_id, viewer))
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));

    const page = rows.slice(offset, offset + limit).map((row) => ({
      sessionId: row.session_id,
      provider: row.provider,
      projectPath: row.project_path,
      name: row.custom_name || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archived: Boolean(row.isArchived),
      running: chatRunRegistry.isProcessing(row.session_id),
      sessionPath: `/session/${row.session_id}`,
    }));

    return res.json({ success: true, total: rows.length, offset, limit, sessions: page });
  } catch (error) {
    console.error('[Agent API] 列会话失败:', error);
    return res.status(500).json({ error: 'Failed to list sessions' });
  }
});

/**
 * GET /api/agent/runs/:sessionId — 会话的运行状态(F5)。
 *
 * 不可见与不存在同形 404。空闲会话返回 status:'idle';跑过的返回注册表里的
 * 最后状态(running/completed)与起止时间。
 */
router.get('/runs/:sessionId', validateExternalApiKey, (req, res) => {
  const { sessionId } = req.params;
  const viewer = readRequestViewer(req);
  if (!canViewerSeeSession(sessionId, viewer)) {
    return res.status(404).json({ error: `Session "${sessionId}" was not found.`, code: 'SESSION_NOT_FOUND' });
  }

  const run = chatRunRegistry.getRun(sessionId);
  if (!run) {
    return res.json({ success: true, sessionId, status: 'idle' });
  }

  return res.json({
    success: true,
    sessionId,
    status: run.status,
    provider: run.provider,
    startedAt: new Date(run.startedAt).toISOString(),
    completedAt: run.completedAt ? new Date(run.completedAt).toISOString() : null,
    lastSeq: run.lastSeq,
  });
});

/**
 * POST /api/agent/sessions/:sessionId/abort — 中止正在跑的回合(F5)。
 *
 * 与网页端 chat.abort 同一条路:先按 provider 原生 id 中止,拿不到(新会话
 * 第一轮)再按 runId(app 会话 id)兜底;随后在注册表里落终态,订阅中的
 * 浏览器会照常收到 complete 帧。
 */
router.post('/sessions/:sessionId/abort', validateExternalApiKey, async (req, res) => {
  const { sessionId } = req.params;
  const viewer = readRequestViewer(req);
  if (!canViewerSeeSession(sessionId, viewer)) {
    return res.status(404).json({ error: `Session "${sessionId}" was not found.`, code: 'SESSION_NOT_FOUND' });
  }

  const run = chatRunRegistry.getRun(sessionId);
  if (!run || run.status !== 'running') {
    return res.status(409).json({ error: `Session "${sessionId}" has no active run.`, code: 'NO_ACTIVE_RUN' });
  }

  try {
    let success = false;
    if (run.provider === 'claude') {
      if (run.providerSessionId) {
        success = Boolean(await abortClaudeSDKSession(run.providerSessionId, { runId: sessionId }));
      }
      if (!success) {
        success = Boolean(await abortClaudeSDKSession('', { runId: sessionId }));
      }
    }

    chatRunRegistry.completeRun(sessionId, { exitCode: success ? 0 : 1, aborted: true });
    return res.json({ success: true, aborted: success, sessionId });
  } catch (error) {
    console.error('[Agent API] 中止失败:', error);
    return res.status(500).json({ error: 'Failed to abort run' });
  }
});

/**
 * POST /api/agent
 *
 * Trigger an AI agent to work on a project.
 * Supports automatic GitHub branch and pull request creation after successful completion.
 *
 * ================================================================================================
 * REQUEST BODY PARAMETERS
 * ================================================================================================
 *
 * @param {string} githubUrl - (Conditionally Required) GitHub repository URL to clone.
 *                             Supported formats:
 *                             - HTTPS: https://github.com/owner/repo
 *                             - HTTPS with .git: https://github.com/owner/repo.git
 *                             - SSH: git@github.com:owner/repo
 *                             - SSH with .git: git@github.com:owner/repo.git
 *
 * @param {string} projectPath - (Conditionally Required) Path to existing project OR destination for cloning.
 *                               Behavior depends on usage:
 *                               - If used alone: Must point to existing project directory
 *                               - If used with githubUrl: Target location for cloning
 *                               - If omitted with githubUrl: Auto-generates temporary path in ~/.claude/external-projects/
 *
 * @param {string} message - (Required) Task description for the AI agent. Used as:
 *                          - Instructions for the agent
 *                          - Source for auto-generated branch names (if createBranch=true and no branchName)
 *                          - Fallback for PR title if no commits are made
 *
 * @param {string} provider - (Optional) AI provider to use. Options: 'claude'
 *                           Default: 'claude'
 *
 * @param {boolean} stream - (Optional) Enable Server-Sent Events (SSE) streaming for real-time updates.
 *                          Default: true
 *                          - true: Returns text/event-stream with incremental updates
 *                          - false: Returns complete JSON response after completion
 *
 * @param {string} model - (Optional) Model identifier.
 *
 *                        Claude models: 'default', 'sonnet', 'opus', 'haiku', 'sonnet[1m]', 'opus[1m]', 'fable'
 *
 * @param {string} effort - (Optional) Reasoning effort for models that support it.
 *                          Claude supports: 'low', 'medium', 'high', 'xhigh', 'max' depending on model.
 *                          'default' or omission lets the provider decide.
 *
 * @param {boolean} cleanup - (Optional) Auto-cleanup project directory after completion.
 *                           Default: true
 *                           Behavior:
 *                           - Only applies when cloning via githubUrl (not for existing projectPath)
 *                           - Deletes cloned repository after 5 seconds
 *                           - Also deletes associated Claude session directory
 *                           - Remote branch and PR remain on GitHub if created
 *
 * @param {string} githubToken - (Optional) GitHub Personal Access Token for authentication.
 *                              Overrides stored token from user settings.
 *                              Required for:
 *                              - Private repositories
 *                              - Branch/PR creation features
 *                              Token must have 'repo' scope for full functionality.
 *
 * @param {string} branchName - (Optional) Custom name for the Git branch.
 *                             If provided, createBranch is automatically set to true.
 *                             Validation rules (errors returned if violated):
 *                             - Cannot be empty or whitespace only
 *                             - Cannot start or end with dot (.)
 *                             - Cannot contain consecutive dots (..)
 *                             - Cannot contain spaces
 *                             - Cannot contain special characters: ~ ^ : ? * [ \
 *                             - Cannot contain @{
 *                             - Cannot start or end with forward slash (/)
 *                             - Cannot contain consecutive slashes (//)
 *                             - Cannot end with .lock
 *                             - Cannot contain ASCII control characters
 *                             Examples: 'feature/user-auth', 'bugfix/login-error', 'refactor/db-optimization'
 *
 * @param {boolean} createBranch - (Optional) Create a new Git branch after successful agent completion.
 *                                Default: false (or true if branchName is provided)
 *                                Behavior:
 *                                - Creates branch locally and pushes to remote
 *                                - If branch exists locally: Checks out existing branch (no error)
 *                                - If branch exists on remote: Uses existing branch (no error)
 *                                - Branch name: Custom (if branchName provided) or auto-generated from message
 *                                - Requires either githubUrl OR projectPath with GitHub remote
 *
 * @param {boolean} createPR - (Optional) Create a GitHub Pull Request after successful completion.
 *                            Default: false
 *                            Behavior:
 *                            - PR title: First commit message (or fallback to message parameter)
 *                            - PR description: Auto-generated from all commit messages
 *                            - Base branch: Always 'main' (currently hardcoded)
 *                            - If PR already exists: GitHub returns error with details
 *                            - Requires either githubUrl OR projectPath with GitHub remote
 *
 * ================================================================================================
 * PATH HANDLING BEHAVIOR
 * ================================================================================================
 *
 * Scenario 1: Only githubUrl provided
 *   Input:  { githubUrl: "https://github.com/owner/repo" }
 *   Action: Clones to auto-generated temporary path: ~/.claude/external-projects/<hash>/
 *   Cleanup: Yes (if cleanup=true)
 *
 * Scenario 2: Only projectPath provided
 *   Input:  { projectPath: "/home/user/my-project" }
 *   Action: Uses existing project at specified path
 *   Validation: Path must exist and be accessible
 *   Cleanup: No (never cleanup existing projects)
 *
 * Scenario 3: Both githubUrl and projectPath provided
 *   Input:  { githubUrl: "https://github.com/owner/repo", projectPath: "/custom/path" }
 *   Action: Clones githubUrl to projectPath location
 *   Validation:
 *     - If projectPath exists with git repo:
 *       - Compares remote URL with githubUrl
 *       - If URLs match: Reuses existing repo
 *       - If URLs differ: Returns error
 *   Cleanup: Yes (if cleanup=true)
 *
 * ================================================================================================
 * GITHUB BRANCH/PR CREATION REQUIREMENTS
 * ================================================================================================
 *
 * For createBranch or createPR to work, one of the following must be true:
 *
 * Option A: githubUrl provided
 *   - Repository URL directly specified
 *   - Works with both cloning and existing paths
 *
 * Option B: projectPath with GitHub remote
 *   - Project must be a Git repository
 *   - Must have 'origin' remote configured
 *   - Remote URL must point to github.com
 *   - System auto-detects GitHub URL via: git remote get-url origin
 *
 * Additional Requirements:
 *   - Valid GitHub token (from settings or githubToken parameter)
 *   - Token must have 'repo' scope for private repos
 *   - Project must have commits (for PR creation)
 *
 * ================================================================================================
 * VALIDATION & ERROR HANDLING
 * ================================================================================================
 *
 * Input Validations (400 Bad Request):
 *   - Either githubUrl OR projectPath must be provided (not neither)
 *   - message must be non-empty string
 *   - provider must be 'claude'
 *   - createBranch/createPR requires githubUrl OR projectPath (not neither)
 *   - branchName must pass Git naming rules (if provided)
 *
 * Runtime Validations (500 Internal Server Error or specific error in response):
 *   - projectPath must exist (if used alone)
 *   - GitHub URL format must be valid
 *   - Git remote URL must include github.com (for projectPath + branch/PR)
 *   - GitHub token must be available (for private repos and branch/PR)
 *   - Directory conflicts handled (existing path with different repo)
 *
 * Branch Name Validation Errors (returned in response, not HTTP error):
 *   Invalid names return: { branch: { error: "Invalid branch name: <reason>" } }
 *   Examples:
 *   - "my branch" → "Branch name cannot contain spaces"
 *   - ".feature" → "Branch name cannot start with a dot"
 *   - "feature.lock" → "Branch name cannot end with .lock"
 *
 * ================================================================================================
 * RESPONSE FORMATS
 * ================================================================================================
 *
 * Streaming Response (stream=true):
 *   Content-Type: text/event-stream
 *   Events:
 *     - { type: "status", message: "...", projectPath: "..." }
 *     - { type: "claude-response", data: {...} }
 *     - { type: "github-branch", branch: { name: "...", url: "..." } }
 *     - { type: "github-pr", pullRequest: { number: 42, url: "..." } }
 *     - { type: "github-error", error: "..." }
 *     - { type: "done" }
 *
 * Non-Streaming Response (stream=false):
 *   Content-Type: application/json
 *   {
 *     success: true,
 *     sessionId: "session-123",
 *     messages: [...],        // Assistant messages only (filtered)
 *     tokens: {
 *       inputTokens: 150,
 *       outputTokens: 50,
 *       cacheReadTokens: 0,
 *       cacheCreationTokens: 0,
 *       totalTokens: 200
 *     },
 *     projectPath: "/path/to/project",
 *     branch: {               // Only if createBranch=true
 *       name: "feature/xyz",
 *       url: "https://github.com/owner/repo/tree/feature/xyz"
 *     } | { error: "..." },
 *     pullRequest: {          // Only if createPR=true
 *       number: 42,
 *       url: "https://github.com/owner/repo/pull/42"
 *     } | { error: "..." }
 *   }
 *
 * Async Response (async=true):
 *   HTTP Status: 202
 *   Content-Type: application/json
 *   {
 *     success: true,
 *     sessionId: "c0c9b6bf-bf3d-4936-a655-460f5d2d10db",
 *     sessionPath: "/session/c0c9b6bf-bf3d-4936-a655-460f5d2d10db",
 *     projectPath: "/path/to/project",
 *     status: "running"
 *   }
 *
 *   响应在回合**开跑之前**就发出去,拿到 sessionId 直接拼前端链接即可,
 *   点进去就能实时看着这一轮跑完(输出走聊天网关广播,断线重连有补发)。
 *
 *   注意:
 *   - 不带 sessionId 时新建会话,id 由服务端生成,同时也是 transcript 文件名;
 *     带 sessionId 时续那段对话(会查可见性,看不见按 404 处理)。
 *   - 与 createBranch / createPR 互斥:响应先发,结果没地方回报。
 *   - cleanup 不生效:会话是留着给人看的,不能把它的项目目录删掉。
 *   - 同一会话已有回合在跑时返回 409。
 *
 * Error Response:
 *   HTTP Status: 400, 401, 404, 409, 500
 *   Content-Type: application/json
 *   { success: false, error: "Error description" }
 *
 * ================================================================================================
 * EXAMPLES
 * ================================================================================================
 *
 * Example 1: Clone and process with auto-cleanup
 *   POST /api/agent
 *   { "githubUrl": "https://github.com/user/repo", "message": "Fix bug" }
 *
 * Example 2: Use existing project with custom branch and PR
 *   POST /api/agent
 *   {
 *     "projectPath": "/home/user/project",
 *     "message": "Add feature",
 *     "branchName": "feature/new-feature",
 *     "createPR": true
 *   }
 *
 * Example 3: 先拿会话 id 再去页面上看(异步模式)
 *   POST /api/agent
 *   {
 *     "projectPath": "/home/user/project",
 *     "message": "把这个仓库的测试跑一遍",
 *     "async": true
 *   }
 *   → 202 { sessionId, sessionPath }  —— 立刻返回,回合在后台跑
 *   → 打开 https://<host>/session/<sessionId> 实时观看
 *
 * Example 4: Clone to specific path with auto-generated branch
 *   POST /api/agent
 *   {
 *     "githubUrl": "https://github.com/user/repo",
 *     "projectPath": "/tmp/work",
 *     "message": "Refactor code",
 *     "createBranch": true,
 *     "cleanup": false
 *   }
 */
router.post('/', validateExternalApiKey, async (req, res) => {
  const { githubUrl, projectPath, message, provider = 'claude', model, githubToken, branchName, sessionId } = req.body;
  const effort = typeof req.body.effort === 'string' && req.body.effort.trim()
    ? req.body.effort.trim()
    : undefined;

  // Parse stream and cleanup as booleans (handle string "true"/"false" from curl)
  const stream = req.body.stream === undefined ? true : (req.body.stream === true || req.body.stream === 'true');
  const cleanup = req.body.cleanup === undefined ? true : (req.body.cleanup === true || req.body.cleanup === 'true');
  /**
   * 异步模式:**先把会话 id 返回,再去跑回合**。
   *
   * 默认(false)是原来的行为 —— 一直等到回合结束才回响应。那种形态下调用方
   * 拿到 id 时对话早就结束了,"拿链接去页面上看着它跑"根本无从谈起。
   */
  const asyncMode = req.body.async === true || req.body.async === 'true';

  // If branchName is provided, automatically enable createBranch
  const createBranch = branchName ? true : (req.body.createBranch === true || req.body.createBranch === 'true');
  const createPR = req.body.createPR === true || req.body.createPR === 'true';

  // Validate inputs
  if (!githubUrl && !projectPath) {
    return res.status(400).json({ error: 'Either githubUrl or projectPath is required' });
  }

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  if (provider !== 'claude') {
    return res.status(400).json({ error: 'provider must be "claude"' });
  }

  // 异步模式下这两件事没有落脚点:分支/PR 的结果要等回合跑完才有,而响应
  // 早就发出去了,做完也没人收得到。与其悄悄做一件没人看得见的事,不如直说。
  if (asyncMode && (createBranch || createPR)) {
    return res.status(400).json({
      error: 'async mode does not support createBranch / createPR — the response is sent before the turn finishes, so there is nowhere to report the result.',
    });
  }

  // Validate GitHub branch/PR creation requirements
  // Allow branch/PR creation with projectPath as long as it has a GitHub remote
  if ((createBranch || createPR) && !githubUrl && !projectPath) {
    return res.status(400).json({ error: 'createBranch and createPR require either githubUrl or projectPath with a GitHub remote' });
  }

  let finalProjectPath = null;
  let writer = null;

  try {
    // Determine the final project path
    if (githubUrl) {
      // Clone repository (to projectPath if provided, otherwise generate path)
      const tokenToUse = githubToken || githubTokensDb.getActiveGithubToken(req.user.id);

      let targetPath;
      if (projectPath) {
        // 用户指定的克隆目标必须落在工作区根之下 —— 这道校验以前只在"已存在
        // 路径"那支有,克隆这支漏了。少了它,一把自助 API key + githubUrl 就能
        // 把攻击者仓库克隆到 /root/.ssh 之类任意可写路径(服务常以 root 跑),
        // 是一个先于 agent 执行、独立于 bypassPermissions 的"任意路径写"原语。
        targetPath = normalizeProjectPath(path.resolve(projectPath));
        await assertInsideWorkspaceRoot(targetPath);
      } else {
        // 自动生成的路径由服务端固定前缀 + hash 决定,不受调用方控制,天然安全。
        const repoHash = crypto.createHash('md5').update(githubUrl + Date.now()).digest('hex');
        targetPath = path.join(os.homedir(), '.claude', 'external-projects', repoHash);
      }

      finalProjectPath = await cloneGitHubRepo(githubUrl.trim(), tokenToUse, targetPath);
    } else {
      // Use existing project path
      finalProjectPath = normalizeProjectPath(path.resolve(projectPath));

      // 必须落在工作区根之下。这个端点用 API key 鉴权,而任何登录用户都能自助
      // 建一把 key(POST /api/settings/api-keys),下面又是以 bypassPermissions
      // 起 Claude —— 少了这道校验,一把 key 就等于对服务进程能到达的任意路径的
      // 读写权,项目边界与逐工具确认两层同时被绕过。
      //
      // 用的是 WORKSPACES_ROOT 包含判定,不是 `validateWorkspacePath`:后者除了
      // 包含判定还会拒绝一批"系统关键目录",而 /root 正在那张表里。以 root 身份
      // 部署时家目录就是 /root,工作区根本身就会被它拒掉,整个端点直接不可用。
      // 根目录可用 WORKSPACES_ROOT 环境变量改。
      await assertInsideWorkspaceRoot(finalProjectPath);

      // Verify the path exists
      try {
        await fs.access(finalProjectPath);
      } catch (error) {
        throw new Error(`Project path does not exist: ${finalProjectPath}`);
      }
    }

    finalProjectPath = normalizeProjectPath(finalProjectPath);

    // Register project path in DB (or reuse existing active registration).
    //
    // owner 必须在这里就传对:这次预注册先落行,后面 createAppSession 内部的
    // createProjectPath 走 ON CONFLICT 分支、按设计**不改归属** —— 也就是说
    // 这里少传 owner,新路径的项目就永远无主。无主项目在现行可见性规则下
    // 非公共目录仅 root 可见:API 调用者自己都打不开返回的 /session/<id> 链接;
    // 恰在公共目录下则对全服务器公开。两个方向都不是"归调用者所有"的本意。
    const registrationResult = projectsDb.createProjectPath(finalProjectPath, null, req.user.id);
    if (registrationResult.outcome === 'active_conflict') {
      console.log('Project registration already exists for:', finalProjectPath);
    } else {
      console.log('Project registered:', registrationResult.project);
    }

    /**
     * 传进来的 `sessionId` 到底是什么意思 —— 判据只有一条:
     * **库里那行的 `provider_session_id` 空不空。**
     *
     * 1. 库里有行、`provider_session_id` 为空 → 这是 `POST /api/agent/sessions`
     *    领过号但还没跑过的会话 → **用这个 id 新建**。此时若按 resume 处理,
     *    CLI 会去找一份根本不存在的 transcript,直接失败。
     * 2. 库里有行、`provider_session_id` 有值 → 续那个 provider 会话。
     * 3. 库里没这行 → **404**。以前的老语义是"当成 provider 原生 id 直接续",
     *    但那条路绕开了 `canViewerSeeSession`(行还没被 watcher 索引进库时,
     *    等于拿任意 id 以 bypassPermissions 续别人的 transcript)。收口:先经
     *    `POST /api/agent/sessions` 领号,或等索引完成后用库里的 id。
     */
    let appSessionId = sessionId || null;
    let resumeProviderSessionId = null;
    let createWithSessionId = null;

    if (sessionId) {
      const row = sessionsDb.getSessionById(sessionId);
      if (row) {
        // API key 背后也是一个具体的人,不能拿一把自助 key 就往别人的会话里写。
        // 与"这个 id 不存在"同形返回,不泄漏"存在但你看不见"。
        if (!canViewerSeeSession(sessionId, readRequestViewer(req))) {
          return res.status(404).json({ error: `Session "${sessionId}" was not found.` });
        }
        if (row.provider_session_id) resumeProviderSessionId = row.provider_session_id;
        else createWithSessionId = sessionId;
      } else {
        return res.status(404).json({ error: `Session "${sessionId}" was not found.` });
      }
    }

    /**
     * 异步模式:id 先走,回合后走。
     *
     * 顺序是**故意**这样的:
     *
     * 1. 先定下会话 id 并**立刻在库里占一行**(`createAppSession`)。占了行,
     *    `/session/<id>` 这个链接当场就能打开 —— 哪怕回合一个字都还没吐,
     *    页面看到的也是一段空对话,而不是"会话不存在"。
     * 2. 把这一轮登记进 `chatRunRegistry`,写入口用网关 writer。**此刻一个
     *    浏览器都没连着**,所以 `connection` 传 null;人点开链接之后
     *    `chat.subscribe` 会把 socket 加进来,前半段由补发游标补上。
     *    走网关还顺带两个好处:显示日志会记(见 az 轮),`chat.abort` 也能用。
     * 3. 回合真正开跑之前就把 id 发回去。调用方直接拿去拼链接。
     *
     * 落盘文件名同样是这个 id(`newSessionId` → SDK 的 `Options.sessionId`),
     * 所以"应用侧 id"和"provider 原生 id"是同一个值,链接、transcript、
     * 侧栏三处对得上。
     */
    if (asyncMode) {
      if (!appSessionId) {
        // 一步到位:没领过号就现领一个,同样占行,链接立刻可用。
        appSessionId = crypto.randomUUID();
        // owner 必须传:不传等于把这个项目标成"公共",全服务器可见。
        sessionsDb.createAppSession(appSessionId, provider, finalProjectPath, req.user.id);
        createWithSessionId = appSessionId;
      }

      const run = chatRunRegistry.startRun({
        appSessionId,
        provider,
        providerSessionId: resumeProviderSessionId,
        connection: null,
        userId: req.user.id,
      });

      if (!run) {
        return res.status(409).json({
          error: `Session "${appSessionId}" already has a run in progress.`,
          sessionId: appSessionId,
        });
      }

      // 用户这条指令写进显示日志(与 chat.send 的 cb 修复同源):外部 API 发起
      // 的回合,网页打开会话也要能看到"是谁让它干的什么",重启/刷新都不丢。
      sessionMessagesDb.append(appSessionId, {
        id: generateMessageId('user'),
        sessionId: appSessionId,
        timestamp: new Date().toISOString(),
        provider,
        kind: 'text',
        role: 'user',
        content: message.trim(),
      });

      res.status(202).json({
        success: true,
        sessionId: appSessionId,
        // 相对路径:服务端不猜自己的对外域名(反代之后 Host 未必对)。
        sessionPath: `/session/${appSessionId}`,
        projectPath: finalProjectPath,
        status: 'running',
      });

      // 不 await:响应已经发出去了,这一轮在后台跑,输出走网关推给
      // 之后订阅上来的浏览器。
      queryClaudeSDK(message.trim(), {
        projectPath: finalProjectPath,
        cwd: finalProjectPath,
        sessionId: resumeProviderSessionId ?? undefined,
        resume: Boolean(resumeProviderSessionId),
        newSessionId: createWithSessionId ?? undefined,
        runId: appSessionId,
        model,
        effort,
        permissionMode: 'bypassPermissions',
        oneShot: true,
      }, run.writer).catch((error) => {
        console.error('[Agent API] 异步回合失败', {
          sessionId: appSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }).finally(() => {
        // 兜底的终止帧:运行时崩了或者没发自己的 complete 时,不能让页面
        // 永远转圈。只对"还是当前这一轮"生效。
        chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
      });

      return;
    }

    // B2:同步路径(stream / 非 stream)也要占用运行位。此前它不 startRun、
    // 不查 holder —— 于是同一个 provider 会话可以被网页聊天的常驻 runtime 与这条
    // 同步 API 回合**同时写同一份 transcript**(正是所有权机制要消灭的双写)。
    // 只在"指向了某个已有会话"(appSessionId 有值:领过号或续已存在会话)时占位
    // 并做冲突检查 —— 这正是双写会发生的场景;全新会话(appSessionId 为空)没有
    // 可冲突的目标,保持原语义不动。冲突回 409;runId 一并传给 queryClaudeSDK,
    // 顺带让 chat.abort 也能中止这条同步回合。
    let syncRun = null;
    if (appSessionId) {
      syncRun = chatRunRegistry.startRun({
        appSessionId,
        provider,
        providerSessionId: resumeProviderSessionId,
        connection: null,
        userId: req.user.id,
      });
      if (!syncRun) {
        return res.status(409).json({
          error: `Session "${appSessionId}" already has a run in progress.`,
          sessionId: appSessionId,
        });
      }
      // 同上:同步路径的用户指令也落显示日志。
      sessionMessagesDb.append(appSessionId, {
        id: generateMessageId('user'),
        sessionId: appSessionId,
        timestamp: new Date().toISOString(),
        provider,
        kind: 'text',
        role: 'user',
        content: message.trim(),
      });
    }

    // Set up writer based on streaming mode
    if (stream) {
      // Set up SSE headers for streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

      writer = new SSEStreamWriter(res, req.user.id);

      // Send initial status
      writer.send({
        type: 'status',
        message: githubUrl ? 'Repository cloned and session started' : 'Session started',
        projectPath: finalProjectPath
      });
    } else {
      // Non-streaming mode: collect messages
      writer = new ResponseCollector(req.user.id);

      // Collect initial status message
      writer.send({
        type: 'status',
        message: githubUrl ? 'Repository cloned and session started' : 'Session started',
        projectPath: finalProjectPath
      });
    }

    // Start the session (Claude is the only provider)
    if (provider === 'claude') {
      console.log('🤖 Starting Claude SDK session');

      try {
        await queryClaudeSDK(message.trim(), {
          projectPath: finalProjectPath,
          cwd: finalProjectPath,
          sessionId: resumeProviderSessionId,
          // 领过号但还没跑过的会话:用这个 id 新建,transcript 落盘就是它。
          newSessionId: createWithSessionId ?? undefined,
          // 占了运行位就带上 runId,让 chat.abort 能中止这条同步回合。
          runId: syncRun ? appSessionId : undefined,
          model: model,
          effort,
          permissionMode: 'bypassPermissions', // Bypass all permissions for API calls
          oneShot: true // API turns stay on the per-turn path (no resident runtime)
        }, writer);
      } finally {
        // 释放运行位:回合结束(成功/失败)都要放,否则这个会话会被永久标成
        // "有回合在跑",后续请求全被 409 挡下。
        if (syncRun) chatRunRegistry.completeRunIfCurrent(syncRun, { exitCode: 0 });
      }

      /**
       * 领过号的会话:回合一跑完就把映射补上,别等 watcher。
       *
       * 这一行的 `provider_session_id` 在领号时是空的,而 `fetchHistory` 见它为空
       * 就直接返回空历史 —— 也就是说在 watcher 扫到 transcript 之前,用户点开
       * 那个链接看到的是一段空对话,尽管内容早就落盘了。这里主动补一次,
       * 窗口从"一次扫描周期"缩到零。
       *
       * 同步路径的 writer 不走网关,所以没有 `recordProviderSessionId` 那条路,
       * 只能在这里补。
       */
      if (createWithSessionId) {
        try {
          sessionsDb.assignProviderSessionId(createWithSessionId, writer.getSessionId() || createWithSessionId);
        } catch (error) {
          console.warn('[Agent API] 回填 provider session id 失败:', error?.message || error);
        }
      }
    }

    // Handle GitHub branch and PR creation after successful agent completion
    let branchInfo = null;
    let prInfo = null;

    if (createBranch || createPR) {
      try {
        console.log('🔄 Starting GitHub branch/PR creation workflow...');

        // Get GitHub token
        const tokenToUse = githubToken || githubTokensDb.getActiveGithubToken(req.user.id);

        if (!tokenToUse) {
          throw new Error('GitHub token required for branch/PR creation. Please configure a GitHub token in settings.');
        }

        // Initialize Octokit
        const octokit = new Octokit({ auth: tokenToUse });

        // Get GitHub URL - either from parameter or from git remote
        let repoUrl = githubUrl;
        if (!repoUrl) {
          console.log('🔍 Getting GitHub URL from git remote...');
          try {
            repoUrl = await getGitRemoteUrl(finalProjectPath);
            if (!repoUrl.includes('github.com')) {
              throw new Error('Project does not have a GitHub remote configured');
            }
            console.log(`✅ Found GitHub remote: ${repoUrl}`);
          } catch (error) {
            throw new Error(`Failed to get GitHub remote URL: ${error.message}`);
          }
        }

        // Parse GitHub URL to get owner and repo
        const { owner, repo } = parseGitHubUrl(repoUrl);
        console.log(`📦 Repository: ${owner}/${repo}`);

        // Use provided branch name or auto-generate from message
        const finalBranchName = branchName || autogenerateBranchName(message);
        if (branchName) {
          console.log(`🌿 Using provided branch name: ${finalBranchName}`);

          // Validate custom branch name
          const validation = validateBranchName(finalBranchName);
          if (!validation.valid) {
            throw new Error(`Invalid branch name: ${validation.error}`);
          }
        } else {
          console.log(`🌿 Auto-generated branch name: ${finalBranchName}`);
        }

        if (createBranch) {
          // Create and checkout the new branch locally
          console.log('🔄 Creating local branch...');
          const checkoutProcess = spawn('git', ['checkout', '-b', finalBranchName], {
            cwd: finalProjectPath,
            stdio: 'pipe'
          });

          await new Promise((resolve, reject) => {
            let stderr = '';
            checkoutProcess.stderr.on('data', (data) => { stderr += data.toString(); });
            checkoutProcess.on('close', (code) => {
              if (code === 0) {
                console.log(`✅ Created and checked out local branch '${finalBranchName}'`);
                resolve();
              } else {
                // Branch might already exist locally, try to checkout
                if (stderr.includes('already exists')) {
                  console.log(`ℹ️ Branch '${finalBranchName}' already exists locally, checking out...`);
                  const checkoutExisting = spawn('git', ['checkout', finalBranchName], {
                    cwd: finalProjectPath,
                    stdio: 'pipe'
                  });
                  checkoutExisting.on('close', (checkoutCode) => {
                    if (checkoutCode === 0) {
                      console.log(`✅ Checked out existing branch '${finalBranchName}'`);
                      resolve();
                    } else {
                      reject(new Error(`Failed to checkout existing branch: ${stderr}`));
                    }
                  });
                } else {
                  reject(new Error(`Failed to create branch: ${stderr}`));
                }
              }
            });
          });

          // Push the branch to remote
          console.log('🔄 Pushing branch to remote...');
          const pushProcess = spawn('git', ['push', '-u', 'origin', finalBranchName], {
            cwd: finalProjectPath,
            stdio: 'pipe'
          });

          await new Promise((resolve, reject) => {
            let stderr = '';
            let stdout = '';
            pushProcess.stdout.on('data', (data) => { stdout += data.toString(); });
            pushProcess.stderr.on('data', (data) => { stderr += data.toString(); });
            pushProcess.on('close', (code) => {
              if (code === 0) {
                console.log(`✅ Pushed branch '${finalBranchName}' to remote`);
                resolve();
              } else {
                // Check if branch exists on remote but has different commits
                if (stderr.includes('already exists') || stderr.includes('up-to-date')) {
                  console.log(`ℹ️ Branch '${finalBranchName}' already exists on remote, using existing branch`);
                  resolve();
                } else {
                  reject(new Error(`Failed to push branch: ${stderr}`));
                }
              }
            });
          });

          branchInfo = {
            name: finalBranchName,
            url: `https://github.com/${owner}/${repo}/tree/${finalBranchName}`
          };
        }

        if (createPR) {
          // Get commit messages to generate PR description
          console.log('🔄 Generating PR title and description...');
          const commitMessages = await getCommitMessages(finalProjectPath, 5);

          // Use the first commit message as the PR title, or fallback to the agent message
          const prTitle = commitMessages.length > 0 ? commitMessages[0] : message;

          // Generate PR body from commit messages
          let prBody = '## Changes\n\n';
          if (commitMessages.length > 0) {
            prBody += commitMessages.map(msg => `- ${msg}`).join('\n');
          } else {
            prBody += `Agent task: ${message}`;
          }
          prBody += '\n\n---\n*This pull request was automatically created by Prism.ai Agent.*';

          console.log(`📝 PR Title: ${prTitle}`);

          // Create the pull request
          console.log('🔄 Creating pull request...');
          prInfo = await createGitHubPR(octokit, owner, repo, finalBranchName, prTitle, prBody, 'main');
        }

        // Send branch/PR info in response
        if (stream) {
          if (branchInfo) {
            writer.send({
              type: 'github-branch',
              branch: branchInfo
            });
          }
          if (prInfo) {
            writer.send({
              type: 'github-pr',
              pullRequest: prInfo
            });
          }
        }

      } catch (error) {
        console.error('❌ GitHub branch/PR creation error:', error);

        // Send error but don't fail the entire request
        if (stream) {
          writer.send({
            type: 'github-error',
            error: error.message
          });
        }
        // Store error info for non-streaming response
        if (!stream) {
          branchInfo = { error: error.message };
          prInfo = { error: error.message };
        }
      }
    }

    // Handle response based on streaming mode
    if (stream) {
      // Streaming mode: end the SSE stream
      writer.end();
    } else {
      // Non-streaming mode: send filtered messages and token summary as JSON
      const assistantMessages = writer.getAssistantMessages();
      const tokenSummary = writer.getTotalTokens();

      const response = {
        success: true,
        sessionId: writer.getSessionId(),
        messages: assistantMessages,
        tokens: tokenSummary,
        projectPath: finalProjectPath
      };

      // Add branch/PR info if created
      if (branchInfo) {
        response.branch = branchInfo;
      }
      if (prInfo) {
        response.pullRequest = prInfo;
      }

      res.json(response);
    }

    // Clean up if requested
    if (cleanup && githubUrl) {
      // Only cleanup if we cloned a repo (not for existing project paths)
      const sessionIdForCleanup = writer.getSessionId();
      setTimeout(() => {
        cleanupProject(finalProjectPath, sessionIdForCleanup);
      }, 5000);
    }

  } catch (error) {
    console.error('❌ External session error:', error);

    // Clean up on error
    if (finalProjectPath && cleanup && githubUrl) {
      const sessionIdForCleanup = writer ? writer.getSessionId() : null;
      cleanupProject(finalProjectPath, sessionIdForCleanup);
    }

    if (stream) {
      // For streaming, send error event and stop
      if (!writer) {
        // Set up SSE headers if not already done
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        writer = new SSEStreamWriter(res, req.user.id);
      }

      if (!res.writableEnded) {
        writer.send({
          type: 'error',
          error: error.message,
          message: `Failed: ${error.message}`
        });
        writer.end();
      }
    } else if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

export default router;

// 单测用:非流式响应的收集器本身是有逻辑的(挑回答、累加用量),值得钉住。
export { ResponseCollector };
