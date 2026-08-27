import express from 'express';

import {
  apiKeysDb,
  auditLogDb,
  credentialsDb,
  notificationPreferencesDb,
  uiSettingsDb,
} from '../modules/database/index.js';
import { clientIp } from '../middleware/rate-limit.js';

const router = express.Router();

/** Shared context for every audit entry written from this router. */
const auditContext = (req) => ({
  userId: req.user?.id ?? null,
  username: req.user?.username ?? null,
  ip: clientIp(req),
  userAgent: req.headers['user-agent'] ?? null,
});

// ===============================
// API Keys Management
// ===============================

// Get all API keys for the authenticated user
router.get('/api-keys', async (req, res) => {
  try {
    const apiKeys = apiKeysDb.getApiKeys(req.user.id);
    // Keys are stored hashed — only the display prefix still exists. `api_key`
    // is kept in the response shape for the existing frontend contract.
    const sanitizedKeys = apiKeys.map(key => ({
      ...key,
      api_key: `${key.api_key_prefix || 'ck_'}...`
    }));
    res.json({ apiKeys: sanitizedKeys });
  } catch (error) {
    console.error('Error fetching API keys:', error);
    res.status(500).json({ error: 'Failed to fetch API keys' });
  }
});

// Create a new API key
router.post('/api-keys', async (req, res) => {
  try {
    const { keyName } = req.body;

    if (!keyName || !keyName.trim()) {
      return res.status(400).json({ error: 'Key name is required' });
    }

    const result = apiKeysDb.createApiKey(req.user.id, keyName.trim());
    auditLogDb.record({
      ...auditContext(req),
      event: 'api_key_created',
      detail: `name=${keyName.trim()} prefix=${result.apiKeyPrefix}`,
    });
    // `apiKey` is the only time the full value is ever returned.
    res.json({
      success: true,
      apiKey: result
    });
  } catch (error) {
    console.error('Error creating API key:', error);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

// Delete an API key
router.delete('/api-keys/:keyId', async (req, res) => {
  try {
    const { keyId } = req.params;
    const success = apiKeysDb.deleteApiKey(req.user.id, parseInt(keyId));

    if (success) {
      auditLogDb.record({ ...auditContext(req), event: 'api_key_deleted', detail: `id=${keyId}` });
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'API key not found' });
    }
  } catch (error) {
    console.error('Error deleting API key:', error);
    res.status(500).json({ error: 'Failed to delete API key' });
  }
});

// Toggle API key active status
router.patch('/api-keys/:keyId/toggle', async (req, res) => {
  try {
    const { keyId } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be a boolean' });
    }

    const success = apiKeysDb.toggleApiKey(req.user.id, parseInt(keyId), isActive);

    if (success) {
      auditLogDb.record({
        ...auditContext(req),
        event: 'api_key_toggled',
        detail: `id=${keyId} active=${isActive}`,
      });
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'API key not found' });
    }
  } catch (error) {
    console.error('Error toggling API key:', error);
    res.status(500).json({ error: 'Failed to toggle API key' });
  }
});

// ===============================
// Generic Credentials Management
// ===============================

// Get all credentials for the authenticated user (optionally filtered by type)
router.get('/credentials', async (req, res) => {
  try {
    const { type } = req.query;
    const credentials = credentialsDb.getCredentials(req.user.id, type || null);
    // Don't send the actual credential values for security
    res.json({ credentials });
  } catch (error) {
    console.error('Error fetching credentials:', error);
    res.status(500).json({ error: 'Failed to fetch credentials' });
  }
});

// Create a new credential
router.post('/credentials', async (req, res) => {
  try {
    const { credentialName, credentialType, credentialValue, description } = req.body;

    if (!credentialName || !credentialName.trim()) {
      return res.status(400).json({ error: 'Credential name is required' });
    }

    if (!credentialType || !credentialType.trim()) {
      return res.status(400).json({ error: 'Credential type is required' });
    }

    if (!credentialValue || !credentialValue.trim()) {
      return res.status(400).json({ error: 'Credential value is required' });
    }

    const result = credentialsDb.createCredential(
      req.user.id,
      credentialName.trim(),
      credentialType.trim(),
      credentialValue.trim(),
      description?.trim() || null
    );

    auditLogDb.record({
      ...auditContext(req),
      event: 'credential_created',
      detail: `type=${credentialType.trim()} name=${credentialName.trim()}`,
    });

    res.json({
      success: true,
      credential: result
    });
  } catch (error) {
    console.error('Error creating credential:', error);
    res.status(500).json({ error: 'Failed to create credential' });
  }
});

// Delete a credential
router.delete('/credentials/:credentialId', async (req, res) => {
  try {
    const { credentialId } = req.params;
    const success = credentialsDb.deleteCredential(req.user.id, parseInt(credentialId));

    if (success) {
      auditLogDb.record({
        ...auditContext(req),
        event: 'credential_deleted',
        detail: `id=${credentialId}`,
      });
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Credential not found' });
    }
  } catch (error) {
    console.error('Error deleting credential:', error);
    res.status(500).json({ error: 'Failed to delete credential' });
  }
});

// Toggle credential active status
router.patch('/credentials/:credentialId/toggle', async (req, res) => {
  try {
    const { credentialId } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be a boolean' });
    }

    const success = credentialsDb.toggleCredential(req.user.id, parseInt(credentialId), isActive);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Credential not found' });
    }
  } catch (error) {
    console.error('Error toggling credential:', error);
    res.status(500).json({ error: 'Failed to toggle credential' });
  }
});

// ===============================
// Notification Preferences
// ===============================

router.get('/notification-preferences', async (req, res) => {
  try {
    const preferences = notificationPreferencesDb.getPreferences(req.user.id);
    res.json({ success: true, preferences });
  } catch (error) {
    console.error('Error fetching notification preferences:', error);
    res.status(500).json({ error: 'Failed to fetch notification preferences' });
  }
});

router.put('/notification-preferences', async (req, res) => {
  try {
    const preferences = notificationPreferencesDb.updatePreferences(req.user.id, req.body || {});
    res.json({ success: true, preferences });
  } catch (error) {
    console.error('Error saving notification preferences:', error);
    res.status(500).json({ error: 'Failed to save notification preferences' });
  }
});

// ===============================
// F11 · 账号级界面偏好
// ===============================

/**
 * 权限清单、项目排序、编辑器偏好此前全在 localStorage —— 换台电脑就归零。
 *
 * 服务端在这里只做**存取**,不解释内容:偏好的形状归前端管,服务端一旦开始
 * 校验字段,加一项偏好就要改两处。只做两件事 —— 限大小(防止有人把它当网盘),
 * 以及要求是个对象(数组/字符串存进去只会让前端读的时候更难受)。
 */
const MAX_UI_SETTINGS_BYTES = 64 * 1024;

router.get('/ui', async (req, res) => {
  try {
    const record = uiSettingsDb.get(req.user.id);
    res.json({ success: true, settings: record?.settings ?? null, clientUpdatedAt: record?.clientUpdatedAt ?? null });
  } catch (error) {
    console.error('Error fetching UI settings:', error);
    res.status(500).json({ error: 'Failed to fetch UI settings' });
  }
});

router.put('/ui', async (req, res) => {
  try {
    const body = req.body || {};
    const settings = body.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return res.status(400).json({ error: 'settings must be an object' });
    }
    const serialized = JSON.stringify(settings);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_UI_SETTINGS_BYTES) {
      return res.status(413).json({ error: '界面偏好过大(上限 64KB)' });
    }

    const clientUpdatedAt = typeof body.clientUpdatedAt === 'string' ? body.clientUpdatedAt : null;
    const record = uiSettingsDb.put(req.user.id, settings, clientUpdatedAt);
    res.json({ success: true, settings: record.settings, clientUpdatedAt: record.clientUpdatedAt });
  } catch (error) {
    console.error('Error saving UI settings:', error);
    res.status(500).json({ error: 'Failed to save UI settings' });
  }
});

export default router;
